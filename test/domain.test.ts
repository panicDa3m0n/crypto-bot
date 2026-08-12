import { describe, expect, it } from "vitest";
import { decisionSchema } from "../src/domain.js";

const base = {
  action: "HOLD", strategyId: "idle_bera", rationale: "No verified positive-net strategy is available.", confidence: 0.9,
  riskUsd: 0, expectedNetProfitUsd: 0, capitalUsd: 0, expiresAt: "2026-08-10T18:07:26.868Z", evidence: ["https://docs.berachain.com/"]
};

describe("Wallet Brain decision schema", () => {
  it("preserves an explicit MiniMax research request returned as boolean", () => {
    const parsed = decisionSchema.parse({ ...base, needsResearch: true });
    expect(parsed.needsResearch).toEqual(["MiniMax requested further research; inspect the decision rationale and evidence."]);
  });

  it("keeps explicit research items unchanged", () => {
    const parsed = decisionSchema.parse({ ...base, needsResearch: ["verify withdrawal liquidity"] });
    expect(parsed.needsResearch).toEqual(["verify withdrawal liquidity"]);
  });
});
