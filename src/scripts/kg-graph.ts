/**
 * KG GRAPH (Item 4.1 — verify the Full Liquidity Graph Loader). Loads the COMPLETE DB-only graph, prints its
 * shape (pools/tokens/archetypes/exactness/decimals/freshness), and contrasts it with the OLD seed universe
 * (60 tokens × poolsForToken) that the arb harness used — quantifying the liquidity the sampling hid.
 * READ-ONLY, no chain RPC.
 *
 *   ... run --rm brain node dist/scripts/kg-graph.js
 */
import { loadConfig } from "../config.js";
import { Database } from "../db.js";
import { loadLiquidityGraph } from "../kg/graph-loader.js";

async function main() {
  const config = loadConfig();
  const db = new Database(config.DATABASE_URL);
  const cid = config.CHAIN_ID;
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();
  const sym = (t: string) => t === weth ? "WETH" : t === usdc ? "USDC" : t.slice(0, 10);

  const t0 = Date.now();
  const g = await loadLiquidityGraph(db, cid, { staleBlocks: 300 });
  const dt = Date.now() - t0;
  const s = g.stats;
  console.log(`[kg-graph] loaded in ${dt}ms  head=${g.head} lag=${g.lag} synced=${g.synced}`);
  console.log(`[kg-graph] pools=${s.poolsTotal} priced=${s.poolsPriced} modelable=${s.modelable} unmodeled=${s.unmodeled} tokens=${s.tokens} edges=${s.edges}`);
  console.log(`[kg-graph] archetypes=${JSON.stringify(s.byArchetype)}`);
  console.log(`[kg-graph] concentrated=${s.concentrated} tickComplete=${s.tickComplete} (${s.concentrated ? (100 * s.tickComplete / s.concentrated).toFixed(2) : "0"}%) stable=${s.stable} decimalsMissing=${s.decimalsMissing} stale(>300blk)=${s.stalePools}`);
  const hubs = [...g.adjacency.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
  console.log(`[kg-graph] top token hubs (by edges): ${hubs.map(([t, e]) => `${sym(t)}:${e.length}`).join("  ")}`);

  // WETH/USDC edges across venues — the "same-pair curve disagreement" surface (4.2 preview).
  const wu = [...g.pools.values()].filter((p) => { const set = new Set([p.token0, p.token1]); return set.has(weth) && set.has(usdc); });
  console.log(`[kg-graph] WETH/USDC edges = ${wu.length}: ${wu.map((p) => `${p.archetype}${p.feePpm ? "/" + p.feePpm : ""}${p.tickCoverage === "complete" ? "✓" : ""}`).join("  ")}`);

  // Contrast with the OLD seed universe (what the arb harness actually saw).
  const cand = await db.arbCandidateTokens(cid, weth, 60).catch(() => []);
  const seeds = new Set<string>([weth, usdc, ...cand.map((c) => c.address.toLowerCase())]);
  const seen = new Set<string>();
  for (const t of seeds) for (const p of await db.poolsForToken(cid, t).catch(() => [])) seen.add(p.address.toLowerCase());
  console.log(`[kg-graph] OLD seed universe (60 seeds × poolsForToken cap-40) = ${seen.size} pools vs FULL ${s.poolsTotal} → the harness saw ${(100 * seen.size / Math.max(1, s.poolsTotal)).toFixed(1)}% of modelable liquidity`);

  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-graph] fatal:", e); process.exit(1); });
