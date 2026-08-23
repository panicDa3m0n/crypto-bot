import type { Database } from "../db.js";
import type { LiquidityGraph } from "./graph-loader.js";

/**
 * LENDING POSITIONS AS FIRST-CLASS KG NODES.
 *
 * A liquidation was, until now, a separate pipeline: its own registry, its own valuation, its own monitor. It
 * predates the graph and was deliberately kept apart. That separation is what let it drift — it rejected a
 * profitable liquidation on an exit number that contradicted the price the rest of the system already held.
 *
 * A borrower's position is not a different KIND of thing from a pool. It is a node whose value depends on the
 * same prices and the same paths:
 *
 *   collateral price ─┐
 *   loan price ───────┼─→ health factor (protocol's own oracle)   → is it liquidatable?
 *   exit path ────────┘   seized collateral sold through pools    → is it profitable?
 *
 * Two consequences, and both matter:
 *
 * 1. IT IS DIRTIED BY THE SAME EVENTS. When a block moves a pool, every position whose collateral or loan
 *    token sits on that pool has a new exit value, hence a new profit. No separate polling loop is needed:
 *    the position is downstream of the same change feed as everything else.
 *
 * 2. IT IS PROFITABLE ON ITS OWN — ARITY 1. A cycle needs several hops to close; a liquidation is already
 *    closed: seize, sell, repay. It must be executable the moment it is favourable, without belonging to a
 *    longer strategy. A graph that only recognises multi-hop paths would step over the single most reliable
 *    edge on the chain.
 *
 * The HF deliberately does NOT come from our spot price. Liquidatability is decided by the PROTOCOL's oracle —
 * that is what the contract itself checks — while profit is decided by our executable exit. Conflating the two
 * would either invent liquidations the contract refuses, or miss ones it allows.
 */

export interface LiquidationNode {
  key: string;                 // protocol:market:borrower
  protocol: string;
  marketId: string;
  borrower: string;
  collateralToken: string;
  loanToken: string;
  collateralRaw: bigint;
  debtRaw: bigint;
  lltv: number;
  oracle: string | null;
  /** Health factor as last established. NULL when it has never been computed — never assumed healthy. */
  hf: number | null;
  tier: string;
}

/** Load the positions that are candidates for evaluation: anything not closed and not blacklisted. */
export async function loadLiquidationNodes(db: Database, cid: number): Promise<LiquidationNode[]> {
  const rows = await db.liquidationGraphNodes(cid).catch(() => []);
  return rows.map((r) => ({
    key: `${r.protocol}:${r.marketId}:${r.borrower}`,
    protocol: r.protocol, marketId: r.marketId, borrower: r.borrower,
    collateralToken: (r.collateralToken ?? "").toLowerCase(),
    loanToken: (r.loanToken ?? "").toLowerCase(),
    collateralRaw: BigInt(r.collateralRaw ?? "0"),
    debtRaw: BigInt(r.debtRaw ?? "0"),
    lltv: r.lltv ?? 0,
    oracle: r.oracle,
    hf: r.hf,
    tier: r.tier,
  })).filter((n) => n.collateralToken && n.loanToken && n.collateralRaw > 0n && n.debtRaw > 0n);
}

/**
 * Which positions a block invalidated.
 *
 * A position is dirty when the value of what it holds or owes can have moved: either its token was repriced,
 * or a pool it would have to sell through moved. The second is the subtle one — a position's collateral price
 * can be unchanged while the DEPTH it must sell into has shifted, and depth is what decides whether the
 * liquidation actually profits.
 */
export function dirtyLiquidationNodes(nodes: LiquidationNode[], graph: LiquidityGraph, dirty: { pools: Set<string>; tokens: Set<string> }): LiquidationNode[] {
  if (!dirty.pools.size && !dirty.tokens.size) return [];
  // Tokens that sit on a moved pool: the exit depth for anything holding them has changed.
  const touched = new Set(dirty.tokens);
  for (const pool of dirty.pools) {
    const p = graph.pools.get(pool);
    if (p) { touched.add(p.token0); touched.add(p.token1); }
  }
  return nodes.filter((n) => touched.has(n.collateralToken) || touched.has(n.loanToken));
}

/**
 * Morpho's liquidation incentive: LIF = min(1.15, 1/(1 − 0.3·(1−LLTV))). The seized slice is worth LIF times
 * the debt repaid — that premium IS the profit, before the cost of selling it.
 */
export function liquidationIncentive(lltv: number): number {
  return lltv > 0 && lltv < 1 ? Math.min(1.15, 1 / (1 - 0.3 * (1 - lltv))) : 1.05;
}

/**
 * The collateral a liquidator may seize and the debt it repays, in RAW units, using the protocol's own
 * arithmetic. Both are capped by what the position actually holds: a liquidation cannot seize more collateral
 * than exists, nor repay more than is owed.
 *
 * `oraclePrice` is Morpho's 1e36-scaled collateral-per-loan price — the same number the contract uses, so the
 * slice we compute is the slice the contract would allow.
 */
export function seizeAndRepay(node: LiquidationNode, oraclePrice: bigint, collateralDecimals: number, loanDecimals: number): { seizeRaw: bigint; repayRaw: bigint } | null {
  if (oraclePrice <= 0n) return null;
  const lif = liquidationIncentive(node.lltv);
  // Value both sides in loan-token units through the protocol oracle, then take the smaller constraint.
  const collateralInLoan = (node.collateralRaw * oraclePrice) / 10n ** 36n;
  if (collateralInLoan <= 0n) return null;
  const lifNum = BigInt(Math.round(lif * 1_000_000));
  // Repay is limited by the debt, and by how much collateral exists at the incentive rate.
  const repayFromCollateral = (collateralInLoan * 1_000_000n) / lifNum;
  const repayRaw = node.debtRaw < repayFromCollateral ? node.debtRaw : repayFromCollateral;
  // Seize is the repaid value times the incentive, converted back to collateral units — capped by holdings.
  const seizeInLoan = (repayRaw * lifNum) / 1_000_000n;
  const seizeRaw = (seizeInLoan * 10n ** 36n) / oraclePrice;
  const capped = seizeRaw > node.collateralRaw ? node.collateralRaw : seizeRaw;
  void collateralDecimals; void loanDecimals; // decimals stay with the caller: raw units carry the decision
  return capped > 0n && repayRaw > 0n ? { seizeRaw: capped, repayRaw } : null;
}
