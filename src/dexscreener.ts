import type { Logger } from "pino";
import type { Config } from "./config.js";

/**
 * DexScreener client — free, ~300 req/min (10x GeckoTerminal), no key. It gives a token's economic
 * snapshot AND its movement in one call: price, multi-window priceChange (m5/h1/h6/h24), volume trend,
 * liquidity, FDV, and buy/sell counts per window — the momentum signal a trader actually acts on. The
 * per-pair address it returns doubles as the pool for the GeckoTerminal OHLCV chart. Cached briefly.
 */
type DsPair = {
  chainId?: string; dexId?: string; pairAddress?: string; url?: string;
  priceUsd?: string; fdv?: number;
  priceChange?: Record<string, number>; volume?: Record<string, number>;
  liquidity?: { usd?: number }; txns?: Record<string, { buys?: number; sells?: number }>;
  baseToken?: { address?: string; symbol?: string };
};

export type TokenMovement = {
  priceUsd: number | null;
  priceChange: Record<string, number> | null;
  volume: Record<string, number> | null;
  liquidityUsd: number | null;
  fdv: number | null;
  txns: Record<string, { buys?: number; sells?: number }> | null;
  pairs: Array<{ pair: string; dex: string | undefined; liquidityUsd: number; url: string | undefined }>;
  source: "dexscreener";
};

export class DexScreener {
  private readonly cache = new Map<string, { at: number; value: TokenMovement | { error: string } }>();
  private static readonly TTL_MS = 30_000;

  constructor(private readonly config: Config, private readonly logger: Logger) {}

  /** Normalized snapshot+movement for a token on OUR chain (best pairs by liquidity). */
  async token(address: string): Promise<TokenMovement | { error: string }> {
    const key = address.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < DexScreener.TTL_MS) return hit.value;
    let value: TokenMovement | { error: string };
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${key}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) { value = { error: `DexScreener ${res.status}` }; }
      else {
        const json = (await res.json()) as { pairs?: DsPair[] };
        const slug = this.config.GT_NETWORK; // "base" — same slug DexScreener uses
        const pairs = (json.pairs ?? []).filter((p) => p.chainId === slug).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        if (!pairs.length) { value = { error: "DexScreener: nessuna coppia su questa chain" }; }
        else {
          const best = pairs[0];
          value = {
            priceUsd: best.priceUsd != null ? Number(best.priceUsd) : null,
            priceChange: best.priceChange ?? null,
            volume: best.volume ?? null,
            liquidityUsd: best.liquidity?.usd ?? null,
            fdv: best.fdv ?? null,
            txns: best.txns ?? null,
            pairs: pairs.slice(0, 3).map((p) => ({ pair: String(p.pairAddress ?? ""), dex: p.dexId, liquidityUsd: p.liquidity?.usd ?? 0, url: p.url })),
            source: "dexscreener"
          };
        }
      }
    } catch (error) {
      value = { error: `DexScreener: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}
