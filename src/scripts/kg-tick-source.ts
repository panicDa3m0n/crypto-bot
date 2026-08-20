/**
 * KG TICK SOURCE PROBE — verifies the unified tick reader across EVERY concentrated fork we index (V3-family
 * + V4), proving there is no protocol on the chain we cannot read. For each representative pool it probes the
 * capability, reads a bounded price window, and reports ticks found / words used / latency. This is the
 * coverage guarantee: if a row here says "none", that fork would be a future blocker — and we'd know now.
 *
 *   ... run --rm -e SCAN_RPC=<reliable> brain node dist/scripts/kg-tick-source.js
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { probeTickCapability, readTicksInWindow, wordsForPriceRatio } from "../router/tick-source.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const cid = config.CHAIN_ID;
  const client = createPublicClient({ chain: base, transport: http(process.env.SCAN_RPC ?? "https://base.drpc.org", { batch: false }) }) as unknown as PublicClient;

  // deepest live pool per factory, across the whole concentrated landscape (v3-family AND v4)
  const rows = await db.topPoolPerFactory(cid, 20).catch(() => []);
  const head = Number(await client.getBlockNumber().catch(() => 0n)) - 3;
  console.log(`[tick-source] probing ${rows.length} factories @B=${head}\n`);
  let ok = 0, none = 0, totalTicks = 0;

  for (const r of rows) {
    const isV4 = r.archetype === "v4" || r.pool.length === 66;
    const t0 = Date.now();
    const kind = await probeTickCapability(client, r.pool, isV4);
    if (!kind) { console.log(`  ${r.factory.slice(0, 12)} ${String(r.archetype).padEnd(4)} pools=${String(r.pools).padEnd(6)} → CAPABILITY: none ✗ (would be a blocker)`); none++; continue; }
    const spacing = r.tickSpacing && r.tickSpacing > 0 ? r.tickSpacing : ({ 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 }[r.fee ?? 0] ?? 60);
    const read = await readTicksInWindow(client, { pool: r.pool, kind, tickSpacing: spacing, block: head });
    const ms = Date.now() - t0;
    if (!read) { console.log(`  ${r.factory.slice(0, 12)} ${String(r.archetype).padEnd(4)} pools=${String(r.pools).padEnd(6)} → ${kind} but READ FAILED ✗`); none++; continue; }
    ok++; totalTicks += read.ticks.length;
    console.log(`  ${r.factory.slice(0, 12)} ${String(r.archetype).padEnd(4)} pools=${String(r.pools).padEnd(6)} → ${kind.padEnd(13)} spacing=${String(spacing).padEnd(4)} ticks=${String(read.ticks.length).padEnd(5)} words=${String(read.words).padEnd(4)} window=[${read.window.tickLo},${read.window.tickHi}] ${ms}ms`);
  }
  console.log(`\n[tick-source] COVERAGE: ${ok}/${rows.length} factories readable, ${none} blockers, ${totalTicks} ticks read total`);
  console.log(`[tick-source] cost model (words per pool, 8× price window): spacing1=${wordsForPriceRatio(1)} spacing10=${wordsForPriceRatio(10)} spacing60=${wordsForPriceRatio(60)} spacing200=${wordsForPriceRatio(200)}  (full domain @spacing1 would be 6932)`);
  await db.close().catch(() => undefined);
  process.exit(none ? 1 : 0);
}
main().catch((e) => { console.error("[tick-source] fatal:", e); process.exit(1); });
