import { z } from "zod";

export const actionSchema = z.enum(["ENTER", "RESIZE", "HARVEST", "EXIT", "HOLD", "RESEARCH_MORE"]);
export type Action = z.infer<typeof actionSchema>;

// MiniMax occasionally returns a boolean here despite the requested array. The
// conversion is structural only: it preserves the model's request for research
// without fabricating strategy, capital, risk, or profit fields.
const needsResearchSchema = z.union([
  z.array(z.string()).max(8),
  z.boolean().transform((needed) => needed ? ["MiniMax requested further research; inspect the decision rationale and evidence."] : [])
]);

export const decisionSchema = z.object({
  action: actionSchema,
  strategyId: z.string().min(1),
  rationale: z.string().min(1).max(4_000),
  confidence: z.number().min(0).max(1),
  riskUsd: z.number().nonnegative(),
  expectedNetProfitUsd: z.number(),
  capitalUsd: z.number().nonnegative(),
  expiresAt: z.string().datetime(),
  evidence: z.array(z.string().url()).min(1),
  needsResearch: needsResearchSchema.default([])
});
export type Decision = z.infer<typeof decisionSchema>;

export type NetworkObservation = {
  observedAt: Date;
  primaryBlock: bigint;
  secondaryBlock: bigint;
  blockGap: bigint;
  gasPriceWei: bigint;
  primaryHealthy: boolean;
  secondaryHealthy: boolean;
  primaryRpc: string;
  secondaryRpc: string;
  source: "poll" | "websocket";
};

export type PortfolioSnapshot = {
  observedAt: string;
  walletAddress?: string;
  bera: number;
  wbera: number;
  usdcE: number;
  honey: number;
  baseAsset: "BERA" | "USDC_E";
  baseAssetBalance: number;
  estimatedNavUsd: number;
  beraUsd: number;
  honeyUsd: number;
  dailyLossUsd: number;
  lockedUsd: number;
  dataHealthy: boolean;
};

export type ExecutionRequest = {
  decisionId: string;
  kind: "micro_test" | "profit" | "allocation" | "exit";
  protocolId: string;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gas: bigint;
  gasPriceWei: bigint;
  quoteObservedAt: Date;
  maxSlippageBps: number;
  expectedNetProfitUsd: number;
  /** Conservative maximum loss of principal for this exact call, excluding gas. */
  maxEconomicLossUsd: number;
  preflightBlock: bigint;
  deadline: Date;
  /** Required for a dynamically onboarded contract; independently rechecked immediately before sending. */
  contractCodeHash?: `0x${string}`;
  /** Limits dynamically onboarded contracts to a small, audited ABI surface. */
  dynamicPolicy?: "erc4626" | "reward_vault";
  /** Links a successful adapter call to an on-chain-reconciled capital position. */
  position?: { strategyId: string; protocolId: string; vault: `0x${string}`; asset: `0x${string}`; owner: `0x${string}`; kind: "erc4626" };
  /** Present only for ERC-20 approvals. It binds calldata to a finite, pre-registered spender. */
  approval?: { token: `0x${string}`; spender: `0x${string}`; amount: bigint; spenderCodeHash?: `0x${string}` };
};
