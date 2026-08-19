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
  ticks: Array<{ tick: number; liquidityNet: bigint }>; // initialized ticks (any order)
}

/** Full result of an exact-input V3 swap, including the POST-swap pool state (for stateful simulation). */
export interface V3SwapResult {
  amountOut: bigint;
  amountInUsed: bigint;   // input actually consumed (= amountIn unless `partial`)
  partial: boolean;       // ran out of indexed ticks/liquidity before consuming all input
  sqrtPriceX96: bigint;   // price after the swap
  tick: number;           // current tick after the swap
  liquidity: bigint;      // in-range liquidity after the swap
}

/**
 * Exact output of swapping `amountIn` of tokenIn (token0 if `zeroForOne`) through the pool, walking ticks,
 * ALSO returning the pool's post-swap state (sqrtPrice/tick/liquidity) so a caller can mutate its mirror
 * and have the next swap see the moved price. Returns null if state/liquidity is unusable. `partial` =
 * true when input couldn't be fully consumed (ran out of indexed ticks) → the out is a floor, not exact.
 */
export function simulateExactInputStateful(pool: V3PoolSim, zeroForOne: boolean, amountIn: bigint): V3SwapResult | null {
  if (amountIn <= 0n || pool.sqrtPriceX96 <= 0n || pool.liquidity <= 0n) return null;
  const sorted = [...pool.ticks].sort((a, b) => a.tick - b.tick);
  const netAt = new Map<number, bigint>(); for (const t of sorted) netAt.set(t.tick, t.liquidityNet);
  const ascTicks = sorted.map((t) => t.tick);

  let sqrtP = pool.sqrtPriceX96;
  let L = pool.liquidity;
  let tick = pool.tick ?? getTickAtSqrtRatio(sqrtP);
  let remaining = amountIn;
  let amountOut = 0n;

  for (let guard = 0; remaining > 0n && L > 0n && guard < 100_000; guard++) {
    // Next initialized tick in the swap direction (zeroForOne=down → ≤ tick; up → > tick).
    let nextTick: number | null = null;
    if (zeroForOne) { for (let i = ascTicks.length - 1; i >= 0; i--) if (ascTicks[i] <= tick) { nextTick = ascTicks[i]; break; } }
    else { for (let i = 0; i < ascTicks.length; i++) if (ascTicks[i] > tick) { nextTick = ascTicks[i]; break; } }

    const boundaryTick = nextTick ?? (zeroForOne ? MIN_TICK : MAX_TICK);
    const sqrtTarget = getSqrtRatioAtTick(boundaryTick);
    const step = computeSwapStep(sqrtP, sqrtTarget, L, remaining, pool.feePips, zeroForOne);
    remaining -= step.amountIn + step.feeAmount;
    amountOut += step.amountOut;
    sqrtP = step.sqrtNext;

    if (sqrtP === sqrtTarget && nextTick != null) {
      let net = netAt.get(nextTick) ?? 0n;
      if (zeroForOne) net = -net;
      L += net;
      tick = zeroForOne ? nextTick - 1 : nextTick;
    } else {
      // Partial fill inside the range, or ran past the last indexed tick → stop. Tick tracks the price.
      return { amountOut, amountInUsed: amountIn - (remaining > 0n ? remaining : 0n), partial: nextTick == null && remaining > 0n, sqrtPriceX96: sqrtP, tick: getTickAtSqrtRatio(sqrtP), liquidity: L };
    }
  }
  return { amountOut, amountInUsed: amountIn - (remaining > 0n ? remaining : 0n), partial: remaining > 0n, sqrtPriceX96: sqrtP, tick, liquidity: L };
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
