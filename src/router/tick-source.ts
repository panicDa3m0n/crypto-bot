import { parseAbi, type Address, type PublicClient } from "viem";
import { MIN_TICK, MAX_TICK } from "./tick-math.js";
import { MULTICALL3 } from "./tick-storage.js";

/**
 * UNIFIED TICK SOURCE — one way to read ANY concentrated pool's tick map on the chain, so no new fork can
 * become a blocker again. Three adapters behind one interface, chosen by a capability probe done ONCE per
 * factory (then cached):
 *
 *   ticklens     — Uniswap's TickLens periphery: getPopulatedTicksInWord returns every populated tick of a
 *                  bitmap word (tick + liquidityNet) in ONE call. Verified working on Base for Uniswap V3,
 *                  Slipstream, Pancake and most forks.
 *   storage      — raw pool.tickBitmap + pool.ticks. UNIVERSAL fallback: verified on 7/7 forks tested.
 *   v4-stateview — Uniswap V4's singleton: StateView.getTickBitmap/getTickInfo keyed by bytes32 poolId.
 *                  Same primitives, different addressing.
 *
 * RANGE-BOUNDED BY DESIGN. We never enumerate the whole ±887272 tick domain (6932 words at spacing 1 — the
 * cost guard that used to block us). We read a PRICE WINDOW around the current tick, and the result carries
 * the window it is complete for. A swap that stays inside is exact; one that leaves it is `partial` →
 * fail-closed, exactly like the existing coverage/envelope model. This turns "complete" from an unreachable
 * absolute into a provable, cheap, and sufficient guarantee.
 */

export type TickKind = "ticklens" | "storage" | "v4-stateview" | "algebra";

// Uniswap periphery lenses on Base.
export const TICKLENS_BASE = "0x0CdeE061c75D43c82520eD998C23ac2991c9ac6d" as Address;
export const V4_STATEVIEW_BASE = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71" as Address;

const LENS_ABI = parseAbi(["function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns ((int24 tick, int128 liquidityNet, uint128 liquidityGross)[])"]);
// MINIMAL slot0: only the two fields every fork shares. Uniswap returns 7 fields, Slipstream 6 — decoding
// with the full Uniswap ABI silently breaks on forks (this caused a real misdiagnosis), so never use it here.
const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)",
]);
const V4_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getTickBitmap(bytes32 poolId, int16 wordPosition) view returns (uint256)",
  "function getTickInfo(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 f0, uint256 f1)",
]);

// Algebra (Quickswap/Camelot family): no slot0 — state lives in globalState(), the bitmap is tickTable(), and
// ticks() returns (liquidityTotal, liquidityDelta). It also carries a DYNAMIC fee, which globalState reports:
// the caller must use THAT fee for the current block, never a static tier.
const ALGEBRA_ABI = parseAbi([
  "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint16 communityFee, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function tickTable(int16 wordPosition) view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityTotal, int128 liquidityDelta)",
]);

const CHUNK = 60;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface TickWindow { tickLo: number; tickHi: number }
export interface TickRead {
  sqrtPriceX96: bigint; tick: number; liquidity: bigint;
  ticks: Array<{ tick: number; liquidityNet: bigint }>;
  window: TickWindow;   // the range these ticks are COMPLETE for (outside ⇒ partial, fail-closed)
  source: TickKind;
  block: number;
  words: number;        // how many bitmap words were actually read (cost telemetry)
  /** Algebra-family pools carry a DYNAMIC fee that changes per block — when present the simulator MUST use
   * this value for this block instead of a static fee tier, or every quote on that fork is wrong. */
  dynamicFeePips?: number;
}

/** Words needed around the current tick to cover a price move of `ratio`× in BOTH directions. A tick is a
 * 1.0001 price step, so R = ln(ratio)/ln(1.0001) ticks; one word spans 256 × tickSpacing ticks. Cheap:
 * spacing 200 → 1 word, spacing 10 → ~6, spacing 1 → ~82 for an 8× move. Compare 6932 for the full domain. */
export function wordsForPriceRatio(tickSpacing: number, ratio = 8): number {
  const r = Math.ceil(Math.log(ratio) / Math.log(1.0001));
  return Math.max(1, Math.ceil(r / (256 * tickSpacing)));
}

/** Retry ONLY the still-failed sub-calls: flaky public RPCs return PARTIAL multicall results, and a window
 * we claim complete needs every read to land. Generic over call shape (pool / lens / stateview). */
async function mcAll(client: PublicClient, contracts: readonly unknown[], blockNumber: bigint): Promise<unknown[] | null> {
  const out = new Array<unknown>(contracts.length);
  let pending = contracts.map((_, i) => i);
  for (let round = 0; round < 10 && pending.length; round++) {
    const sub = pending.map((i) => contracts[i]);
    const r = await client.multicall({ contracts: sub as never, blockNumber, multicallAddress: MULTICALL3, allowFailure: true }).catch(() => null) as Array<{ status: string; result?: unknown }> | null; // db-first-allow: write-side tick reader
    if (r) { const still: number[] = []; for (let j = 0; j < pending.length; j++) { if (r[j]?.status === "success") out[pending[j]] = r[j].result; else still.push(pending[j]); } pending = still; }
    if (pending.length) await sleep(200 * (round + 1));
  }
  return pending.length ? null : out;
}

const clampTick = (t: number) => Math.max(MIN_TICK, Math.min(MAX_TICK, t));

/** Probe which adapter a pool answers to. Do this ONCE per factory and cache it — the answer is a property
 * of the protocol, not the pool. Returns null when nothing works (pool unreadable ⇒ never certifiable). */
export async function probeTickCapability(client: PublicClient, pool: string, isV4: boolean): Promise<TickKind | null> {
  if (isV4) {
    const ok = await client.readContract({ address: V4_STATEVIEW_BASE, abi: V4_ABI, functionName: "getSlot0", args: [pool as `0x${string}`] }).then(() => true).catch(() => false); // db-first-allow
    return ok ? "v4-stateview" : null;
  }
  const p = pool as Address;
  const sp = await client.readContract({ address: p, abi: POOL_ABI, functionName: "tickSpacing" }).catch(() => null); // db-first-allow
  if (!sp) return null;
  const s0 = await client.readContract({ address: p, abi: POOL_ABI, functionName: "slot0" }).catch(() => null); // db-first-allow
  if (!s0) { // no slot0 ⇒ Algebra-family (globalState + tickTable)
    const gs = await client.readContract({ address: p, abi: ALGEBRA_ABI, functionName: "globalState" }).catch(() => null); // db-first-allow
    if (!gs) return null;
    const w = Math.floor(Number(gs[1]) / Number(sp)) >> 8;
    const tt = await client.readContract({ address: p, abi: ALGEBRA_ABI, functionName: "tickTable", args: [w] }).then(() => true).catch(() => false); // db-first-allow
    return tt ? "algebra" : null;
  }
  const word = Math.floor(Number(s0[1]) / Number(sp)) >> 8;
  const lens = await client.readContract({ address: TICKLENS_BASE, abi: LENS_ABI, functionName: "getPopulatedTicksInWord", args: [p, word] }).then(() => true).catch(() => false); // db-first-allow
  if (lens) return "ticklens";
  const bm = await client.readContract({ address: p, abi: POOL_ABI, functionName: "tickBitmap", args: [word] }).then(() => true).catch(() => false); // db-first-allow
  return bm ? "storage" : null;
}

/**
 * Read a pool's tick map inside a bounded price window @ `block`. `kind` comes from the cached capability
 * probe. Returns the ticks AND the window they are complete for — the caller stores that window so the
 * simulator can fail-closed when a swap would leave it.
 */
export async function readTicksInWindow(client: PublicClient, opts: { pool: string; kind: TickKind; tickSpacing: number; block: number; priceRatio?: number }): Promise<TickRead | null> {
  const { pool, kind, tickSpacing, block } = opts;
  const blockNumber = BigInt(block);
  const nWords = wordsForPriceRatio(tickSpacing, opts.priceRatio ?? 8);

  // ── current state (also gives us the window centre) ──
  let sqrtPriceX96: bigint, tick: number, liquidity: bigint, dynamicFeePips: number | undefined;
  if (kind === "v4-stateview") {
    const id = pool as `0x${string}`;
    const [s0, liq] = await Promise.all([
      client.readContract({ address: V4_STATEVIEW_BASE, abi: V4_ABI, functionName: "getSlot0", args: [id], blockNumber }).catch(() => null), // db-first-allow
      client.readContract({ address: V4_STATEVIEW_BASE, abi: V4_ABI, functionName: "getLiquidity", args: [id], blockNumber }).catch(() => null), // db-first-allow
    ]);
    if (!s0 || liq == null) return null;
    sqrtPriceX96 = s0[0]; tick = Number(s0[1]); liquidity = liq as bigint;
  } else if (kind === "algebra") {
    const p = pool as Address;
    const [gs, liq] = await Promise.all([
      client.readContract({ address: p, abi: ALGEBRA_ABI, functionName: "globalState", blockNumber }).catch(() => null), // db-first-allow
      client.readContract({ address: p, abi: ALGEBRA_ABI, functionName: "liquidity", blockNumber }).catch(() => null), // db-first-allow
    ]);
    if (!gs || liq == null) return null;
    sqrtPriceX96 = gs[0]; tick = Number(gs[1]); liquidity = liq as bigint;
    dynamicFeePips = Number(gs[2]); // Algebra's fee moves per block — the caller MUST use this, not a tier
  } else {
    const p = pool as Address;
    const [s0, liq] = await Promise.all([
      client.readContract({ address: p, abi: POOL_ABI, functionName: "slot0", blockNumber }).catch(() => null), // db-first-allow
      client.readContract({ address: p, abi: POOL_ABI, functionName: "liquidity", blockNumber }).catch(() => null), // db-first-allow
    ]);
    if (!s0 || liq == null) return null;
    sqrtPriceX96 = s0[0]; tick = Number(s0[1]); liquidity = liq as bigint;
  }

  const centreWord = Math.floor(tick / tickSpacing) >> 8;
  const loWord = centreWord - nWords, hiWord = centreWord + nWords;
  const window: TickWindow = { tickLo: clampTick(loWord * 256 * tickSpacing), tickHi: clampTick(((hiWord + 1) * 256 - 1) * tickSpacing) };
  const ticks: Array<{ tick: number; liquidityNet: bigint }> = [];
  let wordsRead = 0;

  if (kind === "ticklens") {
    // FAST PATH: one call per word returns every populated tick WITH liquidityNet.
    for (let w = loWord; w <= hiWord; w += CHUNK) {
      const hi = Math.min(w + CHUNK - 1, hiWord);
      const calls = []; for (let k = w; k <= hi; k++) calls.push({ address: TICKLENS_BASE, abi: LENS_ABI, functionName: "getPopulatedTicksInWord", args: [pool as Address, k] });
      const res = await mcAll(client, calls, blockNumber);
      if (!res) return null;
      wordsRead += calls.length;
      for (const r of res) for (const t of (r as Array<{ tick: number; liquidityNet: bigint }>)) if (t.liquidityNet !== 0n) ticks.push({ tick: Number(t.tick), liquidityNet: t.liquidityNet });
    }
  } else {
    // UNIVERSAL PATH: bitmap words → set bits → a ticks()/getTickInfo call per initialized tick.
    const isV4 = kind === "v4-stateview", isAlgebra = kind === "algebra";
    const initialized: number[] = [];
    for (let w = loWord; w <= hiWord; w += CHUNK) {
      const hi = Math.min(w + CHUNK - 1, hiWord);
      const calls = []; for (let k = w; k <= hi; k++) calls.push(isV4
        ? { address: V4_STATEVIEW_BASE, abi: V4_ABI, functionName: "getTickBitmap", args: [pool as `0x${string}`, k] }
        : isAlgebra
          ? { address: pool as Address, abi: ALGEBRA_ABI, functionName: "tickTable", args: [k] }
          : { address: pool as Address, abi: POOL_ABI, functionName: "tickBitmap", args: [k] });
      const res = await mcAll(client, calls, blockNumber);
      if (!res) return null;
      wordsRead += calls.length;
      for (let i = 0; i < res.length; i++) { const bm = res[i] as bigint; if (!bm) continue; const wp = w + i; for (let bit = 0; bit < 256; bit++) if ((bm >> BigInt(bit)) & 1n) initialized.push((wp * 256 + bit) * tickSpacing); }
    }
    for (let i = 0; i < initialized.length; i += CHUNK) {
      const slice = initialized.slice(i, i + CHUNK);
      const calls = slice.map((t) => isV4
        ? { address: V4_STATEVIEW_BASE, abi: V4_ABI, functionName: "getTickInfo", args: [pool as `0x${string}`, t] }
        : isAlgebra
          ? { address: pool as Address, abi: ALGEBRA_ABI, functionName: "ticks", args: [t] }   // (liquidityTotal, liquidityDelta)
          : { address: pool as Address, abi: POOL_ABI, functionName: "ticks", args: [t] });
      const res = await mcAll(client, calls, blockNumber);
      if (!res) return null;
      for (let j = 0; j < res.length; j++) { const net = (res[j] as readonly unknown[])[1] as bigint; if (net !== 0n) ticks.push({ tick: slice[j], liquidityNet: net }); }
    }
  }

  ticks.sort((a, b) => a.tick - b.tick);
  return { sqrtPriceX96, tick, liquidity, ticks, window, source: kind, block, words: wordsRead, dynamicFeePips };
}
