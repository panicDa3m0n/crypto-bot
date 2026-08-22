import { describe, expect, it } from "vitest";
import { ConstantProductAdapter } from "../src/router/adapters/constant-product.js";
import type { PoolState } from "../src/router/types.js";

const T0 = "0x0000000000000000000000000000000000000000".replace(/0$/, "a"); // token0
const T1 = "0x0000000000000000000000000000000000000000".replace(/0$/, "b"); // token1

// Canonical Uniswap-V2 getAmountOut (0.30% fee) — the exact integer math the on-chain pair runs.
function univ2Out(amountIn: bigint, rIn: bigint, rOut: bigint): bigint {
  const inWithFee = amountIn * 997n;
  return (inWithFee * rOut) / (rIn * 1000n + inWithFee);
}
// General ppm-fee constant-product reference.
function cpRef(amountIn: bigint, rIn: bigint, rOut: bigint, feePpm: bigint): bigint {
  const inWithFee = amountIn * (1_000_000n - feePpm);
  return (inWithFee * rOut) / (rIn * 1_000_000n + inWithFee);
}

function pool(over: Partial<PoolState> = {}): PoolState {
  return { address: "0xpool", archetype: "v2", token0: T0, token1: T1, feePpm: 3000, r0: 1_000_000_000_000_000_000_000n, r1: 4_000_000_000n, block: 100, ...over };
}

describe("ConstantProductAdapter", () => {
  const a = new ConstantProductAdapter();

  it("is bit-exact vs canonical UniV2 getAmountOut (0.3%) across sizes, token0→token1", () => {
    const p = pool();
    for (const amt of [10n ** 15n, 10n ** 18n, 5n * 10n ** 18n, 500n * 10n ** 18n]) {
      const got = a.quoteOut(p, T0, amt);
      expect(got?.amountOut).toBe(univ2Out(amt, p.r0!, p.r1!));
    }
  });

  it("returns null for dust whose output rounds to zero (not a usable quote)", () => {
    const p = pool();
    expect(univ2Out(1n, p.r0!, p.r1!)).toBe(0n); // reference confirms 0 out at this size
    expect(a.quoteOut(p, T0, 1n)).toBeNull();
  });

  it("is bit-exact in the token1→token0 direction (reserves swapped)", () => {
    const p = pool();
    for (const amt of [1_000n, 10n ** 9n, 2n * 10n ** 9n]) {
      const got = a.quoteOut(p, T1, amt);
      expect(got?.amountOut).toBe(univ2Out(amt, p.r1!, p.r0!));
    }
  });

  it("applies an arbitrary pool fee exactly (e.g. Aerodrome 0.05% = 500 ppm)", () => {
    const p = pool({ archetype: "aerodrome", feePpm: 500 });
    const amt = 10n ** 18n;
    expect(a.quoteOut(p, T0, amt)?.amountOut).toBe(cpRef(amt, p.r0!, p.r1!, 500n));
    expect(a.quoteOut(p, T0, amt)?.feePpm).toBe(500);
  });

  it("REFUSES to quote when the fee is unknown — it must never be invented", () => {
    // This test previously asserted the opposite ("defaults to 0.3%"), which enshrined the single most
    // damaging default in the codebase: on a strategy whose edge is basis points, an invented fee yields a
    // confident wrong number in either direction, and hides the data hole that caused it. A pool that cannot
    // state its fee is enrichment work, not a 0.30% guess.
    for (const bad of [0, -1, 1_000_000, Number.NaN]) {
      expect(a.quoteOut(pool({ feePpm: bad }), T0, 10n ** 18n)).toBeNull();
    }
  });

  it("quotes normally once the fee IS known", () => {
    const p = pool({ feePpm: 3000 });
    const amt = 10n ** 18n;
    const got = a.quoteOut(p, T0, amt);
    expect(got?.amountOut).toBe(univ2Out(amt, p.r0!, p.r1!));
    expect(got?.feePpm).toBe(3000);
    expect(got?.approximate).toBe(false);
  });

  it("returns null on zero/absent reserves, non-positive amount, and a foreign token", () => {
    expect(a.quoteOut(pool({ r0: 0n }), T0, 10n ** 18n)).toBeNull();
    expect(a.quoteOut(pool({ r1: null }), T0, 10n ** 18n)).toBeNull();
    expect(a.quoteOut(pool(), T0, 0n)).toBeNull();
    expect(a.quoteOut(pool(), "0x00000000000000000000000000000000000000ff", 10n ** 18n)).toBeNull();
  });

  it("does not claim stable pools (handled by a dedicated adapter)", () => {
    expect(a.archetypes).toEqual(["v2", "aerodrome"]);
    expect(a.archetypes).not.toContain("aerodrome-stable");
  });

  it("spot price is the reserve ratio scaled by decimals, and its reciprocal for token1", () => {
    // r0=1000e18 (18-dec), r1=4000e6 (6-dec) → token0 ≈ 4 token1 units per token0.
    const p = pool();
    const s0 = a.spot(p, T0, 18, 6)!;
    expect(s0).toBeCloseTo(4, 9);
    const s1 = a.spot(p, T1, 18, 6)!;
    expect(s1).toBeCloseTo(0.25, 9);
  });
});
