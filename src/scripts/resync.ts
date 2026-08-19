/**
 * MANUAL RE-SYNC (enrichment cold-start / DB reconciliation). After a big system change, existing DB rows
 * lack fields the CURRENT system needs. This one-off pass backfills them from RPC on the ENRICHMENT lane
 * (nodies), PACED so it never saturates the RPC, IDEMPOTENT (re-queries only what's still missing) and
 * INTERRUPTIBLE (per-row commit → Ctrl-C anytime, re-run resumes). It does NOT touch the live brain.
 *
 * Task registry (extensible — add a task when a future change needs a backfill).
 *   - v4pools: scan Uniswap V4 Initialize events (poolId → currencies/fee) so EXISTING V4 pools (which live
 *     only in the singleton PoolManager, discoverable only via their Initialize log) get priced. One-time.
 *   (factory backfill RETIRED — the live enrichment worker owns meta.factory; see enrichFactories.)
 *
 *   ... run --rm brain node dist/scripts/resync.js [v4pools]
 */
import type { Address } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { decodeV4Init, V4_INITIALIZE, type RawLog } from "../indexer/events.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const only = process.argv[2]; // optional task filter
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID, weth = config.WBERA_ADDRESS.toLowerCase();
  const pace = config.ENRICH_SPACING_MS;
  console.log(`[resync] lane=enrichment(${chain.enrichmentRpc})  pace=${pace}ms  task=${only ?? "all"}`);

  // ── TASK: Uniswap V4 pool backfill (Initialize events → V4 pool entities) ───
  if (!only || only === "v4pools") {
    const pm = config.V4_POOLMANAGER as Address;
    const req = (m: string, p: unknown) => (chain.enrichment as unknown as { request: (a: { method: string; params: unknown }) => Promise<unknown> }).request({ method: m, params: p });
    const head = Number(BigInt((await req("eth_blockNumber", []).catch(() => "0x0")) as string)) || Number(await chain.enrichment.getBlockNumber().catch(() => 0n));
    let from = config.V4_BACKFILL_FROM_BLOCK, span = 3_000, created = 0, scanned = 0;
    console.log(`[resync] v4pools: scanning Initialize on PoolManager ${pm} from ${from} → ${head} (span starts ${span})`);
    while (from <= head) {
      const to = Math.min(from + span - 1, head);
      let logs: RawLog[] | null = null;
      try { logs = await req("eth_getLogs", [{ address: pm, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [V4_INITIALIZE] }]) as RawLog[]; }
      catch { if (span > 300) { span = Math.floor(span / 2); continue; } await sleep(4_000); continue; } // exceed limit → shrink; rate-limit → wait; NEVER crash
      try {
        for (const l of logs ?? []) {
          const e = decodeV4Init(l); if (!e || e.kind !== "pool_created") continue;
          const t0 = e.token0 === ZERO_ADDR ? weth : e.token0, t1 = e.token1 === ZERO_ADDR ? weth : e.token1;
          const meta: Record<string, unknown> = { token0: t0, token1: t1, archetype: "v4", fee: e.fee, factory: e.factory, discoveredBy: "resync", origin: "created" };
          if (e.tickSpacing != null) meta.tickSpacing = e.tickSpacing;
          if (e.hooks) meta.hooks = e.hooks;
          const blk = Number(BigInt(l.blockNumber));
          await db.upsertEntity({ chainId: cid, address: e.pool, kind: "pool", meta, source: "resync", block: blk }).catch(() => undefined);
          await db.upsertEntity({ chainId: cid, address: t0, kind: "token", source: "resync", block: blk }).catch(() => undefined);
          await db.upsertEntity({ chainId: cid, address: t1, kind: "token", source: "resync", block: blk }).catch(() => undefined);
          created += 1;
        }
      } catch { /* a bad log must not abort the scan */ }
      scanned += to - from + 1; from = to + 1;
      if (span < 3_000 && (logs?.length ?? 0) < 30) span = Math.min(3_000, span * 2); // ramp back when sparse
      if (scanned % 300_000 < span) console.log(`[resync] v4pools: created=${created} scannedTo=${to} span=${span}`);
      await sleep(pace);
    }
    console.log(`[resync] v4pools DONE: created=${created} pools`);
  }

  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[resync] fatal:", e); process.exit(1); });
