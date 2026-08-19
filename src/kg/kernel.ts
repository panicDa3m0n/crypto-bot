import type { PoolState } from "../router/types.js";
import { getTickAtSqrtRatio } from "../router/tick-math.js";
import { PoolSim, V2PoolSim, V3PoolSim, StablePoolSim, VenueSnapshot, PortfolioState, type StateVersion, type SimulationState, type AssetId, type SwapTrace } from "./state.js";
import { SwapOp, FlashBorrowOp, FlashRepayOp, LiquidateOp, type Transformation } from "./operators.js";
import type { KGCycle } from "./cycle-finder.js";
import { LendingSnapshot, BorrowerPositionSim, LendingMarketSim, computeLiquidation, seizeForFullRepay } from "./lending.js";

/**
 * SIMULATION KERNEL — the deterministic driver over the stateful model. Runs a plan (a list of
 * Transformations) against a forked snapshot and reports REALIZED closed-loop PnL in a chosen numéraire,
 * plus a sizing optimizer that turns a step-1 candidate cycle (a mere topology hint) into an executable
 * decision: the size that maximises realized net profit, computed with true compounding price impact.
 */

// ── PoolState → mutable PoolSim ──────────────────────────────────────────────
const CP_ARCH = new Set(["v2", "aerodrome"]);

/** Build a mutable simulator for a mirrored pool. `ticks` (from db.tickLiquidity) makes V3 exact across
 * tick boundaries; without them a V3 pool is single-tick (only safe for small sizes). Returns null if the
 * pool's state is missing. */
export function buildPoolSim(p: PoolState, ticks?: Array<{ tick: number; liquidityNet: bigint }>): PoolSim | null {
  const fee = p.feePpm > 0 ? p.feePpm : 0;
  if (CP_ARCH.has(p.archetype)) {
    if (p.r0 == null || p.r1 == null || p.r0 <= 0n || p.r1 <= 0n) return null;
    return new V2PoolSim(p.address.toLowerCase(), p.token0, p.token1, p.r0, p.r1, fee || 3000, p.archetype);
  }
  if (p.archetype === "aerodrome-stable") {
    // Stable (x³y+xy³=k): FAIL-CLOSED — needs reserves + BOTH token decimal scales + a real fee (never
    // guess a fee on a small-edge strategy). fee is carried as ppm (= factory bps × 100).
    if (p.r0 == null || p.r1 == null || p.r0 <= 0n || p.r1 <= 0n || p.dec0 == null || p.dec1 == null || fee <= 0) return null;
    return new StablePoolSim(p.address.toLowerCase(), p.token0, p.token1, p.r0, p.r1, p.dec0, p.dec1, fee / 100, "aerodrome-stable");
  }
  if (p.sqrtPriceX96 == null || p.liquidity == null || p.sqrtPriceX96 <= 0n || p.liquidity <= 0n) return null;
  return new V3PoolSim(p.address.toLowerCase(), p.token0, p.token1, p.sqrtPriceX96, p.liquidity, getTickAtSqrtRatio(p.sqrtPriceX96), fee || 3000, ticks ?? [], p.archetype, p.tickCoverage === "complete" ? "complete" : "partial", p.tickSpacing ?? 0);
}

/** Assemble an immutable snapshot from PoolSims. */
export function makeSnapshot(version: StateVersion, sims: PoolSim[]): VenueSnapshot {
  const m = new Map<string, PoolSim>();
  for (const s of sims) m.set(s.poolId.toLowerCase(), s);
  return new VenueSnapshot(version, m);
}

// ── Objective + evaluation ───────────────────────────────────────────────────
export interface SimulationObjective {
  numeraire: AssetId;
  requireClosedPortfolio: boolean;  // no residual non-numéraire tokens in Sn
  requireNoTransientDebt: boolean;  // all flash obligations repaid in Sn
  dust?: bigint;                    // tolerance for residual balances (default 0)
}

export interface PlanResult {
  valid: boolean;
  reason?: string;
  realizedPnl: bigint;   // final numéraire − initial numéraire (raw wei of numéraire)
  gasUnits: bigint;
  residual: Array<{ token: AssetId; amount: bigint }>;
  finalNumeraire: bigint;
  /** Item 3: every leg was certifiably exact (all concentrated legs had complete tick coverage, no floor).
   * A valid plan with simulationExact=false is a positive-PnL economicCandidate but NOT certifiable executable. */
  simulationExact: boolean;
}

/** Run `ops` from `initial` against a fresh fork of `snapshot`; evaluate against `obj`. Pure: `initial`
 * and the snapshot are never mutated (the fork is copy-on-write). */
export function simulatePlan(snapshot: VenueSnapshot, initial: PortfolioState, ops: Transformation[], obj: SimulationObjective, trace?: SwapTrace[], lending?: LendingSnapshot): PlanResult {
  const startNum = initial.get(obj.numeraire);
  const s: SimulationState = { version: snapshot.version, portfolio: initial.clone(), venue: snapshot.fork(), gasUnits: 0n, trace, lending: lending?.fork(), exact: true };
  for (const op of ops) {
    const r = op.apply(s);
    if (!r.ok) return { valid: false, reason: `${op.kind}: ${r.reason}`, realizedPnl: 0n, gasUnits: s.gasUnits, residual: [], finalNumeraire: s.portfolio.get(obj.numeraire), simulationExact: false };
  }
  const dust = obj.dust ?? 0n;
  const residual = s.portfolio.nonZero().filter((h) => h.token !== obj.numeraire.toLowerCase() && (h.amount > dust || h.amount < -dust));
  let valid = true, reason: string | undefined;
  if (obj.requireNoTransientDebt && s.portfolio.totalOwed() !== 0n) { valid = false; reason = "unrepaid flash obligation"; }
  else if (obj.requireClosedPortfolio && residual.length) { valid = false; reason = `residual ${residual.length} token(s)`; }
  const finalNumeraire = s.portfolio.get(obj.numeraire);
  const realizedPnl = finalNumeraire - startNum;
  if (valid && realizedPnl <= 0n) { valid = false; reason = "non-positive realized PnL"; }
  return { valid, reason, realizedPnl, gasUnits: s.gasUnits, residual, finalNumeraire, simulationExact: s.exact };
}

// ── Cycle sizing ─────────────────────────────────────────────────────────────
export interface SizeOpts {
  funding: "own" | "flash";
  flashProvider?: string;
  flashFee?: bigint;
  coarse?: number; // geometric pre-sweep points (default 24)
}
export interface SizedCycle {
  amountIn: bigint;
  numeraire: AssetId;
  realizedPnl: bigint;   // raw wei of numéraire (start token) — GROSS (no gas/flash fee subtracted)
  gasUnits: bigint;
  funding: "own" | "flash";
  ops: Transformation[]; // the winning plan (for reference)
  legs: SwapTrace[];     // per-hop exact amounts (for the encoder)
  simulationExact: boolean; // Item 3: all legs certifiably exact — required before `executable`
}

/** Build the plan for a cycle at a given input size. Start token = cycle.tokens[0] = numéraire. Each leg
 * swaps its full received balance (chaining), optionally funded by a flash loan repaid at the end. */
function cyclePlan(cycle: KGCycle, x: bigint, opts: SizeOpts): { ops: Transformation[]; initial: PortfolioState; numeraire: AssetId } {
  const numeraire = cycle.tokens[0];
  const ops: Transformation[] = [];
  const initial = new PortfolioState();
  if (opts.funding === "flash") ops.push(new FlashBorrowOp(opts.flashProvider ?? "morpho", numeraire, x));
  else initial.credit(numeraire, x);
  for (const e of cycle.edges) ops.push(new SwapOp(e.pool, e.from, e.to, 0n, e.archetype, true));
  if (opts.funding === "flash") ops.push(new FlashRepayOp(opts.flashProvider ?? "morpho", numeraire, x, opts.flashFee ?? 0n));
  return { ops, initial, numeraire };
}

/**
 * Size a candidate cycle for maximum realized PnL, using true compounding impact on a per-trial fork.
 * A geometric pre-sweep brackets the optimum (the profit curve rises then falls), then ternary search
 * refines. Returns null if no positive-PnL size exists (the artifact filter: stale/thin "cycles" die here).
 * `poolSims` must include a mutable sim for every pool in the cycle (V3 pools ideally with real ticks).
 */
export function sizeCycle(version: StateVersion, cycle: KGCycle, poolSims: Map<string, PoolSim>, opts: SizeOpts): SizedCycle | null {
  const numeraire = cycle.tokens[0];
  const first = poolSims.get(cycle.edges[0].pool.toLowerCase());
  if (!first) return null;
  const snapshot = makeSnapshot(version, [...poolSims.values()]);
  const obj: SimulationObjective = { numeraire, requireClosedPortfolio: true, requireNoTransientDebt: opts.funding === "flash" };

  const profit = (x: bigint): bigint => {
    if (x <= 0n) return 0n;
    const { ops, initial } = cyclePlan(cycle, x, opts);
    const r = simulatePlan(snapshot, initial, ops, obj);
    return r.valid ? r.realizedPnl : (r.realizedPnl < 0n ? r.realizedPnl : -1n);
  };

  // Bounds in start-token raw wei: from a tiny fraction up to most of the first pool's reserve.
  const rA = first.reserveOf(numeraire);
  if (rA <= 0n) return null;
  const hi0 = rA; const lo0 = rA / 1_000_000n > 0n ? rA / 1_000_000n : 1n;

  // Geometric pre-sweep to bracket the best.
  const K = Math.max(8, opts.coarse ?? 24);
  const loF = Math.log(Number(lo0)), hiF = Math.log(Number(hi0));
  let bestX = lo0, bestP = profit(lo0);
  const xs: bigint[] = [];
  for (let i = 0; i <= K; i++) { const x = BigInt(Math.floor(Math.exp(loF + (hiF - loF) * (i / K)))); xs.push(x); const p = profit(x); if (p > bestP) { bestP = p; bestX = x; } }

  // Ternary refine within the bracket around bestX.
  const idx = xs.findIndex((x) => x === bestX);
  let lo = xs[Math.max(0, idx - 1)] ?? lo0;
  let hi = xs[Math.min(xs.length - 1, idx + 1)] ?? hi0;
  for (let it = 0; it < 80 && hi > lo + 1n; it++) {
    const m1 = lo + (hi - lo) / 3n;
    const m2 = hi - (hi - lo) / 3n;
    const p1 = profit(m1), p2 = profit(m2);
    if (p1 < p2) { lo = m1; if (p2 > bestP) { bestP = p2; bestX = m2; } }
    else { hi = m2; if (p1 > bestP) { bestP = p1; bestX = m1; } }
  }

  if (bestP <= 0n) return null; // no profitable size → artifact, drop
  const { ops, initial } = cyclePlan(cycle, bestX, opts);
  // Recompute at the winner WITH a trace to capture per-hop amounts for the encoder.
  const legs: SwapTrace[] = [];
  const r = simulatePlan(snapshot, initial, ops, obj, legs);
  return { amountIn: bestX, numeraire, realizedPnl: bestP, gasUnits: r.gasUnits, funding: opts.funding, ops, legs, simulationExact: r.simulationExact };
}

// ── Flash-liquidation as an ordinary plan (F5) — exit is a GENERIC swap route (1..n hops, F5.2) ────
/** One hop of the collateral→loan exit route. `bestRoute` chooses the topology; the kernel simulates it
 * exactly. First hop's tokenIn = collateral, last hop's tokenOut = loan. */
export interface ExitHop { poolId: string; tokenIn: AssetId; tokenOut: AssetId; archetype: string }

export interface FlashLiquidationPlan {
  ops: Transformation[];
  numeraire: AssetId;    // loan token (the profit asset)
  flashAmount: bigint;   // loan flash-borrowed = debt repaid (share-exact)
  seized: bigint;        // collateral seized
  repaid: bigint;        // loan repaid to Morpho (= repaidAssets)
  liquidateOp: LiquidateOp;
  exitOps: SwapOp[];     // the collateral→loan swap route (1 = direct, 2+ = multi-hop)
}

/** Build the flash-liquidation plan for a liquidatable position with a GENERIC exit route:
 *   FlashBorrow(loan, repaid) → Liquidate(seize) → exitOps[collateral→…→loan] → FlashRepay(loan, repaid)
 * `seize`/`repaid` are share-exact (computeLiquidation). The exit route is chosen upstream by bestRoute on
 * the candidate universe; here we only wire the SwapOps (full-balance chaining) — the kernel decides the
 * real output. Returns null if not liquidatable, nothing seizable, or the route is malformed. */
export function planFlashLiquidation(market: LendingMarketSim, pos: BorrowerPositionSim, exit: ExitHop[], provider = "morpho"): FlashLiquidationPlan | null {
  if (!pos.protocolLiquidatable(market) || !exit.length) return null;
  const loan = market.params.loanToken, coll = market.params.collateralToken;
  if (exit[0].tokenIn.toLowerCase() !== coll.toLowerCase() || exit[exit.length - 1].tokenOut.toLowerCase() !== loan.toLowerCase()) return null;
  const calc = computeLiquidation(market, pos, seizeForFullRepay(market, pos));
  if (!calc) return null;
  const liquidateOp = new LiquidateOp(market.marketId, pos.borrower, calc.seized);
  const exitOps = exit.map((h) => new SwapOp(h.poolId, h.tokenIn, h.tokenOut, 0n, h.archetype, true));
  const ops: Transformation[] = [new FlashBorrowOp(provider, loan, calc.repaidAssets), liquidateOp, ...exitOps, new FlashRepayOp(provider, loan, calc.repaidAssets, 0n)];
  return { ops, numeraire: loan, flashAmount: calc.repaidAssets, seized: calc.seized, repaid: calc.repaidAssets, liquidateOp, exitOps };
}

/** Simulate a flash-liquidation plan on forked venue + lending state; realized PnL in the loan token.
 * `trace` (if given) captures the exit swap legs' exact amounts for the encoder. */
export function simulateFlashLiquidation(venueSnap: VenueSnapshot, lendingSnap: LendingSnapshot, plan: FlashLiquidationPlan, trace?: SwapTrace[]): PlanResult {
  const obj: SimulationObjective = { numeraire: plan.numeraire, requireClosedPortfolio: true, requireNoTransientDebt: true };
  return simulatePlan(venueSnap, new PortfolioState(), plan.ops, obj, trace ?? [], lendingSnap);
}
