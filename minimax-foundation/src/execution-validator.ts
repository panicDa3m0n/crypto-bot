import type { DecisionRecord } from "./decision-record.js";
import { evaluateRisk, initialRiskPolicy, type RiskInput, type RiskPolicy } from "./risk.js";

export type WriteIntent = {
  decision: DecisionRecord; chainId: string; kind: "approval" | "contract-call"; to: string; data: string; valueWei: string;
  allowedContracts: string[]; risk: RiskInput;
};
export type IntentValidation = { approvedForBroadcast: false; status: "blocked-read-only" | "rejected"; reasons: string[] };

/**
 * The validator is intentionally incapable of returning broadcast approval at
 * this milestone. It nevertheless applies the permanent structural/risk gates
 * now, so enabling a signer later cannot silently bypass their first use.
 */
export class ExecutionValidator {
  constructor(private readonly policy: RiskPolicy = initialRiskPolicy) {}
  validate(intent: WriteIntent): IntentValidation {
    const reasons: string[] = [];
    if (intent.decision.validation.state !== "accepted") reasons.push("DecisionRecord is not accepted");
    if (!intent.decision.action || !["ENTER", "RESIZE", "HARVEST", "EXIT"].includes(intent.decision.action)) reasons.push("DecisionRecord action is not a financial write action");
    if (!/^0x[0-9a-fA-F]{40}$/.test(intent.to)) reasons.push("recipient is not a valid address");
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(intent.data)) reasons.push("calldata is not hexadecimal bytes");
    if (!/^[0-9]+$/.test(intent.valueWei)) reasons.push("valueWei must be an integer decimal string");
    if (!intent.allowedContracts.some((address) => address.toLowerCase() === intent.to.toLowerCase())) reasons.push("recipient is not in the verified contract allowlist");
    if (intent.kind === "approval") validateApproval(intent, reasons);
    const risk = evaluateRisk({ ...intent.risk, chainId: intent.chainId }, this.policy);
    reasons.push(...risk.reasons);
    if (reasons.length) return { approvedForBroadcast: false, status: "rejected", reasons };
    return { approvedForBroadcast: false, status: "blocked-read-only", reasons: ["No signer or broadcaster is enabled in this milestone; intent is not submitted."] };
  }
}

function validateApproval(intent: WriteIntent, reasons: string[]): void {
  if (intent.data.slice(0, 10).toLowerCase() !== "0x095ea7b3" || intent.data.length !== 138) { reasons.push("approval calldata must be an exact ERC-20 approve(address,uint256) call"); return; }
  const spender = `0x${intent.data.slice(34, 74)}`;
  const amount = BigInt(`0x${intent.data.slice(74, 138)}`);
  if (!intent.allowedContracts.some((address) => address.toLowerCase() === spender.toLowerCase())) reasons.push("approval spender is not in the verified contract allowlist");
  if (amount === (2n ** 256n - 1n)) reasons.push("unlimited ERC-20 approval is forbidden");
  const proposed = intent.decision.proposedCapital?.amountRaw;
  if (!proposed || amount > BigInt(proposed)) reasons.push("approval amount exceeds the DecisionRecord proposed capital");
}
