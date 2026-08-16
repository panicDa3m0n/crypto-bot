import { parseAbi, type Address } from "viem";
import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { Venue, VenueRegistry } from "./venues.js";

/**
 * The unified sensorium. One reader per STANDARD (uni-v3, uni-v2, …) reads every
 * venue of that type from the registry and emits a NORMALIZED pool. Adding a DEX
 * of a known standard needs no new code — only a registry row. This replaces the
 * per-protocol scanners with a single organ that produces one world-model.
 */
export type NormPool = { venueId: string; venueName: string; type: string; pool: string; pair: string; sym0: string; sym1: string; token0: string; token1: string; feeBps: number; price1per0: number; tvlUsd: number; reserve0: number; reserve1: number };
export type WorldModel = { observedAt: string; poolCount: number; pools: NormPool[]; arbHints: Array<{ pair: string; cheapVenue: string; dearVenue: string; spreadPct: number }> };

type Tok = { address: Address; symbol: string; decimals: number };

const v3Factory = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const v3Pool = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool unlocked)",
  "function token0() view returns (address)",
  "function liquidity() view returns (uint128)"
]);
const v2Factory = parseAbi(["function getPair(address,address) view returns (address)"]);
const v2Pool = parseAbi(["function getReserves() view returns (uint112 r0, uint112 r1, uint32 ts)", "function token0() view returns (address)"]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const FEE_TIERS = [100, 500, 2500, 3000, 10000]; // 2500 = PancakeSwap V3 tier
const ZERO = "0x0000000000000000000000000000000000000000";
const SRC = "sensorium";
const KEY = "world";

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
  private async prices(toks: Tok[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of toks) out[t.address.toLowerCase()] = /^USD|USD$/.test(t.symbol) ? 1 : await this.chain.tokenPrice(t.address).catch(() => 0);
    return out;
  }

  async scan(): Promise<WorldModel> {
    await this.venues.hydrate();
    const toks = this.tokens();
    const px = await this.prices(toks);
    const pools: NormPool[] = [];
    for (const venue of this.venues.all) {
      if (venue.type === "uni-v3") pools.push(...await this.readV3(venue, toks, px).catch(() => []));
      else if (venue.type === "uni-v2") pools.push(...await this.readV2(venue, toks, px).catch(() => []));
      // balancer / morpho / dolomite readers plug in here with the same shape.
    }
    pools.sort((a, b) => b.tvlUsd - a.tvlUsd);
    const world: WorldModel = { observedAt: new Date().toISOString(), poolCount: pools.length, pools, arbHints: arbHints(pools) };
    await this.db.saveMarketSnapshot(SRC, KEY, world);
    this.current = world;
    this.logger.info({ pools: pools.length, arb: world.arbHints.length, topTvl: pools[0]?.tvlUsd?.toFixed(0) }, "sensorium world-model saved");
    return world;
  }

  private async readV3(venue: Venue, toks: Tok[], px: Record<string, number>): Promise<NormPool[]> {
    const factory = venue.address as Address;
    const out: NormPool[] = [];
    for (let i = 0; i < toks.length; i += 1) for (let j = i + 1; j < toks.length; j += 1) for (const fee of FEE_TIERS) {
      const pool = await this.chain.primary.readContract({ address: factory, abi: v3Factory, functionName: "getPool", args: [toks[i].address, toks[j].address, fee] }).catch(() => ZERO) as Address;
      if (!pool || pool.toLowerCase() === ZERO) continue;
      try {
        const [slot0, token0, bal0, bal1] = await Promise.all([
          this.chain.primary.readContract({ address: pool, abi: v3Pool, functionName: "slot0" }),
          this.chain.primary.readContract({ address: pool, abi: v3Pool, functionName: "token0" }) as Promise<Address>,
          this.chain.primary.readContract({ address: toks[i].address, abi: erc20, functionName: "balanceOf", args: [pool] }),
          this.chain.primary.readContract({ address: toks[j].address, abi: erc20, functionName: "balanceOf", args: [pool] })
        ]);
        const t0 = pick(token0, toks[i], toks[j]); const t1 = t0 === toks[i] ? toks[j] : toks[i];
        if (!t0) continue;
        const bt0 = t0 === toks[i] ? bal0 : bal1; const bt1 = t0 === toks[i] ? bal1 : bal0;
        const sqrt = Number(slot0[0]) / 2 ** 96;
        const price = sqrt * sqrt * 10 ** (t0.decimals - t1.decimals);
        out.push(norm(venue, pool, fee, t0, t1, price, Number(bt0) / 10 ** t0.decimals, Number(bt1) / 10 ** t1.decimals, px));
      } catch { /* skip pool */ }
    }
    return out;
  }

  private async readV2(venue: Venue, toks: Tok[], px: Record<string, number>): Promise<NormPool[]> {
    const factory = venue.address as Address;
    const out: NormPool[] = [];
    for (let i = 0; i < toks.length; i += 1) for (let j = i + 1; j < toks.length; j += 1) {
      const pool = await this.chain.primary.readContract({ address: factory, abi: v2Factory, functionName: "getPair", args: [toks[i].address, toks[j].address] }).catch(() => ZERO) as Address;
      if (!pool || pool.toLowerCase() === ZERO) continue;
      try {
        const [reserves, token0] = await Promise.all([
          this.chain.primary.readContract({ address: pool, abi: v2Pool, functionName: "getReserves" }),
          this.chain.primary.readContract({ address: pool, abi: v2Pool, functionName: "token0" }) as Promise<Address>
        ]);
        const t0 = pick(token0, toks[i], toks[j]); const t1 = t0 === toks[i] ? toks[j] : toks[i];
        if (!t0) continue;
        const r0 = Number(reserves[0]) / 10 ** t0.decimals; const r1 = Number(reserves[1]) / 10 ** t1.decimals;
        const price = r0 > 0 ? r1 / r0 : 0;
        out.push(norm(venue, pool, 30, t0, t1, price, r0, r1, px));
      } catch { /* skip */ }
    }
    return out;
  }

  start(intervalMs = 60_000): void {
    this.timer = setTimeout(() => {
      void this.scan().catch((error) => this.logger.error({ err: error }, "initial sensorium scan failed"));
      this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "sensorium scan failed")), intervalMs);
    }, 6_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}

function pick(addr: Address, a: Tok, b: Tok): Tok | undefined { const x = addr.toLowerCase(); return a.address.toLowerCase() === x ? a : b.address.toLowerCase() === x ? b : undefined; }
function norm(venue: Venue, pool: Address, feeBps: number, t0: Tok, t1: Tok, price1per0: number, reserve0: number, reserve1: number, px: Record<string, number>): NormPool {
  const tvlUsd = reserve0 * (px[t0.address.toLowerCase()] ?? 0) + reserve1 * (px[t1.address.toLowerCase()] ?? 0);
  return { venueId: venue.id, venueName: venue.name, type: venue.type, pool, pair: `${t0.symbol}/${t1.symbol}`, sym0: t0.symbol, sym1: t1.symbol, token0: t0.address, token1: t1.address, feeBps, price1per0, tvlUsd, reserve0, reserve1 };
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
