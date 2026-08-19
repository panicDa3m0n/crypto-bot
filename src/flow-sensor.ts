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

type FlowRow = { block: number; pool: string; wallet: string | null; valueUsd: number };
type PoolStat = { swaps: number; wallets: Set<string>; lastBlock: number; volUsd: number };
type WalletStat = { swaps: number; pools: Set<string>; lastBlock: number; volUsd: number };

export class FlowSensor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private scans = 0;
  private venueFlow: { topByVolume: unknown[]; trending: unknown[]; venues: unknown[]; crossVenueArb: unknown[] } = { topByVolume: [], trending: [], venues: [], crossVenueArb: [] };

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
      // DB-FIRST (db-first convergence): the block-indexer records every priced swap's wallet + USD into
      // recent_swaps (a rolling window). Read that window from the DB and aggregate — no own getLogs, no RPC.
      const head = await this.db.getIndexerCursor(this.config.CHAIN_ID).catch(() => null);
      if (head == null) return;
      const since = Math.max(0, head - this.config.INDEXER_FLOW_RETAIN_BLOCKS);
      const rows = await this.db.recentSwaps(this.config.CHAIN_ID, since).catch(() => [] as FlowRow[]);
      await this.persistDigest(head, rows);
    } finally {
      this.running = false;
    }
  }

  private async persistDigest(head: number, rows: FlowRow[]): Promise<void> {
    if (!rows.length) { await this.db.saveMarketSnapshot("flow", "recent", { observedAt: new Date().toISOString(), head: String(head), note: "On-chain swap tail is quiet this window — the real volume is venue-agnostic below (topByVolume). Hunt there.", hotPools: [], activeWallets: [], bigSwaps: [], topByVolume: this.venueFlow.topByVolume, trending: this.venueFlow.trending, allVenues: this.venueFlow.venues, crossVenueArb: this.venueFlow.crossVenueArb }).catch(() => undefined); return; }
    const pools = new Map<string, PoolStat>();
    const wallets = new Map<string, WalletStat>();
    for (const s of rows) {
      const ps = pools.get(s.pool) ?? { swaps: 0, wallets: new Set(), lastBlock: 0, volUsd: 0 };
      ps.swaps++; if (s.wallet) ps.wallets.add(s.wallet); if (s.block > ps.lastBlock) ps.lastBlock = s.block; ps.volUsd += s.valueUsd;
      pools.set(s.pool, ps);
      if (s.wallet) { const ws = wallets.get(s.wallet) ?? { swaps: 0, pools: new Set(), lastBlock: 0, volUsd: 0 }; ws.swaps++; ws.pools.add(s.pool); if (s.block > ws.lastBlock) ws.lastBlock = s.block; ws.volUsd += s.valueUsd; wallets.set(s.wallet, ws); }
    }
    const topPools = [...pools.entries()].sort((a, b) => b[1].swaps - a[1].swaps).slice(0, 12);
    const labels = await this.labels(topPools.map(([p]) => p));
    const hotPools = topPools.map(([pool, st]) => ({ pool, label: labels.get(pool) ?? pool.slice(0, 10), swaps: st.swaps, uniqueTraders: st.wallets.size, volUsd: Math.round(st.volUsd), lastBlock: String(st.lastBlock) }));
    const activeWallets = [...wallets.entries()].sort((a, b) => b[1].swaps - a[1].swaps).slice(0, 10).map(([wallet, st]) => ({ wallet, swaps: st.swaps, poolsTraded: st.pools.size, volUsd: Math.round(st.volUsd), lastBlock: String(st.lastBlock) }));
    // Biggest single swaps by USD value — whale moves.
    const big = [...rows].sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 8);
    const bigLabels = await this.labels(big.map((s) => s.pool));
    const bigSwaps = big.map((s) => ({ pool: s.pool, label: bigLabels.get(s.pool) ?? s.pool.slice(0, 10), wallet: s.wallet, valueUsd: Math.round(s.valueUsd), block: String(s.block) }));
    await this.db.saveMarketSnapshot("flow", "recent", {
      observedAt: new Date().toISOString(), head: String(head), windowSwaps: rows.length, windowBlocks: this.config.INDEXER_FLOW_RETAIN_BLOCKS,
      note: "Flow. topByVolume/trending = venue-agnostic (GeckoTerminal, ALL DEXs incl. orderbooks) — where the real $ moves; hunt momentum/arb there. hotPools/activeWallets/bigSwaps = on-chain detail (from the indexer) for wallet-level smart-money to study/follow. Confirm any thesis by reading the pool + simulating.",
      topByVolume: this.venueFlow.topByVolume, trending: this.venueFlow.trending, allVenues: this.venueFlow.venues, crossVenueArb: this.venueFlow.crossVenueArb, hotPools, activeWallets, bigSwaps
    }).catch(() => undefined);
    this.logger.info({ windowSwaps: rows.length, hotPools: hotPools.length, activeWallets: activeWallets.length, source: "db" }, "flow digest saved");
  }

  /** Human-readable pool labels (sym0/sym1) FROM THE DB registry — entities topology + token metadata. */
  private async labels(poolAddrs: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const uniq = [...new Set(poolAddrs.map((p) => p.toLowerCase()))];
    if (!uniq.length) return out;
    const info = await this.db.poolInfoBatch(this.config.CHAIN_ID, uniq).catch(() => new Map());
    const toks = new Set<string>();
    for (const i of info.values()) { if (i.token0) toks.add(i.token0.toLowerCase()); if (i.token1) toks.add(i.token1.toLowerCase()); }
    const meta = await this.db.tokenMeta(this.config.CHAIN_ID, [...toks]).catch(() => new Map());
    for (const p of uniq) {
      const i = info.get(p);
      if (!i?.token0 || !i.token1) { out.set(p, p.slice(0, 10)); continue; }
      out.set(p, `${meta.get(i.token0.toLowerCase())?.symbol ?? "?"}/${meta.get(i.token1.toLowerCase())?.symbol ?? "?"}`);
    }
    return out;
  }
}
