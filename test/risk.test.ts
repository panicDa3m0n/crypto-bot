import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RiskEngine } from "../src/risk.js";
import type { PortfolioSnapshot } from "../src/domain.js";
import { encodeFunctionData } from "viem";
import { erc20Abi } from "../src/chain.js";
import { parseAbi } from "viem";

const env = {
  DATABASE_URL: "postgres://bot:bot@localhost:5432/berabot",
  REDIS_URL: "redis://localhost:6379",
  PRIMARY_RPC_HTTP_URL: "https://rpc.berachain.com",
  SECONDARY_RPC_HTTP_URL: "https://rpc.berachain.com",
  WALLET_ADDRESS: "0x0000000000000000000000000000000000000001",
  WALLET_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
  USDC_E_ADDRESS: "0x549943e04f40284185054145c6e4e9568c1d3241",
  HONEY_ADDRESS: "0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce"
};

const snapshot: PortfolioSnapshot = { observedAt: new Date().toISOString(), walletAddress: "0x0000000000000000000000000000000000000001", bera: 1, wbera: 0, usdcE: 20, honey: 0, baseAsset: "BERA", baseAssetBalance: 1, estimatedNavUsd: 20.15, beraUsd: 0.15, honeyUsd: 1, dailyLossUsd: 0, lockedUsd: 0, dataHealthy: true };
const target = "0x0000000000000000000000000000000000000002";
const selectors = new Map([[target, new Set(["0xd0e30db0"])] ]);
const erc4626Abi = parseAbi(["function deposit(uint256 assets, address receiver) returns (uint256 shares)"]);

describe("risk engine", () => {
  it("allows a healthy funded portfolio", () => {
    const risk = new RiskEngine(loadConfig(env), new Map());
    expect(risk.validatePortfolio(snapshot)).toEqual({ allowed: true });
  });

  it("stops after the daily loss limit", () => {
    const risk = new RiskEngine(loadConfig(env), new Map());
    const result = risk.validatePortfolio({ ...snapshot, dailyLossUsd: 5 });
    expect(result.allowed).toBe(false);
  });

  it("scales the loss ceiling down for a micro-capital wallet", () => {
    const risk = new RiskEngine(loadConfig(env), new Map());
    const result = risk.validatePortfolio({ ...snapshot, estimatedNavUsd: 1.5, dailyLossUsd: 0.4 });
    expect(result.allowed).toBe(false);
  });

  it("never permits execution while disabled", () => {
    const risk = new RiskEngine(loadConfig(env), selectors);
    const result = risk.validateExecution({ decisionId: "d", kind: "profit", protocolId: "test", to: target, data: "0xd0e30db0", value: 0n, gas: 100_000n, gasPriceWei: 1n, quoteObservedAt: new Date(), maxSlippageBps: 1, expectedNetProfitUsd: 1, maxEconomicLossUsd: 0, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000) }, 10n, snapshot);
    expect(result).toEqual({ allowed: false, reason: "execution is disabled" });
  });

  it("permits a selector-allowlisted micro-test only inside its gas-loss budget", () => {
    const risk = new RiskEngine(loadConfig({ ...env, EXECUTION_ENABLED: "true" }), selectors);
    const result = risk.validateExecution({ decisionId: "d", kind: "micro_test", protocolId: "wbera-wrap", to: target, data: "0xd0e30db0", value: 1n, gas: 100_000n, gasPriceWei: 1_000_000_000n, quoteObservedAt: new Date(), maxSlippageBps: 1, expectedNetProfitUsd: 0, maxEconomicLossUsd: 0, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000) }, 10n, snapshot);
    expect(result).toEqual({ allowed: true });
  });

  it("includes principal at risk when enforcing the micro-test budget", () => {
    const risk = new RiskEngine(loadConfig({ ...env, EXECUTION_ENABLED: "true" }), selectors);
    const result = risk.validateExecution({ decisionId: "d", kind: "micro_test", protocolId: "bounded-swap", to: target, data: "0xd0e30db0", value: 0n, gas: 100_000n, gasPriceWei: 1_000_000_000n, quoteObservedAt: new Date(), maxSlippageBps: 1, expectedNetProfitUsd: 0, maxEconomicLossUsd: 0.05, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000) }, 10n, snapshot);
    expect(result).toEqual({ allowed: false, reason: "micro-test worst-case loss exceeds its $0.05 budget" });
  });

  it("permits a promoted allocation only within its NAV cap and positive thesis", () => {
    const risk = new RiskEngine(loadConfig({ ...env, EXECUTION_ENABLED: "true", ACTIVE_STRATEGY_MAX_ALLOCATION_PCT: "0.5" }), selectors);
    const result = risk.validateExecution({ decisionId: "d", kind: "allocation", protocolId: "yield", to: target, data: "0xd0e30db0", value: 0n, gas: 100_000n, gasPriceWei: 1_000_000_000n, quoteObservedAt: new Date(), maxSlippageBps: 1, expectedNetProfitUsd: 0.10, maxEconomicLossUsd: 5, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000) }, 10n, snapshot);
    expect(result).toEqual({ allowed: true });
  });

  it("rejects a promoted allocation that exceeds its NAV cap", () => {
    const risk = new RiskEngine(loadConfig({ ...env, EXECUTION_ENABLED: "true", ACTIVE_STRATEGY_MAX_ALLOCATION_PCT: "0.5" }), selectors);
    const result = risk.validateExecution({ decisionId: "d", kind: "allocation", protocolId: "yield", to: target, data: "0xd0e30db0", value: 0n, gas: 100_000n, gasPriceWei: 1_000_000_000n, quoteObservedAt: new Date(), maxSlippageBps: 1, expectedNetProfitUsd: 0.10, maxEconomicLossUsd: 11, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000) }, 10n, snapshot);
    expect(result.allowed).toBe(false);
  });

  it("rejects a stale quote even if its target is allowlisted", () => {
    const risk = new RiskEngine(loadConfig({ ...env, EXECUTION_ENABLED: "true" }), selectors);
    const result = risk.validateExecution({ decisionId: "d", kind: "micro_test", protocolId: "wbera-wrap", to: target, data: "0xd0e30db0", value: 1n, gas: 1n, gasPriceWei: 1n, quoteObservedAt: new Date(Date.now() - 30_000), maxSlippageBps: 1, expectedNetProfitUsd: 0, maxEconomicLossUsd: 0, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000) }, 10n, snapshot);
    expect(result).toEqual({ allowed: false, reason: "quote is stale" });
  });

  it("permits only an exact finite approval for a registered spender", () => {
    const token = "0x0000000000000000000000000000000000000003" as const;
    const spender = "0x0000000000000000000000000000000000000004" as const;
    const amount = 123n;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
    const risk = new RiskEngine(loadConfig({ ...env, EXECUTION_ENABLED: "true" }), new Map([[token, new Set(["0x095ea7b3"])]]), new Map([[token, new Set([spender])]]));
    const result = risk.validateExecution({ decisionId: "d", kind: "micro_test", protocolId: "approval", to: token, data, value: 0n, gas: 100_000n, gasPriceWei: 1_000_000_000n, quoteObservedAt: new Date(), maxSlippageBps: 1, expectedNetProfitUsd: 0, maxEconomicLossUsd: 0, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000), approval: { token, spender, amount } }, 10n, snapshot);
    expect(result).toEqual({ allowed: true });
  });

  it("allows a dynamic onboarding target only when bound to a verified bytecode hash", () => {
    const dynamicTarget = "0x0000000000000000000000000000000000000005" as const;
    const asset = "0x0000000000000000000000000000000000000003" as const;
    const data = encodeFunctionData({ abi: erc4626Abi, functionName: "deposit", args: [1n, snapshot.walletAddress as `0x${string}`] });
    const risk = new RiskEngine(loadConfig({ ...env, EXECUTION_ENABLED: "true" }), new Map());
    const result = risk.validateExecution({ decisionId: "d", kind: "micro_test", protocolId: "onboarded-vault", to: dynamicTarget, data, value: 0n, gas: 100_000n, gasPriceWei: 1_000_000_000n, quoteObservedAt: new Date(), maxSlippageBps: 1, expectedNetProfitUsd: 0, maxEconomicLossUsd: 0, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000), contractCodeHash: "0x1111111111111111111111111111111111111111111111111111111111111111", dynamicPolicy: "erc4626", position: { strategyId: "lending_prudent", protocolId: "bend-vault:test", vault: dynamicTarget, asset, owner: snapshot.walletAddress as `0x${string}`, kind: "erc4626" } }, 10n, snapshot);
    expect(result).toEqual({ allowed: true });
  });

  it("rejects a dynamic target without a constrained ABI policy", () => {
    const dynamicTarget = "0x0000000000000000000000000000000000000005" as const;
    const risk = new RiskEngine(loadConfig({ ...env, EXECUTION_ENABLED: "true" }), new Map());
    const result = risk.validateExecution({ decisionId: "d", kind: "micro_test", protocolId: "unbound", to: dynamicTarget, data: "0x6e553f65", value: 0n, gas: 100_000n, gasPriceWei: 1_000_000_000n, quoteObservedAt: new Date(), maxSlippageBps: 1, expectedNetProfitUsd: 0, maxEconomicLossUsd: 0, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000), contractCodeHash: "0x1111111111111111111111111111111111111111111111111111111111111111" }, 10n, snapshot);
    expect(result).toEqual({ allowed: false, reason: "target contract is not allowlisted" });
  });

  it("requires a dynamic ERC-4626 deposit to credit the configured wallet position", () => {
    const vault = "0x0000000000000000000000000000000000000005" as const;
    const asset = "0x0000000000000000000000000000000000000003" as const;
    const data = encodeFunctionData({ abi: erc4626Abi, functionName: "deposit", args: [1n, "0x0000000000000000000000000000000000000006"] });
    const risk = new RiskEngine(loadConfig({ ...env, EXECUTION_ENABLED: "true" }), new Map());
    const result = risk.validateExecution({ decisionId: "d", kind: "micro_test", protocolId: "onboarded-vault", to: vault, data, value: 0n, gas: 100_000n, gasPriceWei: 1_000_000_000n, quoteObservedAt: new Date(), maxSlippageBps: 1, expectedNetProfitUsd: 0, maxEconomicLossUsd: 0, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000), contractCodeHash: "0x1111111111111111111111111111111111111111111111111111111111111111", dynamicPolicy: "erc4626", position: { strategyId: "lending_prudent", protocolId: "bend-vault:test", vault, asset, owner: snapshot.walletAddress as `0x${string}`, kind: "erc4626" } }, 10n, snapshot);
    expect(result).toEqual({ allowed: false, reason: "ERC-4626 deposit recipient or amount is invalid" });
  });

  it("rejects an approval when its decoded amount differs from the bound amount", () => {
    const token = "0x0000000000000000000000000000000000000003" as const;
    const spender = "0x0000000000000000000000000000000000000004" as const;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 124n] });
    const risk = new RiskEngine(loadConfig({ ...env, EXECUTION_ENABLED: "true" }), new Map([[token, new Set(["0x095ea7b3"])]]), new Map([[token, new Set([spender])]]));
    const result = risk.validateExecution({ decisionId: "d", kind: "micro_test", protocolId: "approval", to: token, data, value: 0n, gas: 100_000n, gasPriceWei: 1_000_000_000n, quoteObservedAt: new Date(), maxSlippageBps: 1, expectedNetProfitUsd: 0, maxEconomicLossUsd: 0, preflightBlock: 10n, deadline: new Date(Date.now() + 60_000), approval: { token, spender, amount: 123n } }, 10n, snapshot);
    expect(result).toEqual({ allowed: false, reason: "ERC-20 approval calldata is not the exact finite approved amount" });
  });
});
