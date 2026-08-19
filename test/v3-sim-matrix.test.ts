import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { simulateExactInputStateful, MAX_CERTIFIED_V3_CROSSINGS, type V3PoolSim } from "../src/router/v3-sim.js";

/**
 * DIFFERENTIAL REGRESSION MATRIX — `simulateExactInputStateful` vs the on-chain Uniswap-V3 contract.
 * Fixtures are golden (snapshot, direction, amountIn) → (QuoterV2 amountOut, sqrtPriceAfter, ticksCrossed)
 * tuples captured from Base mainnet at a pinned block (regenerate with scripts/kg-v3-fixtures.ts). This is the
 * real proof of the word-boundary-stepping fix: exact amountOut AND sqrtPriceAfter across fee tiers, both
 * directions, and crossing counts from 0 up past 700 — offline, no RPC. Any regression in the tick-crossing
 * math (SqrtPriceMath / SwapMath / word stepping) breaks it.
 */
interface Fixture {
  label: string; feePips: number; tickSpacing: number; zeroForOne: boolean;
  sqrtPriceX96: string; tick: number; liquidity: string;
  ticks: Array<{ tick: number; liquidityNet: string }>;
  amountIn: string; expectedOut: string; expectedSqrtAfter: string; expectedCrossed: number;
}

const fixtures = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/v3-sim-matrix.json", import.meta.url)), "utf8")) as Fixture[];

describe("V3 sim ≡ Uniswap contract (differential matrix)", () => {
  it("has a non-trivial matrix (multiple tiers, directions, and a deep >500-crossing case)", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    expect(new Set(fixtures.map((f) => f.feePips)).size).toBeGreaterThanOrEqual(2);
    expect(fixtures.some((f) => f.expectedCrossed > 500)).toBe(true); // the deep stress case is present
  });

  for (const f of fixtures) {
    it(`${f.label}: amountOut + sqrtPriceAfter bit-exact`, () => {
      const pool: V3PoolSim = {
        sqrtPriceX96: BigInt(f.sqrtPriceX96), liquidity: BigInt(f.liquidity), tick: f.tick,
        feePips: f.feePips, tickSpacing: f.tickSpacing,
        ticks: f.ticks.map((t) => ({ tick: t.tick, liquidityNet: BigInt(t.liquidityNet) })),
      };
      const r = simulateExactInputStateful(pool, f.zeroForOne, BigInt(f.amountIn));
      expect(r).not.toBeNull();
      expect(r!.amountOut).toBe(BigInt(f.expectedOut));           // EXACT — never "close enough"
      expect(r!.sqrtPriceX96).toBe(BigInt(f.expectedSqrtAfter));  // EXACT state transition
      expect(Math.abs(r!.ticksCrossed - f.expectedCrossed)).toBeLessThanOrEqual(1); // counting convention ±1
    });
  }
});

describe("certified-exactness envelope", () => {
  it("MAX_CERTIFIED_V3_CROSSINGS sits below the observed divergence (>720 stays exact in the matrix)", () => {
    // Every captured crossing count (incl. 669/723) is bit-exact; the cap is a conservative safety margin.
    const deepest = Math.max(...fixtures.map((f) => f.expectedCrossed));
    expect(deepest).toBeGreaterThan(MAX_CERTIFIED_V3_CROSSINGS); // matrix probes past the cap and still matches
    expect(MAX_CERTIFIED_V3_CROSSINGS).toBeLessThanOrEqual(500);
  });
});
