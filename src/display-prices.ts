import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { Aggregator } from "./aggregator.js";

/**
 * DisplayPrices — Lane A. Keeps an INDICATIVE USD price for every discovered token in `token_prices`,
 * batch-refreshed on a slow cadence, so the dashboard/wallet read the DB and NEVER call a price API
 * per render. This is display-only: it must never feed an arb/liquidation decision (those compute a
 * fresh execution quote at the exact size — Lane B). The two lanes never cross.
 *
 * Cheap by construction: one DefiLlama BATCH call prices ~120 tokens at once. Each tick refreshes the
 * priority set (tokens the wallet holds + watch-tier collateral/loan — the ones the user actually
 * looks at) plus a slice of the most-stale tail, so over successive ticks the whole registry cycles.
 * A small bounded aggregator→WETH backfill prices priority tokens DefiLlama doesn't cover.
 */
export class DisplayPrices {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly weth: string;

  constructor(private readonly config: Config, private readonly db: Database, private readonly aggregator: Aggregator, private readonly logger: Logger) {
    this.weth = config.WBERA_ADDRESS.toLowerCase();
  }

  start(): void {
    if (!this.config.DISPLAY_PRICE_ENABLED) { this.logger.info("display-price refresher disabled"); return; }
    void this.tick();
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.error({ err: e }, "display-price tick failed")), this.config.DISPLAY_PRICE_INTERVAL_MS);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const chainId = this.config.CHAIN_ID;
      // 1. Priority: what the user actually views — wallet holdings + watch-tier collateral/loan.
      const priority = new Set<string>([this.weth, this.config.USDC_E_ADDRESS.toLowerCase()]); // + the WETH-USD anchor for backfill
      const wallet = await this.db.latestMarketSnapshot<{ holdings?: Array<{ token?: string }> }>("wallet", "holdings").catch(() => undefined);
      for (const h of wallet?.holdings ?? []) if (h.token) priority.add(h.token.toLowerCase());
      const watch = await this.db.listLendingPositions(chainId, { tier: "watch", limit: 200 }).catch(() => []);
      for (const p of watch) { if (p.collateralToken) priority.add(p.collateralToken.toLowerCase()); if (p.loanToken) priority.add(p.loanToken.toLowerCase()); }

      // 2. Fill the batch with the most-stale tail so the whole registry cycles over time.
      const need = Math.max(0, this.config.DISPLAY_PRICE_BATCH - priority.size);
      const stale = need > 0 ? await this.db.tokensForDisplayPricing(chainId, need, this.config.DISPLAY_PRICE_STALE_MS, this.config.DISPLAY_DEAD_RECHECK_MS).catch(() => []) : [];
      const batch = [...new Set([...priority, ...stale.map((t) => t.toLowerCase())])].slice(0, this.config.DISPLAY_PRICE_BATCH);
      if (!batch.length) return;

      // 3. One DefiLlama BATCH call. Unpriced → 0 (NOT null), source "none" — a number so downstream
      // math never breaks, and "none" tokens drop to the slow re-check lane (deadMs).
      const priced = await this.llamaBatch(batch);
      const rows = batch.map((token) => {
        const p = priced.get(token);
        return { token, priceUsd: p ? p.price : 0, confidence: p?.confidence ?? null, source: p ? "defillama" : "none" };
      });

      // 4. Bounded aggregator→WETH backfill for PRIORITY tokens DefiLlama missed (dust/new tokens).
      const wethUsd = priced.get(this.weth)?.price ?? (await this.db.getTokenPrices(chainId, [this.weth]).then((m) => m.get(this.weth)?.priceUsd ?? null).catch(() => null));
      if (wethUsd && wethUsd > 0) {
        let budget = this.config.DISPLAY_BACKFILL_MAX;
        for (const token of priority) {
          if (budget <= 0) break;
          if (priced.has(token) || token === this.weth) continue;
          const px = await this.aggPrice(chainId, token, wethUsd);
          if (px != null) { const row = rows.find((r) => r.token === token); if (row) { row.priceUsd = px; row.confidence = 0.5; row.source = "aggregator"; } budget -= 1; }
        }
      }

      // Same write updates the EWMA volatility from the price move — no extra call (measured, dynamic).
      await this.db.upsertTokenPrices(chainId, rows, { tauFastSec: this.config.VOL_TAU_FAST_SEC, tauSlowSec: this.config.VOL_TAU_SLOW_SEC });
      this.logger.info({ batch: rows.length, priced: rows.filter((r) => r.priceUsd != null).length, priority: priority.size }, "display prices refreshed");
    } finally {
      this.running = false;
    }
  }

  /** One DefiLlama batch request → token(lowercase) → {price, confidence}. Keyless, cheap. */
  private async llamaBatch(tokens: string[]): Promise<Map<string, { price: number; confidence: number }>> {
    const out = new Map<string, { price: number; confidence: number }>();
    const ids = tokens.map((t) => `${this.config.LLAMA_CHAIN}:${t}`).join(",");
    try {
      const r = await fetch(`${this.config.PRICE_API_URL}/prices/current/${ids}`, { headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(12_000) });
      if (!r.ok) return out;
      const j = await r.json() as { coins?: Record<string, { price?: number; confidence?: number }> };
      for (const [key, v] of Object.entries(j.coins ?? {})) {
        const token = key.split(":")[1]?.toLowerCase();
        if (token && typeof v.price === "number") out.set(token, { price: v.price, confidence: v.confidence ?? 0 });
      }
    } catch (error) { this.logger.debug({ err: error instanceof Error ? error.message : String(error) }, "defillama batch failed"); }
    return out;
  }

  /** Bounded display backfill: price token→WETH at ~1 token (decimals from the registry) × WETH-USD.
   * Display-only; execution never uses this. null if unroutable (token then shows balance, no $). */
  private async aggPrice(chainId: number, token: string, wethUsd: number): Promise<number | null> {
    const ent = await this.db.getEntity(chainId, token).catch(() => []);
    const dec = ent[0]?.decimals;
    if (dec == null || !Number.isFinite(dec)) return null; // no decimals → can't size a quote (no guess)
    const q = await this.aggregator.quote(token as `0x${string}`, this.weth as `0x${string}`, 10n ** BigInt(dec)).catch(() => null);
    if (!q || q.amountOut <= 0n) return null;
    return (Number(q.amountOut) / 1e18) * wethUsd; // WETH out per 1 token × WETH-USD
  }
}
