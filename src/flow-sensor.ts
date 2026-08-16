import { parseAbi, parseAbiItem, type Address } from "viem";
import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";

/**
 * Flow-intelligence. True pending-mempool MEV is impossible on Monad's public RPC (it
 * gossips no public mempool — verified), but blocks land ~3×/sec and we read every one
 * the instant it's confirmed. So instead of front-running we do the CLEAN, feasible thing:
 * watch what everyone else is ACTUALLY doing, one block late, and let Scarlet co-trade or
 * backrun the flow. This sensor maps, in a rolling window:
 *   - the HOTTEST pools (where volume/attention is concentrating right now → momentum)
 *   - the most ACTIVE trader wallets (candidate smart-money to study and follow)
 *   - the BIGGEST single swaps (whales moving → backrun/co-trade candidates)
 * It writes a digest each cycle; Scarlet's briefing turns it into theses. This is the
 * "study others' transactions / read the charts" capability, within what's actually possible.
 */
const SWAP_EVENT = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
const POOL_META = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)"
]);
const SYM = parseAbi(["function symbol() view returns (string)"]);
const WINDOW = 90n; // Monad eth_getLogs cap is 100 blocks

type PoolRow = { name: string; pool: string; dex: string; baseId: string; baseSym: string; priceUsd: number; vol: number; liq: number; chg: number };

/** Flatten a GeckoTerminal /pools page into typed rows (base token identity + venue + price). */
function parsePools(json: { data?: Array<{ attributes?: Record<string, unknown>; relationships?: { base_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } } }> } | undefined): PoolRow[] {
  return (json?.data ?? []).map((p) => {
    const a = p.attributes ?? {};
    const vol = a.volume_usd as { h24?: string } | undefined; const chg = a.price_change_percentage as { h24?: string } | undefined;
    const name = String(a.name ?? "?");
    return { name, pool: String(a.address ?? ""), dex: p.relationships?.dex?.data?.id ?? "?", baseId: (p.relationships?.base_token?.data?.id ?? "").split("_")[1] ?? "", baseSym: name.split("/")[0].trim().toUpperCase(), priceUsd: Number(a.base_token_price_usd) || 0, vol: Math.round(Number(vol?.h24) || 0), liq: Math.round(Number(a.reserve_in_usd) || 0), chg: Number(chg?.h24) || 0 };
  });
}

/** Cross-venue arbitrage surface: the SAME base token priced differently across venues =
 * buy-cheap/sell-dear. Only real pools (base token identified, both legs $10k+/24h volume so
 * the quote isn't stale) are compared; spreads are the raw signal — confirm on-chain + fees. */
function crossVenueSpreads(rows: PoolRow[]): Array<{ token: string; spreadPct: number; cheap: { dex: string; pool: string; priceUsd: number }; dear: { dex: string; pool: string; priceUsd: number }; venues: number }> {
  const byToken = new Map<string, PoolRow[]>();
  for (const r of rows) {
    if (!r.baseId || r.priceUsd <= 0 || r.vol < 10_000) continue; // skip unidentified/stale/thin
    const list = byToken.get(r.baseId) ?? []; list.push(r); byToken.set(r.baseId, list);
  }
  const out: Array<{ token: string; spreadPct: number; cheap: { dex: string; pool: string; priceUsd: number }; dear: { dex: string; pool: string; priceUsd: number }; venues: number }> = [];
  for (const list of byToken.values()) {
    const venues = new Set(list.map((r) => r.dex));
    if (venues.size < 2) continue; // need at least two venues to arb
    const cheap = list.reduce((lo, r) => (r.priceUsd < lo.priceUsd ? r : lo));
    const dear = list.reduce((hi, r) => (r.priceUsd > hi.priceUsd ? r : hi));
    const spreadPct = cheap.priceUsd > 0 ? ((dear.priceUsd - cheap.priceUsd) / cheap.priceUsd) * 100 : 0;
    if (spreadPct < 0.3) continue; // below fee+gas noise — not actionable
    out.push({ token: dear.baseSym, spreadPct: Number(spreadPct.toFixed(3)), cheap: { dex: cheap.dex, pool: cheap.pool, priceUsd: cheap.priceUsd }, dear: { dex: dear.dex, pool: dear.pool, priceUsd: dear.priceUsd }, venues: venues.size });
  }
  return out.sort((a, b) => b.spreadPct - a.spreadPct).slice(0, 10);
}

type Swap = { pool: string; wallet: string; block: bigint; absAmount0: bigint; absAmount1: bigint };
type PoolStat = { swaps: number; wallets: Set<string>; lastBlock: bigint; maxAbs0: bigint; maxAbs1: bigint };
type WalletStat = { swaps: number; pools: Set<string>; lastBlock: bigint };

export class FlowSensor {
  private timer?: NodeJS.Timeout;
  private cursor?: bigint;
  private running = false;
  private scans = 0;
  private venueFlow: { topByVolume: unknown[]; trending: unknown[]; venues: unknown[]; crossVenueArb: unknown[] } = { topByVolume: [], trending: [], venues: [], crossVenueArb: [] };
  private readonly recent: Swap[] = [];               // rolling raw swaps (trimmed by block age)
  private readonly poolMeta = new Map<string, { label: string; token0: string; token1: string }>();
  private readonly retainBlocks = 900n;               // ~5 min of flow at ~3 blocks/s

  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly logger: Logger) {}

  /** Venue-AGNOSTIC flow: GeckoTerminal aggregates every DEX/CLOB (the on-chain V3 log
   * watch below only sees Uniswap-V3-shaped swaps, which on Monad are the thin tail — the
   * real $/volume sits on orderbook venues the raw log-scan can't read). This is where the
   * money actually moves; refreshed every few scans (free-tier rate limit). */
  private async pullGeckoVolume(): Promise<void> {
    try {
      const netBase = `${this.config.GECKOTERMINAL_API_URL}/networks/${this.config.GT_NETWORK}`;
      const [vol1Res, vol2Res, trendRes, dexRes] = await Promise.all([
        fetch(`${netBase}/pools?sort=h24_volume_usd_desc&page=1`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) }),
        fetch(`${netBase}/pools?sort=h24_volume_usd_desc&page=2`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) }).catch(() => undefined),
        fetch(`${netBase}/pools/trending?page=1`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) }).catch(() => undefined),
        fetch(`${netBase}/dexes?page=1`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) }).catch(() => undefined)
      ]);
      const rows = [...parsePools(vol1Res.ok ? await vol1Res.json() : undefined), ...(vol2Res?.ok ? parsePools(await vol2Res.json()) : [])];
      const topByVolume = rows.slice(0, 10).map((r) => ({ name: r.name, address: r.pool, dex: r.dex, vol24hUsd: r.vol, liqUsd: r.liq, priceChg24hPct: r.chg }));
      const trending = trendRes?.ok ? parsePools(await trendRes.json()).slice(0, 8).map((r) => ({ name: r.name, address: r.pool, dex: r.dex, vol24hUsd: r.vol, priceChg24hPct: r.chg })) : [];
      // The FULL venue census — every DEX/CLOB on Monad, so nothing is off Scarlet's radar.
      const venues = dexRes?.ok ? ((await dexRes.json()) as { data?: Array<{ id?: string; attributes?: { name?: string } }> }).data?.map((v) => ({ id: v.id, name: v.attributes?.name })) ?? [] : this.venueFlow.venues;
      this.venueFlow = { topByVolume, trending, venues, crossVenueArb: crossVenueSpreads(rows) };
    } catch (error) { this.logger.debug({ err: error }, "gecko volume pull failed"); }
  }

  start(intervalMs = 12_000): void {
    this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "flow sensor scan failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.scans++ % 5 === 0) await this.pullGeckoVolume(); // venue-agnostic volume, gently (stagger vs graduation sensor)
      // Isolate flow reads on the SECONDARY RPC so this never starves the execution path.
      const rpc = this.chain.secondary ?? this.chain.primary;
      const head = await rpc.getBlockNumber();
      if (this.cursor === undefined) { this.cursor = head > 45n ? head - 45n : head; }
      // Never backfill a large gap (would blow the getLogs size + rate limits): sample the
      // most recent ≤45-block window and skip ahead if we've fallen behind.
      let from = this.cursor + 1n;
      if (head - from > 60n) from = head - 45n;
      const to = from + WINDOW > head ? head : from + WINDOW;
      if (from > to) return;
      const logs = await rpc.getLogs({ event: SWAP_EVENT, fromBlock: from, toBlock: to }).catch((e) => { this.logger.debug({ err: e }, "flow getLogs failed"); return []; });
      for (const log of logs) {
        const a = log.args as { recipient?: Address; amount0?: bigint; amount1?: bigint };
        if (!log.address || a.amount0 === undefined || a.amount1 === undefined) continue;
        this.recent.push({ pool: log.address.toLowerCase(), wallet: (a.recipient ?? "0x").toLowerCase(), block: log.blockNumber ?? to, absAmount0: a.amount0 < 0n ? -a.amount0 : a.amount0, absAmount1: a.amount1 < 0n ? -a.amount1 : a.amount1 });
      }
      this.cursor = to;
      // Trim the rolling window to the retention horizon.
      const floor = head > this.retainBlocks ? head - this.retainBlocks : 0n;
      let i = 0; while (i < this.recent.length && this.recent[i].block < floor) i++;
      if (i > 0) this.recent.splice(0, i);
      await this.persistDigest(head);
    } finally {
      this.running = false;
    }
  }

  private async persistDigest(head: bigint): Promise<void> {
    if (!this.recent.length) { await this.db.saveMarketSnapshot("flow", "recent", { observedAt: new Date().toISOString(), head: head.toString(), note: "On-chain V3 swap tail is quiet this window — the real volume is venue-agnostic below (topByVolume). Hunt there.", hotPools: [], activeWallets: [], bigSwaps: [], topByVolume: this.venueFlow.topByVolume, trending: this.venueFlow.trending, allVenues: this.venueFlow.venues, crossVenueArb: this.venueFlow.crossVenueArb }).catch(() => undefined); return; }
    const pools = new Map<string, PoolStat>();
    const wallets = new Map<string, WalletStat>();
    for (const s of this.recent) {
      const ps = pools.get(s.pool) ?? { swaps: 0, wallets: new Set(), lastBlock: 0n, maxAbs0: 0n, maxAbs1: 0n };
      ps.swaps++; ps.wallets.add(s.wallet); if (s.block > ps.lastBlock) ps.lastBlock = s.block; if (s.absAmount0 > ps.maxAbs0) ps.maxAbs0 = s.absAmount0; if (s.absAmount1 > ps.maxAbs1) ps.maxAbs1 = s.absAmount1;
      pools.set(s.pool, ps);
      if (s.wallet && s.wallet !== "0x") { const ws = wallets.get(s.wallet) ?? { swaps: 0, pools: new Set(), lastBlock: 0n }; ws.swaps++; ws.pools.add(s.pool); if (s.block > ws.lastBlock) ws.lastBlock = s.block; wallets.set(s.wallet, ws); }
    }
    const topPools = [...pools.entries()].sort((a, b) => b[1].swaps - a[1].swaps).slice(0, 12);
    await this.enrich(topPools.slice(0, 6).map(([p]) => p));
    const hotPools = topPools.map(([pool, st]) => ({ pool, label: this.poolMeta.get(pool)?.label ?? pool.slice(0, 10), swaps: st.swaps, uniqueTraders: st.wallets.size, lastBlock: st.lastBlock.toString() }));
    const activeWallets = [...wallets.entries()].sort((a, b) => b[1].swaps - a[1].swaps).slice(0, 10).map(([wallet, st]) => ({ wallet, swaps: st.swaps, poolsTraded: st.pools.size, lastBlock: st.lastBlock.toString() }));
    // Biggest single swaps (by the larger of the two leg magnitudes, raw) — whale moves.
    const bigSwaps = [...this.recent].sort((a, b) => Number((b.absAmount0 > b.absAmount1 ? b.absAmount0 : b.absAmount1) - (a.absAmount0 > a.absAmount1 ? a.absAmount0 : a.absAmount1))).slice(0, 8)
      .map((s) => ({ pool: s.pool, label: this.poolMeta.get(s.pool)?.label ?? s.pool.slice(0, 10), wallet: s.wallet, block: s.block.toString() }));
    await this.db.saveMarketSnapshot("flow", "recent", {
      observedAt: new Date().toISOString(), head: head.toString(), windowSwaps: this.recent.length, windowBlocks: Number(this.retainBlocks),
      note: "Flow. topByVolume/trending = venue-agnostic (GeckoTerminal, ALL DEXs incl. orderbooks) — where the real $ moves; hunt momentum/arb there. hotPools/activeWallets/bigSwaps = on-chain V3 detail (one block late) for wallet-level smart-money to study/follow. Confirm any thesis by reading the pool + simulating.",
      topByVolume: this.venueFlow.topByVolume, trending: this.venueFlow.trending, allVenues: this.venueFlow.venues, crossVenueArb: this.venueFlow.crossVenueArb, hotPools, activeWallets, bigSwaps
    }).catch(() => undefined);
    this.logger.info({ windowSwaps: this.recent.length, hotPools: hotPools.length, activeWallets: activeWallets.length }, "flow digest saved");
  }

  /** Lazily resolve + cache a pool's token pair label so the digest is human-readable. */
  private async enrich(poolAddrs: string[]): Promise<void> {
    for (const pool of poolAddrs) {
      if (this.poolMeta.has(pool)) continue;
      const rpc = this.chain.secondary ?? this.chain.primary;
      try {
        const [t0, t1] = await Promise.all([
          rpc.readContract({ address: pool as Address, abi: POOL_META, functionName: "token0" }).catch(() => undefined) as Promise<Address | undefined>,
          rpc.readContract({ address: pool as Address, abi: POOL_META, functionName: "token1" }).catch(() => undefined) as Promise<Address | undefined>
        ]);
        if (!t0 || !t1) { this.poolMeta.set(pool, { label: pool.slice(0, 10), token0: "", token1: "" }); continue; }
        const [s0, s1] = await Promise.all([
          rpc.readContract({ address: t0, abi: SYM, functionName: "symbol" }).catch(() => "?") as Promise<string>,
          rpc.readContract({ address: t1, abi: SYM, functionName: "symbol" }).catch(() => "?") as Promise<string>
        ]);
        this.poolMeta.set(pool, { label: `${s0}/${s1}`, token0: t0.toLowerCase(), token1: t1.toLowerCase() });
      } catch { this.poolMeta.set(pool, { label: pool.slice(0, 10), token0: "", token1: "" }); }
    }
  }
}
