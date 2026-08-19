/**
 * KG STORAGE SCAN (Item 3.4b+c — verify the storage snapshot reproduces the contract via QuoterV2). Scans
 * a real Uniswap-V3 pool's COMPLETE tick map from on-chain state (tickBitmap+ticks, Multicall3, all pinned
 * to one block B), builds an ephemeral V3PoolSim, and validates it against QuoterV2 with probes that ACTUALLY
 * cross ticks: amountOut + sqrtPriceAfter + initializedTicksCrossed must match EXACTLY. This certifies the
 * map produces the same swap state-transition as the contract — not merely "found N ticks". VALIDATION
 * HARNESS (reads live @ B on purpose).
 *
 *   ... run --rm brain node dist/scripts/kg-storage-scan.js [poolAddress]
 */
import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { scanTickMap, validateSnapshotVsQuoter, bitmapWordRange, tickStorageProfile } from "../router/tick-storage.js";

const UNIV3_QUOTER_BASE = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address; // Uniswap V3 QuoterV2 on Base
const SPACING_ABI = parseAbi(["function tickSpacing() view returns (int24)"]);
const FEE_TO_SPACING: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 }; // 2500=Pancake tier

async function main() {
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID;
  // Reliable client for the scan (public lanes throttle a multi-hundred-word scan). Overridable via SCAN_RPC.
  const client = createPublicClient({ chain: base, transport: http(process.env.SCAN_RPC ?? "https://base.drpc.org", { batch: false }) }) as unknown as PublicClient;

  // Pick a Uniswap V3 pool (default: canonical WETH/USDC 0.05%).
  const pool = (process.argv[2] ?? "0xd0b53d9277642d899DF5C87A3966A349A798F224").toLowerCase() as Address;
  const ent = await db.getEntity(cid, pool).catch(() => []);
  const m = (ent[0]?.meta ?? {}) as { token0?: string; token1?: string; fee?: unknown; factory?: string; tickSpacing?: unknown };
  if (!m.token0 || !m.token1) { console.log("[kg-storage-scan] pool not in DB / missing tokens"); process.exit(1); }
  const feePips = Number(m.fee) > 0 ? Number(m.fee) : 500;
  const tickSpacing = Number(m.tickSpacing) > 0 ? Number(m.tickSpacing) : (FEE_TO_SPACING[feePips] ?? Number(await chain.primary.readContract({ address: pool, abi: SPACING_ABI, functionName: "tickSpacing" }).catch(() => 10)));
  const profile = tickStorageProfile(m.factory, { DEX_FACTORY: config.DEX_FACTORY, UNIV3_QUOTER: UNIV3_QUOTER_BASE });
  const { words } = bitmapWordRange(tickSpacing);

  const B = Number(await chain.primary.getBlockNumber().catch(() => 0n)) - 2; // pin all reads to one settled block
  console.log(`[kg-storage-scan] pool=${pool.slice(0, 10)} fee=${feePips} tickSpacing=${tickSpacing} words=${words} @B=${B} quoter=${profile?.quoter ? "yes" : "NONE(no-certify)"}`);

  const snap = await scanTickMap(client, pool, tickSpacing, B);
  if (!snap) { console.log("[kg-storage-scan] scan failed or too large (cost guard)"); await db.close(); process.exit(1); }
  console.log(`[kg-storage-scan] scanned: ${snap.ticks.length} initialized ticks, currentTick=${snap.tick}, liquidity=${snap.liquidity}`);

  if (!profile?.quoter) { console.log("[kg-storage-scan] no known Quoter for this fork → scan-only, NOT certifiable"); await db.close(); process.exit(0); }
  const v = await validateSnapshotVsQuoter(client, profile.quoter, snap, m.token0 as Address, m.token1 as Address, feePips, tickSpacing);
  console.log(`[kg-storage-scan] validation: ${v.detail}`);
  console.log(v.validated
    ? `[kg-storage-scan] ✓ VALIDATED — storage map reproduces QuoterV2 (amountOut+sqrtPriceAfter+ticksCrossed exact, ${v.directions} tick-crossing direction(s)) → certifiable complete`
    : `[kg-storage-scan] ✗ NOT validated (mismatch or no tick-crossing probe) → do NOT certify`);
  await db.close().catch(() => undefined);
  process.exit(v.validated ? 0 : 1);
}
main().catch((e) => { console.error("[kg-storage-scan] fatal:", e); process.exit(1); });
