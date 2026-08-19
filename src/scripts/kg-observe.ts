/**
 * KG OBSERVE (Item 4.2/4.3/4.4 — the KGObserver inner loop, run once). Loads the full DB graph, runs every
 * detector (READ-ONLY, DB-first gas), persists the lifecycle rows, then does a SHADOW PREFLIGHT on ONLY the
 * top-K executable candidates: a fresh eth_call at the real on-chain minProfit floor, measuring predicted vs
 * chain reality (the `precision = preflight-pass / offline-executable` metric). This honours the RPC principle:
 * thousands of offline candidates → a handful of eth_calls. Scarlet/execution stay OFF (no broadcast).
 *
 *   ... run --rm brain node dist/scripts/kg-observe.js [minGrossBps=1] [preflightK=6]
 */
import { decodeErrorResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { LocalRouter } from "../router/router.js";
import { loadLiquidityGraph } from "../kg/graph-loader.js";
import { runObservatory } from "../kg/observatory.js";
import { encodeCycle } from "../kg/encode.js";

const FLASH_ABI = parseAbi(["function flashExecute(uint8 provider, address loanToken, uint256 amount, uint256 minProfit, (address target,uint256 value,bytes data)[] calls)"]);
const REVERT = parseAbi(["error Error(string)"]);
function revertReason(err: unknown): string {
  const e = err as { shortMessage?: string; details?: string; cause?: { data?: Hex; reason?: string; shortMessage?: string } };
  const data = e?.cause?.data;
  if (data && data.length >= 10) { try { const d = decodeErrorResult({ abi: REVERT, data }); if (d.args?.[0]) return String(d.args[0]); } catch { /* not a string revert */ } }
  return e?.cause?.reason ?? e?.cause?.shortMessage ?? e?.shortMessage ?? e?.details ?? String(err).slice(0, 120);
}

async function main() {
  const minGrossBps = Number(process.argv[2] ?? 1);
  const preflightK = Number(process.argv[3] ?? 6);
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID;

  const g = await loadLiquidityGraph(db, cid);
  const t0 = Date.now();
  const { candidates, stats } = await runObservatory(db, config, g, { minGrossBps });
  const dt = Date.now() - t0;

  console.log(`[kg-observe] head=${g.head} lag=${g.lag} gas=${stats.gasPriceWei}wei (age=${stats.gasAgeMs}ms stale=${stats.gasStale}) ethUsd≈${stats.ethUsd.toFixed(2)}`);
  console.log(`[kg-observe] ${dt}ms: pools=${g.stats.poolsPriced}priced multiVenuePairs=${stats.multiVenuePairs} sized=${stats.sized} economic(gross+)=${stats.economic} executable=${stats.executable} detectors=${JSON.stringify(stats.detectors)}`);
  const top = candidates.filter((c) => c.grossUsd != null).sort((a, b) => (b.netUsd ?? b.grossUsd ?? -1e9) - (a.netUsd ?? a.grossUsd ?? -1e9)).slice(0, 15);
  for (const c of top) console.log(`  [${c.detector}] ${c.route.padEnd(22)} gross=${c.grossUsd != null ? "$" + c.grossUsd.toFixed(4) : "n/a"} net=${c.netUsd != null ? "$" + c.netUsd.toFixed(4) : "n/a"} exact=${c.simulationExact} ${c.executable ? "EXECUTABLE ✓" : "skip(" + (c.rejectionReason ?? "") + ")"}`);

  // ── SHADOW PREFLIGHT (Item 4.4): top-K executable only → fresh eth_call, predicted vs chain reality ──
  const org = await db.getOrgan("kg-executor").catch(() => null);
  const exe = candidates.filter((c) => c.executable).sort((a, b) => (b.netUsd ?? -1e9) - (a.netUsd ?? -1e9)).slice(0, preflightK);
  console.log(`\n[kg-observe] SHADOW PREFLIGHT: ${exe.length} executable candidate(s)${org ? "" : " — NO kg-executor organ, skipping"}`);
  let pass = 0, attempted = 0;
  if (org) {
    const kg = org.address as Address;
    const owner = config.WALLET_ADDRESS as Address;
    const router = new LocalRouter(config, logger, db, chain);
    for (const c of exe) {
      const calls = await encodeCycle(router, g.pools, c.legs, kg).catch(() => null);
      if (!calls) { await db.setCandidatePreflight(cid, c.ckey, "encode-fail (fork not own-executable)", g.head).catch(() => undefined); console.log(`   ${c.route.padEnd(22)} ENCODE-FAIL (a hop is on an unknown fork)`); continue; }
      attempted++;
      const tuples = calls.map((x) => ({ target: x.target, value: x.value, data: x.data }));
      // (1) route validity at minProfit=0, then (2) real minProfit floor at CURRENT chain head.
      try { await chain.primary.call({ account: owner, to: kg, data: encodeFunctionData({ abi: FLASH_ABI, functionName: "flashExecute", args: [0, c.numeraire as Address, c.amountIn, 0n, tuples] }) }); }
      catch (e) { const r = revertReason(e); await db.setCandidatePreflight(cid, c.ckey, `route-revert: ${r}`, g.head).catch(() => undefined); console.log(`   ${c.route.padEnd(22)} ROUTE-REVERT "${r}"`); continue; }
      try {
        await chain.primary.call({ account: owner, to: kg, data: encodeFunctionData({ abi: FLASH_ABI, functionName: "flashExecute", args: [0, c.numeraire as Address, c.amountIn, c.minProfitNumeraire, tuples] }) });
        pass++; await db.setCandidatePreflight(cid, c.ckey, "pass", g.head).catch(() => undefined);
        console.log(`   ${c.route.padEnd(22)} PREFLIGHT PASS ✓ (predicted net=$${(c.netUsd ?? 0).toFixed(4)} holds at head ${g.head}, minProfit=${c.minProfitNumeraire})`);
      } catch (e) {
        const r = revertReason(e); const below = /profit below min/i.test(r);
        await db.setCandidatePreflight(cid, c.ckey, below ? "fail-unprofitable-at-head" : `fail: ${r}`, g.head).catch(() => undefined);
        console.log(`   ${c.route.padEnd(22)} PREFLIGHT FAIL — ${below ? "no longer clears real minProfit at head (mirror moved / competition)" : `"${r}"`}`);
      }
    }
    const encodeFail = exe.length - attempted;
    console.log(`[kg-observe] PRECISION: ${pass}/${exe.length} offline-executable are chain-executable at head ${g.head} (${exe.length ? (100 * pass / exe.length).toFixed(0) : 0}%) — encodeFail=${encodeFail} (unsupported fork), routeOrProfitFail=${attempted - pass}`);
  }
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-observe] fatal:", e); process.exit(1); });
