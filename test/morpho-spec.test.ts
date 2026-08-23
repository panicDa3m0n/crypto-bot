import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  liquidationIncentiveFactor, liquidationPriceX36, healthFactor, repayForSeize,
  maxSeizableAssets, sizeLadder, ORACLE_PRICE_SCALE, WAD, LIF_CURSOR, LIF_MAX
} from "../src/morpho.js";

/**
 * THE PROTOCOL'S SPECIFICATION, AS A TEST.
 *
 * Source: https://docs.morpho.org/learn/concepts/liquidation/
 *
 * We had four hand-written copies of this arithmetic and two had already dropped the 1.15 cap. Nothing had
 * broken only because every live market sits above the LLTV where the cap bites — luck, not correctness.
 * These tests state what Morpho says, so a future edit that drifts from it fails here instead of on-chain.
 */

describe("liquidatable means exactly what Morpho says it means", () => {
  // "HEALTH_FACTOR = (COLLATERAL_VALUE_IN_LOAN_TOKEN × LLTV) / BORROWED_AMOUNT", liquidatable below 1.0.
  const lltvWad = (x: number) => BigInt(Math.round(x * 1e18));

  it("puts the crossing price exactly where HF reaches 1", () => {
    const collateral = 10n ** 18n * 1000n;      // 1000 units, 18dp
    const borrow = 10n ** 6n * 500n;            // 500 units, 6dp
    const lltv = lltvWad(0.86);
    const liq = liquidationPriceX36(borrow, collateral, lltv);
    // At exactly the liquidation price, HF is 1 — the boundary itself.
    expect(healthFactor(borrow, collateral, lltv, liq)).toBeCloseTo(1, 9);
    // A hair above is healthy, a hair below is liquidatable. This is the whole decision.
    expect(healthFactor(borrow, collateral, lltv, liq + liq / 1000n)!).toBeGreaterThan(1);
    expect(healthFactor(borrow, collateral, lltv, liq - liq / 1000n)!).toBeLessThan(1);
  });

  it("uses the scales the contract uses: price 1e36, LLTV 1e18", () => {
    expect(ORACLE_PRICE_SCALE).toBe(10n ** 36n);
    expect(WAD).toBe(10n ** 18n);
    // A 1:1 market at LLTV 1e18 (100%) liquidates exactly when price falls to the debt/collateral ratio.
    expect(liquidationPriceX36(10n ** 18n, 10n ** 18n, WAD)).toBe(ORACLE_PRICE_SCALE);
  });

  it("never claims a health factor it cannot compute", () => {
    expect(healthFactor(0n, 10n ** 18n, WAD, ORACLE_PRICE_SCALE)).toBeNull();   // no debt
    expect(healthFactor(10n ** 6n, 0n, WAD, ORACLE_PRICE_SCALE)).toBeNull();    // no collateral
    expect(healthFactor(10n ** 6n, 10n ** 18n, WAD, 0n)).toBeNull();            // no price
    expect(liquidationPriceX36(10n ** 6n, 0n, WAD)).toBe(0n);                   // cannot cross
  });
});

describe("the liquidation incentive is the documented formula, cap included", () => {
  // "LIF = min(M, 1/(β×LLTV+(1-β))), with β = 0.3 and M = 1.15"
  it("matches the specification term for term", () => {
    expect(LIF_CURSOR).toBe(0.3);
    expect(LIF_MAX).toBe(1.15);
    for (const lltv of [0.625, 0.77, 0.86, 0.915, 0.945, 0.965]) {   // every LLTV live on Base today
      expect(liquidationIncentiveFactor(lltv)).toBeCloseTo(Math.min(1.15, 1 / (0.3 * lltv + 0.7)), 12);
    }
  });

  it("reproduces the documentation's own worked example (86% LLTV → ≈1.05)", () => {
    expect(liquidationIncentiveFactor(0.86)).toBeCloseTo(1.0438, 4);
  });

  it("APPLIES THE CAP — the half of the formula two copies had lost", () => {
    // The cap binds below LLTV ≈ 0.5652. No Base market is there today, which is exactly why the omission
    // was invisible; a new low-LLTV market would have had us request a seizure the contract refuses.
    expect(liquidationIncentiveFactor(0.4)).toBe(1.15);
    expect(1 / (0.3 * 0.4 + 0.7)).toBeGreaterThan(1.15);   // uncapped, this is what we would have used
    expect(liquidationIncentiveFactor(0.57)).toBeLessThan(1.15);
  });

  it("refuses to invent an incentive for a market it cannot read", () => {
    for (const bad of [0, 1, -1, NaN]) expect(liquidationIncentiveFactor(bad)).toBe(1.05);
  });
});

describe("there is NO close factor — every size up to the maximum is a legal liquidation", () => {
  // "Liquidators can choose to liquidate any amount of the borrower's debt up to the full amount."
  const price = ORACLE_PRICE_SCALE;             // 1:1
  const lif = liquidationIncentiveFactor(0.86);

  it("charges strictly less than the collateral seized — that gap IS the profit", () => {
    const seize = 10n ** 18n * 1000n;
    const repay = repayForSeize(seize, price, lif);
    expect(repay).toBeLessThan(seize);
    expect(Number(seize - repay) / Number(seize)).toBeCloseTo(1 - 1 / lif, 4);
  });

  it("scales linearly with size, so the gross margin is size-independent", () => {
    const a = repayForSeize(10n ** 18n * 1000n, price, lif);
    const b = repayForSeize(10n ** 18n * 100n, price, lif);
    expect(Number(a) / Number(b)).toBeCloseTo(10, 3);
  });

  it("rounds the repayment UP, the way the contract does", () => {
    // Rounding our way would bias every simulation optimistic on a few-percent margin.
    expect(repayForSeize(1n, price, 1.0438)).toBeGreaterThan(0n);
  });

  it("caps the maximum by the debt owed AND the collateral held — never by their ratio", () => {
    const collateral = 10n ** 18n * 1000n;
    // Plenty of collateral, small debt → the DEBT is the binding constraint.
    const small = maxSeizableAssets(10n ** 18n * 100n, collateral, price, lif);
    expect(small).toBeLessThan(collateral);
    // Huge debt → the COLLATERAL is the binding constraint, and it is still a legal liquidation.
    expect(maxSeizableAssets(10n ** 18n * 100_000n, collateral, price, lif)).toBe(collateral);
  });

  it("BAD DEBT IS STILL SEIZABLE AT A PROFIT — the gate we had rejected these on was wrong", () => {
    // A position 10× under water: $100 of collateral against $1000 of debt. We rejected the whole class
    // on `collateralUsd > debtUsd`, without ever pricing it. The protocol does not work that way: seizing
    // what is left still costs less than it is worth.
    const collateral = 10n ** 18n * 100n;
    const debt = 10n ** 18n * 1000n;
    const max = maxSeizableAssets(debt, collateral, price, lif);
    expect(max).toBe(collateral);                       // take everything there is
    expect(repayForSeize(max, price, lif)).toBeLessThan(max);   // and still pay less than it is worth
  });
});

describe("size is a search, not a constant", () => {
  it("probes geometrically, because that is how slippage spans orders of magnitude", () => {
    const ladder = sizeLadder(10n ** 18n * 1_000_000n, 6, 5n);
    expect(ladder).toHaveLength(6);
    expect(ladder[0]).toBeGreaterThan(ladder[5]);
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]).toBe(ladder[i - 1] / 5n);
  });

  it("stops rather than emitting zero-sized probes", () => {
    expect(sizeLadder(3n, 8, 5n).every((s) => s > 0n)).toBe(true);
    expect(sizeLadder(0n)).toHaveLength(0);
  });
});

describe("the liquidation math has exactly one home", () => {
  it("no module hand-writes the LIF formula any more", () => {
    // Four copies existed; two on the fire path had already dropped the cap.
    for (const f of ["src/liquidation-monitor.ts", "src/position-registry.ts", "src/autoarm-reconciler.ts", "src/kg/liquidation-nodes.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} still computes LIF itself`).not.toMatch(/1\s*\/\s*\(\s*1\s*-\s*(0\.3|LIQUIDATION_CURSOR)\s*\*/);
    }
  });
});
