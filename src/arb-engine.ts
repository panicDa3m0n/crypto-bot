import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { PriceOracle, PoolRef } from "./price-oracle.js";

/**
 * ArbEngine — arbitrage computed on OUR on-chain price oracle, not an aggregator.
 *
 * For each candidate token the system reads all its pools' state at ONE fixed block and computes
 * the EXACT executable spread with the AMM's own math (matches the DEX to the last digit): buy the
 * token on the pool that gives the most, sell it on the pool that gives the most back — all at the
 * same block. This removes the two errors of the old aggregator round-trip: the ±$0.2 timing noise
 * (both legs now priced at the same block) and the ~7x-inflated gas (a realistic per-swap estimate
 * priced at the live gas price). Size is swept up to flashloan-scale so a real-but-tiny spread that
 * loses to fixed gas at $50 can still surface at $1k–5k. Firing stays deferred (ARB_AUTOFIRE).
 */
type Cand = { token: string; symbol: string; kind: "spatial"; quote: string; bestSizeUsd: number; grossUsd: number; gasUsd: number; netUsd: number; buyPool: string; sellPool: string };
type WatchRow = { token: string; symbol: string; venues: number; spreadPct: number; pools: Array<{ dex: string; priceUsd: number; pool: string }>; execNetUsd?: number; execSizeUsd?: number };

export class ArbEngine {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly lastNotified = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly oracle: PriceOracle,
    private readonly logger: Logger,
    private readonly wake: (key: string, reason: string) => void
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick().catch((error) => this.logger.error({ err: error }, "arb tick failed")), this.config.ARB_INTERVAL_MS);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private sizes(): number[] {
    return this.config.ARB_PROBE_SIZES_USD.split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  }

  /** Candidate tokens on >=2 discovered pools — where cross-venue spatial arb can exist. */
  private async candidates(): Promise<Array<{ address: string; symbol: string }>> {
    const reg = await this.db.arbCandidateTokens(this.config.CHAIN_ID, this.config.WBERA_ADDRESS, this.config.ARB_MAX_CANDIDATES).catch(() => []);
    return reg.map((c) => ({ address: c.address, symbol: c.symbol ?? c.address.slice(0, 8) }));
  }

  private async tick(): Promise<void> {
    if (this.running || !this.config.ARB_ENABLED) return;
    this.running = true;
    try {
      const [block, gasPriceWei] = await Promise.all([this.chain.primary.getBlockNumber(), this.chain.primary.getGasPrice().catch(() => 0n)]);
      const baseUsd = (await this.oracle.usdPrice(this.config.WBERA_ADDRESS, block)) ?? (await this.chain.tokenPrice(this.config.WBERA_ADDRESS).catch(() => 0));
      if (!(baseUsd > 0)) return;
      // Realistic atomic-bundle gas: 2 swaps + organ overhead, at the LIVE gas price.
      const gasUnits = 2 * this.config.ARB_SWAP_GAS + this.config.ARB_ORGAN_GAS_OVERHEAD;
      const gasUsd = gasUnits * (Number(gasPriceWei) / 1e18) * baseUsd;
      const cands = await this.candidates();
      if (!cands.length) return;
      const min = this.config.ARB_MIN_PROFIT_USD;
      const found: Cand[] = [];
      const watchlist: WatchRow[] = [];

      for (const c of cands) {
        const refs = await this.oracle.poolRefs(c.address);
        if (refs.length < 2) continue;
        // Group pools by the QUOTE token (the other side of the pair).
        const byQuote = new Map<string, PoolRef[]>();
        for (const r of refs) {
          const q = r.token0.toLowerCase() === c.address ? r.token1.toLowerCase() : r.token0.toLowerCase();
          (byQuote.get(q) ?? byQuote.set(q, []).get(q)!).push(r);
        }
        // Spatial arb: for each quote with >=2 pools, exact best-buy/best-sell across them, size-swept.
        let best: { netUsd: number; grossUsd: number; sizeUsd: number; quote: string; buyPool: string; sellPool: string } | null = null;
        for (const [quote, qrefs] of byQuote) {
          if (qrefs.length < 2) continue;
          const quoteUsd = (await this.oracle.usdPrice(quote, block)) ?? 0;
          if (!(quoteUsd > 0)) continue;
          const quoteDec = await this.oracle.decimalsOf(quote);
          for (const sizeUsd of this.sizes()) {
            const sizeQ = BigInt(Math.floor((sizeUsd / quoteUsd) * 10 ** quoteDec));
            if (sizeQ <= 0n) continue;
            // Buy the token on each pool; keep the best (most token out).
            let buy: { ref: PoolRef; out: bigint } | null = null;
            for (const r of qrefs) { const out = await this.oracle.amountOut(r, quote, sizeQ, block); if (out && (!buy || out > buy.out)) buy = { ref: r, out }; }
            if (!buy) continue;
            // Sell that token back on a DIFFERENT pool; keep the best (most quote back).
            let sell: { ref: PoolRef; out: bigint } | null = null;
            for (const r of qrefs) { if (r.address === buy.ref.address) continue; const out = await this.oracle.amountOut(r, c.address, buy.out, block); if (out && (!sell || out > sell.out)) sell = { ref: r, out }; }
            if (!sell) continue;
            const grossUsd = (Number(sell.out - sizeQ) / 10 ** quoteDec) * quoteUsd;
            const netUsd = grossUsd - gasUsd;
            if (!best || netUsd > best.netUsd) best = { netUsd, grossUsd, sizeUsd, quote, buyPool: buy.ref.address, sellPool: sell.ref.address };
          }
        }
        if (best && best.netUsd >= min) found.push({ token: c.address, symbol: c.symbol, kind: "spatial", quote: best.quote, bestSizeUsd: best.sizeUsd, grossUsd: best.grossUsd, gasUsd, netUsd: best.netUsd, buyPool: best.buyPool, sellPool: best.sellPool });

        // Watchlist: exact spot USD per pool (from the oracle) + the executable net just computed.
        if (watchlist.length < this.config.ARB_WATCHLIST_MAX) {
          const pools: WatchRow["pools"] = [];
          for (const r of refs) { const pu = await this.oracle.spotUsd(r, c.address, block); if (pu != null) pools.push({ dex: r.archetype, priceUsd: pu, pool: r.address }); }
          if (pools.length) {
            const prices = pools.map((p) => p.priceUsd); const lo = Math.min(...prices), hi = Math.max(...prices);
            watchlist.push({ token: c.address, symbol: c.symbol, venues: pools.length, spreadPct: lo > 0 ? Number((((hi - lo) / lo) * 100).toFixed(3)) : 0, pools, execNetUsd: best?.netUsd, execSizeUsd: best?.sizeUsd });
          }
        }
      }

      found.sort((x, y) => y.netUsd - x.netUsd);
      watchlist.sort((a, b) => (b.execNetUsd ?? -1e9) - (a.execNetUsd ?? -1e9));
      const note = found.length
        ? `${found.length} spatial arb(s) profitable — EXACT executable spread from on-chain pool state at block ${block} (buy/sell at the SAME block, zero timing noise; realistic gas). Uncontested (pre-MEV); simulate atomically before firing.${this.config.ARB_AUTOFIRE ? "" : " Auto-fire off."}`
        : `No spatial arb clears gas across ${cands.length} multi-pool tokens at block ${block} — prices coherent across venues (exact oracle math). Base efficient; hunt momentum/flow.`;
      await this.db.saveMarketSnapshot("arb", "recent", { observedAt: new Date().toISOString(), block: block.toString(), scope: `on-chain oracle, exact executable spread at a single block, realistic gas, uncontested`, candidatesScanned: cands.length, note, candidates: found.slice(0, 15), watchlist: watchlist.slice(0, 15) }).catch(() => undefined);

      const now = Date.now();
      for (const c of found) {
        if (now - (this.lastNotified.get(c.token) ?? 0) < 10 * 60_000) continue;
        this.lastNotified.set(c.token, now);
        this.wake(`arb:${c.token}`, `Arbitrage (oracle-exact): ${c.symbol} nets ~$${c.netUsd.toFixed(3)} at $${c.bestSizeUsd} — buy ${c.buyPool.slice(0, 8)}… sell ${c.sellPool.slice(0, 8)}… (same block, realistic gas, UNCONTESTED). Simulate atomically before firing.`);
      }
      if (found.length) this.logger.info({ found: found.length, best: found[0]?.netUsd, block: block.toString() }, "arb (oracle) verified");
    } finally {
      this.running = false;
    }
  }
}
