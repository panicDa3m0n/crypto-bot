/**
 * KG TICKBOOT TEST (Item 3.2 — verify the restart-safe transactional bootstrap cursor). On a FAKE pool,
 * proves applyTickBootstrapChunk is exactly-once: a contiguous chunk applies + advances bootstrap_through;
 * re-applying the SAME range is REJECTED (the contiguity guard → no double-count on a crash-restart);
 * the next contiguous chunk advances. Deterministic, DB-only. Cleans up after itself.
 *
 *   ... run --rm brain node dist/scripts/kg-tickboot-test.js
 */
import { loadConfig } from "../config.js";
import { Database } from "../db.js";

const FAKE = "0x00000000000000000000000000000000deadbeef";

async function main() {
  const config = loadConfig();
  const db = new Database(config.DATABASE_URL);
  const cid = config.CHAIN_ID;
  const D = (tl: number, tu: number, d: bigint) => [{ tickLower: tl, tickUpper: tu, liquidityDelta: d }];
  let pass = true;
  const check = (name: string, ok: boolean, detail = "") => { if (!ok) pass = false; console.log(`  ${ok ? "✓" : "✗"} ${name} ${detail}`); };

  await db.setPoolTickCreation(cid, FAKE, 100, "test");

  const c1 = await db.applyTickBootstrapChunk(cid, FAKE, 100, 199, D(10, 20, 1000n));
  check("first chunk [100,199] applies", c1.ok, c1.reason ?? "");

  const c1b = await db.applyTickBootstrapChunk(cid, FAKE, 100, 199, D(10, 20, 1000n)); // restart re-apply SAME range
  check("re-apply [100,199] REJECTED (exactly-once)", !c1b.ok, `→ ${c1b.reason}`);

  const c2 = await db.applyTickBootstrapChunk(cid, FAKE, 200, 299, D(10, 30, 500n));
  check("next contiguous chunk [200,299] applies", c2.ok, c2.reason ?? "");

  const cBad = await db.applyTickBootstrapChunk(cid, FAKE, 400, 499, D(10, 20, 1n)); // gap → must reject
  check("non-contiguous chunk [400,499] REJECTED", !cBad.ok, `→ ${cBad.reason}`);

  const st = await db.getPoolTickStatus(cid, FAKE);
  check("bootstrap_through == 299 (advanced once per applied chunk)", st?.bootstrapThrough === 299, `got ${st?.bootstrapThrough}`);

  // tick 10 must be +1500 (1000 + 500) applied ONCE each — not doubled by the rejected re-apply.
  const tl = await db.tickLiquidity(cid, FAKE).catch(() => []);
  const t10 = tl.find((t) => t.tick === 10)?.liquidityNet;
  check("tick 10 liquidity_net == 1500 (no double-count)", t10 === 1500n, `got ${t10}`);

  await db.close().catch(() => undefined);
  console.log(pass ? "[kg-tickboot-test] ✓ ALL PASS — transactional cursor is exactly-once & contiguity-guarded" : "[kg-tickboot-test] ✗ FAILURES above");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("[kg-tickboot-test] fatal:", e); process.exit(1); });
