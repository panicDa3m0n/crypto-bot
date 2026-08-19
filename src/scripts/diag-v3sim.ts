/**
 * VERIFY the local V3 swap sim against the on-chain Quoter (ground truth). Reads a real pool's live
 * state (slot0 sqrtPrice+tick, liquidity) via RPC, runs simulateExactInput with the tick data we have,
 * and compares to quoteExactInputSingle at several sizes. In-tick sizes must match EXACTLY (proves the
 * SqrtPriceMath); larger sizes reveal how much tick-map completeness matters.
 *
 *   ... run --rm brain node dist/scripts/diag-v3sim.js <poolAddress>
 */
import { parseAbi, type Address } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { simulateExactInput } from "../router/v3-sim.js";

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)"
]);
const QUOTER_ABI = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]);

async function main() {
  const pool = (process.argv[2] ?? "").toLowerCase() as Address;
  if (!pool.startsWith("0x")) throw new Error("usage: diag-v3sim <poolAddress>");
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const read = <T>(fn: string, args: unknown[] = []) => chain.precision.readContract({ address: pool, abi: POOL_ABI, functionName: fn as never, args: args as never }) as Promise<T>;

  const [slot0, liquidity, token0, token1, fee] = await Promise.all([
    read<readonly [bigint, number, number, number, number, number, boolean]>("slot0"),
    read<bigint>("liquidity"), read<string>("token0"), read<string>("token1"), read<number>("fee")
  ]);
  const [sqrtPriceX96, tick] = slot0;
  const ticks = (await db.tickLiquidity(config.CHAIN_ID, pool).catch(() => [])) as Array<{ tick: number; liquidityNet: bigint }>;
  console.log(`pool ${pool}  fee=${fee}  tick=${tick}  L=${liquidity}  indexedTicks=${ticks.length}`);
  console.log(`token0=${token0}  token1=${token1}\n`);

  const quoter = config.DEX_QUOTER as Address;
  const sizes = [10n ** 15n, 10n ** 16n, 10n ** 17n, 10n ** 18n, 10n ** 19n]; // 0.001 … 10 token0
  console.log(`amountIn(token0)      simOut            quoterOut         match  partial`);
  for (const amt of sizes) {
    const sim = simulateExactInput({ sqrtPriceX96, liquidity, tick, feePips: fee, ticks }, true, amt);
    let quoterOut = 0n;
    try { const r = await chain.precision.simulateContract({ address: quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn: token0 as Address, tokenOut: token1 as Address, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] }); quoterOut = r.result[0]; }
    catch (e) { console.log(`${amt.toString().padEnd(20)} quoter revert: ${String(e).slice(0, 40)}`); continue; }
    const so = sim?.amountOut ?? 0n;
    const diff = so > quoterOut ? so - quoterOut : quoterOut - so;
    const relBps = quoterOut > 0n ? Number((diff * 10000n) / quoterOut) : 0;
    console.log(`${amt.toString().padEnd(20)} ${so.toString().padEnd(17)} ${quoterOut.toString().padEnd(17)} ${relBps === 0 ? "EXACT" : relBps + "bps"}   ${sim?.partial ?? "-"}`);
  }
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[diag-v3sim] fatal:", e); process.exit(1); });
