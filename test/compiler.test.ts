import { describe, expect, it } from "vitest";
import { StrategyCompiler } from "../src/compiler.js";

describe("strategy compiler", () => {
  it("does not elevate an LLM token thesis without a live eligible pool binding", () => {
    const compiled = new StrategyCompiler().compile({ hypotheses: [{ id: "h", category: "momentum", direction: "BUY", thesis: "watch", invalidation: "exit", expectedHorizon: "1d", evidence: ["https://example.com"], requiredData: ["quote"] }] });
    expect(compiled.find((item) => item.id === "h")?.status).toBe("research");
  });
  it("blocks an unprofitable deterministic arbitrage surface", () => {
    const compiled = new StrategyCompiler().compile({ hypotheses: [], opportunity: { observedAt: "x", blockNumber: "1", kind: "bex-cycle", tokenPath: ["WBERA", "HONEY", "WBERA"], inputWbera: "1", outputWbera: "0", grossUsd: -1, estimatedGasUsd: 1, expectedNetUsd: -2, qualified: false, gate: { qualifiedCount: 0, ready: false } } });
    expect(compiled[0]?.status).toBe("blocked");
  });
  it("blocks an LP thesis whose official 90-day relative move breaches the IL limit", () => {
    const poolId = "0x2c4a603a2aa5596287a06886862dc29d56dbc354000200000000000000000002";
    const compiled = new StrategyCompiler().compile({
      discovery: { observedAt: "x", poolCount: 1, eligiblePoolCount: 1, tokenUniverse: [], exclusions: [], candidates: [{ id: `pool:${poolId}`, kind: "lp-yield", poolId, pool: "WBERA/HONEY", tokens: ["WBERA", "HONEY"], tokenAddresses: ["0x6969696969696969696969696969696969696969", "0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce"], tokenDecimals: [18, 18], score: 1, reasons: [], liquidityUsd: 100_000, volume24hUsd: 1_000, feeApr: 0.03, polApr: 0, warnings: [] }] },
      hypotheses: [{ id: "lp", category: "lp", direction: "DEPLOY", thesis: "LP", invalidation: "IL", expectedHorizon: "30d", evidence: [`pool:${poolId}`], requiredData: [] }],
      poolRisk: { observedAt: "x", pools: [{ poolId, poolAddress: "0x2c4a603a2aa5596287a06886862dc29d56dbc354", observedAt: "x", status: "verified", return90dIlPct: -6 }] }
    });
    expect(compiled.find((item) => item.id === "lp")?.status).toBe("blocked");
  });
});
