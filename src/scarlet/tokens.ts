import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { getAddress, type Address } from "viem";
import type { ToolDeps } from "./tools.js";

export const TOKEN_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_token",
      description: "Il PUNTO DI PARTENZA per capire un token: dato l'indirizzo, ritorna il dossier a 360° — identità (registro), provenienza (deploy/verified), SICUREZZA (honeypot/vendibilità, compilata alla prima ricerca), mercato realtime (prezzo/momentum/liquidità da DexScreener), la NOSTRA interazione passata col token, il tuo ultimo GIUDIZIO — più gli HINT dei comandi per approfondire ogni superficie.",
      parameters: { type: "object", properties: { address: { type: "string", description: "indirizzo del token (0x…)" } }, required: ["address"] }
    }
  },
  {
    type: "function",
    function: {
      name: "annotate_token",
      description: "Registra il TUO giudizio su un token nello storico condiviso (address-keyed, così la te-futura lo ritrova subito e NON rianalizza da zero). verdict: avoid (rug/scam/honeypot) | watch (da tenere d'occhio) | candidate (potenziale acquisto) | neutral. Aggiungi SEMPRE il perché nella nota.",
      parameters: { type: "object", properties: { address: { type: "string", description: "indirizzo token" }, verdict: { type: "string", enum: ["avoid", "watch", "candidate", "neutral"], description: "il verdetto" }, note: { type: "string", description: "il perché (segnali concreti)" }, tags: { type: "array", items: { type: "string" }, description: "tag opzionali (es. redeploy, meme, low-liq)" } }, required: ["address", "verdict"] }
    }
  },
  {
    type: "function",
    function: {
      name: "reverify_token",
      description: "Ricontrolla la SICUREZZA on-chain del token (simula buy+sell sul pool più profondo → honeypot/vendibilità/tassa) e aggiorna il valore memorizzato con un nuovo checkedAt. Usalo se il dato di sicurezza è vecchio o le condizioni sono cambiate. Il fatto di sicurezza lo scrive il sistema, non tu.",
      parameters: { type: "object", properties: { address: { type: "string", description: "indirizzo token" } }, required: ["address"] }
    }
  },
  {
    type: "function",
    function: {
      name: "token_annotations",
      description: "Lo STORICO COMPLETO dei tuoi giudizi su un token (search_token ne mostra solo l'ultimo + il conteggio). Usalo per ricostruire come è evoluta la tua valutazione nel tempo prima di ri-giudicarlo.",
      parameters: { type: "object", properties: { address: { type: "string", description: "indirizzo token" }, limit: { type: "number", description: "quanti (default 20)" } }, required: ["address"] }
    }
  },
  {
    type: "function",
    function: {
      name: "token_activity",
      description: "Lo STORICO COMPLETO delle NOSTRE interazioni on-chain col token (trasferimenti in/out del wallet): come e quando il nostro sistema l'ha già toccato. search_token ne mostra solo l'ultima + il conteggio.",
      parameters: { type: "object", properties: { address: { type: "string", description: "indirizzo token" }, limit: { type: "number", description: "quanti (default 20)" } }, required: ["address"] }
    }
  },
  {
    type: "function",
    function: {
      name: "find_tokens",
      description: "Ricerca nel DB token condiviso. mode: 'recent' (ultimi scoperti) | 'symbol' (per simbolo, ILIKE — trova simili/redeploy dello STESSO simbolo, utilissimo per i rugger seriali) | 'verdict' (token il cui TUO ultimo giudizio = verdict) | 'most_pools' (token presenti in più pool = più stabiliti). Ritorna una lista sintetica; poi usa search_token su ciò che ti interessa.",
      parameters: { type: "object", properties: { mode: { type: "string", enum: ["recent", "symbol", "verdict", "most_pools"], description: "il tipo di ricerca" }, query: { type: "string", description: "il simbolo (per mode=symbol)" }, verdict: { type: "string", enum: ["avoid", "watch", "candidate", "neutral"], description: "il verdetto (per mode=verdict)" }, limit: { type: "number", description: "quanti (default 20)" } }, required: ["mode"] }
    }
  },
  {
    type: "function",
    function: {
      name: "sync_address",
      description: "Per un indirizzo SCONOSCIUTO o poco noto: recupera in una chiamata dati RICCHI da Blockscout (contratto verificato, nome, proxy, tipo token, N° HOLDERS, market cap, creator, tag) e li SALVA nel token con un timestamp di sync. Dopo, li rileggi via search_token senza richiamare; ri-lancia sync_address solo se il dato è vecchio o serve aggiornarlo.",
      parameters: { type: "object", properties: { address: { type: "string", description: "indirizzo (0x…)" } }, required: ["address"] }
    }
  }
];

/**
 * TOKEN MANAGEMENT (Step 1) — the 360° dossier + write path, on the SHARED token DB (`entities`).
 *
 * Data is layered by NATURE, so nothing volatile/stale gets duplicated:
 *  - identity/provenance  → entity (system, at discovery), read-only
 *  - security             → entity meta.security {…, checkedAt} — system-authoritative, (re)compiled by
 *                           the honeypot check; replaced wholesale on each check (never a merged blob)
 *  - market (realtime)    → DexScreener live (NOT stored)
 *  - judgment (history)   → token_annotations (append-only timeline — Scarlet's opinion, with the why)
 *  - our interaction      → wallet_transactions filtered by token (how WE already touched it)
 *
 * `search_token` returns a summary of every surface + HINTS of the deeper commands (progressive
 * disclosure). `annotate_token` writes her judgment; `reverify_token` refreshes the security facts.
 */

function normalizeAddr(v: unknown): string | null {
  try { return getAddress(String(v ?? "").trim()).toLowerCase(); } catch { return null; }
}

/** Run the on-chain honeypot/sellability check and persist it onto the entity (system-authoritative). */
async function compileSecurity(deps: ToolDeps, addr: string): Promise<Record<string, unknown> | { error: string }> {
  const check = await deps.primitives.checkToken(addr as Address).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }) as { error: string });
  if ("error" in check) return check;
  const security = { safe: check.safe, canSell: check.canSell, buyable: check.buyable, poolFeeBps: check.poolFeeBps ?? null, reasons: check.reasons, checkedAt: nowIso() };
  await deps.db.setTokenSecurity(deps.config.CHAIN_ID, addr, security).catch(() => undefined);
  return security;
}

/** Assemble the full dossier for a token (all layers), compiling security lazily if never checked. */
async function buildDossier(deps: ToolDeps, addr: string): Promise<unknown> {
  const chainId = deps.config.CHAIN_ID;
  const wallet = deps.config.WALLET_ADDRESS as string | undefined;
  const weth = (deps.config.WBERA_ADDRESS as string).toLowerCase(), usdc = (deps.config.USDC_E_ADDRESS as string).toLowerCase();
  const [entities, prices, vol, annotations, activity, stats, wethMap, poolRows] = await Promise.all([
    deps.db.getEntity(chainId, addr).catch(() => []),
    deps.db.getTokenPrices(chainId, [addr]).catch(() => new Map()),
    deps.db.tokenVolatility(chainId, [addr]).catch(() => new Map()),
    deps.db.listTokenAnnotations(chainId, addr, 5).catch(() => []),
    wallet ? deps.db.walletActivityForToken(chainId, wallet, addr, 10).catch(() => []) : Promise.resolve([]),
    deps.db.tokenStats(chainId, addr).catch(() => null),
    deps.db.getTokenPrices(chainId, [weth]).catch(() => new Map()),
    deps.db.poolsForToken(chainId, addr).catch(() => [])
  ]);
  // Market data is now chain-sourced from the indexer (token_stats + pool_state), not DexScreener.
  const wethUsd = (wethMap as Map<string, { priceUsd: number | null }>).get(weth)?.priceUsd ?? null;
  const quoteUsd = (t: string): number | null => { const x = t.toLowerCase(); return x === usdc ? 1 : x === weth ? wethUsd : null; };
  const liquidityUsd = await deps.db.tokenLiquidityUsd(chainId, addr, quoteUsd).catch(() => null);
  const pools = (poolRows as Array<{ address: string; meta: unknown }>).map((r) => r.address);
  const market = {
    source: "indexer",
    volumeUsd: stats ? { m5: Math.round(stats.vol5m), h1: Math.round(stats.vol1h), h24: Math.round(stats.vol24h) } : null,
    txns24h: stats?.txns24h ?? null, buys24h: stats?.buys24h ?? null, sells24h: stats?.sells24h ?? null,
    priceChangePct: stats ? { h1: stats.change1h, h24: stats.change24h } : null,
    liquidityUsd: liquidityUsd != null ? Math.round(liquidityUsd) : null,
    pools: pools.slice(0, 8),
    note: "volume/txns su finestra 24h (V3); liquidità V3 approssimata (riserve virtuali); price-change si riempie man mano"
  };
  const token = (entities as Array<{ kind: string; symbol: string | null; name: string | null; decimals: number | null; meta: unknown; note: string | null; status: string }>).find((e) => e.kind === "token");
  const meta = (token?.meta ?? {}) as Record<string, unknown>;
  const p = (prices as Map<string, { priceUsd: number | null; source: string; updatedAt: string }>).get(addr);

  // Security: system fact. Compile lazily on first sight; read the stored value otherwise.
  let security = meta.security as Record<string, unknown> | undefined;
  let securityJustCompiled = false;
  if (!security) { const s = await compileSecurity(deps, addr); if (!("error" in s)) { security = s; securityJustCompiled = true; } }

  const anns = annotations as Array<{ at: string; verdict: string; note: string | null; tags: string[] }>;
  const acts = activity as Array<{ direction: string; valueRaw: string; at: string; txHash: string }>;

  const chain = meta.chain as Record<string, unknown> | undefined;
  const hints = [
    "annotate_token(address, verdict, note) — registra il tuo giudizio (verdict: avoid|watch|candidate|neutral)",
    "reverify_token(address) — ricontrolla la sicurezza on-chain (aggiorna checkedAt)",
    "token_chart(pool, timeframe) — storico prezzi/candele del pool (pool da market.pools[0]; timeframe minute|hour|day)",
    ...(anns.length > 1 ? ["token_annotations(address) — lo storico completo dei tuoi giudizi su questo token"] : []),
    ...(acts.length ? ["token_activity(address) — lo storico completo delle nostre interazioni col token"] : []),
    ...(!chain ? ["sync_address(address) — arricchisci con holders/creator/tag/marketcap da Blockscout (una volta, poi resta salvato)"] : [])
  ];

  return {
    address: addr,
    identity: token ? { symbol: token.symbol, decimals: token.decimals, name: token.name, status: token.status } : "non ancora nel registro di sistema — nuovo per te",
    provenance: token ? { discoveredBy: meta.discoveredBy ?? null, contractName: meta.contractName ?? null, isProxy: meta.isProxy ?? null, verified: meta.verified ?? null } : null,
    security: security ? { ...security, ...(securityJustCompiled ? { note: "appena compilata alla prima ricerca" } : {}) } : "non verificabile (nessun pool V3 leggibile) — vedi market/reasons",
    displayPrice: p ? { usd: p.priceUsd, source: p.source, at: p.updatedAt } : null,
    volatility: (vol as Map<string, number | null>).get(addr) ?? null,
    market,
    ourInteraction: acts.length ? { count: acts.length, last: { direction: acts[0].direction, at: acts[0].at, tx: acts[0].txHash } } : "mai interagito con questo token",
    onchain: chain ? { ...chain, note: "dati sincronizzati (Blockscout). Ri-sincronizza con sync_address se syncedAt è vecchio." } : "non ancora sincronizzato — sync_address per holders/creator/tag/marketcap",
    judgment: anns.length ? { last: anns[0], history: anns.length } : "nessun tuo giudizio ancora — usa annotate_token",
    hints
  };
}

export function isTokenTool(name: string): boolean {
  return ["search_token", "annotate_token", "reverify_token", "token_annotations", "token_activity", "find_tokens", "sync_address"].includes(name);
}

export async function dispatchTokenTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<unknown> {
  const chainId = deps.config.CHAIN_ID;
  switch (name) {
    case "search_token": {
      const addr = normalizeAddr(args.address ?? args.query);
      if (!addr) return { error: "indirizzo token non valido (per la ricerca per simbolo arriverà find_tokens)" };
      return buildDossier(deps, addr);
    }
    case "annotate_token": {
      const addr = normalizeAddr(args.address);
      if (!addr) return { error: "indirizzo token non valido" };
      const verdict = String(args.verdict ?? "").trim().toLowerCase();
      if (!["avoid", "watch", "candidate", "neutral"].includes(verdict)) return { error: "verdict deve essere: avoid | watch | candidate | neutral" };
      const note = args.note != null ? String(args.note).trim().slice(0, 2_000) : null;
      const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t).slice(0, 40)) : typeof args.tags === "string" ? String(args.tags).split(",").map((t) => t.trim()).filter(Boolean) : [];
      await deps.db.addTokenAnnotation(chainId, addr, verdict, note, tags).catch(() => undefined);
      return { ok: true, annotated: addr, verdict };
    }
    case "reverify_token": {
      const addr = normalizeAddr(args.address);
      if (!addr) return { error: "indirizzo token non valido" };
      const s = await compileSecurity(deps, addr);
      return "error" in s ? { error: s.error } : { ok: true, security: s };
    }
    case "token_annotations": {
      const addr = normalizeAddr(args.address);
      if (!addr) return { error: "indirizzo token non valido" };
      const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 50) : 20;
      const rows = await deps.db.listTokenAnnotations(chainId, addr, limit).catch(() => []);
      return { address: addr, count: rows.length, annotations: rows };
    }
    case "token_activity": {
      const addr = normalizeAddr(args.address);
      if (!addr) return { error: "indirizzo token non valido" };
      const wallet = deps.config.WALLET_ADDRESS as string | undefined;
      if (!wallet) return { error: "nessun wallet configurato" };
      const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 50) : 20;
      const [acts, meta] = await Promise.all([
        deps.db.walletActivityForToken(chainId, wallet, addr, limit).catch(() => []),
        deps.db.tokenMeta(chainId, [addr]).catch(() => new Map())
      ]);
      const dec = (meta as Map<string, { decimals: number | null }>).get(addr)?.decimals ?? null;
      const list = acts as Array<{ direction: string; valueRaw: string; txHash: string; blockNumber: string; at: string }>;
      return {
        address: addr,
        count: list.length,
        interactions: list.map((a) => ({ direction: a.direction, value: dec != null ? Number(a.valueRaw) / 10 ** dec : a.valueRaw, tx: a.txHash, block: a.blockNumber, at: a.at })),
        note: list.length ? "trasferimenti in/out del nostro wallet per questo token" : "mai interagito con questo token"
      };
    }
    case "find_tokens": {
      const mode = ["recent", "symbol", "verdict", "most_pools"].includes(String(args.mode)) ? String(args.mode) as "recent" | "symbol" | "verdict" | "most_pools" : "recent";
      if (mode === "symbol" && !String(args.query ?? "").trim()) return { error: "mode=symbol richiede 'query' (il simbolo)" };
      if (mode === "verdict" && !["avoid", "watch", "candidate", "neutral"].includes(String(args.verdict))) return { error: "mode=verdict richiede 'verdict' valido" };
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const results = await deps.db.searchTokens(chainId, { mode, query: args.query != null ? String(args.query) : undefined, verdict: args.verdict != null ? String(args.verdict) : undefined, limit }).catch(() => []);
      return { mode, count: results.length, results, hint: "usa search_token(address) per il dossier completo di uno di questi" };
    }
    case "sync_address": {
      const addr = normalizeAddr(args.address);
      if (!addr) return { error: "indirizzo non valido" };
      if (!deps.blockscout.available) return { error: "Blockscout non disponibile" };
      const info = await deps.blockscout.addressInfo(addr).catch(() => null);
      if (!info) return { error: "nessun dato da Blockscout per questo indirizzo (non indicizzato o non-token)" };
      const chain = { ...info, source: "blockscout", syncedAt: nowIso() };
      await deps.db.setTokenChainData(chainId, addr, chain).catch(() => undefined);
      return { ok: true, address: addr, chain };
    }
    default:
      return { error: `strumento token sconosciuto '${name}'` };
  }
}

function nowIso(): string { return new Date().toISOString(); }
