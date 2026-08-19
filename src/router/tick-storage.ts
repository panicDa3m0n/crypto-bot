import { parseAbi, encodeFunctionData, decodeFunctionResult, type Address, type PublicClient } from "viem";
import { MIN_TICK, MAX_TICK, getTickAtSqrtRatio } from "./tick-math.js";
import { simulateExactInputStateful, type V3PoolSim } from "./v3-sim.js";

/**
 * TICK-MAP STORAGE SCAN (Item 3.4) — read a concentrated pool's COMPLETE tick map from its current on-chain
 * state (tickBitmap + ticks), producing an AUTHORITATIVE SNAPSHOT at a pinned block B (a snapshot summarises
 * all prior history → the caller REPLACES, never sums). No archive state (B is recent). Everything here is
 * protocol-aware and validation-gated: a snapshot is only trustworthy if the reconstructed map reproduces
 * the contract's swap via QuoterV2 (amountOut + sqrtPriceAfter + initializedTicksCrossed), with probes that
 * ACTUALLY cross ticks. A fork with no known Quoter can be scanned but NOT certified.
 */

// Canonical Multicall3 — same address on every OP-stack chain (github.com/mds1/multicall3).
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
const CHUNK = 60; // reads per Multicall3 eth_call (public-RPC gas + reliability)

const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)"
]);
const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
]);

/** A protocol's tick-storage capabilities. `quoter` present ⇒ we can independently CERTIFY; absent ⇒ scan
 * only (no certification for that fork until its validator is added). Never certify a fork just because
 * tickBitmap() answered. */
export interface TickStorageProfile {
  bitmapKind: "univ3";
  quoter: Address | null;
}

// PancakeSwap V3 on Base — a fork of Uniswap V3 sharing the SAME certified core math (TickMath / SwapMath /
// tickBitmap word-stepping / fee application), verified BIT-EXACT vs its own QuoterV2 across fee tiers 500 &
// 2500 (spacing 50), both directions, 0..111 crossings (2026-08-19 differential harness). It differs only in
// factory + Quoter address, so our V3PoolSim certifies it directly. QuoterV2 ABI is identical to Uniswap's.
const PANCAKE_V3_FACTORY_BASE = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865";
const PANCAKE_V3_QUOTER_BASE = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" as Address;

/** Resolve a pool's storage profile from its factory. UniV3-classic and its verified fork Pancake certify via
 * their Quoter; other/unknown forks get `quoter: null` (scan-capable, not certify-capable until differentially
 * verified — never trust an unproven fork's Quoter). */
export function tickStorageProfile(factory: string | undefined, cfg: { DEX_FACTORY: string; UNIV3_QUOTER?: string }): TickStorageProfile | null {
  const f = factory?.toLowerCase();
  if (!f) return null;
  if (f === cfg.DEX_FACTORY.toLowerCase()) return { bitmapKind: "univ3", quoter: (cfg.UNIV3_QUOTER as Address | undefined) ?? null };
  if (f === PANCAKE_V3_FACTORY_BASE) return { bitmapKind: "univ3", quoter: PANCAKE_V3_QUOTER_BASE }; // verified fork
  return { bitmapKind: "univ3", quoter: null }; // unknown v3 fork: scan-capable, not certify-capable yet
}

/** tickSpacing → the theoretical bitmap word range covering the WHOLE tick domain (signed/floor semantics
 * for negatives, as V3 uses). We must enumerate all words to claim completeness — not just near the tick. */
export function bitmapWordRange(tickSpacing: number): { minWord: number; maxWord: number; words: number } {
  const cMin = Math.floor(MIN_TICK / tickSpacing), cMax = Math.floor(MAX_TICK / tickSpacing);
  const minWord = cMin >> 8, maxWord = cMax >> 8; // arithmetic shift = floor for negatives
  return { minWord, maxWord, words: maxWord - minWord + 1 };
}

export interface TickSnapshot { sqrtPriceX96: bigint; tick: number; liquidity: bigint; ticks: Array<{ tick: number; liquidityNet: bigint }>; block: number }

/** Read the COMPLETE tick map @ `block` via Multicall3 (all pinned to the same B). Returns null if the pool
 * is too large for one scan (`words > maxWords`, a cost guard — deferred) or a read fails. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type PoolCall = { address: Address; abi: typeof V3_POOL_ABI; functionName: "tickBitmap" | "ticks"; args: readonly [number] };

// Multicall that retries ONLY the still-failed sub-calls — flaky public/aggregator RPCs return PARTIAL
// results (random sub-call failures, not clean throttling), and a COMPLETE snapshot needs every read.
async function mcRetry(client: PublicClient, contracts: readonly PoolCall[], blockNumber: bigint): Promise<unknown[] | null> {
  const out = new Array<unknown>(contracts.length);
  let pending = contracts.map((_, i) => i);
  for (let round = 0; round < 12 && pending.length; round++) {
    const sub = pending.map((i) => contracts[i]);
    const r = await client.multicall({ contracts: sub, blockNumber, multicallAddress: MULTICALL3, allowFailure: true }).catch(() => null); // db-first-allow: storage scanner
    if (r) { const still: number[] = []; for (let j = 0; j < pending.length; j++) { if (r[j].status === "success") out[pending[j]] = r[j].result; else still.push(pending[j]); } pending = still; }
    if (pending.length) await sleep(250 * (round + 1));
  }
  return pending.length ? null : out;
}

/** Read ONLY the bitmaps → the SET of initialized ticks (the cheap check to certify a subgraph seed: the
 * external tick-set must equal the on-chain bitmap set exactly, else reject the seed → full storage scan). */
export async function bitmapTickSet(client: PublicClient, pool: Address, tickSpacing: number, block: number, maxWords = 2000): Promise<Set<number> | null> {
  const { minWord, maxWord, words } = bitmapWordRange(tickSpacing);
  if (words > maxWords) return null;
  const blockNumber = BigInt(block);
  const set = new Set<number>();
  for (let w = minWord; w <= maxWord; w += CHUNK) {
    const hi = Math.min(w + CHUNK - 1, maxWord);
    const calls: PoolCall[] = []; for (let k = w; k <= hi; k++) calls.push({ address: pool, abi: V3_POOL_ABI, functionName: "tickBitmap", args: [k] });
    const bitmaps = await mcRetry(client, calls, blockNumber);
    if (!bitmaps) return null;
    await sleep(400);
    for (let i = 0; i < bitmaps.length; i++) { const bm = bitmaps[i] as bigint; if (bm === 0n) continue; const wp = w + i; for (let bit = 0; bit < 256; bit++) if ((bm >> BigInt(bit)) & 1n) set.add((wp * 256 + bit) * tickSpacing); }
  }
  return set;
}

export async function scanTickMap(client: PublicClient, pool: Address, tickSpacing: number, block: number, maxWords = 2000): Promise<TickSnapshot | null> {
  const { minWord, maxWord, words } = bitmapWordRange(tickSpacing);
  if (words > maxWords) return null; // spacing=1 giants → chunked/incremental scan (future), skip for now
  const blockNumber = BigInt(block);
  const mc = (contracts: readonly PoolCall[]) => mcRetry(client, contracts, blockNumber);

  const [slot0, liquidity] = await Promise.all([
    client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "slot0", blockNumber }).catch(() => null), // db-first-allow: storage scanner (write-side ingestion)
    client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "liquidity", blockNumber }).catch(() => null) // db-first-allow: storage scanner
  ]);
  if (!slot0 || liquidity == null) return null;
  const sqrtPriceX96 = slot0[0] as bigint, curTick = Number(slot0[1]);

  // 1) tickBitmap for every word (Multicall3, pinned to B, CHUNKED so one eth_call stays within gas caps).
  const initTicks: number[] = [];
  for (let w = minWord; w <= maxWord; w += CHUNK) {
    const hi = Math.min(w + CHUNK - 1, maxWord);
    const wordCalls = []; for (let k = w; k <= hi; k++) wordCalls.push({ address: pool, abi: V3_POOL_ABI, functionName: "tickBitmap" as const, args: [k] as const });
    const bitmaps = await mc(wordCalls);
    if (!bitmaps) return null; // a word never resolved (after retries) → can't claim completeness
    await sleep(400);
    for (let i = 0; i < bitmaps.length; i++) {
      const bm = bitmaps[i] as bigint; if (bm === 0n) continue;
      const wordPos = w + i;
      for (let bit = 0; bit < 256; bit++) if ((bm >> BigInt(bit)) & 1n) initTicks.push((wordPos * 256 + bit) * tickSpacing);
    }
  }

  // 2) ticks(tick) for each initialized tick → liquidityNet (Multicall3, pinned to B, chunked).
  const ticks: Array<{ tick: number; liquidityNet: bigint }> = [];
  for (let off = 0; off < initTicks.length; off += CHUNK) {
    const batch = initTicks.slice(off, off + CHUNK).map((t) => ({ address: pool, abi: V3_POOL_ABI, functionName: "ticks" as const, args: [t] as const }));
    const res = await mc(batch);
    if (!res) return null;
    await sleep(400);
    for (let i = 0; i < res.length; i++) { const net = (res[i] as readonly unknown[])[1] as bigint; if (net !== 0n) ticks.push({ tick: initTicks[off + i], liquidityNet: net }); }
  }
  return { sqrtPriceX96, tick: curTick, liquidity: liquidity as bigint, ticks, block };
}

export interface ValidationResult { validated: boolean; directions: number; detail: string }

/** Certification gate: build an ephemeral V3PoolSim from the snapshot and, per direction, quote a swap that
 * ACTUALLY crosses initialized ticks, comparing amountOut + sqrtPriceAfter + initializedTicksCrossed to
 * QuoterV2 (all @ B). A snapshot is validated only if ≥1 direction has a tick-crossing probe that matches
 * EXACTLY. Directions with no reasonable tick-crossing input are `not-validated`, never invented. */
export async function validateSnapshotVsQuoter(client: PublicClient, quoter: Address, snap: TickSnapshot, token0: Address, token1: Address, feePips: number, tickSpacing: number): Promise<ValidationResult> {
  const blockNumber = BigInt(snap.block);
  const sim: V3PoolSim = { sqrtPriceX96: snap.sqrtPriceX96, liquidity: snap.liquidity, tick: snap.tick, feePips, tickSpacing, ticks: snap.ticks };
  let validated = 0, tried = 0; const notes: string[] = [];

  for (const zeroForOne of [true, false]) {
    const tokenIn = zeroForOne ? token0 : token1, tokenOut = zeroForOne ? token1 : token0;
    // Size a probe that crosses ≥1 initialized tick: grow from a fraction of in-range liquidity until the
    // local sim reports ticksCrossed>0 (or give up → this direction is not tick-crossing-testable).
    let amountIn = 0n, local = null as ReturnType<typeof simulateExactInputStateful>;
    for (const mul of [1n, 10n, 100n, 1000n, 10000n, 100000n, 1000000n, 10000000n]) {
      const probe = (snap.liquidity / 1000000n) * mul;
      if (probe <= 0n) continue;
      const r = simulateExactInputStateful(sim, zeroForOne, probe);
      if (r && r.ticksCrossed > 0 && !r.partial) { amountIn = probe; local = r; break; }
      if (r && r.partial) break; // ran out of our ticks → can't build an exact tick-crossing probe here
    }
    if (amountIn <= 0n || !local) { notes.push(`${zeroForOne ? "0→1" : "1→0"}:no-cross`); continue; }
    tried++;
    try {
      // QuoterV2.quoteExactInputSingle is NON-view (returns via normal call) → raw eth_call @ B, not readContract.
      const data = encodeFunctionData({ abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee: feePips, sqrtPriceLimitX96: 0n }] });
      let ret: { data?: `0x${string}` } | null = null;
      for (let a = 0; a < 6 && !ret; a++) { ret = await client.call({ to: quoter, data, blockNumber }).catch(() => null); if (!ret) await sleep(400 * (a + 1)); } // db-first-allow: storage-scan validator (write-side); retry public-RPC throttling
      if (!ret) { notes.push(`${zeroForOne ? "0→1" : "1→0"}:quoter-unreachable`); continue; }
      const q = decodeFunctionResult({ abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle", data: ret.data ?? "0x" }) as readonly [bigint, bigint, number, bigint];
      const [qOut, qSqrt, qCrossed] = [q[0], q[1], Number(q[2])];
      // amountOut + sqrtPriceAfter EXACT = the state transition matches the contract (the real proof).
      // ticksCrossed is a counting-CONVENTION signal (QuoterV2 counts the boundary the swap ends on) → ±1.
      const match = qOut === local.amountOut && qSqrt === local.sqrtPriceX96 && Math.abs(qCrossed - local.ticksCrossed) <= 1;
      notes.push(`${zeroForOne ? "0→1" : "1→0"}:${match ? `EXACT(x${local.ticksCrossed}/${qCrossed})` : `MISMATCH(out ${local.amountOut}/${qOut} sqrt ${local.sqrtPriceX96}/${qSqrt} x ${local.ticksCrossed}/${qCrossed})`}`);
      if (match) validated++;
    } catch (e) { const msg = (e as { shortMessage?: string })?.shortMessage ?? String(e); notes.push(`${zeroForOne ? "0→1" : "1→0"}:quoter-err(${msg.slice(0, 60)})`); }
  }
  // Validated iff at least one direction produced a tick-crossing EXACT match and NONE mismatched.
  const anyMismatch = notes.some((n) => n.includes("MISMATCH"));
  return { validated: validated > 0 && !anyMismatch, directions: validated, detail: notes.join(" ") };
}
