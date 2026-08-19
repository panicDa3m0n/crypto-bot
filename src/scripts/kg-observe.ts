/**
 * KG OBSERVE (Item 4.2/4.3 — run the Opportunity Observatory once). Loads the full DB graph, runs every
 * detector, sizes+gates each reading with DB-first gas, persists the lifecycle rows, and prints the top
 * candidates. READ-ONLY, no chain RPC (gas from gas_state). This is the KGObserver's inner loop, run once.
 *
 *   ... run --rm brain node dist/scripts/kg-observe.js [minGrossBps=1]
 */
import { loadConfig } from "../config.js";
import { Database } from "../db.js";
import { loadLiquidityGraph } from "../kg/graph-loader.js";
import { runObservatory } from "../kg/observatory.js";

async function main() {
  const minGrossBps = Number(process.argv[2] ?? 1);
  const config = loadConfig();
  const db = new Database(config.DATABASE_URL);
  const cid = config.CHAIN_ID;

  const g = await loadLiquidityGraph(db, cid);
  const t0 = Date.now();
  const { candidates, stats } = await runObservatory(db, config, g, { minGrossBps });
  const dt = Date.now() - t0;

  console.log(`[kg-observe] head=${g.head} lag=${g.lag} gas=${stats.gasPriceWei}wei (age=${stats.gasAgeMs}ms stale=${stats.gasStale}) ethUsd≈${stats.ethUsd.toFixed(2)}`);
  console.log(`[kg-observe] ${dt}ms: pools=${g.stats.poolsPriced}priced multiVenuePairs=${stats.multiVenuePairs} sized=${stats.sized} economic(gross+)=${stats.economic} executable=${stats.executable} detectors=${JSON.stringify(stats.detectors)}`);
  const top = candidates.filter((c) => c.grossUsd != null).sort((a, b) => (b.netUsd ?? b.grossUsd ?? -1e9) - (a.netUsd ?? a.grossUsd ?? -1e9)).slice(0, 25);
  for (const c of top) console.log(`  [${c.detector}] ${c.route.padEnd(22)} gross=${c.grossUsd != null ? "$" + c.grossUsd.toFixed(4) : "n/a"} gas=$${c.gasUsd.toFixed(4)} net=${c.netUsd != null ? "$" + c.netUsd.toFixed(4) : "n/a"} exact=${c.simulationExact} ${c.executable ? "EXECUTABLE ✓" : "skip(" + (c.rejectionReason ?? "") + ")"}`);

  const persisted = await db.topCandidates(cid, 12).catch(() => []);
  console.log(`[kg-observe] persisted lifecycle (top by net):`);
  for (const p of persisted) console.log(`   ${p.route.padEnd(22)} net=${p.netUsd != null ? "$" + p.netUsd.toFixed(4) : "n/a"} peak=${p.peakNetUsd != null ? "$" + p.peakNetUsd.toFixed(4) : "n/a"} seen=${p.seenCount} blk[${p.firstSeenBlock}→${p.lastSeenBlock}] ${p.executable ? "EXEC" : ""}`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-observe] fatal:", e); process.exit(1); });
