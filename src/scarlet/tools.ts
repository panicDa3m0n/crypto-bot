import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { getAddress } from "viem";
import type { Config } from "../config.js";
import type { Database } from "../db.js";
import type { MarketData } from "../market-data.js";
import type { Primitives } from "../primitives.js";
import type { DexScreener } from "../dexscreener.js";
import type { Blockscout } from "../blockscout.js";

/**
 * Scarlet's VISION tools (read-only) — the senses she uses to explore, pull economic data, read price
 * movement, and verify a token before ever touching it. NOTHING here spends funds or writes on-chain;
 * buying/selling and position management arrive in the next gradino. Sources: the token DB (knowledge +
 * display price), DexScreener (snapshot + movement, high rate limit), GeckoTerminal (detailed OHLCV
 * candles + discovery), and the on-chain honeypot check.
 */
export type ToolDeps = { config: Config; db: Database; marketData: MarketData; dexscreener: DexScreener; primitives: Primitives; blockscout: Blockscout };

export const VISION_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "token_chart",
      description: "Grafico dei movimenti di prezzo come candele OHLCV di un POOL (prendi l'indirizzo del pool da search_token.market.pairs[0].pair o da discover). Ritorna fino a 48 candele [timestamp, open, high, low, close, volume] dalla più recente. Leggile per capire trend, momentum, breakout, supporti/resistenze.",
      parameters: { type: "object", properties: { pool: { type: "string", description: "indirizzo del pool (0x…)" }, timeframe: { type: "string", enum: ["minute", "hour", "day"], description: "granularità candele (default hour)" } }, required: ["pool"] }
    }
  },
  {
    type: "function",
    function: {
      name: "discover",
      description: "Esplora oltre il briefing: token/pool freschi ('new_pools') o con momentum ora ('trending'). Discovery più ampia per trovare candidati. Ricorda: la maggior parte dei nuovi token sono trappole — search_token (che compila anche la sicurezza) prima di qualsiasi tesi.",
      parameters: { type: "object", properties: { kind: { type: "string", enum: ["new_pools", "trending"], description: "cosa esplorare" }, limit: { type: "number", description: "quanti risultati (default ~15)" } }, required: ["kind"] }
    }
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Salva una nota strutturata e recuperabile (una tesi, un indirizzo, una lezione, un piano) con una chiave. Sovrascrive se la chiave esiste. Usalo per preparare strategie e non dimenticare ciò che conta.",
      parameters: { type: "object", properties: { key: { type: "string", description: "chiave breve e stabile" }, content: { type: "string", description: "il contenuto da ricordare" }, category: { type: "string", description: "categoria (es. tesi, token, lezione) — opzionale" } }, required: ["key", "content"] }
    }
  },
  {
    type: "function",
    function: {
      name: "recall",
      description: "Apri una nota salvata per chiave (l'indice delle chiavi è nel briefing, campo memory.notebook).",
      parameters: { type: "object", properties: { key: { type: "string", description: "la chiave della nota" } }, required: ["key"] }
    }
  }
];

/** True if `name` is one of the vision tools handled here. */
export function isVisionTool(name: string): boolean {
  return ["token_chart", "discover", "remember", "recall"].includes(name);
}

/** Dispatch a vision tool. Read-only except `remember` (writes to the memory store, not on-chain). */
export async function dispatchVisionTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<unknown> {
  switch (name) {
    case "token_chart": {
      const pool = normalizeAddr(args.pool);
      if (!pool) return { error: "indirizzo pool non valido — prendilo da search_token.market.pairs[0].pair o da discover" };
      const timeframe = typeof args.timeframe === "string" ? args.timeframe : "hour";
      return deps.marketData.query("ohlcv", { pool, timeframe }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    }
    case "discover": {
      const kind = args.kind === "trending" ? "trending" : "new_pools";
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      return deps.marketData.query(kind, { limit }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    }
    case "remember": {
      const key = String(args.key ?? "").trim().slice(0, 80);
      const content = String(args.content ?? "").trim().slice(0, 4_000);
      if (!key || !content) return { error: "chiave o contenuto vuoti" };
      await deps.db.saveMemory(key, String(args.category ?? "nota").slice(0, 40), content).catch(() => undefined);
      return { ok: true, remembered: key };
    }
    case "recall": {
      const key = String(args.key ?? "").trim();
      if (!key) return { error: "chiave vuota" };
      const m = await deps.db.getMemory(key).catch(() => undefined);
      return m ?? { error: `nessuna nota con chiave '${key}'` };
    }
    default:
      return { error: `strumento sconosciuto '${name}'` };
  }
}

function normalizeAddr(v: unknown): string | null {
  try { return getAddress(String(v ?? "").trim()).toLowerCase(); } catch { return null; }
}
