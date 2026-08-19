import type { AssetId } from "./state.js";

/**
 * LENDING STATE (phase F4) — makes Morpho lending markets + borrower positions first-class STATE in the
 * Liquidity-Graph kernel, exactly as VenueFork does for AMM pools. Once the state can REPRESENT market /
 * collateral / debt / health / oracle / borrower-position, a liquidation is no longer special: LiquidateOp
 * (F5) is just a Transformation that mutates this state, and a flash-liquidation is an ordinary plan
 *   FlashBorrow(loan) → LiquidateOp(seize collateral, repay debt) → SwapOp(collateral→loan) → FlashRepay
 * the existing kernel simulates, sizes, gates, encodes and executes — composable with swaps.
 *
 * This module is PURE (types + math + COW state). Loading from the DB / fresh oracle reads is the caller's
 * job. Math mirrors Morpho Blue exactly (verified against the live liquidation monitor's formula):
 *   collateralValueInLoan = collateral · price / 1e36        (oracle price is 1e36-scaled, loan per collateral)
 *   maxBorrow             = collateralValueInLoan · lltv / 1e18   (lltv is WAD 1e18)
 *   HF                    = maxBorrow / borrowAssets
 *   liquidatable ⇔ HF < 1 ⇔ collateral · price · lltv < borrowAssets · 1e54   (exact integer form)
 */

export const MORPHO_WAD = 10n ** 18n;    // lltv scale
export const ORACLE_SCALE = 10n ** 36n;  // Morpho oracle price scale (loan per collateral)
const E54 = MORPHO_WAD * ORACLE_SCALE;

export interface MarketParams {
  loanToken: AssetId;
  collateralToken: AssetId;
  oracle: string;
  irm: string;
  lltv: bigint; // WAD (1e18)
}

/** A Morpho market's mirrored state. `oraclePrice` (1e36, loan per collateral) is read fresh — it is the
 * value that determines every borrower's health, so it lives on the market, not the position. */
export class LendingMarketSim {
  constructor(
    readonly marketId: string,
    readonly protocol: string,
    readonly params: MarketParams,
    public oraclePrice: bigint,
    public totalBorrowAssets: bigint = 0n,
    public totalBorrowShares: bigint = 0n
  ) {}
  clone(): LendingMarketSim { return new LendingMarketSim(this.marketId, this.protocol, this.params, this.oraclePrice, this.totalBorrowAssets, this.totalBorrowShares); }
}

/** One borrower's position in a market — the collateral they posted and the debt they owe (in loan
 * assets, already converted from shares). Health is derived against the market's live oracle price. */
export class BorrowerPositionSim {
  constructor(
    readonly marketId: string,
    readonly borrower: string,
    public collateral: bigint,   // raw collateral-token wei
    public debtAssets: bigint    // raw loan-token wei owed
  ) {}

  /** Health factor as a float (display/ranking). Infinity when debt-free. Computed in bigint then scaled
   * to avoid overflow: HF = (collateral·lltv/1e18 · price) / debt / 1e36. */
  healthFactor(m: LendingMarketSim): number {
    if (this.debtAssets <= 0n) return Infinity;
    const collAdj = (this.collateral * m.params.lltv) / MORPHO_WAD; // collateral weighted by lltv
    const scaled = (collAdj * m.oraclePrice) / this.debtAssets;     // ≈ HF · 1e36
    return Number(scaled) / 1e36;
  }

  /** PROTOCOL liquidatability (Morpho's own check), exact integer form: collateral·price·lltv < debt·1e54.
   * Deliberately protocol-correct: collateral==0 && debt>0 IS liquidatable (a fully-underwater bad-debt
   * position) — it is simply NOT economically actionable (nothing to seize). That economic filter
   * (seizable>0, exit>repay+gas+buffer) lives in the actionability/executability gate, NOT here — same
   * discipline as economicEdge≠executable. Do not fold an economic shortcut into the Morpho model. */
  protocolLiquidatable(m: LendingMarketSim): boolean {
    if (this.debtAssets <= 0n) return false; // no debt ⇒ HF = ∞
    return this.collateral * m.oraclePrice * m.params.lltv < this.debtAssets * E54;
  }

  /** The oracle price (1e36) at which HF crosses 1 — the liquidation trigger the monitor precomputes. */
  liqPrice(m: LendingMarketSim): bigint {
    if (this.collateral <= 0n || m.params.lltv <= 0n) return 0n;
    return (this.debtAssets * E54) / (this.collateral * m.params.lltv);
  }

  clone(): BorrowerPositionSim { return new BorrowerPositionSim(this.marketId, this.borrower, this.collateral, this.debtAssets); }
}

export const posKey = (marketId: string, borrower: string): string => `${marketId.toLowerCase()}|${borrower.toLowerCase()}`;

// ── Morpho liquidation math (mirrors Morpho Blue; cross-checked against liquidation-monitor/primitives) ──
const CURSOR = 3n * 10n ** 17n;      // 0.3 WAD
const MAX_LIF = 115n * 10n ** 16n;   // 1.15 WAD

/** Liquidation Incentive Factor (WAD): min(1.15, 1/(1 − 0.3·(1−lltv))). */
export function lifWad(lltv: bigint): bigint {
  const denom = MORPHO_WAD - (CURSOR * (MORPHO_WAD - lltv)) / MORPHO_WAD;
  if (denom <= 0n) return MAX_LIF;
  const lif = (MORPHO_WAD * MORPHO_WAD) / denom;
  return lif < MAX_LIF ? lif : MAX_LIF;
}

/** Loan assets a liquidator repays to seize `seized` collateral: seized·price/1e36 ÷ LIF. */
export function repaidFromSeized(seized: bigint, price: bigint, lifWadV: bigint): bigint {
  const loanValue = (seized * price) / ORACLE_SCALE; // value of seized collateral in loan token
  return (loanValue * MORPHO_WAD) / lifWadV;         // discounted by the incentive
}

/** Collateral to seize to repay the WHOLE debt (= debt·LIF·1e36/price), capped at available collateral. */
export function seizeForFullRepay(debt: bigint, price: bigint, lifWadV: bigint, collateral: bigint): bigint {
  if (price <= 0n) return 0n;
  const need = ((debt * lifWadV) / MORPHO_WAD * ORACLE_SCALE) / price;
  return need < collateral ? need : collateral;
}

/** Immutable lending snapshot at one block. Forks overlay changes copy-on-write (a plan touches one or two
 * positions, never the whole book). */
export class LendingSnapshot {
  constructor(readonly markets: ReadonlyMap<string, LendingMarketSim>, readonly positions: ReadonlyMap<string, BorrowerPositionSim>) {}
  fork(): LendingFork { return new LendingFork(this.markets, this.positions); }
  get size(): number { return this.positions.size; }
}

/** Copy-on-write overlay over the lending book — mirrors VenueFork. */
export class LendingFork {
  private mOver = new Map<string, LendingMarketSim>();
  private pOver = new Map<string, BorrowerPositionSim>();
  constructor(private readonly baseMarkets: ReadonlyMap<string, LendingMarketSim>, private readonly basePositions: ReadonlyMap<string, BorrowerPositionSim>) {}

  market(id: string): LendingMarketSim | undefined { const k = id.toLowerCase(); return this.mOver.get(k) ?? this.baseMarkets.get(k); }
  position(marketId: string, borrower: string): BorrowerPositionSim | undefined { const k = posKey(marketId, borrower); return this.pOver.get(k) ?? this.basePositions.get(k); }

  mutableMarket(id: string): LendingMarketSim | undefined {
    const k = id.toLowerCase(); const e = this.mOver.get(k); if (e) return e;
    const b = this.baseMarkets.get(k); if (!b) return undefined; const c = b.clone(); this.mOver.set(k, c); return c;
  }
  mutablePosition(marketId: string, borrower: string): BorrowerPositionSim | undefined {
    const k = posKey(marketId, borrower); const e = this.pOver.get(k); if (e) return e;
    const b = this.basePositions.get(k); if (!b) return undefined; const c = b.clone(); this.pOver.set(k, c); return c;
  }
}
