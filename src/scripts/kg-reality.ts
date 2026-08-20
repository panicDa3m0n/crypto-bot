/**
 * KG REALITY (Item 6 — the Reality Score report). Reads the observer's accumulated time series and prints, PER
 * DETECTOR, how often opportunities appear, how long they last, how much they're worth, and how often they
 * survive to chain reality. This is the number that finally answers "does Base offer exploitable KG edge?".
 * READ-ONLY.
 *
 *   ... run --rm brain node dist/scripts/kg-reality.js
 */
import { loadConfig } from "../config.js";
import { Database } from "../db.js";

const f = (v: number | null | undefined, d = 2) => v == null ? "—" : (typeof v === "number" ? v.toFixed(d) : String(v));

async function main() {
  const config = loadConfig();
  const db = new Database(config.DATABASE_URL);
  await db.migrate().catch(() => undefined);
  const cid = config.CHAIN_ID;

  const runs = await db.recentObserverRuns(cid, 20).catch(() => []);
  console.log(`[kg-reality] observer runs recorded: ${runs.length}${runs.length ? ` (blocks ${runs[runs.length - 1].block}..${runs[0].block})` : ""}`);
  if (runs.length) {
    const avg = (k: keyof (typeof runs)[number]) => runs.reduce((s, r) => s + (r[k] as number), 0) / runs.length;
    const att = runs.reduce((s, r) => s + r.preflightAttempted, 0), ps = runs.reduce((s, r) => s + r.preflightPass, 0);
    console.log(`[kg-reality] funnel (avg/run, last ${runs.length}): sized=${f(avg("sized"))} economic=${f(avg("economic"))} economicallyPositive=${f(avg("economicallyPositive"))} routeEncodable=${f(avg("routeEncodable"))} executable=${f(avg("executable"))}  dt=${f(avg("durationMs"), 0)}ms`);
    console.log(`[kg-reality] PRECISION across runs: ${ps}/${att} preflights passed (${att ? (100 * ps / att).toFixed(1) : "0"}%)`);
  }

  const byDet = await db.realityByDetector(cid).catch(() => []);
  console.log(`\n[kg-reality] REALITY SCORE by detector:`);
  for (const d of byDet) {
    const preflighted = d.preflightPass + d.behaviorMismatch + d.profitMoved + d.encodeUnsupported;
    console.log(`  ── ${d.detector} ──`);
    console.log(`     candidates=${d.candidates} exact=${d.exact} netPositive=${d.netPositive} executable=${d.executable}`);
    console.log(`     preflight: pass=${d.preflightPass} behaviorMismatch=${d.behaviorMismatch} profitMoved=${d.profitMoved} encodeUnsupported=${d.encodeUnsupported}  precision=${preflighted ? (100 * d.preflightPass / preflighted).toFixed(1) + "%" : "—"}`);
    console.log(`     netUsd: median=$${f(d.medianNet, 4)} p95=$${f(d.p95Net, 4)} max=$${f(d.maxNet, 4)}   lifetime(blocks): median=${f(d.medianLifetime, 0)} p95=${f(d.p95Lifetime, 0)} maxSeen=${d.maxSeen}`);
  }
  if (!byDet.length) console.log(`  (no candidates yet — run the observer to accumulate the time series)`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-reality] fatal:", e); process.exit(1); });
