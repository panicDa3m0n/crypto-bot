import { describe, expect, it } from "vitest";
import { ExecutionValidator, type WriteIntent } from "../src/execution-validator.js";
import { initialRiskPolicy, evaluateRisk } from "../src/risk.js";
import type { DecisionRecord } from "../src/decision-record.js";
import { encodeFunctionData, parseAbi } from "viem";

const now = new Date("2026-01-01T00:00:00.000Z");
const validRisk = { now, chainId: "0x138de", currentNativeBeraWei: 2_000_000_000_000_000_000n, nativeBeraOutflowWei: 0n, navUsdMicros: 20_000_000n, rollingNetLossUsdMicros: 1_000_000n, worstCaseAdditionalLossUsdMicros: 1_000_000n, quoteObservedAt: new Date("2025-12-31T23:59:30.000Z"), preflightSucceeded: true };
const decision: DecisionRecord = { schemaVersion: 1, id: "decision_test", createdAt: now.toISOString(), cycleId: "cycle_test", model: "MiniMax-M2.7", promptSha256: "hash", action: "ENTER", strategy: "test", reasoning: "test", evidenceIds: ["quote"], confidence: 0.8, proposedCapital: { asset: "HONEY", amountRaw: "100" }, financial: { risk: "bounded", sources: ["quote"] }, execution: { capability: "read-only", status: "not-submitted", calldata: null, transactionHash: null }, validation: { state: "accepted", reasons: [] }, rawModelDecision: {} };

describe("permanent risk and intent gates", () => {
  it("allows only fully-valued, fresh, preflighted risk input", () => {
    expect(evaluateRisk(validRisk, initialRiskPolicy)).toEqual({ allowed: true, reasons: [] });
    expect(evaluateRisk({ ...validRisk, rollingNetLossUsdMicros: 4_500_000n, worstCaseAdditionalLossUsdMicros: 600_000n })).toMatchObject({ allowed: false, reasons: expect.arrayContaining([expect.stringContaining("$5")]) });
    expect(evaluateRisk({ ...validRisk, navUsdMicros: undefined })).toMatchObject({ allowed: false, reasons: expect.arrayContaining(["NAV USD valuation is missing"]) });
  });
  it("never approves broadcast and blocks unlimited or over-sized ERC-20 approval", () => {
    const call: WriteIntent = { decision, chainId: "0x138de", kind: "approval", to: "0x0000000000000000000000000000000000000002", data: encodeFunctionData({ abi: parseAbi(["function approve(address spender,uint256 amount)"]), functionName: "approve", args: ["0x0000000000000000000000000000000000000002", 2n ** 256n - 1n] }), valueWei: "0", allowedContracts: ["0x0000000000000000000000000000000000000002"], risk: validRisk };
    const result = new ExecutionValidator().validate(call);
    expect(result).toMatchObject({ approvedForBroadcast: false, status: "rejected", reasons: expect.arrayContaining(["unlimited ERC-20 approval is forbidden"]) });
  });
  it("keeps even a valid contract call blocked while execution is disabled", () => {
    const call: WriteIntent = { decision, chainId: "0x138de", kind: "contract-call", to: "0x0000000000000000000000000000000000000002", data: "0x", valueWei: "0", allowedContracts: ["0x0000000000000000000000000000000000000002"], risk: validRisk };
    expect(new ExecutionValidator().validate(call)).toMatchObject({ approvedForBroadcast: false, status: "blocked-read-only" });
  });
});
