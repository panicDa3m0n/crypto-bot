import { parseAbi, type Address } from "viem";
import type { BerachainClients } from "./chain.js";
import { erc20Abi } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { ExecutionRequest, PortfolioSnapshot } from "./domain.js";
import type { Etherscan } from "./etherscan.js";

const erc4626PositionAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function asset() view returns (address)"
]);

/**
 * Scarlet's position ledger. Every USD value is reconstructed from the current
 * on-chain state (share balance + redemption preview, or token balance × price) —
 * the database is an audit trail, never a source of financial truth, and Scarlet
 * can annotate a position (label, thesis note) but can NEVER set a value herself.
 *
 * Two position kinds are valued:
 *  - erc4626: vault shares → previewRedeem → priced in the vault asset.
 *  - token:   a wallet-held token (a snipe, a swap, seized liquidation collateral)
 *             → balanceOf × price. It is "closed" automatically once the balance is 0.
 */
export class PositionService {
  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly etherscan: Etherscan) {}

  private get coreTokens(): Set<string> {
    return new Set([this.config.WBERA_ADDRESS.toLowerCase(), this.config.USDC_E_ADDRESS.toLowerCase(), this.config.HONEY_ADDRESS.toLowerCase()]);
  }

  /** Complete dynamic wallet awareness: every non-core ERC-20 the wallet actually
   * holds right now (discovered via the explorer's transfer history, valued live
   * on-chain). Lets Scarlet — and the dashboard — see holdings she never explicitly
   * tracked (a swap output, seized collateral) instead of only the 4 core tokens. */
  async walletHoldings(owner: Address): Promise<Array<{ token: string; symbol: string; balance: number; valueUsd: number; priceUsd: number }>> {
    if (!this.etherscan.available) return [];
    const tokens = await this.etherscan.walletTokens(owner).catch(() => []);
    const core = this.coreTokens;
    const candidates = tokens.filter((t) => !core.has(t.address.toLowerCase()));
    const read = await Promise.allSettled(candidates.map(async (t) => {
      const v = await this.readToken(t.address as Address, owner);
      return { token: t.address, symbol: t.symbol, balance: v.balance, valueUsd: v.valueUsd, priceUsd: v.priceUsd };
    }));
    return read.flatMap((r) => (r.status === "fulfilled" && r.value.balance > 0 ? [r.value] : [])).sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 15);
  }

  // --- opening (entry value is read on-chain; Scarlet supplies only label/note) ---

  /** Opens/updates a token position: she declares the token + thesis; the system
   * snapshots the entry value from the wallet's real balance × price. */
  async openTokenPosition(token: Address, label: string, thesisNote: string, cycle: string): Promise<{ id: number; entryValueUsd: number; balance: number }> {
    const owner = this.config.WALLET_ADDRESS as Address;
    const v = await this.readToken(token, owner);
    const id = await this.db.openPosition({
      kind: "token", protocolId: `token:${token.toLowerCase()}`, vaultAddress: token, assetAddress: token,
      sharesRaw: v.balanceRaw, assetsRaw: v.balanceRaw, valueUsd: v.valueUsd,
      label, thesisNote, cycle, metadata: { decimals: v.decimals, priceUsd: v.priceUsd, observedAt: new Date().toISOString() }
    });
    return { id, entryValueUsd: v.valueUsd, balance: v.balance };
  }

  /** Opens/updates an ERC-4626 vault position with a thesis note. */
  async openVaultPosition(vault: Address, asset: Address, label: string, thesisNote: string, cycle: string): Promise<{ id: number; entryValueUsd: number }> {
    const owner = this.config.WALLET_ADDRESS as Address;
    const v = await this.readErc4626(vault, asset, owner);
    const id = await this.db.openPosition({
      kind: "erc4626", protocolId: `erc4626:${vault.toLowerCase()}`, vaultAddress: vault, assetAddress: asset,
      sharesRaw: v.sharesRaw, assetsRaw: v.assetsRaw, valueUsd: v.valueUsd,
      label, thesisNote, cycle, metadata: { assetDecimals: v.assetDecimals, assetPriceUsd: v.assetPriceUsd, observedAt: new Date().toISOString() }
    });
    return { id, entryValueUsd: v.valueUsd };
  }

  // --- auto-capture from adapter-bound executions (lend) ----------------------

  async captureSuccessfulExecution(request: ExecutionRequest, owner: Address): Promise<void> {
    if (!request.position || request.position.kind !== "erc4626") return;
    if (request.position.owner.toLowerCase() !== owner.toLowerCase()) throw new Error("position owner differs from the executor wallet");
    await this.captureSuccessfulPosition(request.position);
  }

  async captureSuccessfulPosition(position: NonNullable<ExecutionRequest["position"]>): Promise<void> {
    const valuation = await this.readErc4626(position.vault, position.asset, position.owner);
    await this.db.upsertPosition({
      strategyId: position.strategyId, protocolId: position.protocolId, kind: "erc4626",
      vaultAddress: position.vault, assetAddress: position.asset,
      sharesRaw: valuation.sharesRaw, assetsRaw: valuation.assetsRaw, valueUsd: valuation.valueUsd,
      status: valuation.sharesRaw > 0n ? "active" : "closed",
      metadata: { source: "receipt-reconciliation", assetDecimals: valuation.assetDecimals, assetPriceUsd: valuation.assetPriceUsd, observedAt: new Date().toISOString() }
    });
  }

  // --- real-time reconciliation (per position, resilient) ---------------------

  async reconcile(portfolio: PortfolioSnapshot): Promise<PortfolioSnapshot> {
    if (!portfolio.walletAddress) return portfolio;
    const positions = await this.db.activePositions();
    if (!positions.length) return portfolio;
    const owner = portfolio.walletAddress as Address;
    let lockedUsd = 0;
    for (const position of positions) {
      try {
        if (position.kind === "token") {
          const v = await this.readToken(position.assetAddress as Address, owner);
          await this.db.upsertPosition({
            strategyId: position.strategyId, protocolId: position.protocolId, kind: "token",
            vaultAddress: position.vaultAddress, assetAddress: position.assetAddress,
            sharesRaw: v.balanceRaw, assetsRaw: v.balanceRaw, valueUsd: v.valueUsd,
            status: v.balanceRaw > 0n ? "active" : "closed",
            metadata: { ...position.metadata, source: "periodic-onchain-reconciliation", decimals: v.decimals, priceUsd: v.priceUsd, observedAt: new Date().toISOString() }
          });
          // A token position is held in the wallet but is not one of the core-4
          // portfolio tokens, so its value is real and not otherwise in NAV.
          if (!this.coreTokens.has(position.assetAddress.toLowerCase())) lockedUsd += v.valueUsd;
        } else {
          const v = await this.readErc4626(position.vaultAddress as Address, position.assetAddress as Address, owner);
          await this.db.upsertPosition({
            strategyId: position.strategyId, protocolId: position.protocolId, kind: "erc4626",
            vaultAddress: position.vaultAddress, assetAddress: position.assetAddress,
            sharesRaw: v.sharesRaw, assetsRaw: v.assetsRaw, valueUsd: v.valueUsd,
            status: v.sharesRaw > 0n ? "active" : "closed",
            metadata: { ...position.metadata, source: "periodic-onchain-reconciliation", assetDecimals: v.assetDecimals, assetPriceUsd: v.assetPriceUsd, observedAt: new Date().toISOString() }
          });
          lockedUsd += v.valueUsd;
        }
      } catch { /* a single unpriceable position must not break the whole reconcile */ }
    }
    return { ...portfolio, lockedUsd, estimatedNavUsd: portfolio.estimatedNavUsd + lockedUsd };
  }

  // --- valuation readers ------------------------------------------------------

  private async readToken(token: Address, owner: Address): Promise<{ balanceRaw: bigint; balance: number; decimals: number; priceUsd: number; valueUsd: number }> {
    const [balanceRaw, decimals] = await Promise.all([
      this.chain.primary.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      this.chain.primary.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })
    ]);
    const priceUsd = await this.chain.tokenPrice(token).catch(() => 0);
    const balance = Number(balanceRaw) / 10 ** Number(decimals);
    return { balanceRaw, balance, decimals: Number(decimals), priceUsd, valueUsd: balance * priceUsd };
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
