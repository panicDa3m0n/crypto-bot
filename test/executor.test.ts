import { describe, expect, it } from "vitest";
import { GuardedExecutor } from "../src/executor.js";
import type { ExecutionRequest, PortfolioSnapshot } from "../src/domain.js";

const request: ExecutionRequest = {
  decisionId: "decision-1", kind: "micro_test", protocolId: "wbera-wrap",
  to: "0x0000000000000000000000000000000000000002", data: "0xd0e30db0", value: 1n,
  gas: 100n, gasPriceWei: 10n, quoteObservedAt: new Date(), maxSlippageBps: 1,
  expectedNetProfitUsd: 0, maxEconomicLossUsd: 0, preflightBlock: 10n,
  deadline: new Date(Date.now() + 60_000)
};

const snapshot = (walletAddress?: string): PortfolioSnapshot => ({
  observedAt: new Date().toISOString(), walletAddress, bera: 2, wbera: 0, usdcE: 0, honey: 0,
  baseAsset: "BERA", baseAssetBalance: 2, estimatedNavUsd: 1, beraUsd: 0.5, honeyUsd: 1,
  dailyLossUsd: 0, lockedUsd: 0, dataHealthy: true
});

describe("guarded executor final preflight", () => {
  it("rejects an otherwise approved request when the persisted portfolio has no bound wallet", async () => {
    const updates: unknown[] = [];
    const executor = new GuardedExecutor(
      {} as never,
      { validateExecution: () => ({ allowed: true as const }) } as never,
      { updateDecision: async (...args: unknown[]) => { updates.push(args); } } as never,
      {} as never,
      {} as never
    );
    await expect(executor.execute(request, snapshot(), 10n)).rejects.toThrow("no bound wallet address");
    expect(updates).toEqual([["decision-1", "blocked", { reason: "execution snapshot has no bound wallet address" }]]);
  });

  it("rejects when the independent RPC gas quote exceeds the approved cap", async () => {
    const updates: unknown[] = [];
    const executor = new GuardedExecutor(
      {
        preflight: async () => ({ gas: 90n, gasPriceWei: 10n, blockNumber: 10n }),
        preflightSecondary: async () => ({ gas: 90n, gasPriceWei: 11n, blockNumber: 10n })
      } as never,
      { validateExecution: () => ({ allowed: true as const }) } as never,
      { updateDecision: async (...args: unknown[]) => { updates.push(args); } } as never,
      {} as never,
      {} as never
    );
    await expect(executor.execute(request, snapshot("0x0000000000000000000000000000000000000001"), 10n)).rejects.toThrow("independent gas price exceeds approved cap");
    expect(updates).toEqual([["decision-1", "blocked", { reason: "independent gas price exceeds approved cap", estimatedGasPriceWei: "11" }]]);
  });
});
