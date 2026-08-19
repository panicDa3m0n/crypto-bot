/**
 * KG RUN (phase F1, step 3 — the Executable Opportunity Pipeline, end-to-end). Verticalises the whole
 * stack on swaps:
 *   Indexer → cycle seed → stateful sim → sizing → executability gate → gas-net PnL → encode plan →
 *   KGExecutor Call[] → eth_call simulation → (flashExecute).
 * Kernel stays oracle-free (gasUnits); THIS layer values gas/PnL in USD and gates. The final eth_call
 * against the live node is the coherence boundary; require(minProfit) on-chain is the last guard.
 * READ-ONLY unless `--execute` AND a genuinely executable (net-positive) opportunity exists.
 *
 *   ... run --rm brain node dist/scripts/kg-run.js [seedTokens=60] [minBps=1] [--execute]
 */
import { decodeErrorResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { LocalRouter } from "../router/router.js";
import type { Archetype, PoolState } from "../router/types.js";
import { findNegativeCycles, type KGCycle } from "../kg/cycle-finder.js";
import { buildPoolSim, sizeCycle } from "../kg/kernel.js";
import { PoolSim } from "../kg/state.js";
import { evaluateExecutable, type GateContext } from "../kg/opportunity.js";
import { encodeCycle } from "../kg/encode.js";

const CONC = new Set<Archetype>(["v3", "v4", "slipstream"]);
// Execution-risk params (env-overridable; move to config when wired into the live engine).
const MAX_EXECUTION_LAG_BLOCKS = Number(process.env.KG_MAX_EXECUTION_LAG_BLOCKS ?? 3);
const EXEC_MIN_PROFIT_BPS = Number(process.env.KG_EXEC_MIN_PROFIT_BPS ?? 7000); // keep ≥70% of predicted gross on-chain
const FLASH_ABI = parseAbi(["function flashExecute(uint8 provider, address loanToken, uint256 amount, uint256 minProfit, (address target,uint256 value,bytes data)[] calls)"]);
const REVERT_STRINGS = parseAbi(["error Error(string)"]);
const EXECUTE = process.argv.includes("--execute");

function rotate(cycle: KGCycle, preferred: string[]): KGCycle {
  const pref = new Set(preferred.map((p) => p.toLowerCase()));
  const k = cycle.tokens.slice(0, cycle.edges.length).findIndex((t) => pref.has(t));
  if (k <= 0) return cycle;
  const edges = [...cycle.edges.slice(k), ...cycle.edges.slice(0, k)];
  return { ...cycle, edges, tokens: [edges[0].from, ...edges.map((e) => e.to)] };
}

function revertReason(err: unknown): string {
  const e = err as { shortMessage?: string; details?: string; cause?: { data?: Hex; reason?: string; shortMessage?: string } };
  const data = e?.cause?.data;
  if (data && data.length >= 10) { try { const d = decodeErrorResult({ abi: REVERT_STRINGS, data }); if (d.args?.[0]) return String(d.args[0]); } catch { /* not a string revert */ } }
  return e?.cause?.reason ?? e?.cause?.shortMessage ?? e?.shortMessage ?? e?.details ?? String(err).slice(0, 140);
}

async function main() {
  const seedN = Number(process.argv[2] ?? 60);
  const minBps = Number(process.argv[3] ?? 1);
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const router = new LocalRouter(config, logger, db, chain);
  const cid = config.CHAIN_ID;
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();
  const owner = config.WALLET_ADDRESS as Address;
  const org = await db.getOrgan("kg-executor");
  if (!org) throw new Error("kg-executor organ not deployed");
  const kg = org.address as Address;

  // Universe + seeds.
  const cand = await db.arbCandidateTokens(cid, weth, seedN).catch(() => []);
  const seeds = new Set<string>([weth, usdc, ...cand.map((c) => c.address.toLowerCase())]);
  const raw = new Map<string, { address: string; meta: unknown }>();
  for (const t of seeds) for (const p of await db.poolsForToken(cid, t).catch(() => [])) raw.set(p.address.toLowerCase(), p);
  const states = await db.poolStateBatch(cid, [...raw.keys()]).catch(() => new Map());
  const poolStates = new Map<string, PoolState>();
  for (const [address, { meta }] of raw) {
    const m = (meta ?? {}) as { token0?: string; token1?: string; archetype?: string; fee?: unknown; factory?: string ; tickSpacing?: unknown };
    if (!m.token0 || !m.token1) continue;
    const archetype = (m.archetype ?? "v3") as Archetype;
    if (archetype === "aerodrome-stable") continue;
    const st = states.get(address);
    poolStates.set(address, { address, archetype, token0: m.token0.toLowerCase(), token1: m.token1.toLowerCase(), feePpm: Number(m.fee) > 0 ? Number(m.fee) : 0, factory: m.factory?.toLowerCase(), r0: st?.r0 ?? null, r1: st?.r1 ?? null, sqrtPriceX96: st?.sqrtPrice ?? null, liquidity: st?.liquidity ?? null, block: st?.block ?? 0, ageMs: st?.ageMs, tickSpacing: Number(m.tickSpacing) > 0 ? Number(m.tickSpacing) : undefined });
  }
  // Item 3: certified tick-map completeness (from pool_tick_status) → PoolState.tickCoverage.
  const concIds = [...poolStates.values()].filter((p) => CONC.has(p.archetype)).map((p) => p.address);
  const tickComplete = await db.poolTickCompleteBatch(cid, concIds).catch(() => new Map<string, boolean>());
  for (const p of poolStates.values()) if (CONC.has(p.archetype)) p.tickCoverage = tickComplete.get(p.address) ? "complete" : "partial";
  const cycles = findNegativeCycles([...poolStates.values()], { minGrossBps: minBps, limit: 40 });

  // Freshness from the MIRROR (DB-first): the indexer publishes indexed_block/head/lag/synced to
  // chain_status; the read-side reads THAT, never getBlockNumber. AMM reserves are valid until the next
  // swap, so the real staleness risk is the indexer being behind — captured by lag/synced here.
  const cs = await db.getChainStatus(cid).catch(() => null);
  const head = cs?.indexedBlock ?? (await db.getIndexerCursor(cid).catch(() => null)) ?? 0;
  const lag = cs && cs.synced ? cs.lag : 999_999; // not synced ⇒ treat as stale (gate rejects)

  // Valuation refs.
  let ethUsd = 0;
  for (const p of poolStates.values()) { const set = new Set([p.token0, p.token1]); if (!(set.has(weth) && set.has(usdc))) continue; const sim = buildPoolSim(p); if (!sim) continue; const q = sim.quote(weth, 10n ** 18n); if (q) ethUsd = Math.max(ethUsd, Number(q.amountOut) / 1e6); }
  const gasPriceWei = (await chain.primary.getGasPrice().catch(() => 0n)) || 0n;
  const decs = await db.tokenMeta(cid, [weth, usdc]).catch(() => new Map());
  const ctx: GateContext = {
    flashFundable: new Set([weth, usdc]),
    gasPriceWei, ethUsd,
    numeraireUsd: (t) => t === usdc ? 1 : t === weth ? ethUsd : null,
    decimalsOf: (t) => t === weth ? 18 : t === usdc ? 6 : (decs.get(t)?.decimals ?? 18),
    minNetUsd: 0.01, safetyUsd: 0.005, flashFeeBps: 0,
    execMinProfitBps: EXEC_MIN_PROFIT_BPS, lag, maxLagBlocks: MAX_EXECUTION_LAG_BLOCKS
  };
  console.log(`[kg-run] head=${head} lag=${lag} synced=${cs?.synced ?? "n/a"} pools=${poolStates.size} cycles=${cycles.length} ethUsd≈${ethUsd.toFixed(2)} gas=${gasPriceWei} kg=${kg}`);

  const tickCache = new Map<string, Array<{ tick: number; liquidityNet: bigint }>>();
  const simFor = async (ps: PoolState): Promise<PoolSim | null> => { let ticks: Array<{ tick: number; liquidityNet: bigint }> | undefined; if (CONC.has(ps.archetype)) { ticks = tickCache.get(ps.address) ?? await db.tickLiquidity(cid, ps.address).catch(() => []); tickCache.set(ps.address, ticks); } return buildPoolSim(ps, ticks); };
  const sym = (t: string) => t === weth ? "WETH" : t === usdc ? "USDC" : t.slice(0, 8);

  let encoded = 0, simulated = 0, executable = 0;
  for (const c0 of cycles) {
    const c = rotate(c0, [weth, usdc]);
    const num = c.tokens[0];
    const sims = new Map<string, PoolSim>();
    let ok = true;
    for (const e of c.edges) { const ps = poolStates.get(e.pool); if (!ps) { ok = false; break; } const s = await simFor(ps); if (!s) { ok = false; break; } sims.set(s.poolId, s); }
    if (!ok) continue;
    const sized = sizeCycle({ chainId: cid, blockNumber: head }, c, sims, { funding: "flash", flashProvider: "morpho", flashFee: 0n });
    if (!sized) continue;
    const opp = evaluateExecutable(sized, ctx);
    if (opp.executable) executable++;
    const usd = opp.grossPnlUsd != null ? `$${opp.grossPnlUsd.toFixed(4)}` : "n/a";
    const net = opp.netPnlUsd != null ? `$${opp.netPnlUsd.toFixed(4)}` : "n/a";
    console.log(`  ${sym(num).padEnd(6)} gross=${usd} gas=$${opp.gasCostUsd.toFixed(4)} net=${net} ${opp.executable ? "EXECUTABLE" : `skip(${opp.rejectionReason})`}  ${c.tokens.map(sym).join("→")} (${c.edges.map((e) => e.archetype).join(",")})`);

    // Encode + eth_call to prove the compilation→executor→simulation path (numéraire flash-fundable only).
    if (!ctx.flashFundable.has(num)) continue;
    const calls = await encodeCycle(router, poolStates, sized.legs, kg).catch(() => null);
    if (!calls) { console.log(`         encode: NOT own-executable (a hop is on an unknown fork)`); continue; }
    encoded++;
    const tuples = calls.map((x) => ({ target: x.target, value: x.value, data: x.data }));
    // Validity eth_call uses minProfit=0 (prove the route technically executes). Execution uses the REAL floor.
    const simData = encodeFunctionData({ abi: FLASH_ABI, functionName: "flashExecute", args: [0, num as Address, sized.amountIn, 0n, tuples] });
    try {
      await chain.primary.call({ account: owner, to: kg, data: simData });
      simulated++;
      console.log(`         eth_call: SUCCESS (${calls.length} calls) — full path executes & repays at minProfit=0`);
      if (EXECUTE && opp.executable) {
        // Freshness re-gate at broadcast time: our mirror was block N; if the chain has run ahead beyond
        // the lag budget, do NOT trust the sized amounts — skip (a live engine would resimulate).
        const cs2 = await db.getChainStatus(cid).catch(() => null);
        const lag2 = cs2 && cs2.synced ? cs2.lag : 999_999;
        if (lag2 > MAX_EXECUTION_LAG_BLOCKS) { console.log(`         send SKIPPED: mirror lag ${lag2} > ${MAX_EXECUTION_LAG_BLOCKS} (or de-synced) — resimulate.`); continue; }
        // Execution calldata carries the real on-chain minProfit floor; re-simulate coherence at CURRENT state.
        const execData = encodeFunctionData({ abi: FLASH_ABI, functionName: "flashExecute", args: [0, num as Address, sized.amountIn, opp.minProfitNumeraire, tuples] });
        try {
          await chain.primary.call({ account: owner, to: kg, data: execData }); // must still clear the REAL minProfit at current head
          const gp = await chain.primary.getGasPrice();
          const h = await chain.wallet!.sendTransaction({ to: kg, data: execData, gas: 2_000_000n, gasPrice: gp });
          const r = await chain.waitReceipt({ hash: h, confirmations: 1, timeout: 120_000 });
          console.log(`         flashExecute(minProfit=${opp.minProfitNumeraire}) → ${r.status} tx=${h}`);
        } catch (e2) { console.log(`         send ABORTED: pre-send eth_call at real minProfit reverted "${revertReason(e2)}" — state moved, NOT broadcasting.`); }
      }
    } catch (err) {
      const reason = revertReason(err);
      const good = /profit below min/i.test(reason); // swaps ran; only the (minProfit=0) profit check failed → encode PROVEN correct
      console.log(`         eth_call: revert "${reason}" ${good ? "→ path OK (swaps executed; unprofitable at minProfit=0, expected)" : "→ ENCODE/EXEC ISSUE"}`);
      if (good) simulated++;
    }
  }

  // ── Path self-test: if no real cycle exercised the compile→executor→eth_call path, construct a REAL
  // WETH→USDC→WETH round-trip through two own-executable pools. It's unprofitable (round-trip fees), so
  // eth_call must revert "profit below min" — proving the full path runs (a "call failed" would be a bug).
  if (simulated === 0) {
    console.log(`[kg-run] no real cycle proved the path → running WETH→USDC→WETH self-test…`);
    // Source WETH/USDC pools directly (poolsForToken has no ORDER BY, so the arb-centric universe may not
    // include the deep executable pools). Dedup by address.
    const wuMap = new Map<string, PoolState>();
    for (const p of poolStates.values()) { const set = new Set([p.token0, p.token1]); if (set.has(weth) && set.has(usdc)) wuMap.set(p.address, p); }
    for (const t of [weth, usdc]) for (const row of await db.poolsForToken(cid, t).catch(() => [])) {
      const m = (row.meta ?? {}) as { token0?: string; token1?: string; archetype?: string; fee?: unknown; factory?: string; tickSpacing?: unknown };
      if (!m.token0 || !m.token1) continue; const set = new Set([m.token0.toLowerCase(), m.token1.toLowerCase()]);
      if (!(set.has(weth) && set.has(usdc)) || wuMap.has(row.address.toLowerCase())) continue;
      const arch = (m.archetype ?? "v3") as Archetype; if (arch === "aerodrome-stable") continue;
      const st = (await db.poolStateBatch(cid, [row.address.toLowerCase()]).catch(() => new Map())).get(row.address.toLowerCase());
      wuMap.set(row.address.toLowerCase(), { address: row.address.toLowerCase(), archetype: arch, token0: m.token0.toLowerCase(), token1: m.token1.toLowerCase(), feePpm: Number(m.fee) > 0 ? Number(m.fee) : 0, factory: m.factory?.toLowerCase(), r0: st?.r0 ?? null, r1: st?.r1 ?? null, sqrtPriceX96: st?.sqrtPrice ?? null, liquidity: st?.liquidity ?? null, block: st?.block ?? 0, tickSpacing: Number(m.tickSpacing) > 0 ? Number(m.tickSpacing) : undefined });
    }
    const amountIn = 10n ** 15n; // 0.001 WETH
    const legPool: Array<{ ps: PoolState; sim: PoolSim }> = [];
    for (const ps of wuMap.values()) { const s = await simFor(ps); if (!s) continue; const enc = await router.encodeLeg(ps, weth as Address, usdc as Address, amountIn, 0n, kg).catch(() => null); if (enc) legPool.push({ ps, sim: s }); if (legPool.length >= 2) break; }
    if (legPool.length < 2) { console.log(`[kg-run] self-test: <2 own-executable WETH/USDC pools among ${wuMap.size} candidates (harness pool-selection limit, not a routing failure)`); }
    else {
      const [A, B] = legPool;
      const q1 = A.sim.quote(weth, amountIn);
      const q2 = q1 ? B.sim.quote(usdc, q1.amountOut) : null;
      if (!q1 || !q2) { console.log(`[kg-run] self-test: quote failed`); }
      else {
        const legs = [
          { poolId: A.ps.address, tokenIn: weth, tokenOut: usdc, amountIn, amountOut: q1.amountOut },
          { poolId: B.ps.address, tokenIn: usdc, tokenOut: weth, amountIn: q1.amountOut, amountOut: q2.amountOut }
        ];
        const calls = await encodeCycle(router, poolStates, legs, kg);
        if (!calls) { console.log(`[kg-run] self-test: encode failed`); }
        else {
          const data = encodeFunctionData({ abi: FLASH_ABI, functionName: "flashExecute", args: [0, weth as Address, amountIn, 0n, calls.map((x) => ({ target: x.target, value: x.value, data: x.data }))] });
          console.log(`[kg-run] self-test: 0.001 WETH →${A.ps.archetype}→ ${Number(q1.amountOut) / 1e6} USDC →${B.ps.archetype}→ ${Number(q2.amountOut) / 1e18} WETH (${calls.length} calls)`);
          try { await chain.primary.call({ account: owner, to: kg, data }); console.log(`[kg-run] self-test: eth_call SUCCESS — full compile→executor→simulate path works (round-trip even broke even).`); }
          catch (err) { const reason = revertReason(err); const good = /profit below min/i.test(reason); console.log(`[kg-run] self-test: eth_call revert "${reason}" ${good ? "→ PATH PROVEN (swaps executed; unprofitable round-trip at minProfit=0, exactly expected)" : "→ ENCODE/EXEC BUG"}`); }
        }
      }
    }
  }

  console.log(`[kg-run] cycles=${cycles.length} executable=${executable} encoded=${encoded} pathProven(eth_call)=${simulated}`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-run] fatal:", e); process.exit(1); });
