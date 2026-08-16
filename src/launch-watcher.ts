import { parseAbi, parseAbiItem, type Address } from "viem";
import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { VenueRegistry } from "./venues.js";

const POOL_CREATED = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const WINDOW = 90n; // stay under Monad's 100-block eth_getLogs cap

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

  private core(): Record<string, { symbol: string; price: () => Promise<number>; decimals: number }> {
    return {
      [this.config.WBERA_ADDRESS.toLowerCase()]: { symbol: "WMON", price: () => this.chain.tokenPrice(this.config.WBERA_ADDRESS).catch(() => 0), decimals: 18 },
      [this.config.USDC_E_ADDRESS.toLowerCase()]: { symbol: "USDC", price: async () => 1, decimals: 6 },
      [this.config.HONEY_ADDRESS.toLowerCase()]: { symbol: "USDT0", price: async () => 1, decimals: this.config.HONEY_DECIMALS }
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
      const factories = this.venues.byType("uni-v3");
      if (!factories.length) return;
      const head = await this.chain.primary.getBlockNumber();
      if (this.cursor === undefined) { this.cursor = head; return; } // watch forward only
      const from = this.cursor + 1n;
      const to = from + WINDOW > head ? head : from + WINDOW;
      if (from > to) return;
      const core = this.core();
      for (const venue of factories) {
        const logs = await this.chain.primary.getLogs({ address: venue.address as Address, event: POOL_CREATED, fromBlock: from, toBlock: to }).catch(() => []);
        for (const log of logs) {
          const { token0, token1, fee, pool } = log.args as { token0: Address; token1: Address; fee: number; pool: Address };
          if (!token0 || !token1 || !pool) continue;
          const c0 = core[token0.toLowerCase()]; const c1 = core[token1.toLowerCase()];
          if (c0 && c1) continue; // core/core pair — not a launch
          const coreTok = c0 ? { addr: token0, ...c0 } : c1 ? { addr: token1, ...c1 } : undefined;
          const newTok = c0 ? token1 : token0; // the non-core side (if both non-core, token0)
          const [symbol, liquidityUsd] = await Promise.all([
            this.chain.primary.readContract({ address: newTok, abi: erc, functionName: "symbol" }).catch(() => "?") as Promise<string>,
            this.poolLiquidityUsd(pool, coreTok)
          ]);
          await this.db.saveDiscoveredPool({ pool, dex: venue.name, token0, token1, newToken: newTok, newSymbol: symbol, fee: Number(fee), liquidityUsd, block: log.blockNumber ?? to }).catch(() => undefined);
          this.logger.info({ pool, dex: venue.name, newToken: newTok, symbol, feeBps: Number(fee), liquidityUsd }, "fresh pool discovered");
        }
      }
      this.cursor = to;
    } finally {
      this.running = false;
    }
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

  /** Rough TVL proxy: the core-side reserve valued and doubled. Null if no core side. */
  private async poolLiquidityUsd(pool: Address, coreTok?: { addr: Address; price: () => Promise<number>; decimals: number }): Promise<number | null> {
    if (!coreTok) return null;
    try {
      const [bal, price] = await Promise.all([
        this.chain.primary.readContract({ address: coreTok.addr, abi: erc, functionName: "balanceOf", args: [pool] }),
        coreTok.price()
      ]);
      const reserve = Number(bal) / 10 ** coreTok.decimals;
      return Math.round(reserve * price * 2 * 100) / 100;
    } catch { return null; }
  }
}
