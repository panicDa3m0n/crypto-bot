import { describe, expect, it } from "vitest";
import { extractLastJsonObject, generateHypotheses, parseDecision, parseResearchHypotheses } from "../src/minimax.js";
import { loadConfig } from "../src/config.js";

describe("MiniMax response extraction", () => {
  it("extracts a trailing JSON decision after reasoning text", () => {
    const content = "<think>analysis with {ignored}</think>\n{\"action\":\"HOLD\",\"rationale\":\"x\"}";
    expect(extractLastJsonObject(content)).toBe('{"action":"HOLD","rationale":"x"}');
  });

  it("respects braces inside JSON strings", () => {
    expect(extractLastJsonObject('reasoning {\"rationale\":\"uses {braces}\",\"action\":\"HOLD\"}')).toBe('{"rationale":"uses {braces}","action":"HOLD"}');
  });

  it("retains an explicit auditable result when research is unavailable", async () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://bot:bot@localhost:5432/berabot", REDIS_URL: "redis://localhost:6379",
      PRIMARY_RPC_HTTP_URL: "https://rpc.berachain.com", SECONDARY_RPC_HTTP_URL: "https://berachain-rpc.publicnode.com",
      USDC_E_ADDRESS: "0x549943e04f40284185054145c6e4e9568c1d3241", HONEY_ADDRESS: "0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce"
    });
    await expect(generateHypotheses(config, { observedAt: new Date().toISOString() })).resolves.toEqual({ hypotheses: [], modelResponse: { unavailable: true }, status: "unavailable" });
  });

  it("preserves an otherwise valid MiniMax hypothesis when singleton evidence fields are strings", () => {
    const raw = `reasoning\n{"hypotheses":[{"id":"h-1","category":"relative_value","direction":"WATCH","thesis":"Observe pool conditions.","invalidation":"Pool pauses.","expectedHorizon":"24h","evidence":"pool:0xabc","requiredData":"fresh route quote"}]}`;
    expect(parseResearchHypotheses(raw)).toEqual([{
      id: "h-1", category: "relative_value", direction: "WATCH", thesis: "Observe pool conditions.", invalidation: "Pool pauses.", expectedHorizon: "24h", evidence: ["pool:0xabc"], requiredData: ["fresh route quote"]
    }]);
  });

  it("does not disguise malformed model JSON as a completed research pass", () => {
    expect(() => parseResearchHypotheses("<think>no final JSON</think>")).toThrow();
  });

  it("normalizes provider-only evidence and boolean research flags without changing the decision", () => {
    const parsed = parseDecision(JSON.stringify({ action: "HOLD", strategyId: "hold", rationale: "Evidence remains incomplete.", confidence: 0.8, riskUsd: 0, expectedNetProfitUsd: 0, capitalUsd: 0, expiresAt: "2026-01-01T00:00:00.000Z", evidence: ["https://docs.berachain.com/", "pool:0xabc"], needsResearch: true }));
    expect(parsed).toEqual({ success: true, decision: expect.objectContaining({ action: "HOLD", evidence: ["https://docs.berachain.com/"], needsResearch: ["MiniMax indicated that further research is required."] }) });
  });

  it("normalizes MiniMax percentage confidence without changing the decision", () => {
    const parsed = parseDecision(JSON.stringify({ action: "HOLD", strategyId: "idle", rationale: "No current candidate.", confidence: 95, riskUsd: 0.45, expectedNetProfitUsd: 0, capitalUsd: 0.45, expiresAt: "2026-01-01T00:00:00.000Z", evidence: ["https://docs.berachain.com/"], needsResearch: false }));
    expect(parsed).toEqual({ success: true, decision: expect.objectContaining({ action: "HOLD", confidence: 0.95, needsResearch: [] }) });
  });
});
