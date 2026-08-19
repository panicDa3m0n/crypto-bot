/**
 * KG SUBGRAPH SCAN (Item 3.4e — verify external tick seed + chain bitmap-set certification, KEYLESS). Fetches
 * a V3 pool's initialized ticks from a subgraph (default: Pancake V3 Base on The Graph Studio, no API key),
 * then reads the pool's on-chain tickBitmap SET and checks they are IDENTICAL. This is the cheap certification
 * that the external seed's tick-set matches the contract — a single mismatched bit ⇒ reject the seed ⇒ full
 * storage scan. Proves the external-seed → chain-certify path without needing the Uniswap gateway API key.
 *
 *   ... run --rm brain node dist/scripts/kg-subgraph-scan.js [pool] [subgraphUrl]
 */
import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { loadConfig } from "../config.js";
import { fetchSubgraphTicks } from "../router/tick-subgraph.js";
import { bitmapTickSet } from "../router/tick-storage.js";

const SPACING_ABI = parseAbi(["function tickSpacing() view returns (int24)"]);
const DEFAULT_POOL = "0xbc6c0c5cc269d5febb1ef11c74a1581c34525e21"; // a Pancake V3 Base pool (factory 0x0BFbCF9f)
const DEFAULT_SUBGRAPH = "https://api.studio.thegraph.com/query/45376/exchange-v3-base/version/latest"; // Pancake V3 Base (keyless Studio)

async function main() {
  loadConfig();
  const pool = (process.argv[2] ?? DEFAULT_POOL).toLowerCase() as Address;
  const endpoint = process.argv[3] ?? DEFAULT_SUBGRAPH;
  const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org", { batch: false }) }) as unknown as PublicClient;

  const maxBlock = Number(await client.getBlockNumber().catch(() => 0n)) - 3;
  console.log(`[kg-subgraph-scan] pool=${pool.slice(0, 10)} subgraph=${endpoint.split("/").slice(0, 4).join("/")}… maxBlock=${maxBlock}`);

  const seed = await fetchSubgraphTicks(endpoint, pool, maxBlock);
  if (!seed) { console.log("[kg-subgraph-scan] subgraph fetch failed / no data → would fall back to storage scan"); process.exit(1); }
  if (seed.indexingErrors) { console.log("[kg-subgraph-scan] subgraph hasIndexingErrors → reject seed → storage scan"); process.exit(1); }
  console.log(`[kg-subgraph-scan] seed: ${seed.ticks.length} ticks @ providerBlock=${seed.providerBlock} (provider=${seed.provider})`);
  if (!seed.ticks.length) { console.log("[kg-subgraph-scan] seed empty (pool may have no liquidity) — inconclusive"); process.exit(0); }

  const tickSpacing = Number(await client.readContract({ address: pool, abi: SPACING_ABI, functionName: "tickSpacing", blockNumber: BigInt(seed.providerBlock) }).catch(() => 0));
  if (!tickSpacing) { console.log("[kg-subgraph-scan] tickSpacing read failed"); process.exit(1); }

  const chainSet = await bitmapTickSet(client, pool, tickSpacing, seed.providerBlock);
  if (!chainSet) { console.log("[kg-subgraph-scan] on-chain bitmap read failed (RPC) — retry later"); process.exit(1); }

  const seedSet = new Set(seed.ticks.map((t) => t.tick));
  const missingOnChain = [...seedSet].filter((t) => !chainSet.has(t)); // in subgraph, NOT on chain
  const missingInSeed = [...chainSet].filter((t) => !seedSet.has(t));   // on chain, NOT in subgraph
  const match = missingOnChain.length === 0 && missingInSeed.length === 0;
  console.log(`[kg-subgraph-scan] tickSpacing=${tickSpacing}  subgraph-set=${seedSet.size}  bitmap-set=${chainSet.size}  seed-only=${missingOnChain.length}  chain-only=${missingInSeed.length}`);
  console.log(match
    ? `[kg-subgraph-scan] ✓ SET MATCH — external tick-set == on-chain bitmap-set exactly → seed certifiable (next: ticks() certify liquidityNet + Quoter)`
    : `[kg-subgraph-scan] ✗ SET MISMATCH → REJECT seed → full storage scan (subgraph stale/buggy). seed-only[0..5]=${missingOnChain.slice(0, 5)} chain-only[0..5]=${missingInSeed.slice(0, 5)}`);
  process.exit(match ? 0 : 1);
}
main().catch((e) => { console.error("[kg-subgraph-scan] fatal:", e); process.exit(1); });
