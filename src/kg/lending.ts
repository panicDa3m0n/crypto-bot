import type { AssetId } from "./state.js";

/**
 * LENDING STATE (F4 model + F5.1 share-exact math) — Morpho lending markets + borrower positions as
 * first-class kernel state, mirroring VenueFork. F5.1 makes the liquidation math BIT-EXACT to Morpho Blue:
 *   - borrowShares is the SOURCE OF TRUTH; debt in assets is DERIVED (toAssetsUp) against live market
 *     totals — because Morpho stores shares and converts with rounding, never a stored asset amount.
 *   - liquidate() replicates Morpho literally: seized → mulDivUp(price)/ORACLE_SCALE → wDivUp(LIF) →
 *     toSharesUp → repaidShares → toAssetsUp → repaidAssets, then subtracts SHARES from position+market
 *     totals and realises bad debt when collateral hits 0. Every conversion rounds the way Morpho does, so
 *     the flash amount we borrow (= repaidAssets) matches what the chain pulls to the wei → no revert.
 *
 * ACCRUAL: Morpho calls _accrueInterest() before the health check + liquidation, which grows
 * totalBorrowAssets by the AdaptiveCurveIRM's compounded rate since lastUpdate. We do NOT replicate the
 * IRM (its rateAtTarget state isn't mirrored); our snapshot is the last-accrued on-chain read, and the
 * final eth_call at inclusion is the SOURCE OF TRUTH for the tiny per-block accrual delta (guarded by the
 * real on-chain minProfit). `lastUpdate`/`fee` are carried for a future deterministic accrueTo().
 */

export const MORPHO_WAD = 10n ** 18n;      // lltv / LIF scale
export const ORACLE_SCALE = 10n ** 36n;    // Morpho oracle price scale (loan per collateral)
export const VIRTUAL_SHARES = 10n ** 6n;   // Morpho SharesMathLib
export const VIRTUAL_ASSETS = 1n;
const CURSOR = 3n * 10n ** 17n;            // LIQUIDATION_CURSOR 0.3 WAD
const MAX_LIF = 115n * 10n ** 16n;        // MAX_LIQUIDATION_INCENTIVE_FACTOR 1.15 WAD

// ── Morpho fixed-point primitives (bit-exact) ──
const mulDivDown = (x: bigint, y: bigint, d: bigint): bigint => (x * y) / d;
const mulDivUp = (x: bigint, y: bigint, d: bigint): bigint => (x * y + (d - 1n)) / d;
const wMulDown = (x: bigint, y: bigint): bigint => mulDivDown(x, y, MORPHO_WAD);
const wDivUp = (x: bigint, y: bigint): bigint => mulDivUp(x, MORPHO_WAD, y);
const zeroFloorSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);

export const toAssetsUp = (shares: bigint, tA: bigint, tS: bigint): bigint => mulDivUp(shares, tA + VIRTUAL_ASSETS, tS + VIRTUAL_SHARES);
export const toAssetsDown = (shares: bigint, tA: bigint, tS: bigint): bigint => mulDivDown(shares, tA + VIRTUAL_ASSETS, tS + VIRTUAL_SHARES);
export const toSharesUp = (assets: bigint, tA: bigint, tS: bigint): bigint => mulDivUp(assets, tS + VIRTUAL_SHARES, tA + VIRTUAL_ASSETS);

/** Liquidation Incentive Factor (WAD): min(1.15, 1/(1 − 0.3·(1−lltv))) — Morpho's exact form. */
export function lifWad(lltv: bigint): bigint {
  const denom = MORPHO_WAD - wMulDown(CURSOR, MORPHO_WAD - lltv);
  if (denom <= 0n) return MAX_LIF;
  const lif = mulDivDown(MORPHO_WAD, MORPHO_WAD, denom);
  return lif < MAX_LIF ? lif : MAX_LIF;
}

export interface MarketParams {
  loanToken: AssetId;
  collateralToken: AssetId;
  oracle: string;
  irm: string;
  lltv: bigint; // WAD
}

/** A Morpho market's mirrored state (post last on-chain accrual). */
export class LendingMarketSim {
  constructor(
    readonly marketId: string,
    readonly protocol: string,
    readonly params: MarketParams,
    public oraclePrice: bigint,          // 1e36, loan per collateral
    public totalBorrowAssets: bigint = 0n,
    public totalBorrowShares: bigint = 0n,
    public totalSupplyAssets: bigint = 0n,
    public lastUpdate: number = 0,       // for a future deterministic accrueTo()
    public fee: bigint = 0n
  ) {}
  clone(): LendingMarketSim { return new LendingMarketSim(this.marketId, this.protocol, this.params, this.oraclePrice, this.totalBorrowAssets, this.totalBorrowShares, this.totalSupplyAssets, this.lastUpdate, this.fee); }
}

/** A borrower's position: collateral + borrowShares (SOURCE OF TRUTH). Debt in assets is derived. */
export class BorrowerPositionSim {
  constructor(readonly marketId: string, readonly borrower: string, public collateral: bigint, public borrowShares: bigint) {}

  /** Debt in loan assets = borrowShares → toAssetsUp against the market's live totals (Morpho's own conv). */
  debtAssets(m: LendingMarketSim): bigint { return this.borrowShares > 0n ? toAssetsUp(this.borrowShares, m.totalBorrowAssets, m.totalBorrowShares) : 0n; }

  /** Health factor (float, display). maxBorrow = collateral·price/1e36 · lltv; HF = maxBorrow / debt. */
  healthFactor(m: LendingMarketSim): number {
    const debt = this.debtAssets(m);
    if (debt <= 0n) return Infinity;
    const maxBorrow = wMulDown(mulDivDown(this.collateral, m.oraclePrice, ORACLE_SCALE), m.params.lltv);
    return Number(mulDivDown(maxBorrow, MORPHO_WAD, debt)) / 1e18;
  }

  /** PROTOCOL liquidatability (Morpho _isHealthy, exact): maxBorrow < borrowed. Protocol-correct:
   * collateral==0 && debt>0 IS liquidatable (bad-debt). The economic filter lives in the gate, not here. */
  protocolLiquidatable(m: LendingMarketSim): boolean {
    const debt = this.debtAssets(m);
    if (debt <= 0n) return false;
    const maxBorrow = wMulDown(mulDivDown(this.collateral, m.oraclePrice, ORACLE_SCALE), m.params.lltv);
    return maxBorrow < debt;
  }

  /** Oracle price (1e36) at which HF crosses 1 — the monitor's trigger. */
  liqPrice(m: LendingMarketSim): bigint {
    if (this.collateral <= 0n || m.params.lltv <= 0n) return 0n;
    const debt = this.debtAssets(m);
    return (debt * ORACLE_SCALE * MORPHO_WAD) / (this.collateral * m.params.lltv);
  }

  clone(): BorrowerPositionSim { return new BorrowerPositionSim(this.marketId, this.borrower, this.collateral, this.borrowShares); }
}

// ── Share-exact liquidation calculus (matches Morpho's seizedAssets path bit-for-bit) ──
export interface LiquidationCalc { seized: bigint; repaidShares: bigint; repaidAssets: bigint }

/** Replicates Morpho.liquidate(seizedAssets=…) forward math on the PRE-mutation (accrued) market totals.
 * seized is capped to the borrower's collateral; repaidShares to their borrowShares (so the on-chain
 * `borrowShares -= repaidShares` can't underflow). Returns null if nothing is seizable. */
export function computeLiquidation(m: LendingMarketSim, pos: BorrowerPositionSim, seizeRequest: bigint): LiquidationCalc | null {
  const seized = seizeRequest < pos.collateral ? seizeRequest : pos.collateral;
  if (seized <= 0n) return null;
  const lif = lifWad(m.params.lltv);
  const seizedQuoted = mulDivUp(seized, m.oraclePrice, ORACLE_SCALE);         // value of seized collateral in loan
  let repaidShares = toSharesUp(wDivUp(seizedQuoted, lif), m.totalBorrowAssets, m.totalBorrowShares);
  if (repaidShares > pos.borrowShares) repaidShares = pos.borrowShares;       // can't repay more than owed
  if (repaidShares <= 0n) return null;
  const repaidAssets = toAssetsUp(repaidShares, m.totalBorrowAssets, m.totalBorrowShares);
  return { seized, repaidShares, repaidAssets };
}

/** The seizeRequest that targets FULL debt repayment (inverse of the seized→repaid path, rounded up so it
 * covers the whole debt); computeLiquidation then caps it to collateral / borrowShares. */
export function seizeForFullRepay(m: LendingMarketSim, pos: BorrowerPositionSim): bigint {
  const lif = lifWad(m.params.lltv);
  const debt = pos.debtAssets(m);                       // assets to repay
  const quoted = mulDivUp(debt, lif, MORPHO_WAD);       // × LIF (loan value of collateral to seize)
  return mulDivUp(quoted, ORACLE_SCALE, m.oraclePrice); // → collateral units
}

export const posKey = (marketId: string, borrower: string): string => `${marketId.toLowerCase()}|${borrower.toLowerCase()}`;

/** Immutable lending snapshot at one block; forks overlay changes copy-on-write. */
export class LendingSnapshot {
  constructor(readonly markets: ReadonlyMap<string, LendingMarketSim>, readonly positions: ReadonlyMap<string, BorrowerPositionSim>) {}
  fork(): LendingFork { return new LendingFork(this.markets, this.positions); }
  get size(): number { return this.positions.size; }
}

/** Copy-on-write overlay over the lending book — mirrors VenueFork. Also exposes bad-debt-aware mutation. */
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

  /** Apply a computed liquidation to the state, EXACTLY as Morpho does: subtract shares from position +
   * market totals, subtract repaidAssets from totalBorrowAssets, subtract seized collateral, then realise
   * bad debt if the collateral hit zero (socialised to supply). Returns the repaidAssets (= flash owed). */
  applyLiquidation(marketId: string, borrower: string, calc: LiquidationCalc): bigint {
    const m = this.mutableMarket(marketId)!;
    const pos = this.mutablePosition(marketId, borrower)!;
    pos.borrowShares -= calc.repaidShares;
    m.totalBorrowShares -= calc.repaidShares;
    m.totalBorrowAssets = zeroFloorSub(m.totalBorrowAssets, calc.repaidAssets);
    pos.collateral -= calc.seized;
    if (pos.collateral === 0n && pos.borrowShares > 0n) {
      const badDebtShares = pos.borrowShares;
      const badDebtAssets = min(m.totalBorrowAssets, toAssetsUp(badDebtShares, m.totalBorrowAssets, m.totalBorrowShares));
      m.totalBorrowAssets = zeroFloorSub(m.totalBorrowAssets, badDebtAssets);
      m.totalSupplyAssets = zeroFloorSub(m.totalSupplyAssets, badDebtAssets);
      m.totalBorrowShares -= badDebtShares;
      pos.borrowShares = 0n;
    }
    return calc.repaidAssets;
  }
}

function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
