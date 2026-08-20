/**
 * KG EXPORT (Item 7 / KG-v2 spike) — dump the current DB liquidity graph to a compact JSON so a LOCAL Memgraph
 * spike can be benchmarked on real Base data without touching production. Emits the topology + capability the
 * traversal needs (pools with archetype/fee/factory/encodable/depth/tickComplete + token decimals/blacklist),
 * NOT the heavy tick state (that stays in Postgres and feeds the kernel). READ-ONLY.
 *
 *   ... run --rm brain node dist/scripts/kg-export.js > /tmp/kg-graph.json
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { LocalRouter } from "../router/router.js";
import { loadLiquidityGraph } from "../kg/graph-loader.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID;
  const router = new LocalRouter(config, logger, db, chain);
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();

  const g = await loadLiquidityGraph(db, cid);
  const bl = await db.listBlacklist().catch(() => [] as Array<{ scope: string; value: string }>);
  const blacklisted = new Set(bl.filter((b) => b.scope === "token").map((b) => b.value.toLowerCase()));

  const depthFor = (p: import("../router/types.js").PoolState, token: string): bigint => {
    if (p.sqrtPriceX96 != null && p.liquidity != null) return p.liquidity;
    const r0 = p.r0 ?? 0n, r1 = p.r1 ?? 0n; return p.token0 === token ? r0 : r1;
  };
  const pools = [...g.pools.values()].map((p) => ({
    id: p.address, t0: p.token0, t1: p.token1, arch: p.archetype, fee: p.feePpm, factory: p.factory ?? null,
    enc: router.execCapability(p) != null, tick: p.tickCoverage === "complete",
    d0: depthFor(p, p.token0).toString(), d1: depthFor(p, p.token1).toString(),
    priced: (p.r0 != null && p.r1 != null) || (p.sqrtPriceX96 != null && p.liquidity != null),
  }));
  const tokens = [...g.adjacency.keys()].map((t) => ({ a: t, dec: g.decimals.get(t) ?? null, bl: blacklisted.has(t) }));

  const out = process.argv[2] ?? "/app/logs/kg-graph.json"; // mounted (./logs) → scp from host; sync write, no flush race
  writeFileSync(out, JSON.stringify({ chainId: cid, head: g.head, weth, usdc, tokens, pools }));
  console.error(`[kg-export] wrote ${out}: ${tokens.length} tokens, ${pools.length} pools`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-export] fatal:", e); process.exit(1); });
