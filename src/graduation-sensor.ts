import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";

/**
 * Graduation-arb sensor — the strategy Scarlet migrated to Base for. Fresh tokens (just
 * launched / just graduated from a bonding curve to a DEX pool) trade at DIVERGENT prices
 * across venues for 2-4h before arb bots align them (documented ~15-25% on Base). This sensor,
 * every cycle:
 *   1. pulls the freshest pools (GeckoTerminal new_pools),
 *   2. keeps only ALIVE ones (real liquidity + real volume — 80%+ of launches are DOA trash),
 *   3. for each, reads that token's price across EVERY venue and finds the cheap↔dear gap,
 *   4. surfaces the ones with a capturable spread as graduation-arb candidates.
 * The spread is the SIGNAL; Scarlet still confirms each leg with an on-chain quote + check_token
 * (can-you-sell) before executing, and NEVER holds — buy the cheap venue, sell the dear, exit.
 */
type GtPool = { attributes?: Record<string, unknown>; relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } } };

export class GraduationSensor {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly logger: Logger
  ) {}

  start(intervalMs = 45_000): void {
    this.timer = setInterval(() => void this.tick().catch((error) => this.logger.error({ err: error }, "graduation sensor tick failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async gt<T>(path: string): Promise<T | undefined> {
    const res = await fetch(`${this.config.GECKOTERMINAL_API_URL}/networks/${this.config.GT_NETWORK}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) }).catch(() => undefined);
    return res && res.ok ? (await res.json() as T) : undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const fresh = await this.gt<{ data?: GtPool[] }>("/new_pools?page=1");
      if (!fresh) { this.logger.debug("graduation: GT throttled, keeping last snapshot"); return; } // never overwrite good data with an empty (rate-limited) fetch
      const pools = fresh.data ?? [];
      // Alive fresh tokens only: real liquidity + real 1h volume, distinct base tokens. These are
      // the momentum-snipe candidates (fresh single-venue tokens actively price-discovering).
      const seen = new Set<string>();
      const candidates: Array<{ token: string; symbol: string }> = [];
      const momentum: Array<{ symbol: string; token: string; pool: string; dex: string; priceUsd: number; chg5m: number; chg1h: number; liqUsd: number; vol1hUsd: number; ageMin: number | null }> = [];
      const nowMs = Date.parse(new Date().toISOString());
      for (const p of pools) {
        const a = p.attributes ?? {};
        const liq = Number(a.reserve_in_usd) || 0;
        const vol1h = Number((a.volume_usd as { h1?: string } | undefined)?.h1) || 0;
        const baseId = (p.relationships?.base_token?.data?.id ?? "").split("_")[1];
        if (!baseId || seen.has(baseId)) continue;
        if (liq < this.config.GRAD_MIN_LIQ_USD || vol1h < this.config.GRAD_MIN_VOL1H_USD) continue;
        seen.add(baseId);
        const chg = (a.price_change_percentage as { m5?: string; h1?: string } | undefined) ?? {};
        const created = a.pool_created_at ? Date.parse(String(a.pool_created_at)) : NaN;
        momentum.push({ symbol: String(a.name ?? "?").split("/")[0].trim(), token: baseId, pool: String(a.address ?? ""), dex: p.relationships?.dex?.data?.id ?? "?", priceUsd: Number(a.base_token_price_usd) || 0, chg5m: Number(chg.m5) || 0, chg1h: Number(chg.h1) || 0, liqUsd: Math.round(liq), vol1hUsd: Math.round(vol1h), ageMin: Number.isFinite(created) ? Math.round((nowMs - created) / 60000) : null });
        candidates.push({ token: baseId, symbol: String(a.name ?? "?").split("/")[0].trim() });
        if (candidates.length >= this.config.GRAD_MAX_PROBES) break;
      }

      const arbs: Array<{ symbol: string; token: string; spreadPct: number; cheap: { dex: string; pool: string; priceUsd: number; liqUsd: number }; dear: { dex: string; pool: string; priceUsd: number; liqUsd: number }; venues: number }> = [];
      for (const c of candidates) {
        // Every venue this fresh token trades on → the cheap↔dear divergence.
        const tp = await this.gt<{ data?: GtPool[] }>(`/tokens/${c.token}/pools`);
        const legs = (tp?.data ?? []).map((p) => {
          const a = p.attributes ?? {};
          const isBase = (p.relationships?.base_token?.data?.id ?? "").split("_")[1]?.toLowerCase() === c.token.toLowerCase();
          const priceUsd = Number(isBase ? a.base_token_price_usd : a.quote_token_price_usd) || 0;
          return { dex: p.relationships?.dex?.data?.id ?? "?", pool: String(a.address ?? ""), priceUsd, liqUsd: Math.round(Number(a.reserve_in_usd) || 0), vol: Number((a.volume_usd as { h24?: string } | undefined)?.h24) || 0 };
        }).filter((l) => l.priceUsd > 0 && l.liqUsd >= this.config.GRAD_MIN_LIQ_USD);
        if (new Set(legs.map((l) => l.dex)).size < 2) continue; // need 2+ venues to arb
        const cheap = legs.reduce((lo, l) => (l.priceUsd < lo.priceUsd ? l : lo));
        const dear = legs.reduce((hi, l) => (l.priceUsd > hi.priceUsd ? l : hi));
        const spreadPct = cheap.priceUsd > 0 ? ((dear.priceUsd - cheap.priceUsd) / cheap.priceUsd) * 100 : 0;
        if (spreadPct < this.config.GRAD_MIN_SPREAD_PCT) continue;
        arbs.push({ symbol: c.symbol, token: c.token, spreadPct: Number(spreadPct.toFixed(2)), cheap: { dex: cheap.dex, pool: cheap.pool, priceUsd: cheap.priceUsd, liqUsd: cheap.liqUsd }, dear: { dex: dear.dex, pool: dear.pool, priceUsd: dear.priceUsd, liqUsd: dear.liqUsd }, venues: new Set(legs.map((l) => l.dex)).size });
      }
      arbs.sort((a, b) => b.spreadPct - a.spreadPct);

      momentum.sort((a, b) => b.vol1hUsd - a.vol1hUsd);
      await this.db.saveMarketSnapshot("graduation", "recent", {
        observedAt: new Date().toISOString(), freshScanned: pools.length, aliveProbed: candidates.length,
        note: "Fresh Base tokens that are ALIVE (real liquidity + volume) and price-discovering. `momentum` = single-venue snipe candidates (buy small EARLY, ride, EXIT fast — variance, 80%+ dump, check_token(can-you-sell) FIRST, never hold). `arbs` = the rarer case of a REAL cross-venue gap (buy cheap venue/sell dear, market-neutral). Confirm every entry with an on-chain swap simulation.",
        momentum: momentum.slice(0, 10), arbs: arbs.slice(0, 10)
      }).catch(() => undefined);
      this.logger.info({ scanned: pools.length, alive: momentum.length, arbs: arbs.length }, arbs.length ? "graduation: cross-venue arb found" : "graduation: momentum candidates only");
    } finally {
      this.running = false;
    }
  }
}
