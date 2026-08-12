import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { NetworkDiscovery } from "./discovery.js";

type ApiHistory = { address: string; prices: Array<{ price: number; timestamp: string; updatedAt: number }> };

export type TokenSignal = {
  address: string; sampleCount: number; latestPriceUsd: number; return24h: number | null; return7d: number | null; return30d: number | null; return90d: number | null;
  realizedVolatility: number | null; rangeMinUsd: number; rangeMaxUsd: number;
  dailySeries: Array<{ date: string; return: number; realizedVolatility: number | null }>;
  latestAt: string;
};

export type DailyReturnCorrelation = { leftAddress: string; rightAddress: string; overlappingDays: number; correlation: number };
export type MarketHistorySnapshot = { observedAt: string; source: "official-bera-api"; signals: TokenSignal[]; correlations: DailyReturnCorrelation[]; excluded: string[] };

/**
 * Official Bera API time series are discovery evidence only. The executor must
 * still use an exact live route and a mainnet eth_call; stale chart data cannot
 * authorize a trade.
 */
export class MarketHistory {
  private timer?: NodeJS.Timeout;
  private current?: MarketHistorySnapshot;
  constructor(private readonly config: Config, private readonly db: Database, private readonly discovery: NetworkDiscovery, private readonly logger: Logger) {}
  get latest() { return this.current; }
  async hydrate(): Promise<void> { this.current = await this.db.latestMarketSnapshot<MarketHistorySnapshot>("market-history", "official-token-history"); }

  async scan(): Promise<MarketHistorySnapshot> {
    const discovery = this.discovery.latest ?? await this.db.latestMarketSnapshot<Awaited<ReturnType<NetworkDiscovery["scan"]>>>("network-discovery", "bex-universe");
    const addresses = [...new Set((discovery?.tokenUniverse ?? []).map((token) => token.address.toLowerCase()))].slice(0, 24);
    if (!addresses.length) throw new Error("No discovered BEX token addresses available for historical-price scan");
    const query = `query History($addresses: [String!]!) { tokenGetHistoricalPrices(addresses: $addresses, chain: BERACHAIN, range: NINETY_DAY) { address prices { price timestamp updatedAt } } }`;
    const response = await fetch(this.config.BERA_API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables: { addresses } }) });
    if (!response.ok) throw new Error(`Bera API historical-price request failed: ${response.status}`);
    const body = await response.json() as { data?: { tokenGetHistoricalPrices?: ApiHistory[] }; errors?: Array<{ message: string }> };
    if (body.errors?.length || !body.data?.tokenGetHistoricalPrices) throw new Error(`Bera API historical-price error: ${body.errors?.map((item) => item.message).join("; ") ?? "missing history"}`);
    const signals = body.data.tokenGetHistoricalPrices.map((history) => deriveTokenSignal(history)).filter((item): item is TokenSignal => Boolean(item));
    const covered = new Set(signals.map((item) => item.address.toLowerCase()));
    const snapshot: MarketHistorySnapshot = { observedAt: new Date().toISOString(), source: "official-bera-api", signals, correlations: dailyReturnCorrelations(signals), excluded: addresses.filter((address) => !covered.has(address)) };
    await this.db.saveMarketSnapshot("market-history", "official-token-history", snapshot);
    this.current = snapshot;
    this.logger.info({ tokens: addresses.length, signals: signals.length, excluded: snapshot.excluded.length }, "official token history saved");
    return snapshot;
  }

  start(intervalMs = 5 * 60_000): void { void this.scan().catch((error) => this.logger.error({ err: error }, "initial token-history scan failed")); this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "token-history scan failed")), intervalMs); }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}

export function deriveTokenSignal(history: ApiHistory, options: { nowMs?: number } = {}): TokenSignal | undefined {
  // An indexer may expose its next bucket before wall-clock time reaches it.
  // Future candles are not evidence and must never influence a live thesis.
  const latestAllowedMs = (options.nowMs ?? Date.now()) + 5 * 60_000;
  const points = history.prices.filter((point) => Number.isFinite(point.price) && point.price > 0 && Number.isFinite(timestampMs(point.timestamp)) && timestampMs(point.timestamp) <= latestAllowedMs).sort((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp));
  if (points.length < 2) return undefined;
  const latest = points.at(-1)!;
  const now = timestampMs(latest.timestamp);
  const point24h = pointAtOrNear(points, now - 24 * 60 * 60_000);
  const point7d = pointAtOrNear(points, now - 7 * 24 * 60 * 60_000);
  const point30d = pointAtOrNear(points, now - 30 * 24 * 60 * 60_000);
  const point90d = pointAtOrNear(points, now - 90 * 24 * 60 * 60_000);
  const returns = points.slice(1).map((point, index) => Math.log(point.price / points[index].price)).filter(Number.isFinite);
  const mean = returns.reduce((sum, value) => sum + value, 0) / Math.max(returns.length, 1);
  const realizedVolatility = returns.length > 1 ? Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)) : null;
  return {
    address: history.address, sampleCount: points.length, latestPriceUsd: latest.price,
    return24h: relativeReturn(latest.price, point24h?.price), return7d: relativeReturn(latest.price, point7d?.price),
    return30d: relativeReturn(latest.price, point30d?.price), return90d: relativeReturn(latest.price, point90d?.price),
    realizedVolatility, rangeMinUsd: Math.min(...points.map((point) => point.price)), rangeMaxUsd: Math.max(...points.map((point) => point.price)),
    dailySeries: dailyObservations(points).slice(-14), latestAt: new Date(now).toISOString()
  };
}

/**
 * Pairwise Pearson correlations over date-aligned official daily return
 * observations.  This is a research signal, never a price or trade quote.
 */
export function dailyReturnCorrelations(signals: readonly TokenSignal[]): DailyReturnCorrelation[] {
  const output: DailyReturnCorrelation[] = [];
  for (let left = 0; left < signals.length; left += 1) for (let right = left + 1; right < signals.length; right += 1) {
    const rightByDate = new Map(signals[right].dailySeries.map((item) => [item.date, item.return]));
    const pairs = signals[left].dailySeries.flatMap((item) => {
      const other = rightByDate.get(item.date);
      return typeof other === "number" && Number.isFinite(item.return) && Number.isFinite(other) ? [[item.return, other] as const] : [];
    });
    const correlation = pearson(pairs);
    if (correlation !== undefined) output.push({ leftAddress: signals[left].address, rightAddress: signals[right].address, overlappingDays: pairs.length, correlation });
  }
  return output;
}

/**
 * Official hourly buckets can start just inside a requested range. Accept at
 * most two hours on the early-history edge; anything less complete remains null.
 */
function pointAtOrNear(points: ApiHistory["prices"], cutoff: number, toleranceMs = 2 * 60 * 60_000): ApiHistory["prices"][number] | undefined {
  const before = [...points].reverse().find((point) => timestampMs(point.timestamp) <= cutoff);
  if (before) return before;
  const earliest = points[0];
  return earliest && timestampMs(earliest.timestamp) <= cutoff + toleranceMs ? earliest : undefined;
}

function relativeReturn(latest: number, earlier?: number): number | null {
  return earlier && earlier > 0 ? latest / earlier - 1 : null;
}

function dailyObservations(points: ApiHistory["prices"]): TokenSignal["dailySeries"] {
  const days = new Map<string, ApiHistory["prices"]>();
  for (const point of points) {
    const key = new Date(timestampMs(point.timestamp)).toISOString().slice(0, 10);
    const entries = days.get(key) ?? [];
    entries.push(point);
    days.set(key, entries);
  }
  return [...days.entries()].map(([date, entries]) => {
    const ordered = entries.sort((left, right) => timestampMs(left.timestamp) - timestampMs(right.timestamp));
    const dayReturns = ordered.slice(1).map((point, index) => Math.log(point.price / ordered[index].price)).filter(Number.isFinite);
    const mean = dayReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, dayReturns.length);
    const volatility = dayReturns.length > 1 ? Math.sqrt(dayReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dayReturns.length - 1)) : null;
    return { date, return: relativeReturn(ordered.at(-1)!.price, ordered[0]?.price) ?? 0, realizedVolatility: volatility };
  });
}

function timestampMs(value: string): number {
  return /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value);
}

function pearson(pairs: ReadonlyArray<readonly [number, number]>): number | undefined {
  if (pairs.length < 3) return undefined;
  const leftMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const rightMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let covariance = 0; let leftVariance = 0; let rightVariance = 0;
  for (const [left, right] of pairs) {
    const leftDelta = left - leftMean; const rightDelta = right - rightMean;
    covariance += leftDelta * rightDelta; leftVariance += leftDelta ** 2; rightVariance += rightDelta ** 2;
  }
  if (leftVariance <= 0 || rightVariance <= 0) return undefined;
  return covariance / Math.sqrt(leftVariance * rightVariance);
}
