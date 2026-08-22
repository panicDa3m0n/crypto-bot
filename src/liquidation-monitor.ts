import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { Primitives } from "./primitives.js";
import type { Aggregator } from "./aggregator.js";

/**
 * LiquidationMonitor — the fast lane. It watches EVERY actionable position (no cap) by computing HF
 * ON-CHAIN each tick, with no third-party API: for each market it reads the Morpho oracle price once
 * (a multicall) and compares it to each position's precomputed LIQUIDATION PRICE — the oracle price
 * at which HF=1: `liq_price = borrowAssets·1e54 / (collateral·lltv)` (Morpho: healthy ⇔ price ≥ this).
 * The instant a position's oracle price crosses below its liq_price it is liquidatable, and we build
 * the flash-liquidation FRESH right then (re-fetch-at-fire: current seized amount + fresh swap route),
 * simulate, and fire — so the tx is correct and doesn't revert on a stale route. This replaces the
 * pre-armed-15 model (which capped us because it pre-built expensive, staleness-prone calldata).
 */
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);
const MORPHO_ABI = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)"
]);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const LIQUIDATION_CURSOR = 0.3;
const Q = 10n ** 54n;
const HEARTBEAT_MS = 60_000; // throttle for the "alive + nearest-to-cross" observability line

export class LiquidationMonitor {
  private timer?: NodeJS.Timeout;
  private unwatch?: () => void;
  private running = false;
  private lastHeartbeat = 0;
  private readonly firedAt = new Map<string, number>(); // borrower:market → last fire ts (cooldown)

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly primitives: Primitives,
    private readonly aggregator: Aggregator,
    private readonly logger: Logger,
    private readonly wake: (key: string, reason: string) => void
  ) {}

  start(): void {
    if (!this.config.LIQ_MONITOR_ENABLED) { this.logger.info("liquidation monitor disabled"); return; }
    // PRIMARY trigger: run the HF check on EACH new block (heads WS, ~2s on Base) — the lowest-latency
    // detection. FALLBACK heartbeat (also covers a dropped WS) at the poll interval. The `running`
    // guard makes overlapping triggers a no-op, so it simply runs as fast as one tick completes.
    this.unwatch = this.chain.watchHeads(
      () => void this.tick("block").catch((e) => this.logger.error({ err: e }, "liquidation monitor tick failed")),
      (err) => this.logger.warn({ err: err.message }, "liquidation monitor heads WS error")
    );
    this.timer = setInterval(() => void this.tick("poll").catch((e) => this.logger.error({ err: e }, "liquidation monitor tick failed")), this.config.LIQ_MONITOR_INTERVAL_MS);
    this.logger.info({ headsWs: Boolean(this.unwatch), pollMs: this.config.LIQ_MONITOR_INTERVAL_MS }, "liquidation monitor started (per-block HF check)");
  }
  stop(): void { if (this.timer) clearInterval(this.timer); if (this.unwatch) this.unwatch(); }

  private async tick(trigger: "block" | "poll" = "poll"): Promise<void> {
    if (this.running) return;
    this.running = true;
    const t0 = Date.now();
    try {
      const organ = (await this.db.getOrgan("atomic-executor").catch(() => undefined))?.address as Address | undefined;
      if (!organ) return; // no organ → no capital-free fire path
      // ALL actionable positions — watch + profitable (near-threshold, profit-verified). No cap.
      const rows = [
        ...await this.db.listLendingPositions(this.config.CHAIN_ID, { tier: "watch", limit: 300 }).catch(() => []),
        ...await this.db.listLendingPositions(this.config.CHAIN_ID, { tier: "profitable", limit: 300 }).catch(() => [])
      ];
      type Watched = { key: string; borrower: string; marketId: string; oracle: string; liqPrice: bigint; collateral: string; loan: string; loanToken: string; collateralToken: string; irm: string; lltvRaw: string; collateralUsd: number; debtUsd: number; profitUsd: number | null };
      const watched: Watched[] = [];
      for (const r of rows) {
        const m = (r.meta ?? {}) as Record<string, unknown>;
        const oracle = String(m.oracle ?? "").toLowerCase();
        const collateralRaw = BigInt(String(m.collateralRaw ?? "0"));
        const debtRaw = BigInt(String(m.debtRaw ?? "0"));
        const lltvRaw = BigInt(String(m.lltv ?? "0"));
        if (!oracle || oracle === "0x" || collateralRaw <= 0n || debtRaw <= 0n || lltvRaw <= 0n || !r.loanToken || !r.collateralToken) continue;
        const liqPrice = (debtRaw * Q) / (collateralRaw * lltvRaw); // oracle price (1e36) at HF=1
        watched.push({ key: `${r.borrower.toLowerCase()}:${r.marketId.toLowerCase()}`, borrower: r.borrower, marketId: r.marketId, oracle, liqPrice, collateral: r.collateralSymbol ?? "?", loan: r.loanSymbol ?? "?", loanToken: r.loanToken, collateralToken: r.collateralToken, irm: String(m.irm ?? "0x0000000000000000000000000000000000000000"), lltvRaw: String(m.lltv ?? "0"), collateralUsd: r.collateralUsd ?? 0, debtUsd: r.debtUsd ?? 0, profitUsd: r.profitUsd });
      }
      if (!watched.length) return;

      // One oracle read per DISTINCT oracle (positions in a market share it) — multicall, precision lane.
      const oracles = [...new Set(watched.map((w) => w.oracle))];
      // NEVER swallow this. Without oracle prices the monitor cannot compute a single health factor, so it
      // watches everything and fires at nothing — and it did exactly that for hours, reporting
      // `nearestHf: null` in a heartbeat that otherwise looked healthy while a profitable liquidation was
      // taken by someone else. A component that cannot do its job must say so, not log an INFO line.
      const prices = await this.chain.precisionRead((c) => c.multicall({ contracts: oracles.map((o) => ({ address: o as Address, abi: ORACLE_ABI, functionName: "price" as const })), allowFailure: true, multicallAddress: MULTICALL3 }), "morpho-oracle-prices")
        .catch((err) => { this.logger.error({ err, oracles: oracles.length }, "liquidation monitor: ORACLE PRICE READ FAILED — cannot evaluate any position this tick"); return [] as Array<{ status: string; result?: unknown }>; });
      const priceByOracle = new Map<string, bigint>();
      oracles.forEach((o, i) => { const r = prices[i]; if (r?.status === "success" && typeof r.result === "bigint") priceByOracle.set(o, r.result); });
      // BLINDNESS IS AN ALARM, not a statistic. Watching N positions while able to price none of them is
      // indistinguishable, in the heartbeat, from watching N positions that are all far from liquidation.
      if (watched.length && !priceByOracle.size) {
        this.logger.error({ watched: watched.length, oracles: oracles.length, sample: oracles.slice(0, 3) },
          "liquidation monitor is BLIND — zero of its oracles returned a price; no liquidation can be detected");
      }

      // FRESH SIZE for the NEAR ones: the liq_price above uses 180s-old collateral/debt. For positions
      // whose live price sits within LIQ_NEAR_MARGIN of that stale liq_price (about to cross), re-read
      // collateral+debt on-chain (position()+market(), one bounded multicall) and recompute liq_price —
      // so a size change (borrow/withdraw between enumerates) can't hide a real cross. Far ones: 180s is fine.
      const marginNum = BigInt(Math.round((1 + this.config.LIQ_NEAR_MARGIN) * 1_000_000));
      const near = watched.filter((w) => { const p = priceByOracle.get(w.oracle); return p != null && p * 1_000_000n <= w.liqPrice * marginNum; });
      if (near.length && this.config.MORPHO_CORE) {
        const morpho = this.config.MORPHO_CORE as Address;
        const nearMarkets = [...new Set(near.map((w) => w.marketId.toLowerCase()))];
        const contracts = [
          ...near.map((w) => ({ address: morpho, abi: MORPHO_ABI, functionName: "position" as const, args: [w.marketId as `0x${string}`, w.borrower as Address] })),
          ...nearMarkets.map((mid) => ({ address: morpho, abi: MORPHO_ABI, functionName: "market" as const, args: [mid as `0x${string}`] }))
        ];
        const res = await this.chain.precisionRead((c) => c.multicall({ contracts, allowFailure: true, multicallAddress: MULTICALL3 }), "morpho-near-size").catch(() => [] as Array<{ status: string; result?: unknown }>);
        const totals = new Map<string, { tba: bigint; tbs: bigint }>();
        nearMarkets.forEach((mid, i) => { const r = res[near.length + i]; if (r?.status === "success" && Array.isArray(r.result)) totals.set(mid, { tba: (r.result as bigint[])[2], tbs: (r.result as bigint[])[3] }); });
        near.forEach((w, i) => {
          const r = res[i]; const mt = totals.get(w.marketId.toLowerCase());
          if (r?.status !== "success" || !Array.isArray(r.result) || !mt) return; // read failed → keep the stale liq_price
          const borrowShares = (r.result as bigint[])[1]; const collateral = (r.result as bigint[])[2];
          const borrowAssets = mt.tbs === 0n || borrowShares === 0n ? 0n : (borrowShares * mt.tba + mt.tbs - 1n) / mt.tbs;
          w.liqPrice = collateral > 0n && borrowAssets > 0n ? (borrowAssets * Q) / (collateral * BigInt(w.lltvRaw)) : 0n; // fresh; 0 = empty → never crosses
        });
      }

      // Crossed = oracle price ≤ liq_price (HF ≤ 1). Fire the most profitable first, bounded per tick.
      const now = Date.now();
      const crossed = watched
        .filter((w) => { const p = priceByOracle.get(w.oracle); return p != null && p <= w.liqPrice && (now - (this.firedAt.get(w.key) ?? 0) > 60_000); })
        .sort((a, b) => (b.profitUsd ?? b.debtUsd) - (a.profitUsd ?? a.debtUsd));

      // HEARTBEAT (throttled): the fast lane is otherwise silent unless something crosses. During data
      // collection we want to SEE it's alive, how many it watches, how NEAR the closest is to the cross
      // (HF ≈ oracle_price / liq_price), how many are in the fresh-size band, oracle-read gaps, latency.
      if (now - this.lastHeartbeat > HEARTBEAT_MS) {
        this.lastHeartbeat = now;
        let nearestHf = Infinity, nearest = "";
        for (const w of watched) { const pr = priceByOracle.get(w.oracle); if (pr != null && w.liqPrice > 0n) { const r = Number(pr) / Number(w.liqPrice); if (r < nearestHf) { nearestHf = r; nearest = `${w.collateral}/${w.loan} ${w.borrower.slice(0, 8)}`; } } }
        this.logger.info({ watched: watched.length, near: near.length, crossed: crossed.length, nearestHf: Number.isFinite(nearestHf) ? Number(nearestHf.toFixed(4)) : null, nearest, oraclesMissing: oracles.length - priceByOracle.size, detectMs: Date.now() - t0, trigger }, "liquidation monitor heartbeat");
      }
      if (!crossed.length) return;
      // detectMs = time from tick start to cross detected (read+compute). trigger = block|poll.
      this.logger.warn({ crossed: crossed.length, watched: watched.length, trigger, detectMs: Date.now() - t0 }, "positions crossed HF<1 on-chain — firing fresh");

      let fires = 0;
      for (const w of crossed) {
        if (fires >= this.config.LIQ_MONITOR_MAX_FIRES) break;
        fires += 1;
        // NOTE: the 60s cooldown (firedAt) is set INSIDE buildAndFire, only when we actually BROADCAST a
        // tx — NOT here. A sim-revert (block skew made us a hair early, or route moved) is not a fire:
        // we must retry it on the very NEXT block and catch the cross precisely when Morpho agrees, not
        // lock ourselves out for 60s while competitors take a genuine, still-liquidatable position.
        await this.buildAndFire(w, organ, trigger, t0);
      }
    } finally {
      this.running = false;
    }
  }

  /** RE-FETCH-AT-FIRE: build the flash-liquidation fresh for the CURRENT position + swap route, then
   * simulate and (if it passes) fire. Records the outcome for observability (hit / armed_fail). */
  private async buildAndFire(w: { key: string; borrower: string; marketId: string; oracle: string; collateral: string; loan: string; loanToken: string; collateralToken: string; irm: string; lltvRaw: string; collateralUsd: number; debtUsd: number; profitUsd: number | null }, organ: Address, trigger: "block" | "poll", t0: number): Promise<void> {
    // Timing (ms): every step of the fire path is logged so we can SEE where latency goes and whether
    // a lost prey was a latency race. detectMs already spent = tick-start → here; the rest we measure.
    const T = { detect: Date.now() - t0, read: 0, swap: 0, sim: 0, send: 0, total: 0 };
    const recordFail = (reason: string) => { T.total = Date.now() - t0; this.logger.warn({ borrower: w.borrower.slice(0, 10), collateral: w.collateral, loan: w.loan, trigger, timing: T, reason: reason.slice(0, 100) }, "liquidation fire aborted"); return this.db.recordLiquidationEvent({ chainId: this.config.CHAIN_ID, kind: "armed_fail", protocol: "morpho", marketId: w.marketId, borrower: w.borrower, collateralSymbol: w.collateral, loanSymbol: w.loan, debtUsd: w.debtUsd, profitUsd: w.profitUsd, note: `fire aborted: ${reason.slice(0, 140)}`, meta: { trigger, timing: T } }).catch(() => undefined); };
    try {
      let ts = Date.now();
      const { borrowAssets, collateral } = await this.primitives.readMorphoPosition(w.marketId as `0x${string}`, w.borrower as Address);
      T.read = Date.now() - ts;
      if (borrowAssets <= 0n || collateral <= 0n || w.collateralUsd <= 0) {
        await this.db.closeLendingPosition(this.config.CHAIN_ID, "morpho", w.marketId, w.borrower, "empty on-chain (already liquidated/closed)").catch(() => undefined);
        await recordFail("empty position — retired");
        return;
      }
      const lltv = Number(BigInt(w.lltvRaw)) / 1e18;
      const lif = 1 / (1 - LIQUIDATION_CURSOR * (1 - lltv));
      const seizeFraction = Math.min(0.98, Math.min(1, w.debtUsd / w.collateralUsd) * lif) * 0.95;
      const seizedAssets = collateral * BigInt(Math.max(1, Math.floor(seizeFraction * 1_000_000))) / 1_000_000n;
      if (seizedAssets <= 0n) { await recordFail("zero seize"); return; }
      ts = Date.now();
      let agg: Awaited<ReturnType<typeof this.aggregator.swapCalldata>> = null;
      for (let a = 0; a < 3 && !agg; a++) { agg = await this.aggregator.swapCalldata(w.collateralToken as Address, w.loanToken as Address, seizedAssets, organ).catch(() => null); if (!agg && a < 2) await new Promise((r) => setTimeout(r, 300)); }
      T.swap = Date.now() - ts;
      if (!agg) { await recordFail("no swap route at fire"); return; }
      // PROFIT-AWARE PRIORITY FEE + ON-CHAIN GAS FLOOR (the safety net). Computed BEFORE the intent so
      // the sim itself enforces it. nativeUsd (ETH) is read from the DB portfolio (no live call). We bid
      // an EIP-1559 priority fee scaled to the profit at stake (to win a contested inclusion), and set
      // minProfitWei = the MAX gas+priority cost in loan-token units — so the on-chain require reverts
      // rather than let the liquidation land net-negative if the real profit no longer covers our bid.
      const nativeUsd = (await this.db.latestPortfolio().catch(() => undefined))?.beraUsd ?? 0;
      const gasUnits = BigInt(this.config.LIQ_GAS_UNITS);
      const fee = await this.priorityFee(w.profitUsd, nativeUsd, gasUnits);
      const maxGasCostUsd = nativeUsd > 0 ? (Number(gasUnits * fee.maxFeePerGas) / 1e18) * nativeUsd : 0;
      const minProfitWei = await this.loanFloor(w.loanToken, borrowAssets, maxGasCostUsd);
      const intent = { organ, loanToken: w.loanToken as Address, collateralToken: w.collateralToken as Address, oracle: w.oracle as Address, irm: w.irm as Address, lltv: w.lltvRaw, borrower: w.borrower as Address, seizedAssets, flashAmount: borrowAssets * 105n / 100n, swapFeeBps: 0, minProfitWei, swap: { router: agg.router, calldata: agg.calldata } };
      const { target, signature, args } = this.primitives.buildFlashLiquidation(intent);
      ts = Date.now();
      const sim = await this.primitives.callContract(target, signature, args, 0n, false).catch((e) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
      T.sim = Date.now() - ts;
      if (!(sim.ok && "mode" in sim && sim.mode === "simulated")) { await recordFail(`sim revert: ${"reason" in sim ? sim.reason : "healthy/unprofitable/below-gas-floor"}`); return; }
      this.logger.warn({ borrower: w.borrower.slice(0, 10), collateral: w.collateral, loan: w.loan, trigger, detectMs: T.detect, readMs: T.read, swapMs: T.swap, simMs: T.sim, priorityGwei: Number(fee.maxPriorityFeePerGas) / 1e9, minProfitWei: minProfitWei.toString(), msSinceCross: Date.now() - t0 }, "liquidation sim PASSED — firing");
      // Cooldown is set HERE — the commit point. The sim passed, we are broadcasting: block re-sends for
      // 60s (avoid double-spend / gas waste while the tx settles). A revert BEFORE this line never gets
      // a cooldown, so it is retried next block. This is the precision boundary.
      this.firedAt.set(w.key, Date.now());
      ts = Date.now();
      const exec = await this.primitives.callContract(target, signature, args, 0n, true, fee).catch((e) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
      T.send = Date.now() - ts; T.total = Date.now() - t0;
      if (exec.ok && "mode" in exec && exec.mode === "executed") {
        this.logger.warn({ borrower: w.borrower.slice(0, 10), collateral: w.collateral, loan: w.loan, trigger, timing: T, txHash: "txHash" in exec ? exec.txHash : undefined }, "LIQUIDATION FIRED — timing (ms)");
        await this.db.recordLiquidationEvent({ chainId: this.config.CHAIN_ID, kind: "hit", protocol: "morpho", marketId: w.marketId, borrower: w.borrower, collateralSymbol: w.collateral, loanSymbol: w.loan, debtUsd: w.debtUsd, profitUsd: w.profitUsd, txHash: "txHash" in exec ? exec.txHash : undefined, liquidator: this.config.WALLET_ADDRESS, note: "liquidated by us (on-chain monitor)", meta: { trigger, timing: T } }).catch(() => undefined);
        await this.db.addJournal("action", `LIQUIDAZIONE ESEGUITA: ${w.collateral}/${w.loan} (${w.borrower.slice(0, 10)}) — tx ${"txHash" in exec ? exec.txHash : "?"} — ${T.total}ms dal cross`, { borrower: w.borrower, marketId: w.marketId, timing: T }, "liquidation").catch(() => undefined);
        this.wake("liquidation-fired", `Liquidazione ${w.collateral}/${w.loan} ESEGUITA (tx ${"txHash" in exec ? exec.txHash : "?"}, ${T.total}ms dal cross). Verifica collaterale + profitto.`);
      } else {
        await recordFail(`execute reverted: ${"reason" in exec ? exec.reason : "unknown"}`);
      }
    } catch (error) {
      await recordFail(error instanceof Error ? error.message : String(error));
    }
  }

  /** Priority fee (EIP-1559) MEASURED from the profit at stake — the lever that wins a contested
   * liquidation. Budget = fraction·profit (in native wei via nativeUsd), spread over the gas units,
   * clamped to [min,max] gwei. If profit/native are unknown we bid the floor (never overbid blindly).
   * maxFeePerGas = 2·baseFee + priority so a base-fee spike next block can't drop us. */
  private async priorityFee(profitUsd: number | null, nativeUsd: number, gasUnits: bigint): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const minP = BigInt(Math.floor(this.config.LIQ_PRIORITY_FEE_MIN_GWEI * 1e9));
    const maxP = BigInt(Math.floor(this.config.LIQ_PRIORITY_FEE_MAX_GWEI * 1e9));
    let priority = minP;
    if (profitUsd && profitUsd > 0 && nativeUsd > 0 && gasUnits > 0n) {
      const budgetWei = BigInt(Math.floor(((profitUsd * this.config.LIQ_PRIORITY_PROFIT_FRACTION) / nativeUsd) * 1e18));
      const perGas = budgetWei / gasUnits;
      priority = perGas < minP ? minP : perGas > maxP ? maxP : perGas;
    }
    const base = await this.chain.baseFee().catch(() => 0n);
    return { maxFeePerGas: base * 2n + priority, maxPriorityFeePerGas: priority };
  }

  /** On-chain profit floor (loan-token raw units) = the max gas+priority cost we might pay, so the
   * organ's require(minProfit) reverts rather than let the tx land net-negative if the real profit no
   * longer covers our bid. Priced from the DB display cache. Unknown price/decimals → 0 (sim still needs
   * profit>0). Sanity-capped at 5% of debt: gas is a rounding error vs the debt, so a floor bigger than
   * that means the loan price is wrong — drop it rather than silently block a genuine liquidation. */
  private async loanFloor(loanToken: string, borrowAssets: bigint, gasCostUsd: number): Promise<bigint> {
    if (!(gasCostUsd > 0)) return 0n;
    const key = loanToken.toLowerCase();
    const prices = await this.db.getTokenPrices(this.config.CHAIN_ID, [loanToken]).catch(() => null);
    const meta = await this.db.tokenMeta(this.config.CHAIN_ID, [loanToken]).catch(() => null);
    const price = prices?.get(key)?.priceUsd ?? null;
    const decimals = meta?.get(key)?.decimals ?? null;
    if (!(price != null && price > 0) || decimals == null) return 0n;
    const floor = BigInt(Math.ceil(((gasCostUsd * 1.1) / price) * 10 ** decimals)); // profit must clear 1.1× gas
    return floor > borrowAssets / 20n ? 0n : floor;
  }
}
