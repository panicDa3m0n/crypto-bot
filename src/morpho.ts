/**
 * MORPHO BLUE LIQUIDATION MATH — the single source, transcribed from the protocol's own specification.
 *
 * Reference: https://docs.morpho.org/learn/concepts/liquidation/
 *
 * This file exists because the same three formulas were written out four times across the codebase, and two
 * of those copies — both on the FIRE path — had already lost the 1.15 cap. Nothing had gone wrong yet only
 * because every live market sits above the LLTV where the cap bites; that is luck, not correctness.
 *
 * THE THREE FACTS THAT DECIDE EVERYTHING, and what each one does NOT say:
 *
 *   1. LIQUIDATABLE  ⇔  HF < 1,  where  HF = collateralValueInLoan · LLTV / borrowAssets.
 *      It says nothing about whether liquidating is worth doing.
 *
 *   2. LIF = min(M, 1 / (β·LLTV + (1−β)))  with β = 0.3, M = 1.15.
 *      The whole incentive goes to the liquidator — Morpho takes no fee. It is a FIXED fraction of whatever
 *      we repay, so the gross reward scales linearly with size while slippage does not. That asymmetry is
 *      why size is a decision and not a detail.
 *
 *   3. THERE IS NO CLOSE FACTOR. "Liquidators can choose to liquidate any amount of the borrower's debt up
 *      to the full amount." Every size in (0, maxSeize] is a legal liquidation.
 *
 * The consequence we had been missing follows from (2) and (3) together: profitability is a CURVE over size,
 * and a position is profitable if the curve is positive ANYWHERE — not only at the maximum. Judging a
 * position by its largest possible liquidation answers a question the protocol never asked.
 *
 * A second consequence, from the same algebra: profit does NOT depend on the collateral-to-debt ratio.
 * Seizing S costs S·price/LIF and returns S·price if sold at oracle value, so the gross margin is
 * S·price·(1 − 1/LIF) > 0 for ANY position with collateral left, bad debt included. Under-collateralisation
 * limits how MUCH can be seized; it does not make the seizure unprofitable.
 */

/** Morpho's oracle price scale: price is collateral-per-loan, scaled by 1e36. */
export const ORACLE_PRICE_SCALE = 10n ** 36n;
/** LLTV is a WAD (1e18-scaled). */
export const WAD = 10n ** 18n;
/** Cursor β and cap M from the specification. */
export const LIF_CURSOR = 0.3;
export const LIF_MAX = 1.15;

/**
 * Liquidation Incentive Factor: `LIF = min(M, 1/(β·LLTV + (1−β)))`.
 *
 * `lltv` is the decimal form (0.86, not the WAD). An LLTV outside (0,1) is not a market we can reason about,
 * so it returns the most conservative incentive rather than a number that would overstate the reward.
 */
export function liquidationIncentiveFactor(lltv: number): number {
  if (!(lltv > 0 && lltv < 1)) return 1.05;
  return Math.min(LIF_MAX, 1 / (LIF_CURSOR * lltv + (1 - LIF_CURSOR)));
}

/**
 * The oracle price at which HF = 1 — the exact instant a position becomes liquidatable.
 *
 * HF = collateral·price/1e36 · lltv/1e18 / borrowAssets ≥ 1
 *   ⇔ price ≥ borrowAssets · 1e36 · 1e18 / (collateral · lltvWad)
 *
 * Returns 0 when the position cannot cross (no collateral or no debt) — 0 never compares below a live price,
 * so an empty position is naturally never "crossed" rather than needing a special case at the call site.
 */
export function liquidationPriceX36(borrowAssets: bigint, collateral: bigint, lltvWad: bigint): bigint {
  if (collateral <= 0n || borrowAssets <= 0n || lltvWad <= 0n) return 0n;
  return (borrowAssets * ORACLE_PRICE_SCALE * WAD) / (collateral * lltvWad);
}

/** Health factor as a number, from the same quantities the contract uses. Null when it is not defined. */
export function healthFactor(borrowAssets: bigint, collateral: bigint, lltvWad: bigint, priceX36: bigint): number | null {
  if (borrowAssets <= 0n || collateral <= 0n || priceX36 <= 0n) return null;
  const liq = liquidationPriceX36(borrowAssets, collateral, lltvWad);
  return liq <= 0n ? null : Number(priceX36) / Number(liq);
}

/**
 * What the contract will CHARGE us to seize `seizedAssets`, in loan-token raw units:
 *   repaidAssets = seizedAssets · price / 1e36 / LIF     (the contract rounds this UP)
 *
 * We round up too. Rounding down would make every simulation marginally optimistic — and the margin we are
 * trading on is a few percent, so a systematic bias in our favour is exactly the error that turns a
 * "profitable" verdict into a reverted transaction.
 */
export function repayForSeize(seizedAssets: bigint, priceX36: bigint, lif: number): bigint {
  if (seizedAssets <= 0n || priceX36 <= 0n) return 0n;
  const lifPpm = BigInt(Math.round(lif * 1_000_000));
  if (lifPpm <= 0n) return 0n;
  const valueInLoan = ceilDiv(seizedAssets * priceX36, ORACLE_PRICE_SCALE);
  return ceilDiv(valueInLoan * 1_000_000n, lifPpm);
}

/**
 * The largest legal seizure: bounded by the collateral that exists AND by the debt that is owed (we may not
 * repay more than the borrower owes). Deliberately NOT bounded by any collateral-vs-debt comparison — an
 * under-collateralised position simply has a smaller maximum, not a forbidden one.
 */
export function maxSeizableAssets(borrowAssets: bigint, collateral: bigint, priceX36: bigint, lif: number): bigint {
  if (collateral <= 0n || borrowAssets <= 0n || priceX36 <= 0n) return 0n;
  const lifPpm = BigInt(Math.round(lif * 1_000_000));
  // Seizing this much would repay exactly the full debt.
  const fromDebt = (borrowAssets * lifPpm * ORACLE_PRICE_SCALE) / (1_000_000n * priceX36);
  return fromDebt < collateral ? fromDebt : collateral;
}

/**
 * A ladder of candidate sizes for probing the exit curve, from `max` down by a geometric factor.
 *
 * Geometric rather than linear because that is how slippage behaves: the interesting region — where the
 * fixed LIF margin still beats a growing price impact — spans orders of magnitude, and a linear sweep would
 * spend every probe in the part of the curve that is already known to be bad.
 */
export function sizeLadder(max: bigint, steps = 6, factor = 5n): bigint[] {
  const out: bigint[] = [];
  let s = max;
  for (let i = 0; i < steps && s > 0n; i++) { out.push(s); s = s / factor; }
  return out;
}

function ceilDiv(a: bigint, b: bigint): bigint { return b <= 0n ? 0n : (a + b - 1n) / b; }
