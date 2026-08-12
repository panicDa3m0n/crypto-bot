import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { Database, ProtocolVerification } from "./db.js";
import type { BerachainClients } from "./chain.js";
import { parseAbi, type Address } from "viem";

export type RewardVault = {
  vaultAddress: string;
  metadata: { name: string; protocolName: string; action: string };
  stakingToken: { symbol: string };
  dynamicData: { apr: number | null; tvl: number | null; lastDayRewards: string; rewardCapturePercentage: number } | null;
};

export type BendVault = {
  vaultAddress: string;
  loanTokenAddress: string;
  dynamicData: { totalApy: number; nativeApy: number; supplyApy1d: number; supplyApy7d: number; supplyApy30d: number; performanceFeePercentage: number } | null;
};

export type ResearchSnapshot = {
  observedAt: string;
  topRewardVaults: RewardVault[];
  bendVaults: BendVault[];
  protocol: { totalLiquidity: string; swapVolume24h: string; swapFee24h: string } | null;
  onchainVerification: { verified: number; rejected: number; blockNumber: string };
};

const rewardVaultAbi = parseAbi([
  "function stakeToken() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function periodFinish() view returns (uint256)"
]);
const erc4626Abi = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)"
]);

export class NetworkResearcher {
  private timer?: NodeJS.Timeout;
  private current?: ResearchSnapshot;

  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly logger: Logger) {}
  get latest(): ResearchSnapshot | undefined { return this.current; }

  async hydrate(): Promise<void> { this.current = await this.db.latestMarketSnapshot<ResearchSnapshot>("bera-api", "mainnet-research"); }

  async scan(): Promise<ResearchSnapshot> {
    const data = await this.graphql<{
      polGetRewardVaults: { vaults: RewardVault[] };
      bendVaults: BendVault[];
      protocolMetricsChain: { totalLiquidity: string; swapVolume24h: string; swapFee24h: string };
    }>(`query NetworkResearch {
      polGetRewardVaults(chain: BERACHAIN, first: 20, orderBy: apr, orderDirection: desc) {
        vaults { vaultAddress metadata { name protocolName action } stakingToken { symbol } dynamicData { apr tvl lastDayRewards rewardCapturePercentage } }
      }
      bendVaults { vaultAddress loanTokenAddress dynamicData { totalApy nativeApy supplyApy1d supplyApy7d supplyApy30d performanceFeePercentage } }
      protocolMetricsChain(chain: BERACHAIN) { totalLiquidity swapVolume24h swapFee24h }
    }`);
    const verification = await this.verifyOnchain(data.polGetRewardVaults.vaults, data.bendVaults);
    const snapshot: ResearchSnapshot = {
      observedAt: new Date().toISOString(), topRewardVaults: data.polGetRewardVaults.vaults,
      bendVaults: data.bendVaults, protocol: data.protocolMetricsChain ?? null, onchainVerification: verification
    };
    await this.db.saveMarketSnapshot("bera-api", "mainnet-research", snapshot);
    this.current = snapshot;
    this.logger.info({ rewardVaults: snapshot.topRewardVaults.length, bendVaults: snapshot.bendVaults.length, verification, protocol: snapshot.protocol }, "mainnet market research saved");
    return snapshot;
  }

  start(intervalMs = 5 * 60_000): void {
    void this.scan().catch((error) => this.logger.error({ err: error }, "initial network research failed"));
    this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "network research failed")), intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async graphql<T>(query: string): Promise<T> {
    const response = await fetch(this.config.BERA_API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
    if (!response.ok) throw new Error(`Bera API request failed: ${response.status}`);
    const body = await response.json() as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length || !body.data) throw new Error(`Bera API GraphQL error: ${body.errors?.map((value) => value.message).join("; ") ?? "missing data"}`);
    return body.data;
  }

  private async verifyOnchain(rewardVaults: RewardVault[], bendVaults: BendVault[]): Promise<ResearchSnapshot["onchainVerification"]> {
    const blockNumber = await this.chain.primary.getBlockNumber();
    const checks: ProtocolVerification[] = [];
    // A deliberately bounded request rate keeps the primary observation source healthy.
    for (const vault of rewardVaults) checks.push(await this.verifyRewardVault(vault.vaultAddress, blockNumber));
    for (const vault of bendVaults) checks.push(await this.verifyBendVault(vault.vaultAddress, blockNumber));
    return { verified: checks.filter((check) => check.status === "verified").length, rejected: checks.filter((check) => check.status === "rejected").length, blockNumber: blockNumber.toString() };
  }

  private async verifyRewardVault(address: string, blockNumber: bigint): Promise<ProtocolVerification> {
    const verifiedAt = new Date();
    try {
      const target = address as Address;
      const [codeHash, stakingToken, totalSupply, rewardRate, periodFinish] = await Promise.all([
        this.chain.verifiedCodeHash(target),
        this.chain.secondary.readContract({ address: target, abi: rewardVaultAbi, functionName: "stakeToken", blockNumber }),
        this.chain.secondary.readContract({ address: target, abi: rewardVaultAbi, functionName: "totalSupply", blockNumber }),
        this.chain.secondary.readContract({ address: target, abi: rewardVaultAbi, functionName: "rewardRate", blockNumber }),
        this.chain.secondary.readContract({ address: target, abi: rewardVaultAbi, functionName: "periodFinish", blockNumber })
      ]);
      const result: ProtocolVerification = { protocol: "reward-vault", address, verifiedAt, blockNumber, codeHash, status: "verified", details: { stakingToken, totalSupply: totalSupply.toString(), rewardRate: rewardRate.toString(), periodFinish: periodFinish.toString() } };
      await this.db.saveProtocolVerification(result);
      return result;
    } catch (error) {
      const result: ProtocolVerification = { protocol: "reward-vault", address, verifiedAt, blockNumber, codeHash: "0x", status: "rejected", details: { error: error instanceof Error ? error.message : "unknown verification error" } };
      await this.db.saveProtocolVerification(result);
      return result;
    }
  }

  private async verifyBendVault(address: string, blockNumber: bigint): Promise<ProtocolVerification> {
    const verifiedAt = new Date();
    try {
      const target = address as Address;
      const [codeHash, asset, totalAssets, totalSupply, maxDeposit] = await Promise.all([
        this.chain.verifiedCodeHash(target),
        this.chain.secondary.readContract({ address: target, abi: erc4626Abi, functionName: "asset", blockNumber }),
        this.chain.secondary.readContract({ address: target, abi: erc4626Abi, functionName: "totalAssets", blockNumber }),
        this.chain.secondary.readContract({ address: target, abi: erc4626Abi, functionName: "totalSupply", blockNumber }),
        this.chain.secondary.readContract({ address: target, abi: erc4626Abi, functionName: "maxDeposit", args: ["0x0000000000000000000000000000000000000000"], blockNumber })
      ]);
      const result: ProtocolVerification = { protocol: "bend-vault", address, verifiedAt, blockNumber, codeHash, status: "verified", details: { asset, totalAssets: totalAssets.toString(), totalSupply: totalSupply.toString(), maxDeposit: maxDeposit.toString() } };
      await this.db.saveProtocolVerification(result);
      return result;
    } catch (error) {
      const result: ProtocolVerification = { protocol: "bend-vault", address, verifiedAt, blockNumber, codeHash: "0x", status: "rejected", details: { error: error instanceof Error ? error.message : "unknown verification error" } };
      await this.db.saveProtocolVerification(result);
      return result;
    }
  }
}
