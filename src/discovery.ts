import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { Database } from "./db.js";

type ApiPool = {
  id: string; address: string; name: string; symbol: string; type: string; incentivized: boolean; createTime: number;
  allTokens: Array<{ address: string; symbol: string; decimals: number; weight?: string | null }>;
  dynamicData: { totalLiquidity: string; totalLiquidity24hAgo: string; volume24h: string; volume48h: string; fees24h: string; swapFee: string; swapEnabled: boolean; isPaused: boolean; holdersCount: string; aprItems: Array<{ title: string; apr: number }> };
  rewardVault?: { vaultAddress: string; dynamicData?: { apr: number; tvl: number | null } | null } | null;
};

export type DiscoveryCandidate = {
  id: string; kind: "token-flow" | "lp-yield" | "pool-risk"; poolId: string; pool: string; tokens: string[];
  tokenAddresses: string[]; tokenDecimals: number[];
  score: number; reasons: string[]; liquidityUsd: number; volume24hUsd: number; feeApr: number; polApr: number; warnings: string[];
};

export type NetworkDiscoverySnapshot = {
  observedAt: string; poolCount: number; eligiblePoolCount: number; tokenUniverse: Array<{ address: string; symbol: string; decimals: number; pools: number; liquidityUsd: number }>;
  candidates: DiscoveryCandidate[]; exclusions: Array<{ poolId: string; reason: string }>;
};

/**
 * Builds a broad, read-only map of BEX liquidity. Scores are discovery signals,
 * never trading signals: MiniMax must turn a candidate into a falsifiable thesis
 * and the executor must still obtain an exact current route and preflight.
 */
export class NetworkDiscovery {
  private timer?: NodeJS.Timeout;
  private current?: NetworkDiscoverySnapshot;
  constructor(private readonly config: Config, private readonly db: Database, private readonly logger: Logger) {}
  get latest() { return this.current; }
  async hydrate(): Promise<void> { this.current = await this.db.latestMarketSnapshot<NetworkDiscoverySnapshot>("network-discovery", "bex-universe"); }

  async scan(): Promise<NetworkDiscoverySnapshot> {
    const pools = await this.queryPools();
    const exclusions: NetworkDiscoverySnapshot["exclusions"] = [];
    const candidates: DiscoveryCandidate[] = [];
    const tokens = new Map<string, { address: string; symbol: string; decimals: number; pools: number; liquidityUsd: number }>();
    for (const pool of pools) {
      const liquidity = number(pool.dynamicData.totalLiquidity);
      const volume = number(pool.dynamicData.volume24h);
      const holders = Number(pool.dynamicData.holdersCount);
      if (!pool.dynamicData.swapEnabled || pool.dynamicData.isPaused) { exclusions.push({ poolId: pool.id, reason: "swaps disabled or paused" }); continue; }
      if (liquidity < 1_000 || volume < 100 || holders < 20) { exclusions.push({ poolId: pool.id, reason: `insufficient liquidity/volume/holders (${liquidity.toFixed(0)}/${volume.toFixed(0)}/${holders})` }); continue; }
      const feeApr = pool.dynamicData.aprItems.find((item) => item.title.toLowerCase().includes("swap"))?.apr ?? 0;
      const polApr = pool.rewardVault?.dynamicData?.apr ?? 0;
      const turnover = volume / liquidity;
      const liquidityDelta = (liquidity - number(pool.dynamicData.totalLiquidity24hAgo)) / Math.max(liquidity, 1);
      const score = Math.min(100, 30 * Math.log10(liquidity) + 20 * Math.min(turnover, 2) + 20 * Math.max(0, liquidityDelta) + 30 * Math.min(feeApr + polApr, 1));
      const tokenSymbols = pool.allTokens.filter((token) => token.address.toLowerCase() !== pool.address.toLowerCase()).map((token) => token.symbol);
      const warnings = [pool.type !== "WEIGHTED" ? `pool type ${pool.type} requires specialized valuation` : undefined, liquidityDelta < -0.2 ? "liquidity declined more than 20% over 24h" : undefined].filter((value): value is string => Boolean(value));
      const reasons = [`$${liquidity.toFixed(0)} liquidity`, `$${volume.toFixed(0)} 24h volume`, `${(turnover * 100).toFixed(1)}% turnover`, `${((feeApr + polApr) * 100).toFixed(2)}% reported fee/PoL APR`];
      const tokenEntries = pool.allTokens.filter((token) => token.address.toLowerCase() !== pool.address.toLowerCase());
      candidates.push({ id: `pool:${pool.id}`, kind: feeApr + polApr > 0 ? "lp-yield" : "token-flow", poolId: pool.id, pool: pool.name, tokens: tokenSymbols, tokenAddresses: tokenEntries.map((token) => token.address), tokenDecimals: tokenEntries.map((token) => token.decimals), score, reasons, liquidityUsd: liquidity, volume24hUsd: volume, feeApr, polApr, warnings });
      for (const token of pool.allTokens.filter((entry) => entry.address.toLowerCase() !== pool.address.toLowerCase())) {
        const prior = tokens.get(token.address.toLowerCase()) ?? { address: token.address, symbol: token.symbol, decimals: token.decimals, pools: 0, liquidityUsd: 0 };
        prior.pools += 1; prior.liquidityUsd += liquidity; tokens.set(token.address.toLowerCase(), prior);
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const snapshot: NetworkDiscoverySnapshot = { observedAt: new Date().toISOString(), poolCount: pools.length, eligiblePoolCount: candidates.length, tokenUniverse: [...tokens.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 80), candidates: candidates.slice(0, 40), exclusions: exclusions.slice(0, 100) };
    await this.db.saveMarketSnapshot("network-discovery", "bex-universe", snapshot);
    this.current = snapshot;
    this.logger.info({ pools: snapshot.poolCount, eligible: snapshot.eligiblePoolCount, candidates: snapshot.candidates.length, exclusions: snapshot.exclusions.length }, "BEX network discovery saved");
    return snapshot;
  }
  start(intervalMs = 5 * 60_000): void { void this.scan().catch((error) => this.logger.error({ err: error }, "initial network discovery failed")); this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "network discovery failed")), intervalMs); }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async queryPools(): Promise<ApiPool[]> {
    const query = `query Discovery { poolGetPools(first: 150, orderBy: volume24h, orderDirection: desc) { id address name symbol type incentivized createTime allTokens { address symbol decimals weight } dynamicData { totalLiquidity totalLiquidity24hAgo volume24h volume48h fees24h swapFee swapEnabled isPaused holdersCount aprItems { title apr } } rewardVault { vaultAddress dynamicData { apr tvl } } } }`;
    const response = await fetch(this.config.BERA_API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
    if (!response.ok) throw new Error(`Bera API discovery request failed: ${response.status}`);
    const body = await response.json() as { data?: { poolGetPools?: ApiPool[] }; errors?: Array<{ message: string }> };
    if (body.errors?.length || !body.data?.poolGetPools) throw new Error(`Bera API discovery error: ${body.errors?.map((item) => item.message).join("; ") ?? "missing pools"}`);
    return body.data.poolGetPools;
  }
}

function number(value: string): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
