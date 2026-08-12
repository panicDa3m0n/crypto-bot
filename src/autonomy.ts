import type { Logger } from "pino";
import { Erc4626Adapter, ExactAllowanceAdapter, type ProposedCall, type WberaAdapter } from "./adapters.js";
import { BexAdapter, BexQuoteScanner, BEX_VAULT, WBERA } from "./bex.js";
import { erc20Abi, type BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { Decision, ExecutionRequest, PortfolioSnapshot } from "./domain.js";
import type { GuardedExecutor } from "./executor.js";
import type { GateService } from "./gates.js";
import type { NetworkResearcher, BendVault } from "./research.js";

type CandidateBindings = Pick<ExecutionRequest, "contractCodeHash" | "dynamicPolicy" | "position">;

export type ExecutionCandidate = {
  id: string;
  kind: "micro_test" | "allocation" | "exit";
  requiredAction: "ENTER" | "EXIT";
  rationale: string;
  plan: ProposedCall;
  maxEconomicLossUsd: number;
  expectedNetProfitUsd: number;
  serializedPlan: Record<string, unknown>;
  /** Rebuilds the same adapter-bound intent against fresh mainnet state. */
  refresh: () => Promise<ProposedCall>;
  /** Reprices the fixed input immediately before execution. */
  economicBound: () => Promise<number>;
  bindings: CandidateBindings;
};

/** Binds an LLM approval to finite, adapter-generated calls; it never accepts model calldata. */
export class AutonomousExecution {
  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly gates: GateService,
    private readonly research: NetworkResearcher,
    private readonly wbera: WberaAdapter,
    private readonly allowance: ExactAllowanceAdapter,
    private readonly bex: BexAdapter,
    private readonly quotes: BexQuoteScanner,
    private readonly executor: GuardedExecutor,
    private readonly logger: Logger
  ) {}

  async candidate(portfolio: PortfolioSnapshot): Promise<ExecutionCandidate | undefined> {
    if (!this.config.EXECUTION_ENABLED || !portfolio.dataHealthy || portfolio.bera < this.config.MIN_BERA_RESERVE || !portfolio.walletAddress) {
      this.logger.debug({
        executionEnabled: this.config.EXECUTION_ENABLED,
        dataHealthy: portfolio.dataHealthy,
        bera: portfolio.bera,
        minBeraReserve: this.config.MIN_BERA_RESERVE,
        walletConfigured: Boolean(portfolio.walletAddress)
      }, "no execution candidate: wallet or data prerequisite not met");
      return undefined;
    }
    const owner = portfolio.walletAddress as `0x${string}`;

    // The first action is self-custodial and reversible. It establishes that
    // nonce, fee, signing, receipt and accounting work on real mainnet without
    // granting an allowance or exposing capital to a third-party protocol.
    if (!await this.db.hasSuccessfulProtocolExecution("wbera-wrap")) {
      const bootstrapGate = await this.gates.bootstrapObservationGate();
      if (!bootstrapGate.ready) {
        this.logger.debug({ bootstrapGate }, "no execution candidate: self-custodial bootstrap evidence gate not ready");
        return undefined;
      }
      return this.bexAdapterMicroCycle(portfolio, owner);
    }
    // BEX/Bend writes remain behind the longer evidence window, then receive a
    // second, exact dual-RPC execution preflight in GuardedExecutor.
    if (!(await this.gates.observationGate()).ready) return undefined;
    if (!await this.db.hasSuccessfulProtocolExecution("wbera-unwrap")) return this.bexAdapterMicroCycle(portfolio, owner);
    const micro = await this.bendLendingMicroCycle(portfolio, owner);
    return micro ?? this.activeBendYieldCycle(portfolio, owner);
  }

  async executeIfApproved(decisionId: string, decision: Decision, portfolio: PortfolioSnapshot, candidate?: ExecutionCandidate): Promise<void> {
    if (!candidate || decision.action !== candidate.requiredAction || decision.strategyId !== candidate.id || decision.confidence < 0.6) return;
    const refreshed = await candidate.refresh();
    const request: ExecutionRequest = {
      decisionId, kind: candidate.kind, protocolId: candidate.plan.protocolId, to: refreshed.to, data: refreshed.data, value: refreshed.value,
      gas: refreshed.preflight.gas, gasPriceWei: refreshed.preflight.gasPriceWei, quoteObservedAt: new Date(), maxSlippageBps: refreshed.maxSlippageBps,
      expectedNetProfitUsd: candidate.expectedNetProfitUsd, maxEconomicLossUsd: await candidate.economicBound(), preflightBlock: refreshed.preflight.blockNumber, deadline: refreshed.deadline,
      approval: refreshed.approval, ...candidate.bindings
    };
    await this.executor.execute(request, portfolio, refreshed.preflight.blockNumber);
    this.logger.warn({ decisionId, protocol: request.protocolId, kind: request.kind }, "MiniMax-approved autonomous execution submitted");
  }

  private async bexAdapterMicroCycle(portfolio: PortfolioSnapshot, owner: `0x${string}`): Promise<ExecutionCandidate | undefined> {
    if (!await this.db.hasProtocolAttempt("wbera-wrap")) {
      const amount = nativeMicroAmount(portfolio, this.config.MIN_BERA_RESERVE);
      if (amount === 0n) return undefined;
      const plan = await this.wbera.prepareWrap(amount);
      return this.makeCandidate("wbera-wrap-microtest", "Wrap bounded BERA into WBERA. Principal remains withdrawable; only gas is at risk.", plan, 0, () => this.wbera.prepareWrap(amount));
    }
    if (!await this.db.hasSuccessfulProtocolExecution("wbera-wrap")) return undefined;
    if (!(await this.gates.protocolObservationGate("bex", BEX_VAULT)).ready) return undefined;

    const wberaAmount = boundedValueAmount(portfolio.wbera, 18, portfolio.beraUsd);
    if (wberaAmount === 0n) return undefined;
    const wberaApprovalId = approvalProtocolId(WBERA, BEX_VAULT);
    if (!await this.db.hasProtocolAttempt(wberaApprovalId)) {
      const plan = await this.allowance.prepareIfNeeded(WBERA, owner, BEX_VAULT, wberaAmount);
      if (plan) return this.approvalCandidate("wbera-bex-approval-microtest", "Set one exact, finite WBERA allowance for the official BEX Vault; unlimited approval is prohibited.", plan, owner);
    } else if (!await this.db.hasSuccessfulProtocolExecution(wberaApprovalId)) return undefined;

    const wberaSwapId = "bex:wbera:honey";
    if (!await this.db.hasProtocolAttempt(wberaSwapId)) {
      const plan = { ...await this.bex.prepareExactIn({ tokenIn: WBERA, tokenInDecimals: 18, tokenOut: this.honey, tokenOutDecimals: 18, amountIn: wberaAmount, sender: owner, recipient: owner, maxSlippagePercent: "0.5" }), protocolId: wberaSwapId };
      return this.makeCandidate("bex-wbera-honey-microtest", "Execute one bounded BEX swap with a fresh quote after exact allowance settlement.", plan, tokenUsd(wberaAmount, 18, portfolio.beraUsd), () => this.bex.prepareExactIn({ tokenIn: WBERA, tokenInDecimals: 18, tokenOut: this.honey, tokenOutDecimals: 18, amountIn: wberaAmount, sender: owner, recipient: owner, maxSlippagePercent: "0.5" }), async () => tokenUsd(wberaAmount, 18, await this.chain.tokenPrice(WBERA)));
    }
    if (!await this.db.hasSuccessfulProtocolExecution(wberaSwapId)) return undefined;

    const honeyAmount = boundedValueAmount(await this.honeyBalance(owner), 18, 1);
    if (honeyAmount === 0n) return undefined;
    const honeyApprovalId = approvalProtocolId(this.honey, BEX_VAULT);
    if (!await this.db.hasProtocolAttempt(honeyApprovalId)) {
      const plan = await this.allowance.prepareIfNeeded(this.honey, owner, BEX_VAULT, honeyAmount);
      if (plan) return this.approvalCandidate("honey-bex-approval-microtest", "Set one exact, finite HONEY allowance for the official BEX Vault before the reversible exit path.", plan, owner);
    } else if (!await this.db.hasSuccessfulProtocolExecution(honeyApprovalId)) return undefined;

    const exitSwapId = "bex:honey:wbera";
    if (!await this.db.hasProtocolAttempt(exitSwapId)) {
      const plan = { ...await this.bex.prepareExactIn({ tokenIn: this.honey, tokenInDecimals: 18, tokenOut: WBERA, tokenOutDecimals: 18, amountIn: honeyAmount, sender: owner, recipient: owner, maxSlippagePercent: "0.5" }), protocolId: exitSwapId };
      return this.makeCandidate("bex-honey-wbera-exit-microtest", "Exercise the BEX exit path back into WBERA using the observed HONEY balance.", plan, tokenUsd(honeyAmount, 18, 1), () => this.bex.prepareExactIn({ tokenIn: this.honey, tokenInDecimals: 18, tokenOut: WBERA, tokenOutDecimals: 18, amountIn: honeyAmount, sender: owner, recipient: owner, maxSlippagePercent: "0.5" }), async () => tokenUsd(honeyAmount, 18, await this.chain.tokenPrice(this.honey)));
    }
    if (!await this.db.hasSuccessfulProtocolExecution(exitSwapId)) return undefined;

    if (!await this.db.hasProtocolAttempt("wbera-unwrap")) {
      // Return the complete bounded experiment, not an arbitrary token slice.
      // The first wrap is itself capped to $0.025 and the reversible BEX leg is
      // capped to the same amount, so a $0.05 value ceiling remains conservative
      // even if a route returns slightly more WBERA than it received.
      const amount = boundedWberaUnwrapAmount(portfolio.wbera, portfolio.beraUsd);
      if (amount === 0n) return undefined;
      const plan = await this.wbera.prepareUnwrap(amount);
      return this.makeCandidate("wbera-unwrap-microtest", "Complete the first adapter cycle by returning bounded WBERA to the native BERA reserve.", plan, 0, () => this.wbera.prepareUnwrap(amount));
    }
    if (!await this.db.hasSuccessfulProtocolExecution("wbera-unwrap")) return undefined;
    return undefined;
  }

  private async bendLendingMicroCycle(portfolio: PortfolioSnapshot, owner: `0x${string}`): Promise<ExecutionCandidate | undefined> {
    const vault = this.selectBendHoneyVault();
    if (!vault) return undefined;
    const vaultAddress = vault.vaultAddress as `0x${string}`;
    if (!(await this.gates.protocolObservationGate("bend-vault", vaultAddress)).ready) return undefined;
    const codeHash = await this.chain.verifiedCodeHash(vaultAddress);
    if (await this.db.latestVerifiedCodeHash("bend-vault", vaultAddress) !== codeHash) return undefined;
    const prefix = `bend-onboarding:${vaultAddress.toLowerCase()}`;
    const asset = this.honey;

    if (!await this.db.hasProtocolAttempt(`${prefix}:wrap`)) {
      const amount = nativeMicroAmount(portfolio, this.config.MIN_BERA_RESERVE);
      if (amount === 0n) return undefined;
      const plan = { ...await this.wbera.prepareWrap(amount), protocolId: `${prefix}:wrap` };
      return this.makeCandidate(`${prefix}:wrap`, "Fund a bounded Bend onboarding experiment by wrapping only the BERA needed for its $0.05-capital path.", plan, 0, () => this.wbera.prepareWrap(amount));
    }
    if (!await this.db.hasSuccessfulProtocolExecution(`${prefix}:wrap`)) return undefined;

    const wberaAmount = boundedValueAmount(portfolio.wbera, 18, portfolio.beraUsd);
    if (wberaAmount === 0n) return undefined;
    const approvalInId = `${prefix}:approve-wbera-bex`;
    if (!await this.db.hasProtocolAttempt(approvalInId)) {
      const plan = await this.allowance.prepareIfNeeded(WBERA, owner, BEX_VAULT, wberaAmount);
      if (plan) return this.approvalCandidate(`${prefix}:approve-wbera-bex`, "Create an exact WBERA allowance for the already verified BEX entry route.", { ...plan, protocolId: approvalInId }, owner);
    } else if (!await this.db.hasSuccessfulProtocolExecution(approvalInId)) return undefined;

    const swapInId = `${prefix}:swap-in`;
    if (!await this.db.hasProtocolAttempt(swapInId)) {
      const plan = { ...await this.bex.prepareExactIn({ tokenIn: WBERA, tokenInDecimals: 18, tokenOut: asset, tokenOutDecimals: 18, amountIn: wberaAmount, sender: owner, recipient: owner, maxSlippagePercent: "0.5" }), protocolId: swapInId };
      return this.makeCandidate(`${prefix}:swap-in`, "Acquire the exact bounded HONEY amount for one Bend deposit experiment, only with a current executable BEX route.", plan, tokenUsd(wberaAmount, 18, portfolio.beraUsd), () => this.bex.prepareExactIn({ tokenIn: WBERA, tokenInDecimals: 18, tokenOut: asset, tokenOutDecimals: 18, amountIn: wberaAmount, sender: owner, recipient: owner, maxSlippagePercent: "0.5" }), async () => tokenUsd(wberaAmount, 18, await this.chain.tokenPrice(WBERA)));
    }
    if (!await this.db.hasSuccessfulProtocolExecution(swapInId)) return undefined;

    const honeyAmount = boundedValueAmount(await this.honeyBalance(owner), 18, 1);
    if (honeyAmount === 0n) return undefined;
    const approvalDepositId = `${prefix}:approve-deposit`;
    if (!await this.db.hasProtocolAttempt(approvalDepositId)) {
      const plan = await this.allowance.prepareIfNeeded(asset, owner, vaultAddress, honeyAmount, codeHash);
      if (plan) return this.approvalCandidate(`${prefix}:approve-deposit`, "Set one exact HONEY allowance bound to the currently dual-RPC-verified Bend vault bytecode.", { ...plan, protocolId: approvalDepositId }, owner);
    } else if (!await this.db.hasSuccessfulProtocolExecution(approvalDepositId)) return undefined;

    const depositId = `${prefix}:deposit`;
    const adapter = new Erc4626Adapter(this.chain, vaultAddress);
    if (!await this.db.hasProtocolAttempt(depositId)) {
      const plan = { ...await adapter.prepareDeposit(honeyAmount, owner), protocolId: depositId };
      const bindings: CandidateBindings = { contractCodeHash: codeHash, dynamicPolicy: "erc4626", position: { strategyId: "lending_prudent", protocolId: `bend-vault:${vaultAddress.toLowerCase()}`, vault: vaultAddress, asset, owner, kind: "erc4626" } };
      return this.makeCandidate(`${prefix}:deposit`, "Perform a single bounded ERC-4626 Bend deposit after 72 hours of stable bytecode and on-chain observation. This is an experiment, not a promoted allocation.", plan, tokenUsd(honeyAmount, 18, 1), () => adapter.prepareDeposit(honeyAmount, owner), async () => tokenUsd(honeyAmount, 18, await this.chain.tokenPrice(asset)), bindings);
    }
    if (!await this.db.hasSuccessfulProtocolExecution(depositId)) return undefined;

    const depositedAt = await this.db.successfulProtocolExecutionAt(depositId);
    if (!depositedAt || Date.now() - depositedAt.getTime() < 7 * 24 * 60 * 60_000) return undefined;
    const inspection = await adapter.inspect(owner);
    if (inspection.maxWithdraw === 0n) return undefined;
    const withdrawId = `${prefix}:withdraw`;
    if (!await this.db.hasProtocolAttempt(withdrawId)) {
      const plan = { ...await adapter.prepareWithdraw(inspection.maxWithdraw, owner, owner), protocolId: withdrawId };
      const bindings: CandidateBindings = { contractCodeHash: codeHash, dynamicPolicy: "erc4626", position: { strategyId: "lending_prudent", protocolId: `bend-vault:${vaultAddress.toLowerCase()}`, vault: vaultAddress, asset, owner, kind: "erc4626" } };
      return this.makeCandidate(`${prefix}:withdraw`, "Exercise the verified Bend withdrawal path after seven full days of real position data; no promotion occurs before this exit succeeds.", plan, 0, () => adapter.prepareWithdraw(inspection.maxWithdraw, owner, owner), undefined, bindings);
    }
    return undefined;
  }

  /** Promotes only a completed real Bend experiment into a bounded yield sleeve. */
  private async activeBendYieldCycle(portfolio: PortfolioSnapshot, owner: `0x${string}`): Promise<ExecutionCandidate | undefined> {
    const vault = this.selectBendHoneyVault();
    if (!vault || !(await this.gates.protocolObservationGate("bend-vault", vault.vaultAddress)).ready) return undefined;
    const prefix = `bend-onboarding:${vault.vaultAddress.toLowerCase()}`;
    if (!await this.db.hasSuccessfulProtocolExecution(`${prefix}:withdraw`)) return undefined;
    const active = (await this.db.activePositions()).find((position) => position.vaultAddress.toLowerCase() === vault.vaultAddress.toLowerCase());
    const adapter = new Erc4626Adapter(this.chain, vault.vaultAddress as `0x${string}`);
    const codeHash = await this.chain.verifiedCodeHash(vault.vaultAddress as `0x${string}`);
    const bindings: CandidateBindings = { contractCodeHash: codeHash, dynamicPolicy: "erc4626", position: { strategyId: "lending_prudent", protocolId: `bend-vault:${vault.vaultAddress.toLowerCase()}`, vault: vault.vaultAddress as `0x${string}`, asset: this.honey, owner, kind: "erc4626" } };
    if (active) {
      if ((vault.dynamicData?.totalApy ?? 0) > 0) return undefined; // ERC-4626 yield compounds in the share price; no harvest transaction is needed.
      const inspection = await adapter.inspect(owner);
      if (inspection.maxWithdraw === 0n) return undefined;
      const plan = { ...await adapter.prepareWithdraw(inspection.maxWithdraw, owner, owner), protocolId: `bend-active:${vault.vaultAddress.toLowerCase()}:exit` };
      return this.makeCandidate(`bend-active:${vault.vaultAddress.toLowerCase()}:exit`, "Exit the active Bend position because the verified yield thesis is no longer positive; retain redeemed HONEY for reassessment.", plan, 0, () => adapter.prepareWithdraw(inspection.maxWithdraw, owner, owner), async () => 0, bindings, { kind: "exit", requiredAction: "EXIT" });
    }
    const amount = activeNativeAmount(portfolio, this.config.MIN_BERA_RESERVE, this.config.ACTIVE_STRATEGY_MAX_ALLOCATION_PCT);
    const thesis = await this.yieldThesis(amount, vault, portfolio);
    if (!thesis || thesis.inputUsd < this.config.ACTIVE_STRATEGY_MIN_CAPITAL_USD || thesis.netUsd < this.config.ACTIVE_MIN_NET_PROFIT_USD) return undefined;
    const activePrefix = `bend-active:${vault.vaultAddress.toLowerCase()}`;
    if (!await this.db.hasProtocolAttempt(`${activePrefix}:wrap`)) {
      const plan = { ...await this.wbera.prepareWrap(amount), protocolId: `${activePrefix}:wrap` };
      return this.makeCandidate(`${activePrefix}:wrap`, `Start a bounded Bend yield allocation with a ${this.config.ACTIVE_YIELD_HORIZON_DAYS}-day projected net return of $${thesis.netUsd.toFixed(4)} after quoted round-trip and gas costs.`, plan, thesis.inputUsd, () => this.wbera.prepareWrap(amount), async () => thesis.inputUsd, {}, { kind: "allocation", expectedNetProfitUsd: thesis.netUsd, thesis });
    }
    if (!await this.db.hasSuccessfulProtocolExecution(`${activePrefix}:wrap`)) return undefined;
    const wberaAmount = boundedActiveAmount(portfolio.wbera, 18, thesis.inputUsd, portfolio.beraUsd);
    if (wberaAmount === 0n) return undefined;
    const approvalId = `${activePrefix}:approve-wbera-bex`;
    if (!await this.db.hasProtocolAttempt(approvalId)) {
      const plan = await this.allowance.prepareIfNeeded(WBERA, owner, BEX_VAULT, wberaAmount);
      if (plan) return this.activeCandidate(`${activePrefix}:approve-wbera-bex`, "Approve exactly the thesis-bound WBERA amount for the verified BEX route.", { ...plan, protocolId: approvalId }, owner, thesis);
    }
    if (!await this.db.hasSuccessfulProtocolExecution(approvalId)) return undefined;
    const swapId = `${activePrefix}:swap-in`;
    if (!await this.db.hasProtocolAttempt(swapId)) {
      const plan = { ...await this.bex.prepareExactIn({ tokenIn: WBERA, tokenInDecimals: 18, tokenOut: this.honey, tokenOutDecimals: 18, amountIn: wberaAmount, sender: owner, recipient: owner, maxSlippagePercent: "0.5" }), protocolId: swapId };
      return this.makeCandidate(`${activePrefix}:swap-in`, "Acquire HONEY only while the live 30-day Bend thesis remains net positive after quoted exit costs.", plan, thesis.inputUsd, () => this.bex.prepareExactIn({ tokenIn: WBERA, tokenInDecimals: 18, tokenOut: this.honey, tokenOutDecimals: 18, amountIn: wberaAmount, sender: owner, recipient: owner, maxSlippagePercent: "0.5" }), async () => thesis.inputUsd, {}, { kind: "allocation", expectedNetProfitUsd: thesis.netUsd, thesis });
    }
    if (!await this.db.hasSuccessfulProtocolExecution(swapId)) return undefined;
    const honeyAmount = boundedActiveAmount(await this.honeyBalance(owner), 18, thesis.inputUsd, 1);
    if (honeyAmount === 0n) return undefined;
    const depositApproval = `${activePrefix}:approve-deposit`;
    if (!await this.db.hasProtocolAttempt(depositApproval)) {
      const plan = await this.allowance.prepareIfNeeded(this.honey, owner, vault.vaultAddress as `0x${string}`, honeyAmount, codeHash);
      if (plan) return this.activeCandidate(`${activePrefix}:approve-deposit`, "Approve exactly the HONEY amount bound to the verified Bend vault and current yield thesis.", { ...plan, protocolId: depositApproval }, owner, thesis);
    }
    if (!await this.db.hasSuccessfulProtocolExecution(depositApproval)) return undefined;
    const depositId = `${activePrefix}:deposit`;
    if (!await this.db.hasProtocolAttempt(depositId)) {
      const plan = { ...await adapter.prepareDeposit(honeyAmount, owner), protocolId: depositId };
      return this.makeCandidate(`${activePrefix}:deposit`, "Deposit into the selected Bend vault; value is subsequently reconciled from previewRedeem and yield compounds in ERC-4626 shares.", plan, thesis.inputUsd, () => adapter.prepareDeposit(honeyAmount, owner), async () => thesis.inputUsd, bindings, { kind: "allocation", expectedNetProfitUsd: thesis.netUsd, thesis });
    }
    return undefined;
  }

  private approvalCandidate(id: string, rationale: string, plan: ProposedCall, owner: `0x${string}`): ExecutionCandidate {
    return this.makeCandidate(id, rationale, plan, 0, async () => {
      if (!plan.approval) throw new Error("approval candidate is missing exact approval metadata");
      const refreshed = await this.allowance.prepareIfNeeded(plan.approval.token, owner, plan.approval.spender, plan.approval.amount, plan.approval.spenderCodeHash);
      if (!refreshed) throw new Error("exact allowance is already present; approval candidate is stale");
      return refreshed;
    });
  }

  private activeCandidate(id: string, rationale: string, plan: ProposedCall, owner: `0x${string}`, thesis: YieldThesis): ExecutionCandidate {
    return this.makeCandidate(id, rationale, plan, thesis.inputUsd, async () => {
      if (!plan.approval) throw new Error("active allowance candidate is missing exact approval metadata");
      const refreshed = await this.allowance.prepareIfNeeded(plan.approval.token, owner, plan.approval.spender, plan.approval.amount, plan.approval.spenderCodeHash);
      if (!refreshed) throw new Error("active allowance is already present; candidate is stale");
      return refreshed;
    }, async () => thesis.inputUsd, {}, { kind: "allocation", expectedNetProfitUsd: thesis.netUsd, thesis });
  }

  private async yieldThesis(amount: bigint, vault: BendVault, portfolio: PortfolioSnapshot): Promise<YieldThesis | undefined> {
    if (amount <= 0n || !vault.dynamicData || portfolio.beraUsd <= 0) return undefined;
    const blockNumber = await this.chain.secondary.getBlockNumber();
    const entry = await this.quotes.quoteExactIn({ tokenInAddress: WBERA, tokenInDecimals: 18, tokenOutAddress: this.honey, tokenOutDecimals: 18, amountIn: amount, blockNumber });
    const honeyRaw = BigInt(entry.amountOut);
    const exit = await this.quotes.quoteExactIn({ tokenInAddress: this.honey, tokenInDecimals: 18, tokenOutAddress: WBERA, tokenOutDecimals: 18, amountIn: honeyRaw, blockNumber });
    const inputUsd = tokenUsd(amount, 18, portfolio.beraUsd);
    const outputUsd = tokenUsd(BigInt(exit.amountOut), 18, portfolio.beraUsd);
    const annualApy = normalizeApy(vault.dynamicData.totalApy);
    if (annualApy <= 0) return undefined;
    const estimatedGasUsd = Number(7n * 450_000n * (await this.chain.secondary.getGasPrice())) / 1e18 * portfolio.beraUsd;
    const projectedYieldUsd = tokenUsd(honeyRaw, 18, portfolio.honeyUsd || 1) * annualApy * this.config.ACTIVE_YIELD_HORIZON_DAYS / 365;
    return { inputUsd, annualApy, projectedYieldUsd, roundTripCostUsd: Math.max(0, inputUsd - outputUsd), estimatedGasUsd, netUsd: projectedYieldUsd - Math.max(0, inputUsd - outputUsd) - estimatedGasUsd, horizonDays: this.config.ACTIVE_YIELD_HORIZON_DAYS, vault: vault.vaultAddress, entryBlock: entry.blockNumber, exitBlock: exit.blockNumber };
  }

  private makeCandidate(id: string, rationale: string, plan: ProposedCall & { amountIn?: bigint }, maxEconomicLossUsd: number, refresh: () => Promise<ProposedCall>, economicBound: () => Promise<number> = async () => 0, bindings: CandidateBindings = {}, options: { kind?: ExecutionCandidate["kind"]; requiredAction?: ExecutionCandidate["requiredAction"]; expectedNetProfitUsd?: number; thesis?: YieldThesis } = {}): ExecutionCandidate {
    return {
      id, kind: options.kind ?? "micro_test", requiredAction: options.requiredAction ?? "ENTER", rationale, plan, maxEconomicLossUsd, expectedNetProfitUsd: options.expectedNetProfitUsd ?? 0, refresh, economicBound, bindings,
      serializedPlan: {
        protocolId: plan.protocolId, target: plan.to, calldata: plan.data, valueWei: plan.value.toString(), estimatedGas: plan.preflight.gas.toString(), gasPriceWei: plan.preflight.gasPriceWei.toString(), preflightBlock: plan.preflight.blockNumber.toString(), deadline: plan.deadline.toISOString(), maxSlippageBps: plan.maxSlippageBps, maxEconomicLossUsd, swapAmountIn: plan.amountIn?.toString(), contractCodeHash: bindings.contractCodeHash, dynamicPolicy: bindings.dynamicPolicy,
        position: bindings.position, yieldThesis: options.thesis,
        approval: plan.approval ? { token: plan.approval.token, spender: plan.approval.spender, amount: plan.approval.amount.toString(), spenderCodeHash: plan.approval.spenderCodeHash } : undefined
      }
    };
  }

  private selectBendHoneyVault(): BendVault | undefined {
    return this.research.latest?.bendVaults
      .filter((vault) => vault.loanTokenAddress.toLowerCase() === this.honey.toLowerCase() && (vault.dynamicData?.totalApy ?? 0) > 0)
      .sort((left, right) => (right.dynamicData?.supplyApy7d ?? -Infinity) - (left.dynamicData?.supplyApy7d ?? -Infinity))[0];
  }

  private get honey(): `0x${string}` { return this.config.HONEY_ADDRESS as `0x${string}`; }

  private async honeyBalance(owner: `0x${string}`): Promise<number> {
    const raw = await this.chain.primary.readContract({ address: this.honey, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    return Number(raw) / 1e18;
  }
}

type YieldThesis = { inputUsd: number; annualApy: number; projectedYieldUsd: number; roundTripCostUsd: number; estimatedGasUsd: number; netUsd: number; horizonDays: number; vault: string; entryBlock: string; exitBlock: string };

function approvalProtocolId(token: string, spender: string): string { return `approval:${token.toLowerCase()}:${spender.toLowerCase()}`; }
function nativeMicroAmount(portfolio: PortfolioSnapshot, reserveBera: number, absoluteCapBera?: number): bigint {
  const available = Math.max(0, portfolio.bera - reserveBera);
  const cap = absoluteCapBera ?? (portfolio.beraUsd > 0 ? 0.025 / portfolio.beraUsd : 0);
  return BigInt(Math.floor(Math.min(available, cap) * 1e18));
}
export function boundedWberaUnwrapAmount(balance: number, beraUsd: number): bigint {
  if (!Number.isFinite(balance) || balance <= 0 || !Number.isFinite(beraUsd) || beraUsd <= 0) return 0n;
  const raw = BigInt(Math.floor(balance * 1e18));
  const valueCap = BigInt(Math.floor((0.05 / beraUsd) * 1e18));
  return raw < valueCap ? raw : valueCap;
}
function boundedValueAmount(balance: number, decimals: number, usdPrice: number): bigint {
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) return 0n;
  const available = BigInt(Math.floor(balance * 10 ** decimals));
  const cap = BigInt(Math.floor((0.025 / usdPrice) * 10 ** decimals));
  return available < cap ? available : cap;
}
function activeNativeAmount(portfolio: PortfolioSnapshot, reserveBera: number, allocationPct: number): bigint {
  const available = Math.max(0, portfolio.bera - reserveBera);
  return BigInt(Math.floor(available * allocationPct * 1e18));
}
function boundedActiveAmount(balance: number, decimals: number, usdCap: number, price: number): bigint {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(usdCap) || usdCap <= 0) return 0n;
  const available = BigInt(Math.floor(balance * 10 ** decimals));
  const cap = BigInt(Math.floor(usdCap / price * 10 ** decimals));
  return available < cap ? available : cap;
}
function normalizeApy(value: number): number { return value > 1 ? value / 100 : value; }
function tokenUsd(amount: bigint, decimals: number, price: number): number { return Number(amount) / 10 ** decimals * price; }
