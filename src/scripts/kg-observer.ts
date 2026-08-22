/**
 * KG OBSERVER (Item 5 — continuous, BLOCK-DRIVEN Reality Observatory). Runs one observatory cycle each time the
 * indexer's indexed_block advances (cost ≈ network change, never a dumb timer). Persists a per-cycle snapshot
 * (kg_observer_runs) + each candidate's value at this block (kg_candidate_observations), and SHADOW-PREFLIGHTs
 * only the top-K executable candidates whose state FINGERPRINT changed (or whose last preflight is stale) — so
 * an unchanged opportunity never burns another eth_call. READ-ONLY + eth_call shadow only; NO broadcast.
 *
 *   ... run -d --rm brain node dist/scripts/kg-observer.js
 */
import { decodeErrorResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { LocalRouter } from "../router/router.js";
import { loadLiquidityGraph } from "../kg/graph-loader.js";
import { runObservatory } from "../kg/observatory.js";
import { buildSurfaceContext } from "../kg/path-surface.js";
import { runSurfaces } from "../kg/surface-observer.js";
import { encodeCycle } from "../kg/encode.js";

const POLL_MS = 4_000, STALE_PREFLIGHT_BLOCKS = 30, PREFLIGHT_K = 8, MIN_GROSS_BPS = 1;
const FLASH_ABI = parseAbi(["function flashExecute(uint8 provider, address loanToken, uint256 amount, uint256 minProfit, (address target,uint256 value,bytes data)[] calls)"]);
const REVERT = parseAbi(["error Error(string)"]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function revertReason(err: unknown): string {
  const e = err as { shortMessage?: string; details?: string; cause?: { data?: Hex; reason?: string; shortMessage?: string } };
  const data = e?.cause?.data;
  if (data && data.length >= 10) { try { const d = decodeErrorResult({ abi: REVERT, data }); if (d.args?.[0]) return String(d.args[0]); } catch { /* not a string revert */ } }
  return e?.cause?.reason ?? e?.cause?.shortMessage ?? e?.shortMessage ?? e?.details ?? String(err).slice(0, 120);
}
function classify(reason: string): string {
  const r = reason.toLowerCase();
  if (/profit below min/.test(r)) return "PROFIT_MOVED";
  if (/transfer|allowance|balance|insufficient|erc20|taxed|fee-on-transfer/.test(r)) return "TOKEN_BEHAVIOR_MISMATCH";
  if (/call failed|out of gas|invalid opcode|execution reverted/.test(r)) return "POOL_BEHAVIOR_MISMATCH";
  return "UNKNOWN_REVERT";
}

async function main() {
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "info" as never });
  const db = new Database(config.DATABASE_URL);
  await db.migrate().catch(() => undefined);
  const OWNER = process.env.HOSTNAME || `pid-${process.pid}`; // container id = the singleton owner identity
  const LEASE_TTL = 600;         // seconds — safely above even a slow surface cycle; standby takes over after this
  const SURFACE_EVERY_MS = 300_000; // surfaces are slow-moving intelligence → every ~5min, NOT every arb cycle
  let lastSurfaceAt = 0;
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID;
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();
  const router = new LocalRouter(config, logger, db, chain);
  const capability = (ps: import("../router/types.js").PoolState) => router.execCapability(ps);
  const org = await db.getOrgan("kg-executor").catch(() => null);
  const kg = org?.address as Address | undefined, owner = config.WALLET_ADDRESS as Address;
  logger.info({ blockDriven: true, preflightK: PREFLIGHT_K, staleBlocks: STALE_PREFLIGHT_BLOCKS, executor: kg ?? "none" }, "KG observer started (READ-ONLY + shadow preflight; NO broadcast)");

  let lastBlock = 0, wasStandby = false;
  for (;;) {
    try {
      // SINGLE-INSTANCE lease heartbeat: only the current lease owner processes blocks.
      if (!(await db.acquireObserverLease(cid, OWNER, LEASE_TTL).catch(() => false))) {
        if (!wasStandby) { logger.warn("another kg-observer holds the lease — standing by"); wasStandby = true; }
        await sleep(POLL_MS * 3); continue;
      }
      if (wasStandby) { logger.info("acquired observer lease — taking over"); wasStandby = false; }
      const cs = await db.getChainStatus(cid).catch(() => null);
      const head = cs?.indexedBlock ?? 0;
      if (!cs?.synced || head <= lastBlock) { await sleep(POLL_MS); continue; } // block-driven: only on advance
      lastBlock = head;
      const t0 = Date.now();
      const g = await loadLiquidityGraph(db, cid);
      // Yield the moment the mirror goes stale. A cycle takes minutes; if the indexer falls behind meanwhile,
      // every remaining number describes a world that no longer exists — and on a single core this work is
      // competing with the very catch-up it depends on. Cheap DB read, checked between candidates.
      const staleSince = () => db.getChainStatus(cid).then((c) => !c?.synced).catch(() => false);
      let stale = false;
      const staleTimer = setInterval(() => { void staleSince().then((v) => { stale = v; }); }, 5_000);
      let candidates: Awaited<ReturnType<typeof runObservatory>>["candidates"], stats: Awaited<ReturnType<typeof runObservatory>>["stats"];
      try { ({ candidates, stats } = await runObservatory(db, config, g, { minGrossBps: MIN_GROSS_BPS, abort: () => stale }, capability)); }
      finally { clearInterval(staleTimer); }
      if (stats.aborted) {
        logger.warn({ block: head, sized: stats.sized }, "observatory cycle ABORTED — mirror went stale mid-cycle; yielding the cpu to the indexer");
        lastBlock = 0; // do not treat this block as observed: redo it once the mirror is fresh again
        await sleep(POLL_MS);
        continue;
      }

      let attempted = 0, pass = 0, reused = 0;
      const outcomes: Record<string, number> = {};
      if (kg) {
        const exe = candidates.filter((c) => c.executable).sort((a, b) => (b.netUsd ?? -1e9) - (a.netUsd ?? -1e9)).slice(0, PREFLIGHT_K);
        for (const c of exe) {
          const meta = await db.getCandidatePreflightMeta(cid, c.ckey).catch(() => null);
          const worthy = !meta || meta.fingerprint !== c.fingerprint || meta.block == null || (head - meta.block) > STALE_PREFLIGHT_BLOCKS;
          if (!worthy) { reused++; await db.setObservationPreflight(cid, c.ckey, head, `${meta!.status ?? "?"} (cached)`).catch(() => undefined); continue; }
          const calls = await encodeCycle(router, g.pools, c.legs, kg).catch(() => null);
          if (!calls) { attempted++; outcomes.ENCODE_UNSUPPORTED = (outcomes.ENCODE_UNSUPPORTED ?? 0) + 1; await db.setCandidatePreflight(cid, c.ckey, "ENCODE_UNSUPPORTED", head, c.fingerprint).catch(() => undefined); await db.setObservationPreflight(cid, c.ckey, head, "ENCODE_UNSUPPORTED").catch(() => undefined); continue; }
          attempted++;
          const tuples = calls.map((x) => ({ target: x.target, value: x.value, data: x.data }));
          try {
            await chain.primary.call({ account: owner, to: kg, data: encodeFunctionData({ abi: FLASH_ABI, functionName: "flashExecute", args: [0, c.numeraire as Address, c.amountIn, c.minProfitNumeraire, tuples] }) });
            pass++; outcomes.pass = (outcomes.pass ?? 0) + 1;
            await db.setCandidatePreflight(cid, c.ckey, "pass", head, c.fingerprint).catch(() => undefined); await db.setObservationPreflight(cid, c.ckey, head, "pass").catch(() => undefined);
            logger.info({ route: c.route, net: c.netUsd, block: head }, "PREFLIGHT PASS — predicted edge holds on-chain");
          } catch (e) {
            const cl = classify(revertReason(e)); outcomes[cl] = (outcomes[cl] ?? 0) + 1;
            await db.setCandidatePreflight(cid, c.ckey, cl, head, c.fingerprint).catch(() => undefined); await db.setObservationPreflight(cid, c.ckey, head, cl).catch(() => undefined);
            if (/BEHAVIOR_MISMATCH/.test(cl)) { const toks = new Set(c.legs.flatMap((l) => [l.tokenIn.toLowerCase(), l.tokenOut.toLowerCase()])); for (const t of toks) if (t !== weth && t !== usdc) await db.addBlacklist({ scope: "token", value: t, tier: "secondary", source: "system", reason: `kg preflight ${cl}` }).catch(() => undefined); }
          }
        }
      }
      // SURFACE INTELLIGENCE (Item 7) — slow-moving; decoupled from the time-sensitive arb cycle so arb detection
      // stays responsive (~cycle) while surfaces run every ~5min. Keeps most cycles fast → lease always fresh.
      let surf = { pairRuns: 0, exitRuns: 0, signals: 0, skipped: 0 };
      if (Date.now() - lastSurfaceAt > SURFACE_EVERY_MS) {
        lastSurfaceAt = Date.now();
        const bl = await db.listBlacklist().catch(() => [] as Array<{ scope: string; value: string }>);
        const blacklisted = new Set(bl.filter((b) => b.scope === "token").map((b) => b.value.toLowerCase()));
        const ctx = buildSurfaceContext(db, cid, g, (ps) => router.execCapability(ps) != null, blacklisted);
        await db.acquireObserverLease(cid, OWNER, LEASE_TTL).catch(() => false); // heartbeat before the heavy pass
        surf = await runSurfaces(db, config, g, ctx, { budgetMs: 60_000 }).catch(() => ({ pairRuns: 0, exitRuns: 0, signals: 0, skipped: 0 }));
      }

      const dt = Date.now() - t0;
      await db.recordObserverRun({ chainId: cid, block: head, durationMs: dt, poolsPriced: g.stats.poolsPriced, multiVenuePairs: stats.multiVenuePairs, sized: stats.sized, economic: stats.economic, economicallyPositive: stats.economicallyPositive, routeEncodable: stats.routeEncodable, executable: stats.executable, preflightAttempted: attempted, preflightPass: pass, detectors: stats.detectors, stats: { unsupportedForks: stats.unsupportedForks, blockedByTicks: stats.blockedByTicks } }).catch(() => undefined);
      logger.info({ block: head, dt, sized: stats.sized, economicallyPositive: stats.economicallyPositive, executable: stats.executable, preflight: `${pass}/${attempted}`, reused, surfaces: `${surf.pairRuns}pair/${surf.exitRuns}exit/${surf.signals}sig/${surf.skipped}skip`, outcomes }, "observer cycle");
    } catch (e) { logger.error({ err: e instanceof Error ? e.message : String(e) }, "observer cycle failed"); }
    await sleep(POLL_MS);
  }
}
main().catch((e) => { console.error("[kg-observer] fatal:", e); process.exit(1); });
