import type { Address } from "viem";
import type { Config } from "../config.js";
import type { Database } from "../db.js";
import type { PositionService } from "../positions.js";
import type { SelfState } from "../self.js";
import { selfContext } from "../self.js";
import { computeGains } from "../gains.js";

/**
 * The TRADING briefing — the focused world Scarlet-trader perceives each activation. It is a strict
 * subset of the legacy `perception.brief`: only what the mission needs (self/capital, own positions +
 * wallet, programmed plans, watchlist, token-discovery signals, memory, known tokens). It deliberately
 * OMITS the liquidation surface, flash-liquidation watchers, DEX arb hints and the atomic-organ map —
 * those are separate autonomous engines, not the trader's concern. Everything is read from the DB (the
 * deterministic lanes persist it), so there is NO live RPC / API call in the thinking path.
 */
export type TradingBriefing = {
  fingerprint: string;
  chainHead: string;
  gains: unknown;
  self: unknown;
  temperament: SelfState["temperament"];
  positions: unknown;
  plans: unknown;
  watchlist: unknown;
  discovery: unknown;
  memory: unknown;
  registry: unknown;
  guidance: string;
};

const r2 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
const r4 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0);

export async function buildTradingBriefing(db: Database, positionsSvc: PositionService, config: Config, self: SelfState): Promise<TradingBriefing> {
  // Chain head from the persisted network observation (no live getBlockNumber).
  const netObs = await db.latestNetworkObservation().catch(() => undefined);
  const chainHead = (netObs?.primaryBlock ?? 0n).toString();

  // Own positions + full wallet awareness (from the walletHoldings DB lane — no live RPC).
  const positionsRaw = await db.activePositions();
  const holdings = self.wallet ? await positionsSvc.walletHoldings(self.wallet as Address).catch(() => []) : [];
  const tracked = new Set(positionsRaw.map((p) => p.assetAddress.toLowerCase()));
  const untracked = holdings.filter((h) => !tracked.has(h.token.toLowerCase())).map((h) => ({ token: h.token, symbol: h.symbol, balance: r4(h.balance), valueUsd: r2(h.valueUsd), note: "posseduto ma non tracciato — apri una posizione (con tesi) se conta, oppure vendilo" }));
  const positions = {
    note: positionsRaw.length
      ? "Le tue posizioni con P&L live (valore attuale vs entry, riconciliato on-chain). pnl<0 = ci stai perdendo. Gestiscile: aggiorna la tesi, esci quando serve."
      : "Nessuna posizione tracciata. Quando ne apri una, registra una tesi così la te-futura ricorda il PERCHÉ.",
    held: positionsRaw.map((p) => ({ id: p.id, kind: p.kind, label: p.label, thesis: p.thesisNote, asset: p.assetAddress, entryUsd: r2(p.entryValueUsd), valueUsd: r2(p.valueUsd), pnlUsd: r4(p.pnlUsd), pnlPct: r2(p.pnlPct), openedAt: p.openedAt })),
    ...(untracked.length ? { untrackedHoldings: untracked } : {})
  };

  // Programmed positions the deterministic manager auto-executes (entry/stop-loss/take-profit/partials).
  const plansRaw = await db.activePositionPlans(config.CHAIN_ID).catch(() => []);
  const plans = {
    note: plansRaw.length ? "Le tue posizioni PROGRAMMATE che il sistema esegue per te ai prezzi live (entry/stop/take)." : "Nessuna posizione programmata. Usa un piano così il sistema gestisce entry ed uscite senza che tu vigili.",
    list: plansRaw.map((p) => ({ id: p.id, symbol: p.symbol, status: p.status, entryKind: p.entryKind, entryPrice: p.entryPrice, amountUsd: p.entryAmountUsd, filledPrice: p.filledPrice, remainingPct: p.remainingPct, stopLossPct: p.stopLossPct, takeProfitPct: p.takeProfitPct, lastResult: p.lastResult }))
  };

  // Watchlist — placeholder until the dedicated gradino (token tenuti d'occhio con tesi + trigger).
  const watchlist = { note: "Watchlist non ancora attiva (arriva nel gradino dedicato).", items: [] as unknown[] };

  // Token DISCOVERY — candidates that might rise: fresh launches, momentum, trending volume, smart-money
  // accumulation. Trimmed of the arb-specific and liquidation fields the trader doesn't act on.
  const [gradSnap, flowSnap, whaleSnap, freshLaunches] = await Promise.all([
    db.latestMarketSnapshot<{ momentum: unknown[]; note: string }>("graduation", "recent").catch(() => undefined),
    db.latestMarketSnapshot<{ topByVolume: unknown[]; trending: unknown[]; hotPools: unknown[] }>("flow", "recent").catch(() => undefined),
    db.latestMarketSnapshot<{ accumulatingNow: unknown[] }>("whale", "recent").catch(() => undefined),
    db.recentDiscoveredPools(180, 12).catch(() => [])
  ]);
  const discovery = {
    note: "Segnali di scoperta token (candidati che POTREBBERO salire). Prima di comprare: verifica honeypot, guarda il grafico, entra piccolo, imposta uno stop. (Strumenti in arrivo nei prossimi gradini.)",
    freshLaunches: freshLaunches.length ? freshLaunches.map((p) => ({ symbol: p.newSymbol, token: p.newToken, dex: p.dex, liquidityUsd: p.liquidityUsd, at: p.discoveredAt })) : "nessun lancio recente",
    momentum: gradSnap?.momentum ?? [],
    trending: flowSnap?.trending ?? [],
    topByVolume: flowSnap?.topByVolume ?? [],
    hotPools: flowSnap?.hotPools ?? [],
    whaleAccumulation: whaleSnap?.accumulatingNow ?? []
  };

  // Memory: recent decisions + saved-notes index.
  const recentDecisions = (await db.recentDecisions(5).catch(() => [])).map((d) => ({ action: (d as { decision?: { action?: string } }).decision?.action, strategy: (d as { decision?: { strategyId?: string } }).decision?.strategyId, status: (d as { status?: string }).status }));
  const notebook = await db.memoryIndex(80).catch(() => []);
  const memory = {
    recentDecisions,
    notebook: notebook.length
      ? { note: "Le tue note salvate — apri con recall(key); salva/aggiorna con remember(key, content, category).", index: notebook.map((m) => ({ key: m.key, category: m.category })) }
      : "Notebook vuoto. Usa remember(key, content) per salvare token, indirizzi, idee e tesi."
  };

  // Known tokens/entities (address-keyed knowledge base).
  const known = await db.listEntities(config.CHAIN_ID, { status: "active", limit: 60 }).catch(() => []);
  const registry = {
    note: "I token/entità che GIÀ conosci (address-keyed). Non ri-scoprirli, costruisci su questi.",
    count: known.length,
    entities: known.map((e) => ({ address: e.address, kind: e.kind, symbol: e.symbol, note: e.note }))
  };

  // Self-drive: baseline (captured once), current NAV, progress to the next milestone.
  const currentNav = self.netWorthHoney;
  let baseline = await db.latestMarketSnapshot<{ navUsd: number }>("scarlet", "baseline").catch(() => undefined);
  if (!baseline || !(baseline.navUsd > 0)) { baseline = { navUsd: currentNav }; await db.saveMarketSnapshot("scarlet", "baseline", baseline).catch(() => undefined); }
  const ledger = await db.ledgerSummary().catch(() => ({ netUsd: 0, gasUsd: 0 }));
  const milestones = config.PROFIT_MILESTONES.split(",").map((m) => Number(m.trim())).filter((n) => n > 0);
  const gains = computeGains(currentNav, baseline.navUsd, ledger.netUsd, milestones);

  const guidance = self.temperament === "exploit"
    ? "Sei affamata (net worth basso). Prendi le azioni più sicure a net positivo per ricostruirlo; spendi poca energia sulla frontiera."
    : self.temperament === "explore"
      ? "Net worth comodo. Sonda qualche segnale token nuovo oltre al solito, non solo il familiare."
      : "Bilanciata. Persegui profitto solido e sonda almeno un segnale nuovo per ciclo. Non fossilizzarti.";

  // Trading material-state fingerprint: positions, untracked holdings, plans, fresh launches. Idle-backoff
  // grows while these are unchanged; snaps back the instant something material moves.
  const fingerprint = JSON.stringify({
    pos: positionsRaw.map((p) => p.id).sort(),
    hold: untracked.map((h) => h.token).sort(),
    plans: plansRaw.map((p) => `${p.id}:${p.status}`).sort(),
    fresh: (Array.isArray(freshLaunches) ? freshLaunches : []).map((p) => p.newToken).sort()
  });

  return { fingerprint, chainHead, gains, self: selfContext(self), temperament: self.temperament, positions, plans, watchlist, discovery, memory, registry, guidance };
}
