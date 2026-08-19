/**
 * KG LIQUIDATE (F5 + F5.2 — flash-liquidation with MULTI-HOP sized exit). For each protocol-liquidatable
 * Morpho position, `bestRoute` chooses WHERE to exit the seized collateral (direct vs collateral→hub→loan,
 * hubs = WETH/USDC), and the EXACT kernel (VenueFork tick-crossing) decides HOW MUCH we actually get —
 * same discipline as the negative-cycle finder. The exit is a generic SwapOp route (1..n hops); the plan
 * and encoder don't care about hop count. We print direct-vs-multihop exit ratios so multi-hop either
 * UNLOCKS a husk the direct edge couldn't exit, or the exact sim collapses an apparent improvement.
 * READ-ONLY unless `--execute` and an actionable position exists.
 *
 *   ... run --rm brain node dist/scripts/kg-liquidate.js [scan=40]
 */
import { decodeErrorResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { LocalRouter } from "../router/router.js";
import type { Archetype, PoolState } from "../router/types.js";
import { bestRoute, type RouteResult } from "../router/graph.js";
import { ConstantProductAdapter } from "../router/adapters/constant-product.js";
import { V3Adapter } from "../router/adapters/v3.js";
import { LendingMarketSim, BorrowerPositionSim, LendingSnapshot, posKey, computeLiquidation, seizeForFullRepay, type MarketParams } from "../kg/lending.js";
import { buildPoolSim, makeSnapshot, planFlashLiquidation, simulateFlashLiquidation, type ExitHop } from "../kg/kernel.js";
import { PoolSim, type SwapTrace } from "../kg/state.js";
import { encodeLiquidationPlan } from "../kg/encode.js";

const CONC = new Set<Archetype>(["v3", "v4", "slipstream"]);
const ADAPTERS = [new ConstantProductAdapter(), new V3Adapter()];
const MORPHO_ABI = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)"
]);
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);
const FLASH_ABI = parseAbi(["function flashExecute(uint8 provider, address loanToken, uint256 amount, uint256 minProfit, (address target,uint256 value,bytes data)[] calls)"]);
const REVERT_STRINGS = parseAbi(["error Error(string)"]);

function revertReason(err: unknown): string {
  const e = err as { shortMessage?: string; cause?: { data?: Hex; reason?: string; shortMessage?: string } };
  const data = e?.cause?.data;
  if (data && data.length >= 10) { try { const d = decodeErrorResult({ abi: REVERT_STRINGS, data }); if (d.args?.[0]) return String(d.args[0]); } catch { /* not a string revert */ } }
  return e?.cause?.reason ?? e?.cause?.shortMessage ?? e?.shortMessage ?? String(err).slice(0, 120);
}

async function main() {
  const scan = Number(process.argv[2] ?? 40);
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const router = new LocalRouter(config, logger, db, chain);
  const cid = config.CHAIN_ID;
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();
  const owner = config.WALLET_ADDRESS as Address;
  const morpho = config.MORPHO_CORE as Address;
  const org = await db.getOrgan("kg-executor"); if (!org) throw new Error("kg-executor not deployed");
  const kg = org.address as Address;
  const head = (await db.getIndexerCursor(cid).catch(() => null)) ?? 0;
  const rc = <T>(p: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => chain.precision.readContract(p as never).catch(() => chain.primary.readContract(p as never)) as Promise<T>;

  const rows = await db.listLendingPositions(cid, { limit: scan }).catch(() => []);
  console.log(`[kg-liquidate] head=${head} morpho=${morpho} scan=${rows.length} (exit hubs: WETH,USDC)`);

  // Build the candidate exit universe for a (collateral, loan) pair = pools touching either → covers direct
  // (collateral/loan) and 2-hop (collateral/hub + hub/loan) since the intermediate lives in one of the two.
  const tickCache = new Map<string, Array<{ tick: number; liquidityNet: bigint }>>();
  async function universe(collateral: string, loan: string): Promise<PoolState[]> {
    const raw = new Map<string, { address: string; meta: unknown }>();
    for (const t of [collateral, loan]) for (const p of await db.poolsForToken(cid, t).catch(() => [])) raw.set(p.address.toLowerCase(), p);
    const states = await db.poolStateBatch(cid, [...raw.keys()]).catch(() => new Map());
    const out: PoolState[] = [];
    for (const [address, { meta }] of raw) {
      const m = (meta ?? {}) as { token0?: string; token1?: string; archetype?: string; fee?: unknown; factory?: string ; tickSpacing?: unknown };
      if (!m.token0 || !m.token1) continue;
      const arch = (m.archetype ?? "v3") as Archetype;
      if (arch === "aerodrome-stable") continue;
      const st = states.get(address);
      out.push({ address, archetype: arch, token0: m.token0.toLowerCase(), token1: m.token1.toLowerCase(), feePpm: Number(m.fee) > 0 ? Number(m.fee) : 0, factory: m.factory?.toLowerCase(), r0: st?.r0 ?? null, r1: st?.r1 ?? null, sqrtPriceX96: st?.sqrtPrice ?? null, liquidity: st?.liquidity ?? null, block: st?.block ?? 0, tickSpacing: Number(m.tickSpacing) > 0 ? Number(m.tickSpacing) : undefined });
    }
    return out;
  }
  const simForPool = async (ps: PoolState): Promise<PoolSim | null> => { let ticks: Array<{ tick: number; liquidityNet: bigint }> | undefined; if (CONC.has(ps.archetype)) { ticks = tickCache.get(ps.address) ?? await db.tickLiquidity(cid, ps.address).catch(() => []); tickCache.set(ps.address, ticks); } return buildPoolSim(ps, ticks); };
  const routeToHops = (r: RouteResult): ExitHop[] => r.path.map((p, i) => ({ poolId: p.address, tokenIn: r.hops[i], tokenOut: r.hops[i + 1], archetype: p.archetype }));
  const sym = (t: string) => t === weth ? "WETH" : t === usdc ? "USDC" : t.slice(0, 6);

  // Exact-simulate one candidate exit route → { exitOut, pnl, valid, legs, poolStates }.
  async function evalRoute(market: LendingMarketSim, pos: BorrowerPositionSim, route: RouteResult) {
    const hops = routeToHops(route);
    const poolStates = new Map<string, PoolState>();
    const sims: PoolSim[] = [];
    for (const p of route.path) { const s = await simForPool(p); if (!s) return null; sims.push(s); poolStates.set(p.address.toLowerCase(), p); }
    const plan = planFlashLiquidation(market, pos, hops);
    if (!plan) return null;
    const lendingSnap = new LendingSnapshot(new Map([[market.marketId.toLowerCase(), market]]), new Map([[posKey(market.marketId, pos.borrower), pos]]));
    const venueSnap = makeSnapshot({ chainId: cid, blockNumber: head }, sims);
    const trace: SwapTrace[] = [];
    const res = simulateFlashLiquidation(venueSnap, lendingSnap, plan, trace);
    const exitOut = trace.length ? trace[trace.length - 1].amountOut : 0n;
    return { hops, plan, res, trace, exitOut, poolStates };
  }

  let liquidatable = 0, actionable = 0, unlocked = 0, pathProven = 0;
  for (const p of rows) {
    if (!p.marketId) continue;
    const id = p.marketId as Hex;
    try {
      const mp = await rc<[Address, Address, Address, Address, bigint]>({ address: morpho, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [id] });
      const params: MarketParams = { loanToken: mp[0].toLowerCase(), collateralToken: mp[1].toLowerCase(), oracle: mp[2].toLowerCase(), irm: mp[3].toLowerCase(), lltv: mp[4] };
      if (params.oracle === "0x0000000000000000000000000000000000000000") continue;
      const loan = params.loanToken, coll = params.collateralToken;
      if (loan !== usdc && loan !== weth) continue;
      const [mk, price] = await Promise.all([
        rc<[bigint, bigint, bigint, bigint, bigint, bigint]>({ address: morpho, abi: MORPHO_ABI, functionName: "market", args: [id] }),
        rc<bigint>({ address: params.oracle as Address, abi: ORACLE_ABI, functionName: "price" })
      ]);
      const posR = await rc<[bigint, bigint, bigint]>({ address: morpho, abi: MORPHO_ABI, functionName: "position", args: [id, p.borrower as Address] });
      const market = new LendingMarketSim(id, p.protocol, params, price, mk[2], mk[3], mk[0], Number(mk[4]), mk[5]);
      const position = new BorrowerPositionSim(id, p.borrower, posR[2], posR[1]);
      if (!position.protocolLiquidatable(market)) continue;
      liquidatable++;

      const calc = computeLiquidation(market, position, seizeForFullRepay(market, position));
      if (!calc) continue;
      const pools = await universe(coll, loan);
      const rDirect = bestRoute(ADAPTERS, pools, coll, loan, calc.seized, 1);
      const rMulti = bestRoute(ADAPTERS, pools, coll, loan, calc.seized, 2);
      if (!rDirect && !rMulti) { console.log(`  ${p.collateralSymbol}→${p.loanSymbol} liquidatable, NO own-routable exit  ${p.borrower.slice(0, 10)}`); continue; }

      const evDirect = rDirect ? await evalRoute(market, position, rDirect) : null;
      const evMulti = rMulti ? await evalRoute(market, position, rMulti) : null;
      const ratio = (e: typeof evDirect) => e && calc.repaidAssets > 0n ? Number(e.exitOut) / Number(calc.repaidAssets) : 0;
      const rd = ratio(evDirect), rm = ratio(evMulti);
      // Pick the exact-best route (kernel decides, not bestRoute's adapter amountOut).
      const best = (evMulti && (!evDirect || evMulti.exitOut > evDirect.exitOut)) ? evMulti : evDirect;
      if (!best) continue;
      const bestHops = best.hops.map((h) => sym(h.tokenOut));
      const path = `${sym(coll)}→${bestHops.join("→")}`;
      const act = best.res.valid;
      if (act) actionable++;
      if (evMulti && evDirect && evMulti.exitOut > evDirect.exitOut * 11n / 10n) unlocked++;
      console.log(`  ${p.collateralSymbol}→${p.loanSymbol} seize=${calc.seized} repay=${calc.repaidAssets}  exit: direct=${(rd * 100).toFixed(1)}% multi=${(rm * 100).toFixed(1)}% → best ${path} (${best.hops.length}hop, ${act ? "ACTIONABLE" : best.res.reason})  ${p.borrower.slice(0, 10)}`);

      // Encode the exact-best route + eth_call (liquidation prefix + generic swap-trace compiler).
      const calls = await encodeLiquidationPlan(router, morpho, { loanToken: loan as Address, collateralToken: coll as Address, oracle: params.oracle as Address, irm: params.irm as Address, lltv: params.lltv }, p.borrower as Address, calc.seized, best.trace, best.poolStates, kg);
      if (!calls) { console.log(`         encode: an exit hop not own-executable`); continue; }
      const data = encodeFunctionData({ abi: FLASH_ABI, functionName: "flashExecute", args: [0, loan as Address, calc.repaidAssets, 0n, calls.map((x) => ({ target: x.target, value: x.value, data: x.data }))] });
      try { await chain.primary.call({ account: owner, to: kg, data }); pathProven++; console.log(`         eth_call: SUCCESS — flash+liquidate+${best.hops.length}-hop swap+repay executes (profitable @minProfit=0)`); }
      catch (err) { const reason = revertReason(err); const good = /profit below min/i.test(reason); if (good) pathProven++; console.log(`         eth_call: revert "${reason}" ${good ? "→ PATH PROVEN (liquidate+multi-hop swap ran; unprofitable @minProfit=0)" : ""}`); }
    } catch { /* skip unreadable */ }
  }
  console.log(`[kg-liquidate] liquidatable=${liquidatable} actionable=${actionable} multihop-unlocked(>10% better exit)=${unlocked} pathProven(eth_call)=${pathProven}`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-liquidate] fatal:", e); process.exit(1); });
