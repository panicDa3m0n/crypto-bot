/**
 * KG LIQUIDATE (phase F5 — flash-liquidation as an ordinary plan, end-to-end). For each PROTOCOL-
 * liquidatable Morpho position (fresh on-chain HF), builds the plan
 *   FlashBorrow(loan) → LiquidateOp(seize) → SwapOp(collateral→loan) → FlashRepay
 * simulates realized PnL on the SAME kernel (lending + venue forks), applies the ECONOMIC actionability
 * gate (seizable>0, exit>repay+gas+buffer — kept OUT of the protocol model), encodes to KGExecutor Call[]
 * and eth_call's flashExecute. Proves LiquidateOp composes with SwapOp through the proven pipeline.
 * READ-ONLY unless `--execute` and a genuinely actionable position exists.
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
import { LendingMarketSim, BorrowerPositionSim, LendingSnapshot, posKey, type MarketParams } from "../kg/lending.js";
import { buildPoolSim, makeSnapshot, planFlashLiquidation, simulateFlashLiquidation } from "../kg/kernel.js";
import { PoolSim } from "../kg/state.js";
import { encodeLiquidationPlan } from "../kg/encode.js";

const CONC = new Set<Archetype>(["v3", "v4", "slipstream"]);
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
  return e?.cause?.reason ?? e?.cause?.shortMessage ?? e?.shortMessage ?? String(err).slice(0, 140);
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

  // ethUsd for USD netting.
  let ethUsd = 0;
  for (const p of await db.poolsForToken(cid, weth).catch(() => [])) { const m = (p.meta ?? {}) as { token0?: string; token1?: string }; if (!m.token0 || !m.token1) continue; const set = new Set([m.token0.toLowerCase(), m.token1.toLowerCase()]); if (!set.has(usdc)) continue; const st = (await db.poolStateBatch(cid, [p.address.toLowerCase()])).get(p.address.toLowerCase()); if (!st) continue; const sim = buildPoolSim({ address: p.address, archetype: (m as { archetype?: string }).archetype as Archetype ?? "v3", token0: m.token0.toLowerCase(), token1: m.token1.toLowerCase(), feePpm: 0, r0: st.r0, r1: st.r1, sqrtPriceX96: st.sqrtPrice, liquidity: st.liquidity, block: st.block }); const q = sim?.quote(weth, 10n ** 18n); if (q) ethUsd = Math.max(ethUsd, Number(q.amountOut) / 1e6); }
  const gasPriceWei = (await chain.primary.getGasPrice().catch(() => 0n)) || 0n;
  const loanUsd = (t: string) => t === usdc ? 1 : t === weth ? ethUsd : null;

  const rows = await db.listLendingPositions(cid, { limit: scan }).catch(() => []);
  console.log(`[kg-liquidate] head=${head} morpho=${morpho} scan=${rows.length} ethUsd≈${ethUsd.toFixed(2)}`);

  // Build a collateral→loan PoolSim/PoolState for a token pair (best output for `amount`).
  const tickCache = new Map<string, Array<{ tick: number; liquidityNet: bigint }>>();
  async function bestExitPool(collateral: string, loan: string, amount: bigint): Promise<{ ps: PoolState; sim: PoolSim } | null> {
    const rowsC = await db.poolsForToken(cid, collateral).catch(() => []);
    const cands = rowsC.filter((p) => { const m = (p.meta ?? {}) as { token0?: string; token1?: string }; const set = new Set([m.token0?.toLowerCase(), m.token1?.toLowerCase()]); return set.has(loan); });
    if (!cands.length) return null;
    const states = await db.poolStateBatch(cid, cands.map((c) => c.address.toLowerCase())).catch(() => new Map());
    let best: { ps: PoolState; sim: PoolSim; out: bigint } | null = null;
    for (const c of cands) {
      const m = (c.meta ?? {}) as { token0?: string; token1?: string; archetype?: string; fee?: unknown; factory?: string };
      if (!m.token0 || !m.token1) continue;
      const arch = (m.archetype ?? "v3") as Archetype;
      if (arch === "aerodrome-stable") continue;
      const st = states.get(c.address.toLowerCase());
      const ps: PoolState = { address: c.address.toLowerCase(), archetype: arch, token0: m.token0.toLowerCase(), token1: m.token1.toLowerCase(), feePpm: Number(m.fee) > 0 ? Number(m.fee) : 0, factory: m.factory?.toLowerCase(), r0: st?.r0 ?? null, r1: st?.r1 ?? null, sqrtPriceX96: st?.sqrtPrice ?? null, liquidity: st?.liquidity ?? null, block: st?.block ?? 0 };
      let ticks: Array<{ tick: number; liquidityNet: bigint }> | undefined;
      if (CONC.has(arch)) { ticks = tickCache.get(ps.address) ?? await db.tickLiquidity(cid, ps.address).catch(() => []); tickCache.set(ps.address, ticks); }
      const sim = buildPoolSim(ps, ticks); if (!sim) continue;
      const q = sim.quote(collateral, amount); if (!q) continue;
      if (!best || q.amountOut > best.out) best = { ps, sim, out: q.amountOut };
    }
    return best ? { ps: best.ps, sim: best.sim } : null;
  }

  let liquidatable = 0, actionable = 0, pathProven = 0;
  for (const p of rows) {
    if (!p.marketId) continue;
    const id = p.marketId as Hex;
    try {
      const mp = await rc<[Address, Address, Address, Address, bigint]>({ address: morpho, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [id] });
      const params: MarketParams = { loanToken: mp[0].toLowerCase(), collateralToken: mp[1].toLowerCase(), oracle: mp[2].toLowerCase(), irm: mp[3].toLowerCase(), lltv: mp[4] };
      if (params.oracle === "0x0000000000000000000000000000000000000000") continue;
      const loan = params.loanToken, coll = params.collateralToken;
      if (loan !== usdc && loan !== weth) continue; // need flash-fundable loan
      const [mk, price] = await Promise.all([
        rc<[bigint, bigint, bigint, bigint, bigint, bigint]>({ address: morpho, abi: MORPHO_ABI, functionName: "market", args: [id] }),
        rc<bigint>({ address: params.oracle as Address, abi: ORACLE_ABI, functionName: "price" })
      ]);
      const pos = await rc<[bigint, bigint, bigint]>({ address: morpho, abi: MORPHO_ABI, functionName: "position", args: [id, p.borrower as Address] });
      const collateral = pos[2];
      const market = new LendingMarketSim(id, p.protocol, params, price, mk[2], mk[3], mk[0], Number(mk[4]), mk[5]);
      const position = new BorrowerPositionSim(id, p.borrower, collateral, pos[1]);
      if (!position.protocolLiquidatable(market)) continue;
      liquidatable++;

      // Exit pool for collateral→loan (the executability/actionability gate: no route ⇒ not actionable).
      const exit = await bestExitPool(coll, loan, position.protocolLiquidatable(market) ? (collateral > 0n ? collateral : 1n) : 1n);
      if (!exit) { console.log(`  ${p.collateralSymbol}→${p.loanSymbol} liquidatable but NO own-executable exit pool → not actionable  ${p.borrower.slice(0, 10)}`); continue; }

      const plan = planFlashLiquidation(market, position, exit.ps.address, exit.ps.archetype);
      if (!plan) continue;
      const lendingSnap = new LendingSnapshot(new Map([[id.toLowerCase(), market]]), new Map([[posKey(id, p.borrower), position]]));
      const venueSnap = makeSnapshot({ chainId: cid, blockNumber: head }, [exit.sim]);
      const sim = simulateFlashLiquidation(venueSnap, lendingSnap, plan);
      const dq = exit.sim.quote(coll, plan.seized); // diagnostic: what the exit swap yields
      const swapOut = dq?.amountOut ?? 0n;
      const lu = loanUsd(loan)!;
      const dec = loan === usdc ? 6 : 18;
      const pnlUsd = Number(sim.realizedPnl) / 10 ** dec * lu;
      const gasUsd = Number(plan.ops.reduce((s, o) => s + o.gas(), 0n) * gasPriceWei) / 1e18 * ethUsd;
      const netUsd = pnlUsd - gasUsd;
      const act = sim.valid && netUsd > 0.01;
      if (act) actionable++;
      const exitRatio = plan.repaid > 0n ? Number(swapOut) / Number(plan.repaid) : 0;
      console.log(`  ${p.collateralSymbol}→${p.loanSymbol} seize=${plan.seized} repay=${plan.repaid} swapOut=${swapOut} (exit=${(exitRatio * 100).toFixed(1)}% of repay via ${exit.ps.archetype} ${exit.ps.address.slice(0, 8)}) pnl=$${pnlUsd.toFixed(4)} net=$${netUsd.toFixed(4)} ${act ? "ACTIONABLE" : `not(${sim.valid ? "net≤thr" : sim.reason})`}  ${p.borrower.slice(0, 10)}`);

      // Encode + eth_call to prove the composed path (approve→liquidate→approve→swap under flash).
      const calls = await encodeLiquidationPlan(router, morpho, { loanToken: loan as Address, collateralToken: coll as Address, oracle: params.oracle as Address, irm: params.irm as Address, lltv: params.lltv }, p.borrower as Address, plan.seized, exit.ps, kg);
      if (!calls) { console.log(`         encode: exit hop not own-executable`); continue; }
      const data = encodeFunctionData({ abi: FLASH_ABI, functionName: "flashExecute", args: [0, loan as Address, plan.flashAmount, 0n, calls.map((x) => ({ target: x.target, value: x.value, data: x.data }))] });
      try { await chain.primary.call({ account: owner, to: kg, data }); pathProven++; console.log(`         eth_call: SUCCESS — flash+liquidate+swap+repay path executes (profitable at minProfit=0)`); }
      catch (err) { const reason = revertReason(err); const good = /profit below min/i.test(reason); if (good) pathProven++; console.log(`         eth_call: revert "${reason}" ${good ? "→ PATH PROVEN (liquidate+swap ran; unprofitable husk at minProfit=0)" : "→ (Morpho/exec revert — inspect)"}`); }
    } catch { /* skip unreadable */ }
  }
  console.log(`[kg-liquidate] liquidatable=${liquidatable} actionable=${actionable} pathProven(eth_call)=${pathProven}`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-liquidate] fatal:", e); process.exit(1); });
