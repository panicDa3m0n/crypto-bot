import type { PoolState, QuoteLeg, VenueAdapter } from "../types.js";

const Q96 = 2n ** 96n;

/**
 * Uniswap-V3 / Slipstream concentrated liquidity. WITHIN the current tick the pool is a constant
 * product on the VIRTUAL reserves derived from (sqrtPriceX96, in-range liquidity L):
 *
 *     x (token0) = L · 2⁹⁶ / √P        y (token1) = L · √P / 2⁹⁶
 *
 * so the same closed-form getAmountOut applies, fork-agnostic, no quoter contract needed. This is
 * EXACT for a trade that stays in the current tick (the dominant case: sellability probes, arb-size
 * sims). A trade large enough to cross into a neighbouring tick draws on liquidity this single-tick
 * model can't see — it then UNDER-states the true output (a conservative bias) and we flag it
 * `approximate` so the router confirms it on-chain (Quoter) until the Phase-4 tick map makes it exact.
 */
export class V3Adapter implements VenueAdapter {
  readonly archetypes = ["v3", "v4"] as const; // V4 pools price with the SAME concentrated-liquidity math (sqrtPrice); only their poolId keying + router differ

  quoteOut(pool: PoolState, tokenIn: string, amountIn: bigint): QuoteLeg | null {
    if (amountIn <= 0n) return null;
    const sp = pool.sqrtPriceX96, L = pool.liquidity;
    if (sp == null || L == null || sp <= 0n || L <= 0n) return null;
    const inl = tokenIn.toLowerCase();
    const inIs0 = inl === pool.token0.toLowerCase();
    if (!inIs0 && inl !== pool.token1.toLowerCase()) return null;
    const r0 = (L * Q96) / sp; // virtual reserve of token0
    const r1 = (L * sp) / Q96; // virtual reserve of token1
    if (r0 <= 0n || r1 <= 0n) return null;
    const [rIn, rOut] = inIs0 ? [r0, r1] : [r1, r0];
    const feePpm = pool.feePpm > 0 && pool.feePpm < 1_000_000 ? BigInt(Math.round(pool.feePpm)) : 3000n;
    const inWithFee = amountIn * (1_000_000n - feePpm);
    const out = (inWithFee * rOut) / (rIn * 1_000_000n + inWithFee);
    if (out <= 0n) return null;
    // Crossing-tick heuristic: an input above ~1% of the in-range virtual reserve likely leaves the
    // current tick → the single-tick number is only a (conservative) approximation.
    const approximate = amountIn * 100n > rIn;
    return { amountOut: out, feePpm: Number(feePpm), approximate };
  }

  spot(pool: PoolState, base: string, dec0: number, dec1: number): number | null {
    const sp = pool.sqrtPriceX96;
    if (sp == null || sp <= 0n) return null;
    // P = (√P / 2⁹⁶)² = token1 per token0 in RAW units; scale by decimals to human units.
    const sqrt = Number(sp) / Number(Q96);
    const p1per0 = sqrt * sqrt * 10 ** (dec0 - dec1);
    if (!(p1per0 > 0) || !Number.isFinite(p1per0)) return null;
    return base.toLowerCase() === pool.token0.toLowerCase() ? p1per0 : 1 / p1per0;
  }
}
