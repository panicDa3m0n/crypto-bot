import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { ExecutionRequest, PortfolioSnapshot } from "./domain.js";
import type { RiskEngine } from "./risk.js";
import type { PositionService } from "./positions.js";

export class GuardedExecutor {
  constructor(private readonly chain: BerachainClients, private readonly risk: RiskEngine, private readonly db: Database, private readonly positions: PositionService, private readonly logger: Logger, private readonly maxBlockLag: bigint = 8n) {}

  async execute(request: ExecutionRequest, snapshot: PortfolioSnapshot, currentBlock: bigint): Promise<Hex> {
    const verdict = this.risk.validateExecution(request, currentBlock, snapshot);
    if (!verdict.allowed) {
      await this.db.updateDecision(request.decisionId, "blocked", { reason: verdict.reason });
      throw new Error(`Execution blocked: ${verdict.reason}`);
    }
    if (!snapshot.walletAddress) {
      await this.db.updateDecision(request.decisionId, "blocked", { reason: "execution snapshot has no bound wallet address" });
      throw new Error("Execution blocked: execution snapshot has no bound wallet address");
    }
    const account = snapshot.walletAddress as Address;
    await this.verifyCodeBindings(request);
    const [preflight, independentPreflight] = await Promise.all([
      this.chain.preflight({ to: request.to as Address, data: request.data, value: request.value, account }),
      this.chain.preflightSecondary({ to: request.to as Address, data: request.data, value: request.value, account })
    ]);
    if (preflight.blockNumber >= independentPreflight.blockNumber ? preflight.blockNumber - independentPreflight.blockNumber > this.maxBlockLag : independentPreflight.blockNumber - preflight.blockNumber > this.maxBlockLag) {
      await this.db.updateDecision(request.decisionId, "blocked", { reason: "independent preflight block divergence", primaryBlock: preflight.blockNumber.toString(), secondaryBlock: independentPreflight.blockNumber.toString() });
      throw new Error("Execution blocked: independent preflight block divergence");
    }
    if (preflight.blockNumber < currentBlock - this.maxBlockLag || preflight.blockNumber > currentBlock + this.maxBlockLag) {
      await this.db.updateDecision(request.decisionId, "blocked", { reason: "preflight block drifted", preflightBlock: preflight.blockNumber.toString(), currentBlock: currentBlock.toString() });
      throw new Error("Execution blocked: preflight block drifted");
    }
    if (preflight.gas > request.gas) {
      await this.db.updateDecision(request.decisionId, "blocked", { reason: "preflight gas exceeds approved gas limit", estimated: preflight.gas.toString() });
      throw new Error("Execution blocked: preflight gas exceeds approved gas limit");
    }
    if (independentPreflight.gas > request.gas) {
      await this.db.updateDecision(request.decisionId, "blocked", { reason: "independent preflight gas exceeds approved gas limit", estimated: independentPreflight.gas.toString() });
      throw new Error("Execution blocked: independent preflight gas exceeds approved gas limit");
    }
    if (preflight.gasPriceWei > request.gasPriceWei) {
      await this.db.updateDecision(request.decisionId, "blocked", { reason: "gas price exceeds approved cap", estimatedGasPriceWei: preflight.gasPriceWei.toString() });
      throw new Error("Execution blocked: gas price exceeds approved cap");
    }
    if (independentPreflight.gasPriceWei > request.gasPriceWei) {
      await this.db.updateDecision(request.decisionId, "blocked", { reason: "independent gas price exceeds approved cap", estimatedGasPriceWei: independentPreflight.gasPriceWei.toString() });
      throw new Error("Execution blocked: independent gas price exceeds approved cap");
    }
    await this.db.updateDecisionExecutionPlan(request.decisionId, {
      protocolId: request.protocolId, target: request.to, calldata: request.data, valueWei: request.value.toString(),
      gasLimit: request.gas.toString(), gasPriceWei: request.gasPriceWei.toString(), preflightBlock: preflight.blockNumber.toString(),
      independentPreflightBlock: independentPreflight.blockNumber.toString(), deadline: request.deadline.toISOString(),
      maxSlippageBps: request.maxSlippageBps, maxEconomicLossUsd: request.maxEconomicLossUsd,
      expectedNetProfitUsd: request.expectedNetProfitUsd, contractCodeHash: request.contractCodeHash,
      dynamicPolicy: request.dynamicPolicy, position: request.position,
      approval: request.approval ? { token: request.approval.token, spender: request.approval.spender, amount: request.approval.amount.toString(), spenderCodeHash: request.approval.spenderCodeHash } : undefined,
      finalizedAt: new Date().toISOString()
    });
    const hash = await this.chain.send(request.to as Address, request.data, request.value, request.gas, request.gasPriceWei);
    await this.db.recordExecution({ decisionId: request.decisionId, protocolId: request.protocolId, txHash: hash, target: request.to, calldata: request.data, valueWei: request.value, gasLimit: request.gas, beraUsdAtSubmission: snapshot.beraUsd, status: "submitted", position: request.position });
    await this.db.updateDecision(request.decisionId, "submitted", { hash, preflightBlock: preflight.blockNumber.toString(), gasEstimate: preflight.gas.toString(), gasPriceWei: preflight.gasPriceWei.toString() });
    void this.settle(hash, snapshot, request.decisionId, request);
    this.logger.warn({ hash, decisionId: request.decisionId }, "mainnet transaction submitted");
    return hash;
  }

  private async verifyCodeBindings(request: ExecutionRequest): Promise<void> {
    const checks: Array<{ address: Address; expected: `0x${string}`; label: string }> = [];
    if (request.contractCodeHash) checks.push({ address: request.to as Address, expected: request.contractCodeHash, label: "target" });
    if (request.approval?.spenderCodeHash) checks.push({ address: request.approval.spender as Address, expected: request.approval.spenderCodeHash, label: "approval spender" });
    for (const check of checks) {
      const actual = await this.chain.verifiedCodeHash(check.address);
      if (actual !== check.expected) {
        await this.db.updateDecision(request.decisionId, "blocked", { reason: `${check.label} bytecode hash changed or disagrees across RPCs`, expected: check.expected, actual });
        throw new Error(`Execution blocked: ${check.label} bytecode hash is not the verified candidate hash`);
      }
    }
  }

  private async settle(hash: Hex, snapshot: PortfolioSnapshot, decisionId: string, request: ExecutionRequest): Promise<void> {
    try {
      const receipt = await this.chain.primary.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
      if (receipt.status === "success" && request.position) {
        if (!snapshot.walletAddress) throw new Error("position settlement lacks the bound wallet address");
        await this.positions.captureSuccessfulExecution(request, snapshot.walletAddress as Address);
      }
      await this.db.settleExecution(hash, {
        status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPriceWei: receipt.effectiveGasPrice, receipt,
        beraUsdAtSubmission: snapshot.beraUsd,
        outcome: { txHash: hash, receiptStatus: receipt.status, gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString(), settledAt: new Date().toISOString() }
      });
      const liquidAfterReceipt = await this.chain.portfolio(await this.db.dailyLossUsd(), true);
      const afterAtReceipt = await this.positions.reconcile(liquidAfterReceipt);
      const gasUsd = Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18 * snapshot.beraUsd;
      const navDeltaUsd = afterAtReceipt.estimatedNavUsd - snapshot.estimatedNavUsd;
      // NAV delta already includes gas. This entry stores only the non-gas component,
      // so together with the receipt gas row the ledger equals observed NAV movement.
      await this.db.addExecutionCapitalDelta(hash, navDeltaUsd + gasUsd, {
        status: receipt.status, portfolioBefore: snapshot, portfolioAfter: afterAtReceipt,
        navDeltaUsd, gasUsd, methodology: "receipt-time marked-to-market NAV delta excluding separately ledgered gas"
      });
      const after = { ...afterAtReceipt, dailyLossUsd: await this.db.dailyLossUsd() };
      await this.db.savePortfolio(after);
      await this.db.updateDecision(decisionId, receipt.status, {
        txHash: hash, receiptStatus: receipt.status, gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
        settledAt: new Date().toISOString(), portfolioBefore: snapshot, portfolioAfter: after,
        actualNavChangeUsd: navDeltaUsd
      });
    } catch (error) {
      this.logger.error({ err: error, hash }, "mainnet transaction receipt could not be finalized");
    }
  }

}
