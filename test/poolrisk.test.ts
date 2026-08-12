import { describe, expect, it } from "vitest";
import { poolAddressFromId, weightedImpermanentLoss, weightedStressCases } from "../src/poolrisk.js";

describe("weighted BEX pool risk calculations", () => {
  it("calculates standard 50/50 impermanent loss", () => {
    expect(weightedImpermanentLoss([0.5, 0.5], [0.5, 1])).toBeCloseTo(-0.0571909584, 9);
  });

  it("emits bounded stress cases and derives the pool address", () => {
    const cases = weightedStressCases([{ symbol: "WBERA", weight: 0.5 }, { symbol: "HONEY", weight: 0.5 }]);
    expect(cases).toHaveLength(8);
    expect(Math.min(...cases.map((item) => item.ilPct))).toBeLessThan(0);
    expect(poolAddressFromId("0x2c4a603a2aa5596287a06886862dc29d56dbc354000200000000000000000002")).toBe("0x2c4a603a2aa5596287a06886862dc29d56dbc354");
  });
});
