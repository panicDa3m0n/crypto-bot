import { describe, expect, it } from "vitest";
import { getSqrtRatioAtTick, getTickAtSqrtRatio, Q96, MIN_TICK, MAX_TICK } from "../src/router/tick-math.js";

describe("V3 TickMath", () => {
  it("tick 0 → sqrtRatio exactly 2^96", () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
  });

  it("matches known on-chain reference values (Uniswap TickMath)", () => {
    // Reference sqrtPriceX96 values from Uniswap's TickMath (verified on-chain).
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(4295128739n);
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(1461446703485210103287273052203988822378723970342n);
    expect(getSqrtRatioAtTick(1)).toBe(79232123823359799118286999568n);
    expect(getSqrtRatioAtTick(-1)).toBe(79224201403219477170569942574n);
  });

  it("is strictly monotonic in tick", () => {
    let prev = 0n;
    for (const t of [-500000, -10000, -1, 0, 1, 10000, 500000]) {
      const r = getSqrtRatioAtTick(t);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });

  it("getTickAtSqrtRatio is the inverse (greatest tick with ratio ≤ sqrtPrice)", () => {
    for (const t of [-200000, -3000, -1, 0, 1, 3000, 200000]) {
      const sqrt = getSqrtRatioAtTick(t);
      expect(getTickAtSqrtRatio(sqrt)).toBe(t);                 // exact at a tick boundary
      expect(getTickAtSqrtRatio(sqrt + 1n)).toBe(t);            // just above → same tick
      if (t > MIN_TICK) expect(getTickAtSqrtRatio(sqrt - 1n)).toBe(t - 1); // just below → previous tick
    }
  });

  it("rejects out-of-range ticks", () => {
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow();
  });
});
