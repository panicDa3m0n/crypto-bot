import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { MonadSignals, AtRiskPosition } from "./monad-signals.js";
import type { Primitives } from "./primitives.js";
import type { Aggregator } from "./aggregator.js";

/**
 * The safety net over the liquidation surface. Every reconcile it looks at the
 * verified-liquid prey (positions whose seized collateral has a PROVEN on-chain exit
 * route) that sit on the edge or already liquidatable, and — capital-free via the
 * atomic organ — auto-arms a flash-liquidation watcher on each one it isn't already
 * watching. The watcher then fires the instant the position crosses hf<1 (AutoflashService,
 * ~4s). So an edge position can no longer slip through between Scarlet's cycles.
 *
 * Every armed tx is self-verifying: the organ's flashExecute reverts unless it ends
 * with >= flashAmount + minProfit, so a mis-sized or unprofitable arm simply never
 * fires (costs only gas) and can never lose the flash principal.
 */
const FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const POOL_ABI = parseAbi(["function liquidity() view returns (uint128)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const AUTO_PREFIX = "auto";
const LIQUIDATION_CURSOR = 0.3; // Morpho Blue constant used to derive the incentive factor

export class AutoArmReconciler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly signals: MonadSignals,
    private readonly primitives: Primitives,
    private readonly aggregator: Aggregator,
    private readonly logger: Logger
  ) {}

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick().catch((error) => this.logger.error({ err: error }, "auto-arm reconcile failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const organRow = await this.db.getOrgan("atomic-executor").catch(() => undefined);
      if (!organRow) return; // no organ → no capital-free path to auto-arm
      const organ = organRow.address as Address;
      const feed = await this.signals.fetch().catch(() => undefined);
      // Candidates = the feed's verified-liquid edge prey PLUS the complete position registry's
      // watch tier (the near-threshold, profit-verified positions). Deduped by borrower+market.
      const seen = new Set<string>();
      const prey = [...(feed?.liquidatableNow ?? []), ...(feed?.onTheEdge ?? []), ...(await this.registryPrey())]
        .filter((p) => p.collateralClass === "liquid" && p.debtUsd >= this.config.AUTOARM_MIN_DEBT_USD)
        .filter((p) => { const k = `${p.user.toLowerCase()}:${p.marketId}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => (b.evScore ?? (2 - b.healthFactor)) - (a.evScore ?? (2 - a.healthFactor))) // EV desc (feed prey w/o EV fall back to HF-proximity)
        .slice(0, this.config.AUTOARM_MAX_WATCHERS);
      this.logger.info({ prey: prey.length, feedEdge: feed?.onTheEdge?.length ?? 0, organ: organ.slice(0, 10) }, "auto-arm candidates");
      if (!prey.length) return;

      const active = await this.db.listAutoflash(["armed"]).catch(() => []);
      const armedKeys = new Set(active.map((w) => `${(w.borrower ?? "").toLowerCase()}:${w.marketId ?? ""}`));
      // EV REPLACEMENT: the armed set must always be the TOP prey by EV. Retire auto-watchers that fell
      // OUT of the current top-EV prey set so their slots free for higher-EV prey. Without this, 15
      // small-profit slots armed early blocked the big-profit positions from ever being armed (budget=0).
      const preyKeys = new Set(prey.map((p) => `${p.user.toLowerCase()}:${p.marketId}`));
      let autoArmedCount = 0;
      for (const w of active) {
        if (!(w.label ?? "").startsWith(`${AUTO_PREFIX}:`)) continue;
        const wkey = `${(w.borrower ?? "").toLowerCase()}:${w.marketId ?? ""}`;
        if (preyKeys.has(wkey)) { autoArmedCount += 1; continue; } // still top-EV → keep
        await this.db.cancelAutoflash(w.id, "dropped out of top-EV set (replaced by higher-EV prey)").catch(() => undefined);
        armedKeys.delete(wkey);
      }
      let budget = Math.max(0, this.config.AUTOARM_MAX_WATCHERS - autoArmedCount);

      for (const p of prey) {
        if (budget <= 0) break;
        const key = `${p.user.toLowerCase()}:${p.marketId}`;
        if (armedKeys.has(key)) continue; // already watching this borrower+market

        const intent = await this.buildIntent(organ, p).catch((error) => { this.logger.warn({ err: error instanceof Error ? error.message : String(error), borrower: p.user, market: p.marketId }, "auto-arm intent build failed"); return undefined; });
        if (!intent) { this.logger.debug({ borrower: p.user, collateral: p.collateral, loan: p.loan, hf: p.healthFactor }, "auto-arm no intent (no exit / zero position)"); continue; }
        const { target, signature, args } = this.primitives.buildFlashLiquidation(intent);
        // Validate the encoding is well-formed (build stage). It is EXPECTED to revert
        // while the position is still healthy — we arm regardless; the watcher fires on cross.
        const sim = await this.primitives.callContract(target, signature, args, 0n, false).catch(() => undefined);
        const firableNow = Boolean(sim && sim.ok && sim.mode === "simulated");
        const label = `${AUTO_PREFIX}:${p.collateral}/${p.loan} ${p.user.slice(0, 8)}`;
        const id = await this.db.armAutoflash({ label, marketId: p.marketId, borrower: p.user, target, signature, args, note: `auto-armed flash-liquidation (verified-liquid ${p.collateral}); hf ${p.healthFactor}, debt $${p.debtUsd.toFixed(2)}`, cycle: "autoarm" }).catch(() => undefined);
        if (id === undefined) continue;
        budget -= 1;
        armedKeys.add(key);
        await this.db.addJournal("action", `AUTO-ARM #${id}: watcher flash-liquidation su ${p.collateral}/${p.loan} (${p.user.slice(0, 10)}), hf ${p.healthFactor}, debito $${p.debtUsd.toFixed(2)}${firableNow ? " — LIQUIDABILE ORA, scatta a breve" : " — in ascolto, scatta appena hf<1"}.`, { autoflash: id, borrower: p.user, marketId: p.marketId }, "autoarm").catch(() => undefined);
        await this.db.recordLiquidationEvent({ chainId: this.config.CHAIN_ID, kind: "found", protocol: "morpho", marketId: p.marketId, borrower: p.user, collateralSymbol: p.collateral, loanSymbol: p.loan, debtUsd: p.debtUsd, note: `armed (hf ${p.healthFactor.toFixed(3)}, EV ${(p.evScore ?? 0).toFixed(1)})`, meta: { hf: p.healthFactor, evScore: p.evScore } }).catch(() => undefined);
        this.logger.warn({ autoflash: id, borrower: p.user, collateral: p.collateral, hf: p.healthFactor, firableNow }, "auto-armed flash-liquidation watcher");
      }
    } finally {
      this.running = false;
    }
  }

  /** WATCH-tier candidates, selected by a VOLATILITY-SCALED proximity band and ranked by EV.
   * imminence = σ(T)/distance-to-cross, where σ is MEASURED (EWMA vol; high prior for unknown tokens)
   * and distance = HF−1. A stable at HF 1.10 (tiny σ) is far → dropped; a volatile at HF 1.10 (big σ)
   * could cross → kept. EV = profit × imminence. No hardwiring — the vol comes from real price moves. */
  private async registryPrey(): Promise<AtRiskPosition[]> {
    const rows = await this.db.listLendingPositions(this.config.CHAIN_ID, { tier: "watch", limit: 120 }).catch(() => []);
    const eligible = rows.filter((r) => r.protocol === "morpho" && r.collateralToken && r.loanToken && (r.meta as Record<string, unknown>)?.oracle && (r.meta as Record<string, unknown>)?.lltv && (r.debtUsd ?? 0) >= this.config.AUTOARM_MIN_DEBT_USD);
    const vols = await this.db.tokenVolatility(this.config.CHAIN_ID, eligible.map((r) => r.collateralToken!)).catch(() => new Map<string, number | null>());
    const T = this.config.AUTOARM_HORIZON_SEC;
    const out: AtRiskPosition[] = [];
    for (const r of eligible) {
      const m = r.meta as Record<string, unknown>;
      const hf = r.hf ?? 1;
      const distance = Math.max(hf - 1, 0.0005);                 // price drop fraction to reach HF=1
      const varRate = vols.get(r.collateralToken!.toLowerCase());
      const sigma = varRate != null ? Math.sqrt(varRate * T) : this.config.AUTOARM_PRIOR_VOL; // measured σ(T), else high prior
      const imminence = Math.min(sigma / distance, 8);           // how many σ fit in the distance (bounded)
      if (imminence < this.config.AUTOARM_MIN_IMMINENCE && hf > 1.02) continue; // vol-scaled band (always keep hf≤1.02)
      const profit = r.profitUsd != null && r.profitUsd > 0 ? r.profitUsd : (r.debtUsd ?? 0) * 0.005; // unknown-USD profit → small proxy
      const evScore = profit * (0.2 + imminence);
      out.push({
        healthFactor: hf, dropToLiqPct: distance * 100, collateral: r.collateralSymbol ?? "?", loan: r.loanSymbol ?? "?",
        collateralClass: "liquid", quality: "primary", routeVerified: true, evScore,
        debtUsd: r.debtUsd ?? 0, collateralUsd: r.collateralUsd ?? 0, user: r.borrower, marketId: r.marketId,
        marketParams: { loanToken: r.loanToken!, collateralToken: r.collateralToken!, oracle: String(m.oracle), irm: String(m.irm ?? ZERO), lltv: String(m.lltv) }
      });
    }
    return out.sort((a, b) => (b.evScore ?? 0) - (a.evScore ?? 0));
  }

  /** Sizes a conservative full-debt liquidation from live on-chain state + the indexed
   * USD values. Under-seizes on purpose (0.95 margin) so the swap never tries to sell
   * more collateral than Morpho actually releases; over-provisions the 0-fee flash loan. */
  private async buildIntent(organ: Address, p: import("./monad-signals.js").AtRiskPosition): Promise<import("./primitives.js").FlashLiquidationIntent | undefined> {
    const mp = p.marketParams;
    const { borrowAssets, collateral } = await this.primitives.readMorphoPosition(p.marketId as `0x${string}`, p.user as Address);
    if (borrowAssets <= 0n || collateral <= 0n || p.collateralUsd <= 0) return undefined;
    const lltv = Number(BigInt(mp.lltv)) / 1e18;                       // e.g. 0.86
    const lif = 1 / (1 - LIQUIDATION_CURSOR * (1 - lltv));             // Morpho liquidation incentive factor
    const currentLtv = Math.min(1, p.debtUsd / p.collateralUsd);       // debt value / collateral value
    const seizeFraction = Math.min(0.98, currentLtv * lif) * 0.95;     // fraction of collateral to seize, conservatively
    const seizedAssets = collateral * BigInt(Math.max(1, Math.floor(seizeFraction * 1_000_000))) / 1_000_000n;
    if (seizedAssets <= 0n) return undefined;
    // Exit swap: the AGGREGATOR (all venues, exact seized amount) first — this is what lets us exit
    // collateral with no V3 pool. RETRY it: a transient KyberSwap rate-limit during the prey burst
    // must NOT silently drop a high-EV position (that biased arming toward small, buildable positions
    // and missed the big-profit ones — the full fix is re-fetch-at-fire). Fall back to a V3 pool only
    // if the aggregator genuinely can't route.
    let agg: Awaited<ReturnType<typeof this.aggregator.swapCalldata>> = null;
    for (let attempt = 0; attempt < 3 && !agg; attempt++) {
      agg = await this.aggregator.swapCalldata(mp.collateralToken as Address, mp.loanToken as Address, seizedAssets, organ).catch(() => null);
      if (!agg && attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    let swap: { router: Address; calldata: `0x${string}` } | undefined; let swapFeeBps = 0;
    if (agg) swap = { router: agg.router, calldata: agg.calldata };
    else { const fee = await this.bestSwapFee(mp.collateralToken as Address, mp.loanToken as Address); if (fee === undefined) return undefined; swapFeeBps = fee; }
    return {
      organ, loanToken: mp.loanToken as Address, collateralToken: mp.collateralToken as Address, oracle: mp.oracle as Address, irm: mp.irm as Address, lltv: mp.lltv, borrower: p.user as Address,
      seizedAssets, flashAmount: borrowAssets * 105n / 100n, swapFeeBps, minProfitWei: 0n, swap
    };
  }

  /** Deepest V3 fee tier for the collateral→loan exit swap (by in-range liquidity). */
  private async bestSwapFee(collateral: Address, loan: Address): Promise<number | undefined> {
    let bestFee: number | undefined; let bestLiq = 0n;
    // Use the SECONDARY RPC — the primary is saturated by the read-heavy sensors; the liquidation
    // arming path is few-but-critical reads and must not starve on shared-RPC rate limits.
    const rpc = this.chain.secondary;
    for (const fee of [100, 500, 2500, 3000, 10000]) {
      const pool = await rpc.readContract({ address: this.config.DEX_FACTORY as Address, abi: FACTORY_ABI, functionName: "getPool", args: [collateral, loan, fee] }).catch(() => ZERO) as Address;
      if (!pool || pool.toLowerCase() === ZERO) continue;
      const liq = await rpc.readContract({ address: pool, abi: POOL_ABI, functionName: "liquidity" }).catch(() => 0n) as bigint;
      if (liq > bestLiq) { bestLiq = liq; bestFee = fee; }
    }
    return bestFee;
  }
}
