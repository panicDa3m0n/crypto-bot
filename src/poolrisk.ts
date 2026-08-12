import { parseAbi, type Address } from "viem";
import type { Logger } from "pino";
import { BEX_VAULT } from "./bex.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { NetworkDiscovery, NetworkDiscoverySnapshot } from "./discovery.js";
import type { MarketHistory } from "./history.js";

const vaultAbi = parseAbi(["function getPoolTokens(bytes32) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)"]);
const weightedPoolAbi = parseAbi(["function getNormalizedWeights() view returns (uint256[])"]);
const WAD = 1e18;

export type PoolRiskAssessment = {
  poolId: string;
  poolAddress: string;
  observedAt: string;
  status: "verified" | "rejected";
  reason?: string;
  codeHash?: string;
  lastChangeBlock?: string;
  tokens?: Array<{ address: string; symbol: string; balanceRaw: string; usdValue: number; valueWeight: number; normalizedWeight: number }>;
  /** Worst no-fee counterfactual IL across independent ±10% and ±20% shocks. */
  worstStressIlPct?: number;
  /** Counterfactual no-fee IL using official 30/90-day token price relatives. */
  return30dIlPct?: number;
  return90dIlPct?: number;
  stressCases?: Array<{ token: string; shockPct: number; ilPct: number }>;
};

export type PoolRiskSnapshot = { observedAt: string; pools: PoolRiskAssessment[] };

/**
 * Converts public LP APR into a falsifiable risk input.  Pool balances and
 * normalized weights are read from the BEX vault/pool through both RPCs; price
 * values are only used for sizing and are never an execution quote.
 */
export class PoolRiskScanner {
  private timer?: NodeJS.Timeout;
  private current?: PoolRiskSnapshot;

  constructor(private readonly chain: BerachainClients, private readonly db: Database, private readonly discovery: NetworkDiscovery, private readonly history: MarketHistory, private readonly logger: Logger) {}
  get latest() { return this.current; }
  async hydrate(): Promise<void> { this.current = await this.db.latestMarketSnapshot<PoolRiskSnapshot>("pool-risk", "weighted-bex-pools"); }

  async scan(): Promise<PoolRiskSnapshot> {
    const discovery = this.discovery.latest ?? await this.db.latestMarketSnapshot<NetworkDiscoverySnapshot>("network-discovery", "bex-universe");
    const candidates = (discovery?.candidates ?? []).filter((candidate) => candidate.tokenAddresses.length >= 2).slice(0, 12);
    const pools = await Promise.all(candidates.map((candidate) => this.inspect(candidate)));
    const snapshot: PoolRiskSnapshot = { observedAt: new Date().toISOString(), pools };
    await this.db.saveMarketSnapshot("pool-risk", "weighted-bex-pools", snapshot);
    this.current = snapshot;
    this.logger.info({ checked: pools.length, verified: pools.filter((pool) => pool.status === "verified").length, rejected: pools.filter((pool) => pool.status === "rejected").length }, "BEX weighted-pool risk scan saved");
    return snapshot;
  }

  start(intervalMs = 5 * 60_000): void {
    this.timer = setTimeout(() => {
      void this.scan().catch((error) => this.logger.error({ err: error }, "initial BEX pool-risk scan failed"));
      this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "BEX pool-risk scan failed")), intervalMs);
    }, 10_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async inspect(candidate: NetworkDiscoverySnapshot["candidates"][number]): Promise<PoolRiskAssessment> {
    const poolAddress = poolAddressFromId(candidate.poolId);
    try {
      const [primary, secondary, primaryWeights, secondaryWeights, codeHash] = await Promise.all([
        this.chain.primary.readContract({ address: BEX_VAULT, abi: vaultAbi, functionName: "getPoolTokens", args: [candidate.poolId as `0x${string}`] }),
        this.chain.secondary.readContract({ address: BEX_VAULT, abi: vaultAbi, functionName: "getPoolTokens", args: [candidate.poolId as `0x${string}`] }),
        this.chain.primary.readContract({ address: poolAddress, abi: weightedPoolAbi, functionName: "getNormalizedWeights" }),
        this.chain.secondary.readContract({ address: poolAddress, abi: weightedPoolAbi, functionName: "getNormalizedWeights" }),
        this.chain.verifiedCodeHash(poolAddress)
      ]);
      if (!samePoolState(primary, secondary) || !sameBigints(primaryWeights, secondaryWeights)) throw new Error("pool state differs between independent RPCs");
      const [tokens, balances, lastChangeBlock] = primary;
      if (tokens.length < 2 || tokens.length !== balances.length || tokens.length !== primaryWeights.length) throw new Error("pool token, balance and weight arrays are inconsistent");
      const expected = new Set(candidate.tokenAddresses.map((address) => address.toLowerCase()));
      if (tokens.some((token) => !expected.has(token.toLowerCase()))) throw new Error("on-chain pool tokens differ from discovery candidate");
      const decimals = tokens.map((token) => tokenDecimals(candidate, token));
      // Reuse the already persisted official chart snapshot.  Per-token live
      // price calls here would compete with the discovery scanner and turn a
      // rate limit into a false pool rejection.
      const signals = new Map((this.history.latest?.signals ?? []).map((signal) => [signal.address.toLowerCase(), signal]));
      const prices = tokens.map((token) => signals.get(token.toLowerCase())?.latestPriceUsd ?? 0);
      if (prices.some((price) => !Number.isFinite(price) || price <= 0)) throw new Error("one or more token prices are unavailable");
      const values = balances.map((balance, index) => rawToNumber(balance, decimals[index]) * prices[index]);
      const totalValue = values.reduce((sum, value) => sum + value, 0);
      if (!Number.isFinite(totalValue) || totalValue <= 0) throw new Error("pool USD valuation is unusable");
      const normalized = primaryWeights.map((weight) => Number(weight) / WAD);
      const weightSum = normalized.reduce((sum, weight) => sum + weight, 0);
      if (Math.abs(weightSum - 1) > 0.000_001) throw new Error("pool normalized weights do not sum to one");
      const tokenReports = tokens.map((token, index) => ({
        address: token, symbol: candidate.tokens[candidate.tokenAddresses.findIndex((address) => address.toLowerCase() === token.toLowerCase())] ?? token.slice(0, 10),
        balanceRaw: balances[index].toString(), usdValue: values[index], valueWeight: values[index] / totalValue, normalizedWeight: normalized[index]
      }));
      const stressCases = weightedStressCases(tokenReports.map((token) => ({ symbol: token.symbol, weight: token.normalizedWeight })));
      const return30dIlPct = historicalIlPct(tokens, normalized, signals, "return30d");
      const return90dIlPct = historicalIlPct(tokens, normalized, signals, "return90d");
      return { poolId: candidate.poolId, poolAddress, observedAt: new Date().toISOString(), status: "verified", codeHash, lastChangeBlock: lastChangeBlock.toString(), tokens: tokenReports, worstStressIlPct: Math.min(...stressCases.map((item) => item.ilPct)), return30dIlPct, return90dIlPct, stressCases };
    } catch (error) {
      return { poolId: candidate.poolId, poolAddress, observedAt: new Date().toISOString(), status: "rejected", reason: error instanceof Error ? error.message : "pool risk inspection failed" };
    }
  }
}

export function poolAddressFromId(poolId: string): Address {
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) throw new Error("pool id is not bytes32");
  return poolId.slice(0, 42) as Address;
}

/** Weighted constant-mean IL relative to holding the initial pool basket. */
export function weightedImpermanentLoss(weights: number[], priceRelatives: number[]): number {
  if (weights.length < 2 || weights.length !== priceRelatives.length || weights.some((weight) => !Number.isFinite(weight) || weight < 0) || priceRelatives.some((price) => !Number.isFinite(price) || price <= 0)) throw new Error("invalid weighted IL input");
  const sum = weights.reduce((total, weight) => total + weight, 0);
  if (Math.abs(sum - 1) > 0.000_001) throw new Error("weights must sum to one");
  const lp = priceRelatives.reduce((product, relative, index) => product * relative ** weights[index], 1);
  const hold = priceRelatives.reduce((total, relative, index) => total + weights[index] * relative, 0);
  return lp / hold - 1;
}

export function weightedStressCases(tokens: Array<{ symbol: string; weight: number }>): Array<{ token: string; shockPct: number; ilPct: number }> {
  const cases: Array<{ token: string; shockPct: number; ilPct: number }> = [];
  for (let index = 0; index < tokens.length; index += 1) for (const shockPct of [-20, -10, 10, 20]) {
    const relatives = tokens.map((_, relativeIndex) => relativeIndex === index ? 1 + shockPct / 100 : 1);
    cases.push({ token: tokens[index].symbol, shockPct, ilPct: weightedImpermanentLoss(tokens.map((token) => token.weight), relatives) * 100 });
  }
  return cases;
}

function tokenDecimals(candidate: NetworkDiscoverySnapshot["candidates"][number], token: string): number {
  const index = candidate.tokenAddresses.findIndex((address) => address.toLowerCase() === token.toLowerCase());
  const decimals = candidate.tokenDecimals?.[index];
  if (index < 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("token decimal metadata is missing or invalid");
  return decimals;
}

function rawToNumber(value: bigint, decimals: number): number { return Number(value) / 10 ** decimals; }
function sameBigints(left: readonly bigint[], right: readonly bigint[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function samePoolState(left: readonly [readonly Address[], readonly bigint[], bigint], right: readonly [readonly Address[], readonly bigint[], bigint]): boolean {
  return left[2] === right[2] && left[0].length === right[0].length && left[0].every((token, index) => token.toLowerCase() === right[0][index]?.toLowerCase()) && sameBigints(left[1], right[1]);
}

function historicalIlPct(tokens: readonly Address[], weights: readonly number[], signals: Map<string, { return30d?: number | null; return90d?: number | null }>, horizon: "return30d" | "return90d"): number | undefined {
  const relatives = tokens.map((token) => {
    const change = signals.get(token.toLowerCase())?.[horizon];
    return typeof change === "number" && Number.isFinite(change) && change > -1 ? 1 + change : undefined;
  });
  if (relatives.some((relative) => relative === undefined)) return undefined;
  return weightedImpermanentLoss([...weights], relatives as number[]) * 100;
}
