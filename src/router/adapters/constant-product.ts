import type { PoolState, QuoteLeg, VenueAdapter } from "../types.js";

/**
 * Constant-product AMM: Uniswap-V2 and Solidly-VOLATILE (Aerodrome/Velodrome) pools. The invariant is
 * x·y = k, so a swap of `amountIn` (after fee) gives, EXACTLY (integer math, same as the contract):
 *
 *     inWithFee = amountIn · (1e6 − feePpm)
 *     out       = inWithFee · rOut / (rIn · 1e6 + inWithFee)
 *
 * This is bit-identical to Uniswap-V2's `getAmountOut` (with feePpm=3000 it reduces to the canonical
 * amountIn·997·rOut / (rIn·1000 + amountIn·997)), and to Aerodrome's volatile `getAmountOut` when
 * given the pool's real fee. Exact at ANY size — no tick crossing, no approximation.
 *
 * NOTE — Aerodrome STABLE pools (archetype "aerodrome-stable") are NOT constant-product: they use the
 * x³y+xy³=k invariant and 1:1-imbalanced reserves, so cp math fabricates a phantom spread. They also
 * carry no `pool_state` today (the indexer skips them). They belong to a dedicated stable adapter and
 * are intentionally out of scope here — this adapter never claims them.
 */
export class ConstantProductAdapter implements VenueAdapter {
  readonly archetypes = ["v2", "aerodrome"] as const;

  quoteOut(pool: PoolState, tokenIn: string, amountIn: bigint): QuoteLeg | null {
    if (amountIn <= 0n) return null;
    const r0 = pool.r0, r1 = pool.r1;
    if (r0 == null || r1 == null || r0 <= 0n || r1 <= 0n) return null;
    const inl = tokenIn.toLowerCase();
    const inIs0 = inl === pool.token0.toLowerCase();
    if (!inIs0 && inl !== pool.token1.toLowerCase()) return null; // token not in this pool
    const [rIn, rOut] = inIs0 ? [r0, r1] : [r1, r0];
    const feePpm = pool.feePpm > 0 && pool.feePpm < 1_000_000 ? BigInt(Math.round(pool.feePpm)) : 3000n;
    const inWithFee = amountIn * (1_000_000n - feePpm);
    const out = (inWithFee * rOut) / (rIn * 1_000_000n + inWithFee);
    return out > 0n ? { amountOut: out, feePpm: Number(feePpm), approximate: false } : null;
  }

  spot(pool: PoolState, base: string, dec0: number, dec1: number): number | null {
    const r0 = pool.r0, r1 = pool.r1;
    if (r0 == null || r1 == null || r0 <= 0n || r1 <= 0n) return null;
    // token1 per token0 = (r1/r0) · 10^(d0−d1). base=token0 → that; base=token1 → its reciprocal.
    const p1per0 = (Number(r1) / Number(r0)) * 10 ** (dec0 - dec1);
    if (!(p1per0 > 0) || !Number.isFinite(p1per0)) return null;
    return base.toLowerCase() === pool.token0.toLowerCase() ? p1per0 : 1 / p1per0;
  }
}
