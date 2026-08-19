import type { PoolState, QuoteLeg, VenueAdapter } from "../types.js";
import { stableGetAmountOut } from "../solidly-math.js";

/**
 * Aerodrome/Solidly STABLE pools (x³y+xy³=k). Uses the shared integer-exact math (solidly-math.ts) so the
 * quote equals the on-chain getAmountOut wei-for-wei. Decimal-aware: needs the two token scales
 * (PoolState.dec0/dec1 = 10**decimals) — without them the pool isn't quotable (returns null), never a
 * guess. Fee is the factory fee in bps; we carry it as ppm in `feePpm` (bps×100) for a uniform PoolState.
 * Volatile Aerodrome pools use the ConstantProductAdapter, not this one.
 */
export class StableAdapter implements VenueAdapter {
  readonly archetypes = ["aerodrome-stable"] as const;

  private feeBps(pool: PoolState): number { return pool.feePpm > 0 ? pool.feePpm / 100 : 5; } // default 0.05%

  quoteOut(pool: PoolState, tokenIn: string, amountIn: bigint): QuoteLeg | null {
    if (amountIn <= 0n || pool.r0 == null || pool.r1 == null || pool.r0 <= 0n || pool.r1 <= 0n) return null;
    if (pool.dec0 == null || pool.dec1 == null) return null; // decimals required — never guess
    const inl = tokenIn.toLowerCase();
    const inIs0 = inl === pool.token0.toLowerCase();
    if (!inIs0 && inl !== pool.token1.toLowerCase()) return null;
    const out = stableGetAmountOut(amountIn, inIs0, pool.r0, pool.r1, pool.dec0, pool.dec1, this.feeBps(pool));
    return out > 0n ? { amountOut: out, feePpm: pool.feePpm > 0 ? pool.feePpm : 500, approximate: false } : null;
  }

  spot(pool: PoolState, base: string, _dec0: number, _dec1: number): number | null {
    if (pool.r0 == null || pool.r1 == null || pool.dec0 == null || pool.dec1 == null || pool.r0 <= 0n || pool.r1 <= 0n) return null;
    // Marginal price via a 1-token probe (stable curve is ~1:1 near peg but we quote it exactly).
    const baseIs0 = base.toLowerCase() === pool.token0.toLowerCase();
    const probe = baseIs0 ? pool.dec0 : pool.dec1; // 1 whole base token, raw
    const out = stableGetAmountOut(probe, baseIs0, pool.r0, pool.r1, pool.dec0, pool.dec1, this.feeBps(pool));
    if (out <= 0n) return null;
    const outScale = baseIs0 ? pool.dec1 : pool.dec0;
    return Number(out) / Number(outScale); // human OTHER-token per 1 whole base token
  }
}
