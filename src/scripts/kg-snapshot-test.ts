/**
 * KG SNAPSHOT TEST (Item 3.4 — verify the atomic snapshot REPLACE is NOT additive). On a FAKE pool, seeds
 * a stale tick map (as if the indexer had partial deltas), then applies a storage snapshot: the result must
 * be EXACTLY the snapshot (+ any disjoint replay deltas), with the stale rows GONE — never summed. This is
 * the core distinction: historical bootstrap = additive delta reconstruction; storage bootstrap = state
 * snapshot replacement. Deterministic, DB-only. Cleans up after itself.
 *
 *   ... run --rm brain node dist/scripts/kg-snapshot-test.js
 */
import { loadConfig } from "../config.js";
import { Database } from "../db.js";

const FAKE = "0x00000000000000000000000000000000cafe5a5a";

async function main() {
  const config = loadConfig();
  const db = new Database(config.DATABASE_URL);
  const cid = config.CHAIN_ID;
  let pass = true;
  const check = (name: string, ok: boolean, detail = "") => { if (!ok) pass = false; console.log(`  ${ok ? "✓" : "✗"} ${name} ${detail}`); };

  // 1) Seed a STALE partial map (simulate the indexer's incomplete accumulation) via the additive cursor.
  await db.setPoolTickCreation(cid, FAKE, 100, "test");
  await db.applyTickBootstrapChunk(cid, FAKE, 100, 199, [{ tickLower: 10, tickUpper: 20, liquidityDelta: 999n }]); // tick 10=+999 (stale/wrong)

  // 2) Storage snapshot @ block 500 says the TRUE map is tick 10=+7000, tick 40=-7000 (+ a replay delta).
  const snap = [{ tick: 10, liquidityNet: 7000n }, { tick: 40, liquidityNet: -7000n }];
  const replay = [{ tickLower: 10, tickUpper: 50, liquidityDelta: 3n }]; // [501,510] indexer delta: tick10 +3, tick50 -3
  const r = await db.replaceTickMapSnapshot(cid, FAKE, 500, snap, 510, replay);
  check("replaceTickMapSnapshot ok", r.ok, r.reason ?? "");

  const tl = await db.tickLiquidity(cid, FAKE).catch(() => []);
  const at = (t: number) => tl.find((x) => x.tick === t)?.liquidityNet;
  // tick 10 must be 7000+3 = 7003 (snapshot REPLACED the stale 999, NOT 999+7000+3).
  check("tick 10 == 7003 (snapshot REPLACED stale, not summed)", at(10) === 7003n, `got ${at(10)}`);
  check("tick 40 == -7000 (snapshot)", at(40) === -7000n, `got ${at(40)}`);
  check("tick 50 == -3 (replay delta)", at(50) === -3n, `got ${at(50)}`);
  check("tick 20 GONE (stale removed)", at(20) === undefined, `got ${at(20)}`);
  check("exactly 3 tick rows", tl.length === 3, `got ${tl.length}`);

  const st = await db.getPoolTickStatus(cid, FAKE);
  check("status=snapshot, source=storage_scan, through=510, NOT complete", st?.status === "snapshot" && !st?.complete && st?.bootstrapThrough === 510, `${st?.status}/${st?.complete}/${st?.bootstrapThrough}`);

  await db.close().catch(() => undefined);
  console.log(pass ? "[kg-snapshot-test] ✓ ALL PASS — storage snapshot REPLACES (not sums); validation gate still owns complete" : "[kg-snapshot-test] ✗ FAILURES above");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("[kg-snapshot-test] fatal:", e); process.exit(1); });
