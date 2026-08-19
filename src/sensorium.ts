import type { Address } from "viem";
import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { VenueRegistry } from "./venues.js";
import { priceV3FromSqrt, priceV2FromReserves } from "./block-indexer.js";

/**
 * The unified sensorium. One reader per STANDARD (uni-v3, uni-v2, …) reads every
 * venue of that type from the registry and emits a NORMALIZED pool. Adding a DEX
 * of a known standard needs no new code — only a registry row. This replaces the
 * per-protocol scanners with a single organ that produces one world-model.
 */
export type NormPool = { venueId: string; venueName: string; type: string; pool: string; pair: string; sym0: string; sym1: string; token0: string; token1: string; feeBps: number; price1per0: number; tvlUsd: number; reserve0: number; reserve1: number };
export type WorldModel = { observedAt: string; poolCount: number; pools: NormPool[]; arbHints: Array<{ pair: string; cheapVenue: string; dearVenue: string; spreadPct: number }> };

type Tok = { address: Address; symbol: string; decimals: number };

const SRC = "sensorium";
const KEY = "world";
const Q96 = 2n ** 96n;

export class Sensorium {
  private timer?: NodeJS.Timeout;
  private current?: WorldModel;

  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly venues: VenueRegistry, private readonly logger: Logger) {}

  get latest(): WorldModel | undefined { return this.current; }
  async hydrate(): Promise<void> { this.current = await this.db.latestMarketSnapshot<WorldModel>(SRC, KEY); }

  private tokens(): Tok[] {
    return [
      { address: this.config.WBERA_ADDRESS as Address, symbol: this.config.WRAPPED_SYMBOL, decimals: 18 },
      { address: this.config.USDC_E_ADDRESS as Address, symbol: "USDC", decimals: 6 },
      { address: this.config.HONEY_ADDRESS as Address, symbol: "USDT0", decimals: this.config.HONEY_DECIMALS }
    ];
  }
  /** Core-token USD from the DB (indexer/display prices); stables anchored to 1. No RPC. */
  private async prices(toks: Tok[]): Promise<Record<string, number>> {
    const map = await this.db.getTokenPrices(this.config.CHAIN_ID, toks.map((t) => t.address.toLowerCase())).catch(() => new Map());
    const out: Record<string, number> = {};
    for (const t of toks) { const a = t.address.toLowerCase(); out[a] = /^USD|USD$/.test(t.symbol) ? 1 : (map.get(a)?.priceUsd ?? 0); }
    return out;
  }

  /** DB-READ world-model (db-first convergence): the SAME normalized core-pair view, now assembled from the
   * indexer's DB (entities topology + pool_state reserves/sqrtPrice + token_prices) instead of RPC slot0/
   * balanceOf. A core pool with no pool_state yet (never swapped since the indexer started) is simply absent
   * — for the always-hot core pairs that's rare, and it self-heals on the pool's next swap. */
  async scan(): Promise<WorldModel> {
    await this.venues.hydrate();
    const toks = this.tokens();
    const core = new Map(toks.map((t) => [t.address.toLowerCase(), t]));
    const px = await this.prices(toks);
    // Core-pair pools (BOTH sides core) from the registry, deduped.
    const seen = new Set<string>();
    const cand: Array<{ address: string; token0: string; token1: string; meta: Record<string, unknown> }> = [];
    for (const a of core.keys()) for (const p of await this.db.poolsForToken(this.config.CHAIN_ID, a).catch(() => [])) {
      const m = (p.meta ?? {}) as Record<string, unknown>;
      const t0 = (m.token0 as string | undefined)?.toLowerCase(), t1 = (m.token1 as string | undefined)?.toLowerCase();
      if (!t0 || !t1 || !core.has(t0) || !core.has(t1) || seen.has(p.address)) continue;
      seen.add(p.address); cand.push({ address: p.address, token0: t0, token1: t1, meta: m });
    }
    const states = await this.db.poolStateBatch(this.config.CHAIN_ID, cand.map((c) => c.address)).catch(() => new Map());
    const pools: NormPool[] = [];
    for (const c of cand) {
      const st = states.get(c.address.toLowerCase()); if (!st) continue; // no state → blind to this pool (measured)
      const np = this.normFromState(c.address, c.meta, st, core.get(c.token0)!, core.get(c.token1)!, px);
      if (np) pools.push(np);
    }
    pools.sort((a, b) => b.tvlUsd - a.tvlUsd);
    const world: WorldModel = { observedAt: new Date().toISOString(), poolCount: pools.length, pools, arbHints: arbHints(pools) };
    await this.db.saveMarketSnapshot(SRC, KEY, world);
    this.current = world;
    this.logger.info({ pools: pools.length, arb: world.arbHints.length, topTvl: pools[0]?.tvlUsd?.toFixed(0), source: "db" }, "sensorium world-model saved (DB-read)");
    return world;
  }

  /** Normalized pool from DB state. Price is exact (pool_state); TVL is exact for V2 (reserves) and a
   * virtual-reserve proxy for V3 (liquidity/sqrtPrice) — enough for the depth filter + display. */
  private normFromState(pool: string, meta: Record<string, unknown>, st: { archetype: string; r0: bigint | null; r1: bigint | null; sqrtPrice: bigint | null; liquidity: bigint | null }, t0: Tok, t1: Tok, px: Record<string, number>): NormPool | null {
    let price1per0 = 0, reserve0 = 0, reserve1 = 0, feeBps: number;
    if (st.archetype === "v3" && st.sqrtPrice != null && st.sqrtPrice > 0n) {
      price1per0 = priceV3FromSqrt(st.sqrtPrice, t0.decimals, t1.decimals) ?? 0;
      if (st.liquidity != null && st.liquidity > 0n) { // virtual reserves
        reserve0 = Number((st.liquidity * Q96) / st.sqrtPrice) / 10 ** t0.decimals;
        reserve1 = Number((st.liquidity * st.sqrtPrice) / Q96) / 10 ** t1.decimals;
      }
      feeBps = meta.fee != null ? Number(meta.fee) : 3000; // preserve the existing (tier-valued) convention
    } else if (st.r0 != null && st.r1 != null) {
      reserve0 = Number(st.r0) / 10 ** t0.decimals; reserve1 = Number(st.r1) / 10 ** t1.decimals;
      price1per0 = priceV2FromReserves(st.r0, st.r1, t0.decimals, t1.decimals) ?? 0;
      feeBps = 30;
    } else return null;
    const factory = (meta.factory as string | undefined)?.toLowerCase();
    const venue = factory ? this.venues.all.find((v) => v.address.toLowerCase() === factory) : undefined;
    return {
      venueId: venue?.id ?? factory ?? "unknown", venueName: venue?.name ?? (factory ? factory.slice(0, 10) : "unknown"),
      type: venue?.type ?? st.archetype, pool, pair: `${t0.symbol}/${t1.symbol}`, sym0: t0.symbol, sym1: t1.symbol,
      token0: t0.address, token1: t1.address, feeBps, price1per0,
      tvlUsd: reserve0 * (px[t0.address.toLowerCase()] ?? 0) + reserve1 * (px[t1.address.toLowerCase()] ?? 0), reserve0, reserve1
    };
  }

  start(intervalMs = 60_000): void {
    this.timer = setTimeout(() => {
      void this.scan().catch((error) => this.logger.error({ err: error }, "initial sensorium scan failed"));
      this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "sensorium scan failed")), intervalMs);
    }, 6_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}

/** Cross-venue price spread on the same pair = the arbitrage the parasite feeds on. */
function arbHints(pools: NormPool[]): WorldModel["arbHints"] {
  const byPair = new Map<string, NormPool[]>();
  for (const p of pools) { if (p.price1per0 > 0 && p.tvlUsd > 500) (byPair.get(p.pair) ?? byPair.set(p.pair, []).get(p.pair)!).push(p); }
  const hints: WorldModel["arbHints"] = [];
  for (const [pair, ps] of byPair) {
    if (ps.length < 2) continue;
    const sorted = [...ps].sort((a, b) => a.price1per0 - b.price1per0);
    const lo = sorted[0]; const hi = sorted[sorted.length - 1];
    const spreadPct = lo.price1per0 > 0 ? (hi.price1per0 - lo.price1per0) / lo.price1per0 * 100 : 0;
    if (spreadPct > 0.3) hints.push({ pair, cheapVenue: `${lo.venueName} ${lo.feeBps}bps`, dearVenue: `${hi.venueName} ${hi.feeBps}bps`, spreadPct: Number(spreadPct.toFixed(3)) });
  }
  return hints.sort((a, b) => b.spreadPct - a.spreadPct);
}

/** Prompt-safe world-model for Scarlet's briefing. */
export function worldContext(world: WorldModel | undefined): unknown {
  if (!world) return { status: "not-scanned" };
  return {
    note: "Your unified view of the DEX venues (one normalized shape). Pools are sorted by depth; arbHints are same-pair price spreads across venues/fee-tiers you can capture.",
    observedAt: world.observedAt,
    arbHints: world.arbHints.slice(0, 6),
    pools: world.pools.slice(0, 14).map((p) => ({ venue: p.venueName, pair: p.pair, feeBps: p.feeBps, price: round(p.price1per0), tvlUsd: Math.round(p.tvlUsd), pool: p.pool }))
  };
}
function round(v: number): number { return Number.isFinite(v) ? Number(v.toPrecision(6)) : 0; }
