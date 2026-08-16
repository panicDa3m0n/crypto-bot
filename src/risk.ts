import type { Config } from "./config.js";
import type { ExecutionRequest, PortfolioSnapshot } from "./domain.js";
import { decodeFunctionData, maxUint256, parseAbi } from "viem";
import { erc20Abi } from "./chain.js";

const erc4626ExecutionAbi = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)"
]);

export type RiskResult = { allowed: true } | { allowed: false; reason: string };

export class RiskEngine {
  constructor(
    private readonly config: Config,
    private readonly allowedContracts: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly approvalSpenders: ReadonlyMap<string, ReadonlySet<string>> = new Map()
  ) {}

  validatePortfolio(snapshot: PortfolioSnapshot): RiskResult {
    if (!snapshot.dataHealthy) return { allowed: false, reason: "network data quality is degraded" };
    if (snapshot.walletAddress && snapshot.estimatedNavUsd < this.config.MIN_NAV_USD) return { allowed: false, reason: `NAV is below $${this.config.MIN_NAV_USD}` };
    const effectiveLossLimit = Math.min(this.config.DAILY_LOSS_LIMIT_USD, snapshot.estimatedNavUsd * 0.25);
    if (snapshot.dailyLossUsd >= effectiveLossLimit) return { allowed: false, reason: `effective daily loss budget $${effectiveLossLimit.toFixed(4)} reached` };
    if (snapshot.walletAddress && snapshot.bera < this.config.MIN_BERA_RESERVE) return { allowed: false, reason: `BERA reserve below ${this.config.MIN_BERA_RESERVE}` };
    return { allowed: true };
  }

  validateExecution(request: ExecutionRequest, currentBlock: bigint, snapshot: PortfolioSnapshot): RiskResult {
    const portfolio = this.validatePortfolio(snapshot);
    if (!portfolio.allowed) return portfolio;
    if (!this.config.EXECUTION_ENABLED) return { allowed: false, reason: "execution is disabled" };
    const selectors = this.allowedContracts.get(request.to.toLowerCase());
    const dynamicSelectors: Record<NonNullable<ExecutionRequest["dynamicPolicy"]>, ReadonlySet<string>> = {
      erc4626: new Set(["0x6e553f65", "0xb460af94"]), // deposit(uint256,address), withdraw(uint256,address,address)
      reward_vault: new Set(["0xa694fc3a", "0x2e1a7d4d", "0x6b091695"]) // stake, withdraw, getReward
    };
    const dynamicOnboarding = Boolean(request.contractCodeHash && request.dynamicPolicy && dynamicSelectors[request.dynamicPolicy]?.has(request.data.slice(0, 10).toLowerCase()));
    if (!selectors && !dynamicOnboarding) return { allowed: false, reason: "target contract is not allowlisted" };
    if (selectors && !selectors.has(request.data.slice(0, 10).toLowerCase())) return { allowed: false, reason: "calldata selector is not allowlisted" };
    if (!selectors && !dynamicOnboarding) return { allowed: false, reason: "dynamic contract call lacks an approved ABI policy or verified bytecode hash" };
    if (request.dynamicPolicy === "erc4626") {
      const position = request.position;
      const owner = snapshot.walletAddress?.toLowerCase();
      if (!position || !owner || position.kind !== "erc4626" || position.vault.toLowerCase() !== request.to.toLowerCase() || position.owner.toLowerCase() !== owner) {
        return { allowed: false, reason: "ERC-4626 call is not bound to the current wallet and vault position" };
      }
      try {
        const decoded = decodeFunctionData({ abi: erc4626ExecutionAbi, data: request.data });
        if (decoded.functionName === "deposit") {
          const [assets, receiver] = decoded.args as readonly [bigint, `0x${string}`];
          if (assets <= 0n || receiver.toLowerCase() !== owner) return { allowed: false, reason: "ERC-4626 deposit recipient or amount is invalid" };
        } else {
          const [assets, receiver, withdrawalOwner] = decoded.args as readonly [bigint, `0x${string}`, `0x${string}`];
          if (assets <= 0n || receiver.toLowerCase() !== owner || withdrawalOwner.toLowerCase() !== owner) return { allowed: false, reason: "ERC-4626 withdrawal recipient, owner, or amount is invalid" };
        }
      } catch {
        return { allowed: false, reason: "ERC-4626 calldata could not be decoded" };
      }
    }
    const selector = request.data.slice(0, 10).toLowerCase();
    if (selector === "0x095ea7b3") {
      const approval = request.approval;
      const allowedSpenders = this.approvalSpenders.get(request.to.toLowerCase());
      const dynamicSpender = Boolean(approval?.spenderCodeHash);
      if (!approval || approval.token.toLowerCase() !== request.to.toLowerCase() || (!allowedSpenders?.has(approval.spender.toLowerCase()) && !dynamicSpender)) {
        return { allowed: false, reason: "ERC-20 approval is not bound to an allowlisted token and spender" };
      }
      try {
        const decoded = decodeFunctionData({ abi: erc20Abi, data: request.data });
        const [spender, amount] = decoded.args as readonly [`0x${string}`, bigint];
        if (spender.toLowerCase() !== approval.spender.toLowerCase() || amount !== approval.amount || amount === maxUint256) {
          return { allowed: false, reason: "ERC-20 approval calldata is not the exact finite approved amount" };
        }
      } catch {
        return { allowed: false, reason: "ERC-20 approval calldata could not be decoded" };
      }
    } else if (request.approval) {
      return { allowed: false, reason: "approval metadata is present on a non-approval call" };
    }
    if (request.deadline.getTime() <= Date.now()) return { allowed: false, reason: "transaction deadline elapsed" };
    if (request.preflightBlock < currentBlock - 1n) return { allowed: false, reason: "preflight is older than one block" };
    if (Date.now() - request.quoteObservedAt.getTime() > this.config.MAX_QUOTE_AGE_MS) return { allowed: false, reason: "quote is stale" };
    if (request.maxSlippageBps > this.config.MAX_SLIPPAGE_BPS) return { allowed: false, reason: "slippage exceeds configured maximum" };
    const gasUsd = Number(request.gas * request.gasPriceWei) / 1e18 * snapshot.beraUsd;
    if (!Number.isFinite(gasUsd) || gasUsd <= 0) return { allowed: false, reason: "gas cost cannot be priced" };
    if (request.kind === "micro_test") {
      if (!Number.isFinite(request.maxEconomicLossUsd) || request.maxEconomicLossUsd < 0) return { allowed: false, reason: "micro-test principal-loss bound is invalid" };
      if (gasUsd + request.maxEconomicLossUsd > this.config.MICRO_TEST_MAX_LOSS_USD) return { allowed: false, reason: "micro-test worst-case loss exceeds its $0.05 budget" };
      return { allowed: true };
    }
    if (request.kind === "exit") return { allowed: true };
    if (request.kind === "agent_action") {
      // Scarlet composes plans freely; the body does not demand that each single
      // action be profitable (the profit lives in the whole sequence, which she
      // judges and simulation confirms). The reflex here bounds only the DOWNSIDE
      // of this one action, so a mistaken leg can never drain more than the cap.
      // Everything else — allowlist, exact approval, dual-RPC preflight, code-hash
      // binding, deadline, freshness, slippage, the daily loss budget, and the
      // native-BERA energy floor — has already been enforced above.
      if (!Number.isFinite(request.maxEconomicLossUsd) || request.maxEconomicLossUsd < 0) return { allowed: false, reason: "agent action downside bound is invalid" };
      if (gasUsd + request.maxEconomicLossUsd > this.config.AGENT_MAX_ACTION_LOSS_HONEY) return { allowed: false, reason: `agent action worst-case loss exceeds the per-action cap of ${this.config.AGENT_MAX_ACTION_LOSS_HONEY} HONEY` };
      return { allowed: true };
    }
    if (request.kind === "arbitrage" || request.kind === "liquidation") {
      // For a same-block arbitrage cycle the on-chain minAmountOut (>= amountIn),
      // and for a liquidation the atomic flash-loan repay, guarantee the principal
      // cannot be lost: only gas is ever at risk, and it either reverts or profits.
      // expectedNetProfitUsd is already net of gas and swap fees. Berachain's
      // micro-cent gas must therefore not disqualify a genuinely positive micro
      // profit through a gas x3 or $0.03 floor. We still require a strictly
      // positive net and that no principal beyond gas is exposed.
      if (!Number.isFinite(request.expectedNetProfitUsd) || request.expectedNetProfitUsd <= 0) return { allowed: false, reason: `${request.kind} expected net profit is not strictly positive` };
      if (!Number.isFinite(request.maxEconomicLossUsd) || request.maxEconomicLossUsd > gasUsd) return { allowed: false, reason: `${request.kind} principal is not protected: worst-case loss exceeds gas` };
      return { allowed: true };
    }
    if (request.kind === "allocation") {
      const allocationCap = snapshot.estimatedNavUsd * this.config.ACTIVE_STRATEGY_MAX_ALLOCATION_PCT;
      if (request.maxEconomicLossUsd > allocationCap) return { allowed: false, reason: `allocation $${request.maxEconomicLossUsd.toFixed(4)} exceeds ${Math.round(this.config.ACTIVE_STRATEGY_MAX_ALLOCATION_PCT * 100)}% NAV cap` };
      if (request.expectedNetProfitUsd < Math.max(gasUsd * 3, this.config.ACTIVE_MIN_NET_PROFIT_USD)) return { allowed: false, reason: "strategy thesis does not exceed gas-adjusted absolute profit floor" };
      return { allowed: true };
    }
    if (request.expectedNetProfitUsd < gasUsd * 3) return { allowed: false, reason: "expected net profit is below three times estimated gas" };
    if (request.expectedNetProfitUsd < 0.03) return { allowed: false, reason: "expected net profit is below $0.03" };
    return { allowed: true };
  }
}
