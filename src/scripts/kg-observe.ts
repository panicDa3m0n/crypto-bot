/**
 * KG OBSERVE (Item 4 — the KGObserver inner loop, run once). Loads the full DB graph, runs every detector
 * (READ-ONLY, DB-first gas), folds own-ENCODABILITY into the gate, persists the lifecycle rows, then SHADOW
 * PREFLIGHTs ONLY the top-K executable candidates: a fresh eth_call at the real minProfit floor, classifying
 * predicted-vs-chain outcomes into a taxonomy. Reports precision = chain-executable / offline-executable, plus
 * "profit lost to unsupported forks" and the tick-coverage value. Scarlet/execution stay OFF (no broadcast).
 *
 *   ... run --rm brain node dist/scripts/kg-observe.js [minGrossBps=1] [preflightK=8]
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
/** Preflight failure taxonomy — WHERE the offline model and chain reality diverge (drives what to fix next). */
function classify(reason: string): string {
  const r = reason.toLowerCase();
  if (/profit below min/.test(r)) return "PROFIT_MOVED";                                   // was profitable, no longer clears floor
  if (/transfer|allowance|balance|insufficient|erc20|taxed|fee-on-transfer/.test(r)) return "TOKEN_BEHAVIOR_MISMATCH";
  if (/call failed|out of gas|invalid opcode|execution reverted/.test(r)) return "POOL_BEHAVIOR_MISMATCH"; // pool doesn't behave as modeled
  return "UNKNOWN_REVERT: " + reason.slice(0, 60);
}

async function main() {
  const minGrossBps = Number(process.argv[2] ?? 1);
  const preflightK = Number(process.argv[3] ?? 8);
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  await db.migrate().catch(() => undefined);
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID;
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();
  const router = new LocalRouter(config, logger, db, chain);

  const g = await loadLiquidityGraph(db, cid);
  const t0 = Date.now();
  const { candidates, stats } = await runObservatory(db, config, g, { minGrossBps }, (ps) => router.execCapability(ps));
  const dt = Date.now() - t0;

  console.log(`[kg-observe] head=${g.head} lag=${g.lag} gas=${stats.gasPriceWei}wei (age=${stats.gasAgeMs}ms stale=${stats.gasStale}) ethUsd≈${stats.ethUsd.toFixed(2)}`);
  console.log(`[kg-observe] ${dt}ms  pools=${g.stats.poolsPriced}priced multiVenuePairs=${stats.multiVenuePairs} sized=${stats.sized} detectors=${JSON.stringify(stats.detectors)}`);
  console.log(`[kg-observe] GATE: economicEdge=${stats.economic} → economicallyPositive=${stats.economicallyPositive} → routeEncodable=${stats.routeEncodable} → executable=${stats.executable}`);
  if (stats.unsupportedForks.length) console.log(`[kg-observe] profit lost to UNSUPPORTED FORKS (positive edge, can't encode): ${stats.unsupportedForks.map((f) => `${f.factory.slice(0, 10)}:${f.candidates}cand/$${f.peakUsd.toFixed(2)}`).join("  ")}`);
  const bt = stats.blockedByTicks;
  console.log(`[kg-observe] COVERAGE VALUE (edge blocked ONLY by partial ticks): ${bt.candidates} cand, Σ$${bt.sumPeakUsd.toFixed(2)}; topFactories=${bt.topFactories.slice(0, 4).map((f) => `${f.factory.slice(0, 10)}:$${f.usd.toFixed(2)}`).join(" ")} topPools=${bt.topPools.slice(0, 4).map((p) => `${p.pool.slice(0, 10)}:$${p.usd.toFixed(2)}`).join(" ")}`);

  const top = candidates.filter((c) => c.grossUsd != null).sort((a, b) => (b.netUsd ?? b.grossUsd ?? -1e9) - (a.netUsd ?? a.grossUsd ?? -1e9)).slice(0, 12);
  for (const c of top) console.log(`  [${c.detector}] ${c.route.padEnd(22)} net=${c.netUsd != null ? "$" + c.netUsd.toFixed(4) : "n/a"} exact=${c.simulationExact} ${c.executable ? "EXECUTABLE ✓" : "skip(" + (c.rejectionReason ?? "") + ")"}`);

  // ── SHADOW PREFLIGHT (Item 4.4): top-K executable → fresh eth_call, classify predicted-vs-chain ──
  const org = await db.getOrgan("kg-executor").catch(() => null);
  const exe = candidates.filter((c) => c.executable).sort((a, b) => (b.netUsd ?? -1e9) - (a.netUsd ?? -1e9)).slice(0, preflightK);
  console.log(`\n[kg-observe] SHADOW PREFLIGHT: ${exe.length} executable candidate(s)${org ? "" : " — NO kg-executor organ, skipping"}`);
  const outcomes: Record<string, number> = {};
  let pass = 0;
  if (org) {
    const kg = org.address as Address, owner = config.WALLET_ADDRESS as Address;
    for (const c of exe) {
      const record = async (status: string) => { outcomes[status.split(":")[0]] = (outcomes[status.split(":")[0]] ?? 0) + 1; await db.setCandidatePreflight(cid, c.ckey, status, g.head).catch(() => undefined); };
      const calls = await encodeCycle(router, g.pools, c.legs, kg).catch(() => null);
      if (!calls) { await record("ENCODE_UNSUPPORTED"); console.log(`   ${c.route.padEnd(22)} ENCODE_UNSUPPORTED`); continue; }
      const tuples = calls.map((x) => ({ target: x.target, value: x.value, data: x.data }));
      try { await chain.primary.call({ account: owner, to: kg, data: encodeFunctionData({ abi: FLASH_ABI, functionName: "flashExecute", args: [0, c.numeraire as Address, c.amountIn, c.minProfitNumeraire, tuples] }) });
        pass++; await record("pass"); console.log(`   ${c.route.padEnd(22)} PASS ✓ net=$${(c.netUsd ?? 0).toFixed(4)} holds at head ${g.head}`);
      } catch (e) {
        const cl = classify(revertReason(e)); await record(cl); console.log(`   ${c.route.padEnd(22)} ${cl}`);
        // LEARNING LOOP: a behavior mismatch means our ERC20-standard model is wrong for a route token → add
        // its intermediate tokens to the blacklist. They stay VISIBLE in the graph (economic/model-mismatch
        // signal) but the executability gate will skip them next cycle. Only for behavior mismatches, never
        // PROFIT_MOVED (that's a legit edge that merely decayed).
        if (/BEHAVIOR_MISMATCH/.test(cl)) {
          const toks = new Set(c.legs.flatMap((l) => [l.tokenIn.toLowerCase(), l.tokenOut.toLowerCase()]));
          for (const t of toks) if (t !== weth && t !== usdc) await db.addBlacklist({ scope: "token", value: t, tier: "secondary", source: "system", reason: `kg preflight ${cl}` }).catch(() => undefined);
        }
      }
    }
    console.log(`[kg-observe] PRECISION: ${pass}/${exe.length} chain-executable (${exe.length ? (100 * pass / exe.length).toFixed(0) : 0}%)  outcomes=${JSON.stringify(outcomes)}`);
  }
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-observe] fatal:", e); process.exit(1); });
