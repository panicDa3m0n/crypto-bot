import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { ExecutionRequest } from "./domain.js";
import type { PositionService } from "./positions.js";

/** Repairs only persisted accounting from actual mainnet receipts; it never creates transactions. */
export class ReceiptReconciler {
  private timer?: NodeJS.Timeout;

  constructor(private readonly chain: BerachainClients, private readonly db: Database, private readonly positions: PositionService, private readonly logger: Logger) {}

  async run(): Promise<void> {
    for (const execution of await this.db.unsettledExecutions()) {
      try {
        const receipt = await this.chain.primary.getTransactionReceipt({ hash: execution.txHash as `0x${string}` });
        const beraUsdAtSubmission = execution.beraUsdAtSubmission ?? await this.chain.tokenPrice("0x6969696969696969696969696969696969696969");
        if (!Number.isFinite(beraUsdAtSubmission) || beraUsdAtSubmission <= 0) {
          this.logger.warn({ hash: execution.txHash }, "receipt found but BERA price unavailable for reconciliation");
          continue;
        }
        if (receipt.status === "success" && isErc4626Position(execution.position)) await this.positions.captureSuccessfulPosition(execution.position);
        await this.db.settleExecution(execution.txHash, {
          status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPriceWei: receipt.effectiveGasPrice, receipt, beraUsdAtSubmission,
          outcome: { txHash: execution.txHash, receiptStatus: receipt.status, gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString(), reconciledAt: new Date().toISOString() }
        });
        this.logger.info({ hash: execution.txHash, status: receipt.status }, "mainnet receipt reconciled");
      } catch (error) {
        // Pending transactions have no receipt; retain them for the next pass.
        this.logger.debug({ err: error, hash: execution.txHash }, "receipt not yet available for reconciliation");
      }
    }
  }

  start(intervalMs = 30_000): void {
    void this.run().catch((error) => this.logger.error({ err: error }, "initial receipt reconciliation failed"));
    this.timer = setInterval(() => void this.run().catch((error) => this.logger.error({ err: error }, "receipt reconciliation failed")), intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}

function isErc4626Position(value: unknown): value is NonNullable<ExecutionRequest["position"]> {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const address = (key: string) => typeof item[key] === "string" && /^0x[a-fA-F0-9]{40}$/.test(item[key] as string);
  return item.kind === "erc4626" && typeof item.strategyId === "string" && typeof item.protocolId === "string" && address("vault") && address("asset") && address("owner");
}
