import type { Config } from "./config.js";

/**
 * One parameterized data faculty instead of a tool per source. Scarlet calls
 * market_data(kind, params) and the system routes to the best free source:
 *  - yields    → DefiLlama (every pool with TVL/APY, for yield/lending discovery)
 *  - new_pools → GeckoTerminal (freshly created pools — new-token discovery)
 *  - trending  → GeckoTerminal (pools with momentum)
 *  - token     → GeckoTerminal (a token's price, volume, liquidity + its top pools)
 *  - ohlcv     → GeckoTerminal (price candles for a pool — charts/momentum)
 */
export type MarketKind = "yields" | "new_pools" | "trending" | "token" | "ohlcv";

export class MarketData {
  // Short TTL cache over GeckoTerminal responses: the agent re-inspects the same tokens across a cycle,
  // and background sensors share the same free-tier budget — caching by path avoids refetching what we
  // just fetched and keeps us under the rate limit (the 429s that blinded inspect_token intermittently).
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private static readonly CACHE_TTL_MS = 45_000;
  // Pace GeckoTerminal calls: the free public API is ~30/min and this client's bursts (the agent
  // inspecting several tokens at once) would 429. Serialize them with a min gap so they queue and
  // succeed instead of failing. Cache hits bypass the pacer.
  private static readonly MIN_GAP_MS = 2_200;
  private gate: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(private readonly config: Config) {}

  async query(kind: MarketKind, params: { token?: string; pool?: string; timeframe?: string; limit?: number }): Promise<unknown> {
    switch (kind) {
      case "yields": return this.yields(params.limit ?? 15);
      case "new_pools": return this.gtPools("new_pools", params.limit ?? 12);
      case "trending": return this.gtPools("trending_pools", params.limit ?? 12);
      case "token": return params.token ? this.tokenInfo(params.token) : { error: "token address required" };
      case "ohlcv": return params.pool ? this.ohlcv(params.pool, params.timeframe ?? "hour") : { error: "pool address required" };
      default: return { error: `unknown market_data kind '${kind}'` };
    }
  }

  private async gt<T>(path: string): Promise<T> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < MarketData.CACHE_TTL_MS) return hit.value as T;
    // Serialize through the gate with a min gap (a cache re-check inside, in case a concurrent call for
    // the same path already fetched it while we waited in the queue).
    const result = this.gate.then(async () => {
      const cached = this.cache.get(path);
      if (cached && Date.now() - cached.at < MarketData.CACHE_TTL_MS) return cached.value as T;
      const wait = MarketData.MIN_GAP_MS - (Date.now() - this.lastAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
      const res = await fetch(`${this.config.GECKOTERMINAL_API_URL}/networks/${this.config.GT_NETWORK}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
      const json = (await res.json()) as T;
      this.cache.set(path, { at: Date.now(), value: json });
      if (this.cache.size > 300) { const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100); for (const [k] of oldest) this.cache.delete(k); }
      return json;
    });
    this.gate = result.then(() => undefined, () => undefined);
    return result;
  }

  private async yields(limit: number): Promise<unknown> {
    const res = await fetch(`${this.config.YIELDS_API_URL}/pools`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`yields API ${res.status}`);
    const json = await res.json() as { data?: Array<Record<string, unknown>> };
    const pools = (json.data ?? []).filter((p) => p.chain === this.config.LLAMA_CHAIN);
    const fmt = (p: Record<string, unknown>) => ({ project: p.project, symbol: p.symbol, tvlUsd: Math.round(Number(p.tvlUsd) || 0), apy: round2(Number(p.apy) || 0), apyBase: round2(Number(p.apyBase) || 0), apyReward: round2(Number(p.apyReward) || 0), rewardTokens: p.rewardTokens, stablecoin: p.stablecoin, ilRisk: p.ilRisk, pool: p.pool });
    // Incentivized pools (apyReward>0) = points/reward farming — a real small-capital edge
    // on a growth chain that is NOT a latency race. Surfaced separately from raw TVL.
    const incentivized = pools.filter((p) => (Number(p.apyReward) || 0) > 0).sort((a, b) => (Number(b.apyReward) || 0) - (Number(a.apyReward) || 0));
    const byTvl = [...pools].sort((a, b) => (Number(b.tvlUsd) || 0) - (Number(a.tvlUsd) || 0));
    // Idle-capital storage: deepest low-risk STABLE pools (stop-the-bleed vs volatile native token).
    const stableStorage = byTvl.filter((p) => p.stablecoin && (p.ilRisk === "no" || p.ilRisk == null) && (Number(p.tvlUsd) || 0) > 500_000);
    return {
      note: "Yield surface. incentivized = reward/points farming (real edge on a growth chain, not a latency race). stableStorage = park idle capital to stop bleeding to native-token volatility (not the goal, just a baseline). Verify safety (project, TVL, ilRisk) before depositing.",
      count: pools.length,
      incentivized: incentivized.slice(0, limit).map(fmt),
      stableStorage: stableStorage.slice(0, 6).map(fmt),
      topByTvl: byTvl.slice(0, limit).map(fmt)
    };
  }

  private async gtPools(kind: "new_pools" | "trending_pools", limit: number): Promise<unknown> {
    const json = await this.gt<{ data?: Array<{ attributes?: Record<string, unknown>; relationships?: unknown }> }>(`/${kind}?page=1`);
    return {
      note: kind === "new_pools" ? "Freshly created pools — new-token discovery. ALWAYS check_token before buying (honeypot gate); most new tokens are traps." : "Pools with momentum right now.",
      pools: (json.data ?? []).slice(0, limit).map((p) => {
        const a = p.attributes ?? {};
        const vol = a.volume_usd as Record<string, unknown> | undefined;
        const chg = a.price_change_percentage as Record<string, unknown> | undefined;
        return { name: a.name, address: a.address, liquidityUsd: round2(Number(a.reserve_in_usd) || 0), volume24hUsd: round2(Number(vol?.h24) || 0), priceChange24h: chg?.h24, createdAt: a.pool_created_at, baseToken: (a.base_token_price_usd != null ? `$${a.base_token_price_usd}` : undefined) };
      })
    };
  }

  private async tokenInfo(token: string): Promise<unknown> {
    // Snapshot + its top pools (the pool addresses feed the ohlcv chart, which is per-pool).
    const [info, pools] = await Promise.all([
      this.gt<{ data?: { attributes?: Record<string, unknown> } }>(`/tokens/${token}`),
      this.gt<{ data?: Array<{ attributes?: Record<string, unknown> }> }>(`/tokens/${token}/pools?page=1`).catch(() => ({ data: [] as Array<{ attributes?: Record<string, unknown> }> }))
    ]);
    const a = info.data?.attributes ?? {};
    const topPools = (pools.data ?? []).slice(0, 3).map((p) => {
      const pa = p.attributes ?? {};
      return { pool: pa.address, name: pa.name, liquidityUsd: round2(Number(pa.reserve_in_usd) || 0), volume24hUsd: round2(Number((pa.volume_usd as Record<string, unknown> | undefined)?.h24) || 0), priceChange24h: (pa.price_change_percentage as Record<string, unknown> | undefined)?.h24 };
    });
    return {
      note: "Token market snapshot (GeckoTerminal). Use a pool from topPools for token_chart. Verify (honeypot) before buying.",
      symbol: a.symbol, name: a.name, address: a.address, priceUsd: a.price_usd, fdvUsd: a.fdv_usd,
      volume24hUsd: (a.volume_usd as Record<string, unknown> | undefined)?.h24, totalReserveUsd: a.total_reserve_in_usd, topPools
    };
  }

  private async ohlcv(pool: string, timeframe: string): Promise<unknown> {
    const tf = ["day", "hour", "minute"].includes(timeframe) ? timeframe : "hour";
    const json = await this.gt<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(`/pools/${pool}/ohlcv/${tf}?limit=48`);
    const list = json.data?.attributes?.ohlcv_list ?? [];
    return {
      note: `OHLCV candles (${tf}) — [timestamp, open, high, low, close, volume], newest first.`,
      candles: list.slice(0, 48)
    };
  }
}

function round2(v: number): number { return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }
