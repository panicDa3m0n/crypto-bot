/**
 * KG V3 SIM DIAGNOSTIC (V3-sim vs faithful Solidity, step-by-step) — isolates the FIRST per-step divergence
 * between our `v3-sim` math and a bit-faithful uint256 port of Uniswap's SqrtPriceMath/SwapMath, then proves
 * the faithful port IS the on-chain oracle by matching QuoterV2's final (amountOut, sqrtPriceAfter). The walk
 * advances on the FAITHFUL result (the oracle); at every step it ALSO computes the CURRENT-code step from the
 * SAME inputs and diffs the tuple {sqrtNext, amountIn, amountOut, feeAmount}. First mismatch = the bug.
 *
 *   ... run --rm -e SCAN_RPC=<reliable rpc> brain node dist/scripts/kg-v3-diag.js [pool] [zeroForOne=1] [amountIn]
 */
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseAbi, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { loadConfig } from "../config.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { createLogger } from "../logger.js";
import { scanTickMap } from "../router/tick-storage.js";
import { getSqrtRatioAtTick, getTickAtSqrtRatio, MIN_TICK, MAX_TICK, Q96 } from "../router/tick-math.js";

// Quoter defaults to Uniswap V3 Base; override with QUOTER_ADDR to differential-test a fork (e.g. Pancake).
const UNIV3_QUOTER_BASE = (process.env.QUOTER_ADDR ?? "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a") as Address;
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

// ── shared integer helpers (identical to v3-sim + FullMath semantics) ──
const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;
const mulDivRoundingUp = (a: bigint, b: bigint, d: bigint): bigint => { const p = a * b; return p / d + (p % d === 0n ? 0n : 1n); };
const divRoundingUp = (a: bigint, d: bigint): bigint => a / d + (a % d === 0n ? 0n : 1n);
const U256 = (x: bigint) => BigInt.asUintN(256, x);

// getAmount{0,1}Delta — identical in current & faithful (already match Solidity FullMath).
function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, L: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const num1 = L << 96n, num2 = sqrtB - sqrtA;
  return roundUp ? divRoundingUp(mulDivRoundingUp(num1, num2, sqrtB), sqrtA) : mulDiv(num1, num2, sqrtB) / sqrtA;
}
function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, L: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? mulDivRoundingUp(L, sqrtB - sqrtA, Q96) : mulDiv(L, sqrtB - sqrtA, Q96);
}
// nextSqrtFromAmount1 — identical (Solidity uses (amount<<96)/L for amount<=uint160.max, == mulDiv(amount,Q96,L)).
const nextSqrtFromAmount1 = (sqrtP: bigint, L: bigint, amount: bigint): bigint => sqrtP + mulDiv(amount, Q96, L);

// ── CURRENT code (verbatim from v3-sim.ts) ──
function cur_nextSqrtFromAmount0(sqrtP: bigint, L: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtP;
  const num1 = L << 96n;
  const product = amount * sqrtP;
  const denom = num1 + product;
  if (denom >= num1) return mulDivRoundingUp(num1, sqrtP, denom);
  return divRoundingUp(num1, num1 / sqrtP + amount);
}
function cur_step(sqrtP: bigint, sqrtTarget: bigint, L: bigint, remaining: bigint, feePips: number, zeroForOne: boolean) {
  const fee = BigInt(feePips);
  const lessFee = mulDiv(remaining, 1_000_000n - fee, 1_000_000n);
  let amountIn = zeroForOne ? getAmount0Delta(sqrtTarget, sqrtP, L, true) : getAmount1Delta(sqrtP, sqrtTarget, L, true);
  const max = lessFee >= amountIn;
  const sqrtNext = max ? sqrtTarget : (zeroForOne ? cur_nextSqrtFromAmount0(sqrtP, L, lessFee) : nextSqrtFromAmount1(sqrtP, L, lessFee));
  amountIn = max ? amountIn : (zeroForOne ? getAmount0Delta(sqrtNext, sqrtP, L, true) : getAmount1Delta(sqrtP, sqrtNext, L, true));
  const amountOut = zeroForOne ? getAmount1Delta(sqrtNext, sqrtP, L, false) : getAmount0Delta(sqrtP, sqrtNext, L, false);
  const feeAmount = max ? mulDivRoundingUp(amountIn, fee, 1_000_000n - fee) : (remaining - amountIn);
  return { sqrtNext, amountIn, amountOut, feeAmount };
}

// ── FAITHFUL Solidity port (uint256-exact) ──
function sol_nextSqrtFromAmount0(sqrtP: bigint, L: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtP;
  const numerator1 = L << 96n;                       // uint128<<96 < 2^224 → no wrap
  const product = U256(amount * sqrtP);              // uint256 multiply (wraps)
  if (product / amount === sqrtP) {                  // no overflow
    const denominator = U256(numerator1 + product);  // uint256 add (may wrap)
    if (denominator >= numerator1) return mulDivRoundingUp(numerator1, sqrtP, denominator);
  }
  return divRoundingUp(numerator1, numerator1 / sqrtP + amount); // overflow / denom-wrap branch
}
function sol_step(sqrtP: bigint, sqrtTarget: bigint, L: bigint, remaining: bigint, feePips: number, zeroForOne: boolean) {
  const fee = BigInt(feePips);
  const lessFee = mulDiv(remaining, 1_000_000n - fee, 1_000_000n);
  let amountIn = zeroForOne ? getAmount0Delta(sqrtTarget, sqrtP, L, true) : getAmount1Delta(sqrtP, sqrtTarget, L, true);
  let sqrtNext: bigint;
  if (lessFee >= amountIn) sqrtNext = sqrtTarget;
  else sqrtNext = zeroForOne ? sol_nextSqrtFromAmount0(sqrtP, L, lessFee) : nextSqrtFromAmount1(sqrtP, L, lessFee);
  const max = sqrtTarget === sqrtNext;               // Solidity: max computed AFTER, from equality
  amountIn = max ? amountIn : (zeroForOne ? getAmount0Delta(sqrtNext, sqrtP, L, true) : getAmount1Delta(sqrtP, sqrtNext, L, true));
  const amountOut = zeroForOne ? getAmount1Delta(sqrtNext, sqrtP, L, false) : getAmount0Delta(sqrtP, sqrtNext, L, false);
  const feeAmount = (sqrtNext !== sqrtTarget) ? (remaining - amountIn) : mulDivRoundingUp(amountIn, fee, 1_000_000n - fee);
  return { sqrtNext, amountIn, amountOut, feeAmount };
}

interface Snap { sqrtPriceX96: bigint; tick: number; liquidity: bigint; ticks: Array<{ tick: number; liquidityNet: bigint }> }

/** Walk faithfully; at each step also compute the current-code step from identical inputs and diff. */
function diagWalk(snap: Snap, feePips: number, zeroForOne: boolean, amountIn: bigint, tickSpacing: number) {
  const sorted = [...snap.ticks].sort((a, b) => a.tick - b.tick);
  const netAt = new Map<number, bigint>(); for (const t of sorted) netAt.set(t.tick, t.liquidityNet);
  const ascTicks = sorted.map((t) => t.tick);
  let sqrtP = snap.sqrtPriceX96, L = snap.liquidity, tick = snap.tick, remaining = amountIn, out = 0n, crossed = 0;
  let firstDiv: string | null = null;
  let lastCrossOut = 0n, lastCrossSqrt = 0n, lastCrossTick = 0;
  const rows: string[] = [];
  for (let g = 0; remaining > 0n && L > 0n && g < 100_000; g++) {
    // Uniswap's tickBitmap.nextInitializedTickWithinOneWord: stop at the next initialized tick OR the current
    // word's boundary (whichever is nearer), never jumping across an uninitialized multi-word gap in one shot.
    const compressed = Math.floor(tick / tickSpacing);
    let boundaryTick: number, initialized: boolean;
    if (zeroForOne) {
      const wordLow = (compressed >> 8) * 256 * tickSpacing;
      let it: number | null = null; for (let i = ascTicks.length - 1; i >= 0; i--) if (ascTicks[i] <= tick) { it = ascTicks[i]; break; }
      if (it != null && it >= wordLow) { boundaryTick = it; initialized = true; } else { boundaryTick = wordLow; initialized = false; }
    } else {
      const wordHigh = (((compressed + 1) >> 8) * 256 + 255) * tickSpacing;
      let it: number | null = null; for (let i = 0; i < ascTicks.length; i++) if (ascTicks[i] > tick) { it = ascTicks[i]; break; }
      if (it != null && it <= wordHigh) { boundaryTick = it; initialized = true; } else { boundaryTick = wordHigh; initialized = false; }
    }
    boundaryTick = Math.max(MIN_TICK, Math.min(MAX_TICK, boundaryTick));
    const sqrtTarget = getSqrtRatioAtTick(boundaryTick);
    const sf = sol_step(sqrtP, sqrtTarget, L, remaining, feePips, zeroForOne);
    const sc = cur_step(sqrtP, sqrtTarget, L, remaining, feePips, zeroForOne);
    const diff = sf.sqrtNext !== sc.sqrtNext || sf.amountIn !== sc.amountIn || sf.amountOut !== sc.amountOut || sf.feeAmount !== sc.feeAmount;
    if (g < 16 || diff) rows.push(`  step ${g} tgt=${boundaryTick}${initialized ? "*" : ""} Lbefore=${L} rem=${remaining}  sqrtNext=${sf.sqrtNext}${diff ? "  ◀── cur≠faith" : ""}`);
    if (diff && !firstDiv) firstDiv = `step ${g} @tick→${boundaryTick}`;
    remaining -= sf.amountIn + sf.feeAmount; out += sf.amountOut; sqrtP = sf.sqrtNext;
    if (sqrtP === sqrtTarget) {
      if (initialized) { lastCrossOut = out; lastCrossSqrt = sqrtP; lastCrossTick = boundaryTick; let net = netAt.get(boundaryTick) ?? 0n; if (zeroForOne) net = -net; L += net; crossed++; }
      tick = zeroForOne ? boundaryTick - 1 : boundaryTick; // step past the boundary (Uniswap: tickNext-1 / tickNext)
    } else {
      return { out, sqrtAfter: sqrtP, crossed, firstDiv, rows, partial: remaining > 0n, lastCrossOut, lastCrossSqrt, lastCrossTick };
    }
  }
  return { out, sqrtAfter: sqrtP, crossed, firstDiv, rows, partial: remaining > 0n, lastCrossOut, lastCrossSqrt, lastCrossTick };
}

async function quoter(client: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number, blockNumber: bigint, sqrtLimit = 0n) {
  const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: sqrtLimit }] });
  const r = await client.call({ to: UNIV3_QUOTER_BASE, data, blockNumber }); // PIN to snapshot block B (no skew)
  const [amountOut, sqrtAfter, ticksCrossed] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", data: r.data! }) as [bigint, bigint, number, bigint];
  return { amountOut, sqrtAfter, ticksCrossed };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const client = createPublicClient({ chain: base, transport: http(process.env.SCAN_RPC ?? "https://base.drpc.org", { batch: false }) }) as unknown as PublicClient;

  const pool = (process.argv[2] ?? "0xdc26f2cef9af2de34e6ff0d01c66a602e06c638d").toLowerCase() as Address;
  const zeroForOne = (process.argv[3] ?? "1") !== "0";
  const ent = await db.getEntity(config.CHAIN_ID, pool).catch(() => []);
  const m = (ent[0]?.meta ?? {}) as { token0?: string; token1?: string; fee?: unknown; tickSpacing?: unknown };
  if (!m.token0 || !m.token1) { console.log("pool not in DB"); process.exit(1); }
  const feePips = Number(m.fee) > 0 ? Number(m.fee) : 500;
  const tickSpacing = Number(m.tickSpacing) > 0 ? Number(m.tickSpacing) : ({ 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 }[feePips] ?? 10);
  const B = Number(await chain.primary.getBlockNumber().catch(() => 0n)) - 3;
  const snap = await scanTickMap(client, pool, tickSpacing, B);
  if (!snap) { console.log("scan failed"); await db.close(); process.exit(1); }
  console.log(`[diag] pool=${pool.slice(0, 10)} fee=${feePips} zeroForOne=${zeroForOne} @B=${B} ticks=${snap.ticks.length} curTick=${snap.tick}`);
  // INVARIANT: a well-formed V3 pool's liquidityNet across ALL initialized ticks sums to 0. A non-zero sum ⇒
  // a tick is MISSING from the scan or a liquidityNet was misread → the walk uses wrong in-range L somewhere.
  const netSum = snap.ticks.reduce((s, t) => s + t.liquidityNet, 0n);
  const sortedT = [...snap.ticks].sort((a, b) => a.tick - b.tick);
  console.log(`[diag] Σ liquidityNet = ${netSum}  ${netSum === 0n ? "✓ (well-formed)" : "✗ NON-ZERO → missing/misread tick!"}`);
  console.log(`[diag] ticks: ${sortedT.map((t) => `${t.tick}:${t.liquidityNet}`).join("  ")}`);

  const tokenIn = (zeroForOne ? m.token0 : m.token1) as Address;
  const tokenOut = (zeroForOne ? m.token1 : m.token0) as Address;
  // SWEEP: grow amountIn geometrically; per amount compare faithful vs Quoter@B. Isolates whether the FIRST
  // divergence is at 0-cross (base SwapMath) or appears when a specific initialized tick is crossed.
  console.log(`[diag] SWEEP zeroForOne=${zeroForOne} (cross=# initialized ticks the walk crosses)`);
  console.log(`  ${"amountIn".padEnd(24)} ${"cross".padEnd(6)} ${"outΔ(faith-Q)".padEnd(16)} ${"sqrtΔ".padEnd(22)} verdict`);
  const seed = process.argv[4] ? BigInt(process.argv[4]) : 1_000_000n;
  let lastExactCross = -1, lastPrintedCross = -99;
  const growNum = process.argv[5] ? BigInt(process.argv[5]) : 3n, growDen = process.argv[5] ? BigInt(process.argv[5]) - 1n : 2n;
  for (let i = 0, mul = 1n; i < 120; i++, mul = (mul * growNum) / growDen + 1n) {
    const amountIn = seed * mul;
    const w = diagWalk(snap, feePips, zeroForOne, amountIn, tickSpacing);
    const q = await quoter(client, tokenIn, tokenOut, amountIn, feePips, BigInt(snap.block)).catch(() => null);
    if (!q) { console.log(`  ${String(amountIn).padEnd(24)} ${String(w.crossed).padEnd(6)} quoter-unreachable`); if (w.partial) break; continue; }
    const outD = w.out - q.amountOut, sqrtD = w.sqrtAfter - q.sqrtAfter;
    const exact = outD === 0n && sqrtD === 0n;
    if (exact) lastExactCross = w.crossed;
    // print one row per distinct cross-count (the full ladder) + any divergence
    if (w.crossed !== lastPrintedCross || !exact) { lastPrintedCross = w.crossed; console.log(`  ${String(amountIn).padEnd(24)} ${("c" + w.crossed + "/q" + q.ticksCrossed).padEnd(8)} ${String(outD).padEnd(14)} ${String(sqrtD).padEnd(22)} ${exact ? "EXACT ✓" : "DIVERGE ✗"}${w.partial ? " [PARTIAL→fail-closed]" : ""}`); }
    if (!exact) { console.log(`  → last EXACT cross-count was ${lastExactCross}; diverges when walk crosses=${w.crossed} (Quoter crossed=${q.ticksCrossed})`); break; }
    if (w.partial) break;
  }

  // BOUNDARY PROBE: pin the Quoter to stop EXACTLY at getSqrtRatioAtTick(lastCrossedTick) via sqrtPriceLimit,
  // isolating "everything down to that boundary" (must be EXACT) from "the final extreme partial step below".
  let probe = seed;
  for (let i = 0; i < 40; i++) { const w = diagWalk(snap, feePips, zeroForOne, probe, tickSpacing); if (w.crossed >= 11 && w.partial) break; probe = (probe * 3n) / 2n + 1n; }
  const wp = diagWalk(snap, feePips, zeroForOne, probe, tickSpacing);
  if (wp.lastCrossSqrt > 0n) {
    const boundarySqrt = getSqrtRatioAtTick(wp.lastCrossTick);
    const qb = await quoter(client, tokenIn, tokenOut, probe, feePips, BigInt(snap.block), boundarySqrt).catch(() => null);
    console.log(`\n[diag] BOUNDARY PROBE @ tick ${wp.lastCrossTick} (last full crossing), amountIn=${probe}`);
    console.log(`  getSqrtRatioAtTick(${wp.lastCrossTick}) local = ${boundarySqrt}`);
    if (qb) {
      console.log(`  Quoter(limit=boundary): out=${qb.amountOut} sqrtAfter=${qb.sqrtAfter} crossed=${qb.ticksCrossed}`);
      console.log(`  walk@boundary        : out=${wp.lastCrossOut} sqrt=${wp.lastCrossSqrt}`);
      const bExact = qb.amountOut === wp.lastCrossOut && qb.sqrtAfter === boundarySqrt;
      console.log(`  → to-boundary ${bExact ? "EXACT ✓ (tick-math + crossings correct; bug is BELOW, in the extreme partial step)" : `DIVERGE ✗ (outΔ=${wp.lastCrossOut - qb.amountOut} boundarySqrtΔ=${boundarySqrt - qb.sqrtAfter}) → tick-math/crossing at ${wp.lastCrossTick}`}`);
    }
    // AUTOPSY of the final extreme partial step (the last row printed by diagWalk).
    console.log(`\n[diag] PARTIAL-STEP AUTOPSY (amountIn=${probe}):`);
    console.log(wp.rows.slice(-1).join("\n"));
    const qFull = await quoter(client, tokenIn, tokenOut, probe, feePips, BigInt(snap.block)).catch(() => null);
    const qLim = await quoter(client, tokenIn, tokenOut, probe, feePips, BigInt(snap.block), wp.sqrtAfter).catch(() => null);
    if (qFull) console.log(`  Quoter FULL (no limit): out=${qFull.amountOut} sqrtAfter=${qFull.sqrtAfter}`);
    console.log(`  walk   FULL           : out=${wp.out} sqrtAfter=${wp.sqrtAfter}`);
    if (qLim) console.log(`  Quoter @limit=walkSqrt: out=${qLim.amountOut} sqrtAfter=${qLim.sqrtAfter}  (out at MY price; ==walk.out? ${qLim.amountOut === wp.out})`);
  }
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[diag] fatal:", e); process.exit(1); });
