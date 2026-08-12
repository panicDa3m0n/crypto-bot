import { parseAbi, type Address } from "viem";
import type { BerachainClients } from "./chain.js";
import { erc20Abi } from "./chain.js";
import type { Database } from "./db.js";
import type { ExecutionRequest, PortfolioSnapshot } from "./domain.js";

const erc4626PositionAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function asset() view returns (address)"
]);

/**
 * Values only positions that have an adapter-bound execution record. Every value
 * is reconstructed from the vault's current on-chain share balance and redemption
 * preview; the database is an audit trail, never a source of financial truth.
 */
export class PositionService {
  constructor(private readonly chain: BerachainClients, private readonly db: Database) {}

  async captureSuccessfulExecution(request: ExecutionRequest, owner: Address): Promise<void> {
    if (!request.position || request.position.kind !== "erc4626") return;
    if (request.position.owner.toLowerCase() !== owner.toLowerCase()) throw new Error("position owner differs from the executor wallet");
    await this.captureSuccessfulPosition(request.position);
  }

  async captureSuccessfulPosition(position: NonNullable<ExecutionRequest["position"]>): Promise<void> {
    const valuation = await this.readErc4626(position.vault, position.asset, position.owner);
    await this.db.upsertPosition({
      strategyId: position.strategyId, protocolId: position.protocolId,
      vaultAddress: position.vault, assetAddress: position.asset,
      sharesRaw: valuation.sharesRaw, assetsRaw: valuation.assetsRaw, valueUsd: valuation.valueUsd,
      status: valuation.sharesRaw > 0n ? "active" : "closed",
      metadata: { source: "receipt-reconciliation", assetDecimals: valuation.assetDecimals, assetPriceUsd: valuation.assetPriceUsd, observedAt: new Date().toISOString() }
    });
  }

  async reconcile(portfolio: PortfolioSnapshot): Promise<PortfolioSnapshot> {
    if (!portfolio.walletAddress) return portfolio;
    const positions = await this.db.activePositions();
    if (!positions.length) return portfolio;
    let lockedUsd = 0;
    for (const position of positions) {
      const valuation = await this.readErc4626(position.vaultAddress as Address, position.assetAddress as Address, portfolio.walletAddress as Address);
      await this.db.upsertPosition({
        strategyId: position.strategyId, protocolId: position.protocolId,
        vaultAddress: position.vaultAddress, assetAddress: position.assetAddress,
        sharesRaw: valuation.sharesRaw, assetsRaw: valuation.assetsRaw, valueUsd: valuation.valueUsd,
        status: valuation.sharesRaw > 0n ? "active" : "closed",
        metadata: { ...position.metadata, source: "periodic-onchain-reconciliation", assetDecimals: valuation.assetDecimals, assetPriceUsd: valuation.assetPriceUsd, observedAt: new Date().toISOString() }
      });
      lockedUsd += valuation.valueUsd;
    }
    return { ...portfolio, lockedUsd, estimatedNavUsd: portfolio.estimatedNavUsd + lockedUsd };
  }

  private async readErc4626(vault: Address, expectedAsset: Address, owner: Address): Promise<{ sharesRaw: bigint; assetsRaw: bigint; assetDecimals: number; assetPriceUsd: number; valueUsd: number }> {
    const [asset, sharesRaw] = await Promise.all([
      this.chain.primary.readContract({ address: vault, abi: erc4626PositionAbi, functionName: "asset" }),
      this.chain.primary.readContract({ address: vault, abi: erc4626PositionAbi, functionName: "balanceOf", args: [owner] })
    ]);
    if (asset.toLowerCase() !== expectedAsset.toLowerCase()) throw new Error("active vault asset does not match the adapter-bound asset");
    const [assetsRaw, assetDecimals, assetPriceUsd] = await Promise.all([
      this.chain.primary.readContract({ address: vault, abi: erc4626PositionAbi, functionName: "previewRedeem", args: [sharesRaw] }),
      this.chain.primary.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }),
      this.chain.tokenPrice(asset)
    ]);
    const valueUsd = Number(assetsRaw) / 10 ** Number(assetDecimals) * assetPriceUsd;
    if (!Number.isFinite(valueUsd) || valueUsd < 0) throw new Error("vault position cannot be priced from current on-chain redemption value");
    return { sharesRaw, assetsRaw, assetDecimals: Number(assetDecimals), assetPriceUsd, valueUsd };
  }
}
