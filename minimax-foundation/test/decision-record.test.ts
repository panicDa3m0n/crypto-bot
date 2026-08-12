import { describe, expect, it } from "vitest";
import { fromCycle } from "../src/decision-record.js";
import type { CycleRecord } from "../src/cycle-store.js";

const cycle = (parsedFinalResponse: unknown): CycleRecord => ({ id: "cycle_test", createdAt: "2026-01-01T00:00:00.000Z", status: "completed", trigger: "test", promptSha256: "hash", model: "MiniMax-M2.7", input: {}, events: [], parsedFinalResponse });

describe("DecisionRecord schema gate", () => {
  it("accepts a fully evidenced research decision while keeping execution impossible", () => {
    const decision = fromCycle(cycle({ decision: { action: "RESEARCH_MORE", strategy: "cross-venue price verification", reasoning: "No net P&L evidence exists.", evidenceIds: ["bex_quote_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "registry_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], confidence: 0.8, financial: { risk: "No execution path is enabled.", sources: ["bex_quote_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"] } } }));
    expect(decision).toMatchObject({ validation: { state: "accepted", reasons: [] }, execution: { capability: "read-only", status: "not-submitted", calldata: null, transactionHash: null }, action: "RESEARCH_MORE" });
  });
  it("rejects prose that omits a typed decision instead of treating it as an approval", () => {
    const decision = fromCycle(cycle({ summary: "No decision object." }));
    expect(decision.validation).toMatchObject({ state: "rejected" });
    expect(decision.validation.reasons).toEqual(expect.arrayContaining([expect.stringContaining("decision.action"), expect.stringContaining("decision.evidenceIds")]));
  });
  it("rejects a human label masquerading as persistent evidence", () => {
    const decision = fromCycle(cycle({ decision: { action: "HOLD", strategy: "wait", reasoning: "test", evidenceIds: ["walletValuation_19:53:41"], confidence: 0.5, financial: { sources: [] } } }));
    expect(decision.validation.reasons).toEqual(expect.arrayContaining([expect.stringContaining("known-format persistent") ]));
  });
  it("rejects an invented USD attestation when the valuation explicitly lacks one", () => {
    const decision = fromCycle({ ...cycle({ decision: { action: "HOLD", strategy: "wait", reasoning: "test", evidenceIds: ["valuation_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], confidence: 0.5, financial: { sources: [] } } }), finalResponse: "USDC.e valuation is attested." }, { usdAttestationUnavailable: true });
    expect(decision.validation.reasons).toEqual(expect.arrayContaining([expect.stringContaining("attestation absent")]));
  });
  it("does not confuse an explicit not-attested status with a positive attestation", () => {
    const decision = fromCycle({ ...cycle({ decision: { action: "HOLD", strategy: "wait", reasoning: "test", evidenceIds: ["valuation_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], confidence: 0.5, financial: { sources: [] } } }), finalResponse: "The total equivalent USDC.e is 0.387283 and carries usdStatus not-attested." }, { usdAttestationUnavailable: true });
    expect(decision.validation.reasons).not.toEqual(expect.arrayContaining([expect.stringContaining("attestation absent")]));
  });
  it("rejects a global no-position claim when protocol coverage is incomplete", () => {
    const decision = fromCycle({ ...cycle({ decision: { action: "HOLD", strategy: "wait", reasoning: "test", evidenceIds: ["valuation_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], confidence: 0.5, financial: { sources: [] } } }), finalResponse: "The wallet has zero positions across all protocols." }, { positionCoverageIncomplete: true });
    expect(decision.validation.reasons).toEqual(expect.arrayContaining([expect.stringContaining("global absence of positions")]));
  });
  it("requires capital and a risk statement for an execution-class decision", () => {
    const decision = fromCycle(cycle({ decision: { action: "ENTER", strategy: "buy", reasoning: "test", evidenceIds: ["bex_quote_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], confidence: 0.5, financial: { sources: [] } } }));
    expect(decision.validation.reasons).toEqual(expect.arrayContaining([expect.stringContaining("requires decision.proposedCapital"), expect.stringContaining("requires decision.financial.risk")]));
  });
});
