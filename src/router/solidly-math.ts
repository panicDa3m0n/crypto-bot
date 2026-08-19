/**
 * SOLIDLY / AERODROME **STABLE** invariant — a literal integer-exact port of Aerodrome's Pool.sol, so a
 * local quote equals `pool.getAmountOut(...)` wei-for-wei (validated against the live contract). NOT a
 * closed-form solution of the quartic: we replicate the contract's Newton iteration (`_get_y`) with the
 * same integer divisions, the same `dy==0` convergence branches, and the same decimals normalisation, so
 * rounding matches the chain exactly. Volatile Aerodrome/V2 pools stay constant-product (handled elsewhere).
 *
 * ONE implementation, shared by StablePoolSim (KG kernel), the router's StableAdapter, and PriceOracle —
 * they must never diverge. Pure: no I/O. All inputs raw wei; `dec0`/`dec1` are the SCALE (10**decimals);
 * `feeBps` is the factory fee on base 10000 (NOT ppm) — Aerodrome subtracts it BEFORE normalisation.
 *
 * Invariant (stable): x³y + xy³ ≥ k, computed on reserves normalised to 1e18.
 */

const E18 = 10n ** 18n;

/** f(x0,y) = (x0·y/1e18)·((x0²/1e18 + y²/1e18))/1e18 — the normalised invariant value. */
function _f(x0: bigint, y: bigint): bigint {
  const a = (x0 * y) / E18;
  const b = (x0 * x0) / E18 + (y * y) / E18;
  return (a * b) / E18;
}

/** d(x0,y) = 3·x0·(y²/1e18)/1e18 + (x0²/1e18)·x0/1e18 — the derivative used by Newton. */
function _d(x0: bigint, y: bigint): bigint {
  return (3n * x0 * ((y * y) / E18)) / E18 + ((((x0 * x0) / E18) * x0) / E18);
}

/** k(x,y) on RAW reserves: normalise by decimals, then the stable invariant. Equals _f on normalised reserves. */
export function stableK(x: bigint, y: bigint, dec0: bigint, dec1: bigint): bigint {
  const _x = (x * E18) / dec0;
  const _y = (y * E18) / dec1;
  const a = (_x * _y) / E18;
  const b = (_x * _x) / E18 + (_y * _y) / E18;
  return (a * b) / E18;
}

/** Newton solve for y given x0 and target invariant xy (all 1e18-normalised). Mirrors Aerodrome _get_y,
 * including the exact `dy==0` branches. `_f` is used for the convergence checks (x0/y are already
 * normalised, so re-normalising via _k would be wrong — _f is the same scale as the precomputed xy). */
function _getY(x0: bigint, xy: bigint, y: bigint): bigint {
  for (let i = 0; i < 255; i++) {
    const k = _f(x0, y);
    if (k < xy) {
      let dy = ((xy - k) * E18) / _d(x0, y);
      if (dy === 0n) {
        if (k === xy) return y;
        if (_f(x0, y + 1n) > xy) return y + 1n;
        dy = 1n;
      }
      y = y + dy;
    } else {
      let dy = ((k - xy) * E18) / _d(x0, y);
      if (dy === 0n) {
        if (k === xy || _f(x0, y - 1n) < xy) return y;
        dy = 1n;
      }
      y = y - dy;
    }
  }
  throw new Error("solidly _getY: no convergence");
}

/**
 * Exact stable-pool output for swapping `amountIn` of the given token (raw wei), reproducing
 * Aerodrome `getAmountOut` → `_getAmountOut`. `inIsToken0` picks the direction; `dec0`/`dec1` = 10**decimals;
 * `feeBps` on base 10000. Returns 0 on degenerate input.
 */
export function stableGetAmountOut(amountIn: bigint, inIsToken0: boolean, r0: bigint, r1: bigint, dec0: bigint, dec1: bigint, feeBps: number): bigint {
  if (amountIn <= 0n || r0 <= 0n || r1 <= 0n) return 0n;
  const amt = amountIn - (amountIn * BigInt(Math.round(feeBps))) / 10_000n; // fee removed first
  const xy = stableK(r0, r1, dec0, dec1);
  const R0 = (r0 * E18) / dec0, R1 = (r1 * E18) / dec1;
  const [reserveA, reserveB] = inIsToken0 ? [R0, R1] : [R1, R0];
  const amtN = inIsToken0 ? (amt * E18) / dec0 : (amt * E18) / dec1;
  const y = reserveB - _getY(amtN + reserveA, xy, reserveB);
  return (y * (inIsToken0 ? dec1 : dec0)) / E18;
}

/** Marginal raw rate (wei out per wei in) at the current reserves, via a tiny probe — for the cycle-finder
 * SEED. The stable curve's reserve RATIO is NOT the marginal price, so we probe ~1e-6 of the input reserve
 * and read the exact output. Returns {inWei, outWei} (both raw wei) or null. */
export function stableProbe(r0: bigint, r1: bigint, dec0: bigint, dec1: bigint, feeBps: number, inIsToken0: boolean): { inWei: bigint; outWei: bigint } | null {
  if (r0 <= 0n || r1 <= 0n) return null;
  const rIn = inIsToken0 ? r0 : r1;
  const probe = rIn / 1_000_000n > 0n ? rIn / 1_000_000n : 1n;
  const out = stableGetAmountOut(probe, inIsToken0, r0, r1, dec0, dec1, feeBps);
  return out > 0n ? { inWei: probe, outWei: out } : null;
}
