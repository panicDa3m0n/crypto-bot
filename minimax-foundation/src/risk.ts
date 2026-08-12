/** Monetary amounts use integer USD micro-units; floats are never used for risk limits. */
export type RiskPolicy = {
  chainId: "0x138de";
  maxRollingNetLossUsdMicros: bigint;
  minNativeBeraReserveWei: bigint;
  minNavUsdMicros: bigint;
  maxQuoteAgeSeconds: number;
};
export const initialRiskPolicy: RiskPolicy = {
  chainId: "0x138de", maxRollingNetLossUsdMicros: 5_000_000n, minNativeBeraReserveWei: 1_000_000_000_000_000_000n, minNavUsdMicros: 15_000_000n, maxQuoteAgeSeconds: 60
};
export type RiskInput = {
  now: Date; chainId: string; currentNativeBeraWei: bigint; nativeBeraOutflowWei: bigint;
  navUsdMicros?: bigint; rollingNetLossUsdMicros?: bigint; worstCaseAdditionalLossUsdMicros?: bigint;
  quoteObservedAt?: Date; preflightSucceeded: boolean;
};
export type RiskResult = { allowed: boolean; reasons: string[] };

/** Fails closed: missing valuation or realised-loss context cannot pass a financial write gate. */
export function evaluateRisk(input: RiskInput, policy: RiskPolicy = initialRiskPolicy): RiskResult {
  const reasons: string[] = [];
  if (input.chainId.toLowerCase() !== policy.chainId) reasons.push(`wrong chain: expected ${policy.chainId}, received ${input.chainId}`);
  if (input.currentNativeBeraWei < 0n || input.nativeBeraOutflowWei < 0n) reasons.push("native BERA amounts must be non-negative");
  if (input.currentNativeBeraWei - input.nativeBeraOutflowWei < policy.minNativeBeraReserveWei) reasons.push("native BERA reserve would fall below the configured 1 BERA minimum");
  if (input.navUsdMicros === undefined) reasons.push("NAV USD valuation is missing");
  else if (input.navUsdMicros < policy.minNavUsdMicros) reasons.push("NAV is below the configured $15 stop threshold");
  if (input.rollingNetLossUsdMicros === undefined) reasons.push("rolling 24-hour net loss is missing");
  if (input.worstCaseAdditionalLossUsdMicros === undefined) reasons.push("worst-case additional loss is missing");
  if (input.rollingNetLossUsdMicros !== undefined && input.worstCaseAdditionalLossUsdMicros !== undefined && input.rollingNetLossUsdMicros + input.worstCaseAdditionalLossUsdMicros > policy.maxRollingNetLossUsdMicros) reasons.push("rolling 24-hour net loss would exceed the configured $5 budget");
  if (!input.quoteObservedAt) reasons.push("fresh quote timestamp is missing");
  else if (!Number.isFinite(input.quoteObservedAt.getTime()) || input.now.getTime() - input.quoteObservedAt.getTime() > policy.maxQuoteAgeSeconds * 1_000) reasons.push("quote is stale");
  if (!input.preflightSucceeded) reasons.push("same-calldata preflight did not succeed");
  return { allowed: reasons.length === 0, reasons };
}
