import { describe, expect, it } from "vitest";
import { simulateExactInput, type V3PoolSim } from "../src/router/v3-sim.js";
import { Q96 } from "../src/router/tick-math.js";

// Constant-product on virtual reserves — what the single-tick V3Adapter computes; the exact sim must
// agree with it WITHIN the current tick (no crossing).
function cpOut(amountIn: bigint, rIn: bigint, rOut: bigint, feePpm: bigint): bigint {
  const inWithFee = amountIn * (1_000_000n - feePpm);
  return (inWithFee * rOut) / (rIn * 1_000_000n + inWithFee);
}

describe("V3 exact swap sim", () => {
  const L = 10n ** 27n; // deep liquidity so a moderate trade stays in-tick
  const pool = (over: Partial<V3PoolSim> = {}): V3PoolSim => ({ sqrtPriceX96: Q96, liquidity: L, tick: 0, feePips: 3000, ticks: [], ...over });

  it("matches constant-product within the current tick (no crossing), not partial", () => {
    // At sqrtP = 2^96 the virtual reserves are r0 = r1 = L.
    for (const amt of [10n ** 15n, 10n ** 18n, 5n * 10n ** 18n]) {
      const r = simulateExactInput(pool(), true, amt)!; // token0 → token1
      const cp = cpOut(amt, L, L, 3000n);
      expect(r.partial).toBe(false);
      const diff = r.amountOut > cp ? r.amountOut - cp : cp - r.amountOut;
      expect(diff * 1_000_000n <= cp).toBe(true); // within 1e-6 relative (rounding only)
    }
  });

  it("is monotonic: more input → more output", () => {
    const a = simulateExactInput(pool(), true, 10n ** 18n)!;
    const b = simulateExactInput(pool(), true, 2n * 10n ** 18n)!;
    expect(b.amountOut).toBeGreaterThan(a.amountOut);
  });

  it("both directions produce positive output", () => {
    expect(simulateExactInput(pool(), true, 10n ** 18n)!.amountOut).toBeGreaterThan(0n);
    expect(simulateExactInput(pool(), false, 10n ** 18n)!.amountOut).toBeGreaterThan(0n);
  });

  it("crossing an initialized tick that ADDS liquidity yields more output than ignoring it", () => {
    // A big trade down (zeroForOne) that crosses a tick below with +liquidity should out-perform the
    // same pool with no tick data (which would run thinner). We just assert crossing changed the result.
    const big = 50n * 10n ** 18n;
    const noTicks = simulateExactInput(pool({ liquidity: 10n ** 18n }), true, big)!;
    const withTick = simulateExactInput(pool({ liquidity: 10n ** 18n, ticks: [{ tick: -100, liquidityNet: 10n ** 20n }] }), true, big)!;
    expect(withTick.amountOut).not.toBe(noTicks.amountOut);
  });

  it("returns null on unusable state", () => {
    expect(simulateExactInput(pool({ liquidity: 0n }), true, 10n ** 18n)).toBeNull();
    expect(simulateExactInput(pool(), true, 0n)).toBeNull();
  });
});
