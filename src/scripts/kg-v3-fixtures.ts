/**
 * KG V3 DIFFERENTIAL-FIXTURE GENERATOR — captures golden (pool snapshot @B, direction, amountIn) → (QuoterV2
 * amountOut, sqrtPriceAfter, ticksCrossed) tuples across Uniswap fee tiers, both directions, and a range of
 * initialized-tick crossing counts. Writes test/fixtures/v3-sim-matrix.json, which the PERMANENT offline test
 * (test/v3-sim-matrix.test.ts) replays: the differential proof that `simulateExactInputStateful` reproduces
 * the on-chain contract bit-for-bit — no RPC in CI. Re-run this only to refresh the goldens.
 *
 *   ... run --rm -e SCAN_RPC=<reliable rpc> brain node dist/scripts/kg-v3-fixtures.js
 */
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseAbi, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { createLogger } from "../logger.js";
import { scanTickMap } from "../router/tick-storage.js";
import { simulateExactInputStateful, type V3PoolSim } from "../router/v3-sim.js";

const UNIV3_QUOTER_BASE = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address;
const QUOTER_ABI = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
const FEE_TO_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const CROSS_TARGETS = [0, 1, 10, 50, 100, 500];
// One pool per fee tier (deep where possible). 500 = canonical WETH/USDC (reaches 500 crossings); 10000 = the
// pool that exposed the word-stepping bug. 100/3000 filled from the DB at runtime (deepest available).
const POOLS: Array<{ fee: number; pool: string }> = [
  { fee: 500, pool: "0xd0b53d9277642d899df5c87a3966a349a798f224" },
  { fee: 10000, pool: "0xdc26f2cef9af2de34e6ff0d01c66a602e06c638d" },
];

async function quoter(client: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number, block: bigint) {
  const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] });
  const r = await client.call({ to: UNIV3_QUOTER_BASE, data, blockNumber: block });
  const [amountOut, sqrtAfter, crossed] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", data: r.data! }) as [bigint, bigint, number, bigint];
  return { amountOut, sqrtAfter, crossed: Number(crossed) };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID;
  const client = createPublicClient({ chain: base, transport: http(process.env.SCAN_RPC ?? "https://base.drpc.org", { batch: false }) }) as unknown as PublicClient;

  // Fill fee 100 / 3000 with the deepest Uniswap pool we can find (most tick rows via a quick probe).
  const UNIV3 = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
  const allV3 = await db.poolsByArchetype(cid, "v3", 4000).catch(() => []);
  for (const fee of [100, 3000]) {
    const cands = allV3.filter((p) => { const mm = (p.meta ?? {}) as { factory?: string; fee?: unknown; token0?: string }; return (mm.factory ?? "").toLowerCase() === UNIV3 && Number(mm.fee) === fee && !!mm.token0 && p.address.length === 42; }).slice(0, 12);
    let best: { pool: string; n: number } | null = null;
    const B0 = Number(await chain.primary.getBlockNumber().catch(() => 0n)) - 3;
    for (const r of cands) {
      const s = await scanTickMap(client, r.address as Address, FEE_TO_SPACING[fee], B0).catch(() => null);
      if (s && (!best || s.ticks.length > best.n)) best = { pool: r.address, n: s.ticks.length };
      if (best && best.n >= 40) break;
    }
    if (best) { POOLS.push({ fee, pool: best.pool }); logger.info({ fee, pool: best.pool, ticks: best.n }, "picked pool"); }
  }

  const fixtures: unknown[] = [];
  for (const { fee, pool } of POOLS) {
    const ent = await db.getEntity(cid, pool.toLowerCase()).catch(() => []);
    const m = (ent[0]?.meta ?? {}) as { token0?: string; token1?: string; tickSpacing?: unknown };
    if (!m.token0 || !m.token1) { console.log(`skip ${pool} (no tokens)`); continue; }
    const tickSpacing = Number(m.tickSpacing) > 0 ? Number(m.tickSpacing) : FEE_TO_SPACING[fee];
    const B = Number(await chain.primary.getBlockNumber().catch(() => 0n)) - 3;
    const snap = await scanTickMap(client, pool.toLowerCase() as Address, tickSpacing, B);
    if (!snap) { console.log(`skip ${pool} (scan failed)`); continue; }
    const sim: V3PoolSim = { sqrtPriceX96: snap.sqrtPriceX96, liquidity: snap.liquidity, tick: snap.tick, feePips: fee, tickSpacing, ticks: snap.ticks };

    for (const zeroForOne of [true, false]) {
      const tokenIn = (zeroForOne ? m.token0 : m.token1) as Address;
      const tokenOut = (zeroForOne ? m.token1 : m.token0) as Address;
      const seenCross = new Set<number>();
      for (const target of CROSS_TARGETS) {
        // grow amountIn until the sim reaches >= target crossings (and isn't partial); skip if unreachable.
        let amountIn = 0n;
        for (let mul = 1n, i = 0; i < 60; i++, mul = (mul * 3n) / 2n + 1n) {
          const probe = (snap.liquidity / 1_000_000n || 1n) * mul;
          const r = simulateExactInputStateful(sim, zeroForOne, probe);
          if (!r) break;
          if (r.partial) break;
          if (r.ticksCrossed >= target) { amountIn = probe; break; }
        }
        if (amountIn <= 0n) continue;
        const local = simulateExactInputStateful(sim, zeroForOne, amountIn)!;
        if (seenCross.has(local.ticksCrossed)) continue; // dedupe identical crossing counts
        seenCross.add(local.ticksCrossed);
        const q = await quoter(client, tokenIn, tokenOut, amountIn, fee, BigInt(snap.block)).catch(() => null);
        if (!q) continue;
        fixtures.push({
          label: `fee${fee} ${zeroForOne ? "0to1" : "1to0"} x${local.ticksCrossed}`,
          feePips: fee, tickSpacing, zeroForOne,
          sqrtPriceX96: snap.sqrtPriceX96.toString(), tick: snap.tick, liquidity: snap.liquidity.toString(),
          ticks: snap.ticks.map((t) => ({ tick: t.tick, liquidityNet: t.liquidityNet.toString() })),
          amountIn: amountIn.toString(),
          expectedOut: q.amountOut.toString(), expectedSqrtAfter: q.sqrtAfter.toString(), expectedCrossed: q.crossed,
          localOut: local.amountOut.toString(), localSqrtAfter: local.sqrtPriceX96.toString(), localCrossed: local.ticksCrossed,
          match: q.amountOut === local.amountOut && q.sqrtAfter === local.sqrtPriceX96,
        });
        console.log(`  fee${fee} ${zeroForOne ? "0→1" : "1→0"} x${local.ticksCrossed}: ${q.amountOut === local.amountOut && q.sqrtAfter === local.sqrtPriceX96 ? "EXACT ✓" : "DIVERGE ✗"}`);
      }
    }
  }

  const path = "test/fixtures/v3-sim-matrix.json";
  writeFileSync(path, JSON.stringify(fixtures, null, 0));
  console.log(`\nwrote ${fixtures.length} fixtures → ${path}  (${fixtures.filter((f) => (f as { match: boolean }).match).length} EXACT)`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
