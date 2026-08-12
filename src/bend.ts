import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";

const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)"
]);
const priceAbi = parseAbi(["function price() view returns (uint256)"]);
const borrowEvent = parseAbiItem("event Borrow(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)");
const supplyCollateralEvent = parseAbiItem("event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)");
const WAD = 10n ** 18n;

export function calculateHealthFactorWad(collateral: bigint, oraclePrice: bigint, lltv: bigint, borrowAssets: bigint): bigint | undefined {
  if (borrowAssets === 0n) return undefined;
  const collateralValue = collateral * oraclePrice / (10n ** 36n);
  return collateralValue * lltv / borrowAssets;
}

type MarketParams = readonly [Address, Address, Address, Address, bigint];
type MarketState = readonly [bigint, bigint, bigint, bigint, bigint, bigint];
type Position = readonly [bigint, bigint, bigint];
export type BendScanSummary = { observedAt: string; blockNumber: string; markets: number; accounts: number; liquidatable: number };

export class BendScanner {
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private last?: BendScanSummary;
  private previousLiquidatable = 0;
  private readonly liquidationListeners = new Set<(summary: BendScanSummary) => void>();
  private readonly archive;

  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly logger: Logger) {
    this.archive = createPublicClient({ transport: http(config.BEND_ARCHIVE_RPC_URL, { timeout: 20_000, retryCount: 1 }) });
  }
  get latest() { return this.last; }
  onLiquidationChange(listener: (summary: BendScanSummary) => void): () => void { this.liquidationListeners.add(listener); return () => this.liquidationListeners.delete(listener); }

  async scan(): Promise<void> {
    if (this.scanning) {
      this.logger.debug("Bend scan skipped because the preceding mainnet scan is still running");
      return;
    }
    this.scanning = true;
    try {
      const latestBlock = await this.archiveCall((client) => client.getBlockNumber());
      let accounts = 0;
      let liquidatable = 0;
      for (const marketId of this.marketIds()) {
        try {
          await this.backfillAccounts(marketId, latestBlock);
          accounts += await this.db.bendAccountCount(marketId);
          liquidatable += await this.snapshotPositions(marketId, latestBlock);
        } catch (error) {
          this.logger.error({ err: error, marketId }, "Bend market scan failed; market excluded from candidates");
        }
      }
      this.last = { observedAt: new Date().toISOString(), blockNumber: latestBlock.toString(), markets: this.marketIds().length, accounts, liquidatable };
      await this.db.saveMarketSnapshot("bend-rpc", "scanner", this.last);
      if (liquidatable > 0 && liquidatable !== this.previousLiquidatable) for (const listener of this.liquidationListeners) listener(this.last);
      this.previousLiquidatable = liquidatable;
      this.logger.info(this.last, "Bend mainnet scanner saved");
    } finally {
      this.scanning = false;
    }
  }

  start(intervalMs = this.config.BEND_SCAN_INTERVAL_MS): void {
    void this.scan().catch((error) => this.logger.error({ err: error }, "initial Bend scan failed"));
    this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "Bend scan failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private marketIds(): Hex[] { return this.config.BEND_MARKET_IDS.split(",").map((id) => id.trim()).filter(Boolean).map((id) => id as Hex); }

  private async backfillAccounts(marketId: Hex, latestBlock: bigint): Promise<string[]> {
    const key = `bend:${marketId.toLowerCase()}`;
    const cursor = await this.db.scanCursor(key);
    const firstBlock = cursor ? cursor + 1n : latestBlock > BigInt(this.config.BEND_LOG_LOOKBACK_BLOCKS) ? latestBlock - BigInt(this.config.BEND_LOG_LOOKBACK_BLOCKS) : 0n;
    if (firstBlock > latestBlock) return [];
    const lastBlock = firstBlock + BigInt(this.config.BEND_BACKFILL_BLOCKS_PER_SCAN) - 1n > latestBlock ? latestBlock : firstBlock + BigInt(this.config.BEND_BACKFILL_BLOCKS_PER_SCAN) - 1n;
    const accounts = new Set<string>();
    const step = 2_000n;
    for (let fromBlock = firstBlock; fromBlock <= lastBlock; fromBlock += step) {
      const toBlock = fromBlock + step - 1n > lastBlock ? lastBlock : fromBlock + step - 1n;
      const [borrows, collaterals] = await Promise.all([
        this.archiveCall((client) => client.getLogs({ address: this.config.BEND_MORPHO_ADDRESS as Address, event: borrowEvent, args: { id: marketId }, fromBlock, toBlock })),
        this.archiveCall((client) => client.getLogs({ address: this.config.BEND_MORPHO_ADDRESS as Address, event: supplyCollateralEvent, args: { id: marketId }, fromBlock, toBlock }))
      ]);
      for (const log of [...borrows, ...collaterals]) {
        const account = log.args.onBehalf;
        if (account) accounts.add(account.toLowerCase());
      }
    }
    await this.db.upsertBendAccounts(marketId, [...accounts], lastBlock);
    await this.db.saveScanCursor(key, lastBlock);
    return [...accounts];
  }

  private async snapshotPositions(marketId: Hex, blockNumber: bigint): Promise<number> {
    const morpho = this.config.BEND_MORPHO_ADDRESS as Address;
    const accounts = await this.db.nextBendAccountsForSnapshot(marketId, this.config.BEND_MAX_POSITION_READS_PER_SCAN);
    if (!accounts.length) return 0;
    const [paramsResult, marketResult] = await Promise.all([
      this.archiveCall((client) => client.readContract({ address: morpho, abi: morphoAbi, functionName: "idToMarketParams", args: [marketId], blockNumber })),
      this.archiveCall((client) => client.readContract({ address: morpho, abi: morphoAbi, functionName: "market", args: [marketId], blockNumber }))
    ]);
    const [loanToken, collateralToken, oracle, , lltv] = paramsResult as MarketParams;
    const [, , totalBorrowAssets, totalBorrowShares] = marketResult as MarketState;
    // Morpho Blue's immutable ORACLE_PRICE_SCALE is 1e36. Oracle implementations
    // encode token decimal adjustments in price(), so applying them again here creates false liquidations.
    const oraclePrice = await this.archiveCall((client) => client.readContract({ address: oracle, abi: priceAbi, functionName: "price", blockNumber }));
    let liquidatable = 0;
    const observedAt = new Date();
    for (const account of accounts) {
      const [, borrowShares, collateral] = await this.archiveCall((client) => client.readContract({ address: morpho, abi: morphoAbi, functionName: "position", args: [marketId, account as Address], blockNumber })) as Position;
      const borrowAssets = totalBorrowShares === 0n || borrowShares === 0n ? 0n : (borrowShares * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;
      const healthFactorWad = calculateHealthFactorWad(collateral, oraclePrice, lltv, borrowAssets);
      if (healthFactorWad !== undefined && healthFactorWad <= WAD) liquidatable += 1;
      await this.db.saveBendPosition({ observedAt, blockNumber, marketId, account, loanToken, collateralToken, oracle, borrowAssets, collateral, lltv, oraclePrice, healthFactorWad });
    }
    await this.db.markBendAccountsSnapshot(marketId, accounts, observedAt);
    return liquidatable;
  }

  /**
   * The archive endpoint is preferred for historical logs. It is never a
   * single point of failure: a timed-out free plan falls back to the two RPC
   * sources already used for execution. A failed market remains excluded.
   */
  private async archiveCall<T>(operation: (client: typeof this.archive) => Promise<T>): Promise<T> {
    try {
      return await operation(this.archive);
    } catch (archiveError) {
      this.logger.warn({ err: archiveError }, "Bend archive RPC failed; retrying through execution RPC sources");
      try {
        return await operation(this.chain.secondary as unknown as typeof this.archive);
      } catch (secondaryError) {
        this.logger.warn({ err: secondaryError }, "Bend secondary RPC failed; retrying through primary RPC");
        return operation(this.chain.primary as unknown as typeof this.archive);
      }
    }
  }
}
