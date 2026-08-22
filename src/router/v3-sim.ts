import { getSqrtRatioAtTick, getTickAtSqrtRatio, MIN_TICK, MAX_TICK, Q96 } from "./tick-math.js";

/**
 * EXACT Uniswap-V3 swap simulation — walks the price across initialized ticks using our indexed state
 * (sqrtPriceX96, current tick, in-range liquidity) + the tick_liquidity map, reproducing the pool's own
 * SqrtPriceMath/SwapMath. Result == the on-chain Quoter, but computed locally (no RPC, exact at any size).
 * Removes the single-tick approximation for large V3 trades.
 */

// ── 512-bit-safe mulDiv (bigint is arbitrary precision, so a*b never overflows) ──
const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;
const mulDivRoundingUp = (a: bigint, b: bigint, d: bigint): bigint => { const p = a * b; return p / d + (p % d === 0n ? 0n : 1n); };
const divRoundingUp = (a: bigint, d: bigint): bigint => a / d + (a % d === 0n ? 0n : 1n);

/** amount0 between two sqrt prices for liquidity L (raw token0). roundUp for exact-in cost, down for out. */
function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, L: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const num1 = L << 96n, num2 = sqrtB - sqrtA;
  return roundUp ? divRoundingUp(mulDivRoundingUp(num1, num2, sqrtB), sqrtA) : mulDiv(num1, num2, sqrtB) / sqrtA;
}
/** amount1 between two sqrt prices for liquidity L (raw token1). */
function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, L: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? mulDivRoundingUp(L, sqrtB - sqrtA, Q96) : mulDiv(L, sqrtB - sqrtA, Q96);
}
/** Next sqrtPrice after adding `amount` of token0 (price decreases). */
function nextSqrtFromAmount0(sqrtP: bigint, L: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtP;
  const num1 = L << 96n;
  const product = amount * sqrtP;
  const denom = num1 + product;
  if (denom >= num1) return mulDivRoundingUp(num1, sqrtP, denom);
  return divRoundingUp(num1, num1 / sqrtP + amount);
}
/** Next sqrtPrice after adding `amount` of token1 (price increases). */
function nextSqrtFromAmount1(sqrtP: bigint, L: bigint, amount: bigint): bigint {
  return sqrtP + mulDiv(amount, Q96, L);
}
function nextSqrtFromInput(sqrtP: bigint, L: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? nextSqrtFromAmount0(sqrtP, L, amountIn) : nextSqrtFromAmount1(sqrtP, L, amountIn);
}

/** One SwapMath step from sqrtP toward sqrtTarget, consuming up to `remaining` input (exact-in, with fee). */
function computeSwapStep(sqrtP: bigint, sqrtTarget: bigint, L: bigint, remaining: bigint, feePips: number, zeroForOne: boolean) {
  const fee = BigInt(feePips);
  const lessFee = mulDiv(remaining, 1_000_000n - fee, 1_000_000n);
  let amountIn = zeroForOne ? getAmount0Delta(sqrtTarget, sqrtP, L, true) : getAmount1Delta(sqrtP, sqrtTarget, L, true);
  const max = lessFee >= amountIn;
  const sqrtNext = max ? sqrtTarget : nextSqrtFromInput(sqrtP, L, lessFee, zeroForOne);
  if (zeroForOne) {
    amountIn = max ? amountIn : getAmount0Delta(sqrtNext, sqrtP, L, true);
  } else {
    amountIn = max ? amountIn : getAmount1Delta(sqrtP, sqrtNext, L, true);
  }
  const amountOut = zeroForOne ? getAmount1Delta(sqrtNext, sqrtP, L, false) : getAmount0Delta(sqrtP, sqrtNext, L, false);
  const feeAmount = max ? mulDivRoundingUp(amountIn, fee, 1_000_000n - fee) : (remaining - amountIn);
  return { sqrtNext, amountIn, amountOut, feeAmount };
}

export interface V3PoolSim {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick?: number; // if absent, derived from sqrtPrice
  feePips: number; // e.g. 3000 = 0.30%
  tickSpacing?: number; // REQUIRED for exactness: the pool steps at tickBitmap WORD boundaries (see below).
  ticks: ReadonlyArray<{ tick: number; liquidityNet: bigint }>; // initialized ticks (any order); NEVER mutated
}

/**
 * DERIVED TICK INDEX, computed once per tick array instead of once per quote.
 *
 * A pool's tick map is immutable for the life of the snapshot it came from, yet every call used to copy it,
 * sort it (O(n log n)), build a Map of it and map it again — for a single quote. Sizing one cycle probes many
 * amounts across several legs, so on a pool with a few thousand initialized ticks that rebuild dominated
 * everything: one observatory cycle took 33 MINUTES, of which the database was 25 seconds.
 *
 * Keyed on the array's identity in a WeakMap, so a new snapshot (a new array) naturally gets a fresh index and
 * nothing has to be invalidated by hand. Every field here is READ-ONLY inside the swap loop, which is what
 * makes sharing it across calls safe.
 */
type TickIndex = { sorted: ReadonlyArray<{ tick: number; liquidityNet: bigint }>; netAt: Map<number, bigint>; ascTicks: number[] };
const tickIndexCache = new WeakMap<object, TickIndex>();
function tickIndexOf(ticks: ReadonlyArray<{ tick: number; liquidityNet: bigint }>): TickIndex {
  const hit = tickIndexCache.get(ticks as object);
  if (hit) return hit;
  const sorted = [...ticks].sort((a, b) => a.tick - b.tick);
  const netAt = new Map<number, bigint>(); for (const t of sorted) netAt.set(t.tick, t.liquidityNet);
  const idx: TickIndex = { sorted, netAt, ascTicks: sorted.map((t) => t.tick) };
  tickIndexCache.set(ticks as object, idx);
  return idx;
}

// Fallback tickSpacing by fee tier (canonical Uniswap) — used only if the caller omits pool.tickSpacing; a
// fork with a non-standard spacing MUST pass it explicitly or the word-boundary walk (below) will be wrong.
const FEE_TO_SPACING: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };

/**
 * CERTIFIED-EXACTNESS ENVELOPE (Item 3). The word-boundary walk reproduces QuoterV2 bit-for-bit well past 720
 * initialized-tick crossings (the differential matrix confirms EXACT at x669/x723); only far deeper does a
 * residual few-wei drift with a diverging crossing-count appear (accumulated deep-penetration rounding, not yet
 * root-caused). Exactness is therefore size/path-dependent, NOT merely pool-level: a swap crossing MORE than
 * this many initialized ticks is treated as NON-certified (economicCandidate only) even when the tick map is
 * `complete`. 500 is a conservative margin BELOW the highest crossing count proven exact (>723). Economically
 * this regime is unreachable by any sane route (a single-pool swap of many millions of dollars); the cap simply
 * keeps `simulationExact` honest and fail-closed.
 */
export const MAX_CERTIFIED_V3_CROSSINGS = 500;

/** Full result of an exact-input V3 swap, including the POST-swap pool state (for stateful simulation). */
export interface V3SwapResult {
  amountOut: bigint;
  amountInUsed: bigint;   // input actually consumed (= amountIn unless `partial`)
  partial: boolean;       // ran out of indexed ticks/liquidity before consuming all input
  sqrtPriceX96: bigint;   // price after the swap
  tick: number;           // current tick after the swap
  liquidity: bigint;      // in-range liquidity after the swap
  ticksCrossed: number;   // INITIALIZED ticks the swap crossed — QuoterV2's independent validation signal
}

/**
 * Exact output of swapping `amountIn` of tokenIn (token0 if `zeroForOne`) through the pool, walking ticks,
 * ALSO returning the pool's post-swap state (sqrtPrice/tick/liquidity) so a caller can mutate its mirror
 * and have the next swap see the moved price. Returns null if state/liquidity is unusable. `partial` =
 * true when input couldn't be fully consumed (ran out of indexed ticks) → the out is a floor, not exact.
 */
export function simulateExactInputStateful(pool: V3PoolSim, zeroForOne: boolean, amountIn: bigint): V3SwapResult | null {
  if (amountIn <= 0n || pool.sqrtPriceX96 <= 0n || pool.liquidity <= 0n) return null;
  const { netAt, ascTicks } = tickIndexOf(pool.ticks);

  const tickSpacing = pool.tickSpacing && pool.tickSpacing > 0 ? pool.tickSpacing : (FEE_TO_SPACING[pool.feePips] ?? 1);
  let sqrtP = pool.sqrtPriceX96;
  let L = pool.liquidity;
  let tick = pool.tick ?? getTickAtSqrtRatio(sqrtP);
  let remaining = amountIn;
  let amountOut = 0n;
  let ticksCrossed = 0;

  for (let guard = 0; remaining > 0n && L > 0n && guard < 1_000_000; guard++) {
    // Uniswap's swap loop advances via tickBitmap.nextInitializedTickWithinOneWord: it stops at the next
    // INITIALIZED tick OR the current bitmap WORD boundary (256 spacings), whichever is nearer — it NEVER jumps
    // across an uninitialized multi-word gap in one step. That matters: computeSwapStep rounds at each segment,
    // so one big step across a wide gap accumulates rounding differently than the pool's word-by-word walk
    // (verified: a wide-gap partial step to an extreme tick diverged from QuoterV2 until this was replicated).
    const compressed = Math.floor(tick / tickSpacing);
    let boundaryTick: number, initialized: boolean;
    if (zeroForOne) {
      const wordLow = (compressed >> 8) * 256 * tickSpacing;                 // lowest tick in the current word
      let it: number | null = null; for (let i = ascTicks.length - 1; i >= 0; i--) if (ascTicks[i] <= tick) { it = ascTicks[i]; break; }
      if (it != null && it >= wordLow) { boundaryTick = it; initialized = true; } else { boundaryTick = wordLow; initialized = false; }
    } else {
      const wordHigh = (((compressed + 1) >> 8) * 256 + 255) * tickSpacing;  // highest tick in the next word up
      let it: number | null = null; for (let i = 0; i < ascTicks.length; i++) if (ascTicks[i] > tick) { it = ascTicks[i]; break; }
      if (it != null && it <= wordHigh) { boundaryTick = it; initialized = true; } else { boundaryTick = wordHigh; initialized = false; }
    }
    boundaryTick = Math.max(MIN_TICK, Math.min(MAX_TICK, boundaryTick));

    const sqrtTarget = getSqrtRatioAtTick(boundaryTick);
    const step = computeSwapStep(sqrtP, sqrtTarget, L, remaining, pool.feePips, zeroForOne);
    remaining -= step.amountIn + step.feeAmount;
    amountOut += step.amountOut;
    sqrtP = step.sqrtNext;

    if (sqrtP === sqrtTarget) {
      // Reached the boundary. Cross liquidity ONLY at an initialized tick; an uninitialized word edge just
      // advances the tick and the walk continues into the next word.
      if (initialized) { let net = netAt.get(boundaryTick) ?? 0n; if (zeroForOne) net = -net; L += net; ticksCrossed += 1; }
      tick = zeroForOne ? boundaryTick - 1 : boundaryTick;
      if (boundaryTick <= MIN_TICK || boundaryTick >= MAX_TICK) break; // hit the price domain edge → no more liquidity
    } else {
      // Partial fill inside the range → all input consumed. Tick tracks the price.
      return { amountOut, amountInUsed: amountIn, partial: false, sqrtPriceX96: sqrtP, tick: getTickAtSqrtRatio(sqrtP), liquidity: L, ticksCrossed };
    }
  }
  return { amountOut, amountInUsed: amountIn - (remaining > 0n ? remaining : 0n), partial: remaining > 0n, sqrtPriceX96: sqrtP, tick, liquidity: L, ticksCrossed };
}

/**
 * Exact output of swapping `amountIn` of tokenIn (token0 if `zeroForOne`) through the pool, walking ticks.
 * Returns null if state/liquidity is unusable. `partial` = true when input couldn't be fully consumed
 * (ran out of indexed ticks/liquidity) → the caller treats the quote as a floor, not exact. Thin wrapper
 * over `simulateExactInputStateful` for callers that only need the output.
 */
export function simulateExactInput(pool: V3PoolSim, zeroForOne: boolean, amountIn: bigint): { amountOut: bigint; partial: boolean } | null {
  const r = simulateExactInputStateful(pool, zeroForOne, amountIn);
  return r ? { amountOut: r.amountOut, partial: r.partial } : null;
}
