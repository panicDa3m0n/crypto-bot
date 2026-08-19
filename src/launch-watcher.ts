import type { Address } from "viem";
import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { VenueRegistry } from "./venues.js";

const Q96 = 2n ** 96n;

/**
 * The fresh-launch sensor: on a growth chain, new-token flow is where small capital
 * actually compounds. This watches the V3 factories' PoolCreated events FORWARD from
 * the moment it starts, so brand-new pools surface in Scarlet's briefing within
 * seconds of creation — she then gates them with check_token and snipes the survivors.
 */
export class LaunchWatcher {
  private timer?: NodeJS.Timeout;
  private cursor?: bigint;
  private running = false;
  private scans = 0;

  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly venues: VenueRegistry, private readonly logger: Logger) {}

  /** Core tokens (static identity) + their USD from the DB (no RPC): WBERA from token_prices, stables = 1. */
  private async core(): Promise<Record<string, { symbol: string; priceUsd: number; decimals: number }>> {
    const w = this.config.WBERA_ADDRESS.toLowerCase();
    const px = await this.db.getTokenPrices(this.config.CHAIN_ID, [w]).catch(() => new Map());
    return {
      [w]: { symbol: "WMON", priceUsd: px.get(w)?.priceUsd ?? 0, decimals: 18 },
      [this.config.USDC_E_ADDRESS.toLowerCase()]: { symbol: "USDC", priceUsd: 1, decimals: 6 },
      [this.config.HONEY_ADDRESS.toLowerCase()]: { symbol: "USDT0", priceUsd: 1, decimals: this.config.HONEY_DECIMALS }
    };
  }

  start(intervalMs = 20_000): void {
    this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "launch watcher scan failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // New tokens launch on venues beyond the two V3 factories (launchpads, CLOBs);
      // GeckoTerminal indexes them all, so pull it every ~4th scan to complete coverage.
      if (this.scans++ % 4 === 0) await this.pullGeckoTerminal().catch(() => undefined);
      await this.venues.hydrate();
      // DB-FIRST (db-first convergence): the block-indexer already discovers every PoolCreated into
      // `entities` (origin='created', created_block). Read genuine fresh launches from the DB instead of a
      // duplicate getLogs — forward-only from the indexer's cursor; liquidity/symbol come from the DB too.
      const head = await this.db.getIndexerCursor(this.config.CHAIN_ID).catch(() => null);
      if (head == null) return;
      if (this.cursor === undefined) { this.cursor = BigInt(head); return; } // watch forward only
      const since = Number(this.cursor) + 1;
      const launches = await this.db.recentLaunches(this.config.CHAIN_ID, since, 100).catch(() => []);
      const core = await this.core();
      let maxBlock = Number(this.cursor);
      for (const l of launches) {
        maxBlock = Math.max(maxBlock, l.createdBlock);
        const c0 = core[l.token0], c1 = core[l.token1];
        if (c0 && c1) continue; // core/core pair — not a launch
        const coreAddr = c0 ? l.token0 : c1 ? l.token1 : undefined;
        const coreTok = c0 ?? c1;
        const newTok = (c0 ? l.token1 : l.token0) as Address; // the non-core side (if both non-core, token0)
        const symbol = (await this.db.tokenMeta(this.config.CHAIN_ID, [newTok]).catch(() => new Map())).get(newTok.toLowerCase())?.symbol ?? "?";
        const liquidityUsd = await this.poolLiquidityUsd(l, coreAddr, coreTok);
        await this.db.saveDiscoveredPool({ pool: l.address as Address, dex: this.venueName(l.factory, l.archetype), token0: l.token0 as Address, token1: l.token1 as Address, newToken: newTok, newSymbol: symbol, fee: l.fee, liquidityUsd, block: BigInt(l.createdBlock) }).catch(() => undefined);
        this.logger.info({ pool: l.address, newToken: newTok, symbol, feeBps: l.fee, liquidityUsd, source: "db" }, "fresh pool discovered");
      }
      this.cursor = BigInt(maxBlock);
    } finally {
      this.running = false;
    }
  }

  /** Factory → venue name via the registry (fallback: short factory / archetype). */
  private venueName(factory: string | null, archetype: string | null): string {
    const v = factory ? this.venues.all.find((x) => x.address.toLowerCase() === factory.toLowerCase()) : undefined;
    return v?.name ?? (factory ? factory.slice(0, 10) : (archetype ?? "?"));
  }

  /** Comprehensive launch coverage: GeckoTerminal new_pools (any venue) → discovered_pools. */
  private async pullGeckoTerminal(): Promise<void> {
    const res = await fetch(`${this.config.GECKOTERMINAL_API_URL}/networks/${this.config.GT_NETWORK}/new_pools?page=1`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return;
    const json = await res.json() as { data?: Array<{ attributes?: Record<string, unknown>; relationships?: { base_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } } }> };
    for (const p of json.data ?? []) {
      const a = p.attributes ?? {};
      const pool = String(a.address ?? "");
      if (!/^0x[a-fA-F0-9]{40}$/.test(pool)) continue;
      const baseId = p.relationships?.base_token?.data?.id ?? ""; // "monad_0x..."
      const newToken = baseId.includes("_") ? baseId.split("_")[1] : null;
      const name = String(a.name ?? "?"); const newSymbol = name.split("/")[0].trim();
      await this.db.saveDiscoveredPool({ pool, dex: `GT:${p.relationships?.dex?.data?.id ?? "?"}`, token0: newToken ?? pool, token1: pool, newToken, newSymbol, fee: null, liquidityUsd: Number(a.reserve_in_usd) || null, block: 0n }).catch(() => undefined);
    }
  }

  /** Rough TVL proxy from the DB: the core-side reserve (V2 actual / V3 virtual) valued and doubled. */
  private async poolLiquidityUsd(l: { address: string; token0: string; token1: string }, coreAddr?: string, coreTok?: { priceUsd: number; decimals: number }): Promise<number | null> {
    if (!coreAddr || !coreTok || !(coreTok.priceUsd > 0)) return null;
    const stMap = await this.db.poolStateBatch(this.config.CHAIN_ID, [l.address]).catch(() => new Map());
    const st = stMap.get(l.address.toLowerCase()) as { archetype: string; r0: bigint | null; r1: bigint | null; sqrtPrice: bigint | null; liquidity: bigint | null } | undefined;
    if (!st) return null;
    const coreIsT0 = coreAddr.toLowerCase() === l.token0.toLowerCase();
    let reserve = 0;
    if (st.archetype === "v3" && st.sqrtPrice != null && st.sqrtPrice > 0n && st.liquidity != null && st.liquidity > 0n) {
      const raw: bigint = coreIsT0 ? (st.liquidity * Q96) / st.sqrtPrice : (st.liquidity * st.sqrtPrice) / Q96;
      reserve = Number(raw) / 10 ** coreTok.decimals;
    } else if (st.r0 != null && st.r1 != null) {
      const raw: bigint = coreIsT0 ? st.r0 : st.r1;
      reserve = Number(raw) / 10 ** coreTok.decimals;
    } else return null;
    return Math.round(reserve * coreTok.priceUsd * 2 * 100) / 100;
  }
}
