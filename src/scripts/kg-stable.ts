/**
 * KG STABLE (Item 2, step 4 — validate the local Aerodrome-stable math against the LIVE contract). For a
 * matrix of real aerodrome-stable pools (varied token decimals) × sizes × directions, compares
 * `stableGetAmountOut(...)` (our integer port) to `pool.getAmountOut(...)` on-chain, wei-for-wei. Target:
 * delta = 0 everywhere. Until it is, we do NOT un-exclude stable pools from the graph/router. VALIDATION
 * HARNESS: reads live on purpose (allowed — it verifies the model against chain truth).
 *
 *   ... run --rm brain node dist/scripts/kg-stable.js [poolsToTest=6]
 */
import { parseAbi, type Address } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { stableGetAmountOut } from "../router/solidly-math.js";

const POOL_ABI = parseAbi([
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function stable() view returns (bool)",
  "function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"
]);
const FACTORY_ABI = parseAbi(["function getFee(address pool, bool stable) view returns (uint256)"]);
const ERC20_DEC = parseAbi(["function decimals() view returns (uint8)"]);

async function main() {
  const limit = Number(process.argv[2] ?? 6);
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID;
  const rc = <T>(p: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => chain.precision.readContract(p as never).catch(() => chain.primary.readContract(p as never)) as Promise<T>;

  // Most pre-existing Aerodrome pools were discovered via Sync (no stable/volatile distinction) → labelled
  // "aerodrome". Read the immutable stable() flag live to find the real stable ones (DB classification is
  // fixed separately via the enricher). Include the correctly-labelled ones too.
  const candidates = [
    ...(await db.poolsByArchetype(cid, "aerodrome-stable", 100).catch(() => [])),
    ...(await db.poolsByArchetype(cid, "aerodrome", 800).catch(() => []))
  ];
  console.log(`[kg-stable] scanning ${candidates.length} aerodrome pools for the stable() flag → testing up to ${limit}`);

  let tested = 0, exactPools = 0;
  const seenDec = new Set<string>();
  const results: Array<{ pool: string; dec: string; maxAbsDelta: bigint; rows: number; exact: boolean }> = [];

  for (const row of candidates) {
    if (tested >= limit && seenDec.size >= 3) break;
    const pool = row.address as Address;
    try {
      const isStable = await rc<boolean>({ address: pool, abi: POOL_ABI, functionName: "stable" }).catch(() => false);
      if (!isStable) continue;
      const [res, t0, t1, factory] = await Promise.all([
        rc<[bigint, bigint, bigint]>({ address: pool, abi: POOL_ABI, functionName: "getReserves" }),
        rc<Address>({ address: pool, abi: POOL_ABI, functionName: "token0" }),
        rc<Address>({ address: pool, abi: POOL_ABI, functionName: "token1" }),
        rc<Address>({ address: pool, abi: POOL_ABI, functionName: "factory" })
      ]);
      const [r0, r1] = [res[0], res[1]];
      if (r0 <= 0n || r1 <= 0n) continue;
      const [d0, d1, feeRaw] = await Promise.all([
        rc<number>({ address: t0, abi: ERC20_DEC, functionName: "decimals" }).then(Number),
        rc<number>({ address: t1, abi: ERC20_DEC, functionName: "decimals" }).then(Number),
        rc<bigint>({ address: factory, abi: FACTORY_ABI, functionName: "getFee", args: [pool, true] })
      ]);
      const decKey = `${d0}/${d1}`;
      if (tested >= limit && seenDec.has(decKey)) continue; // once past limit, only keep NEW decimal combos
      const dec0 = 10n ** BigInt(d0), dec1 = 10n ** BigInt(d1), feeBps = Number(feeRaw);

      // size matrix as fractions of the input reserve; both directions.
      const fractions = [1_000_000n, 100_000n, 10_000n, 1_000n, 100n, 10n]; // reserve/frac = dust … ~10%
      let maxAbs = 0n, n = 0;
      for (const inIs0 of [true, false]) {
        const rIn = inIs0 ? r0 : r1;
        for (const f of fractions) {
          const amountIn = rIn / f;
          if (amountIn <= 0n) continue;
          const local = stableGetAmountOut(amountIn, inIs0, r0, r1, dec0, dec1, feeBps);
          const onchain = await rc<bigint>({ address: pool, abi: POOL_ABI, functionName: "getAmountOut", args: [amountIn, inIs0 ? t0 : t1] });
          const delta = onchain > local ? onchain - local : local - onchain;
          if (delta > maxAbs) maxAbs = delta;
          n++;
        }
      }
      const exact = maxAbs === 0n;
      if (exact) exactPools++;
      seenDec.add(decKey); tested++;
      results.push({ pool, dec: decKey, maxAbsDelta: maxAbs, rows: n, exact });
      console.log(`  ${pool.slice(0, 10)} dec=${decKey} fee=${feeBps}bp  rows=${n}  maxAbsDelta=${maxAbs} ${exact ? "✓ EXACT" : "✗ MISMATCH"}`);
    } catch (e) { logger.debug({ err: e, pool }, "stable test skip"); }
  }

  console.log(`[kg-stable] pools tested=${tested} exact=${exactPools} decimalCombos=${[...seenDec].join(",")}`);
  console.log(exactPools === tested && tested > 0
    ? `[kg-stable] ✓ local stable math == on-chain getAmountOut wei-for-wei across all combos → safe to un-exclude`
    : `[kg-stable] ✗ mismatch(es) remain — do NOT un-exclude; inspect rounding/fee source before proceeding`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-stable] fatal:", e); process.exit(1); });
