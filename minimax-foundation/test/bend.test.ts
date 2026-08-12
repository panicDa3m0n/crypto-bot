import { describe, expect, it } from "vitest";
import { bendPublishedMarkets, derivePosition } from "../src/bend.js";

describe("Bend position arithmetic", () => {
  it("uses down-rounding for supplied assets and up-rounding for borrowed assets", () => {
    expect(derivePosition(
      { supplyShares: "3", borrowShares: "3", collateral: "7" },
      { totalSupplyAssets: "10", totalSupplyShares: "4", totalBorrowAssets: "10", totalBorrowShares: "4", lastUpdate: "0", fee: "0" }
    )).toEqual({ suppliedLoanAssets: "7", borrowedLoanAssets: "8", collateralAssets: "7", active: true });
  });

  it("tracks all currently published Bend market IDs", () => {
    expect(bendPublishedMarkets).toHaveLength(6);
    for (const market of bendPublishedMarkets) expect(market.id).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
