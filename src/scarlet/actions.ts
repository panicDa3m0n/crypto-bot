import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { getAddress, type Address } from "viem";
import type { ToolDeps } from "./tools.js";

/**
 * Scarlet's ACTION tools — how she actually takes positions. Design principle: the AGENT declares simple
 * INTENT (which token, how much, optional stop/target); the deterministic SYSTEM fills in everything else
 * — best pool/route, slippage & minAmountOut, gas, token approval, native→WETH wrap, the honeypot
 * (sellability) gate, entity creation, and continuous SL/TP/partial management. She never builds a
 * transaction, computes an amount in wei, or picks a fee tier. She says "buy $X of TOKEN"; the engine
 * (PositionManager) does the rest on its next tick and wakes her on fill/exit.
 *
 * Safety without over-caution: refuse only a token we can't SELL (honeypot) or sizes outside the bounds
 * — never refuse a real opportunity merely because it's new or volatile.
 */
export const ACTION_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "open_position",
      description: "Apri una posizione: COMPRA un token. NON scegli la size in dollari — il sistema la DIMENSIONA come un trader umano, in base al RISCHIO: rischia una % del NAV, e la size = rischio / distanza-dello-stop (stop stretto → size maggiore). Poi la limita per concentrazione (qualità/liquidità del token) e per il CALORE totale di portafoglio (quante posizioni-a-rischio hai già aperte). Tu dai: stopLossPct (OBBLIGATORIO — definisce la size), takeProfitPct, e conviction (low|medium|high = quanto osare). Il sistema fa rotta/slippage/gas/approve/wrap, verifica l'anti-honeypot, gestisce stop/target, e ti dice la size calcolata + il perché. limitPrice opzionale.",
      parameters: { type: "object", additionalProperties: false, properties: {
        token: { type: "string", description: "indirizzo del token da comprare (0x…)" },
        stopLossPct: { type: "number", description: "OBBLIGATORIO: stop-loss in % sotto l'entry (es. 30). Definisce la size dal rischio." },
        takeProfitPct: { type: "number", description: "take-profit in % sopra l'entry (es. 50)" },
        conviction: { type: "string", enum: ["low", "medium", "high"], description: "quanto rischiare su questa idea (default medium)" },
        limitPrice: { type: "number", description: "prezzo USD limite d'ingresso: compra solo se ≤ questo (opzionale = compra subito)" }
      }, required: ["token", "stopLossPct"] }
    }
  },
  {
    type: "function",
    function: {
      name: "close_position",
      description: "Chiudi (vendi) una posizione aperta, tutta o in parte. Il sistema vende al prossimo tick per la rotta migliore e aggiorna la posizione. Usa l'id dalla briefing (positions/plans).",
      parameters: { type: "object", additionalProperties: false, properties: {
        positionId: { type: "number", description: "id della posizione da chiudere" },
        pct: { type: "number", description: "percentuale da vendere (default 100 = tutta)" }
      }, required: ["positionId"] }
    }
  },
  {
    type: "function",
    function: {
      name: "adjust_position",
      description: "Modifica lo stop-loss e/o il take-profit di una posizione aperta (il sistema riarma automaticamente). Usa l'id dalla briefing.",
      parameters: { type: "object", additionalProperties: false, properties: {
        positionId: { type: "number", description: "id della posizione" },
        stopLossPct: { type: "number", description: "nuovo stop-loss % (ometti per non cambiarlo)" },
        takeProfitPct: { type: "number", description: "nuovo take-profit % (ometti per non cambiarlo)" }
      }, required: ["positionId"] }
    }
  }
];

export function isActionTool(name: string): boolean {
  return ["open_position", "close_position", "adjust_position"].includes(name);
}

function normalizeAddr(v: unknown): string | null {
  try { return getAddress(String(v ?? "").trim()).toLowerCase(); } catch { return null; }
}
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export async function dispatchActionTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<unknown> {
  const chainId = deps.config.CHAIN_ID;
  switch (name) {
    case "open_position": {
      const cfg = deps.config;
      const token = normalizeAddr(args.token);
      if (!token) return { error: "indirizzo token non valido" };
      const stopLossPct = numOrNull(args.stopLossPct);
      if (stopLossPct == null || stopLossPct < 1 || stopLossPct >= 100) return { error: "stopLossPct obbligatorio (1–99): è ciò che determina la size dal rischio" };
      const takeProfitPct = numOrNull(args.takeProfitPct);
      const conviction = ["low", "medium", "high"].includes(String(args.conviction)) ? String(args.conviction) : "medium";
      const convMult = conviction === "low" ? 0.5 : conviction === "high" ? 1.6 : 1;

      const nav = (await deps.db.latestPortfolio().catch(() => undefined))?.estimatedNavUsd ?? 0;
      if (!(nav > 0)) return { error: "NAV non disponibile ora — riprova al prossimo ciclo" };
      const openPlans = await deps.db.activePositionPlans(chainId).catch(() => []);
      // ONE strategy per token: a token can't have two open plans. Modify/close the existing one first.
      const existing = openPlans.find((p) => p.token.toLowerCase() === token);
      if (existing) return { error: `hai GIÀ una strategia su ${existing.symbol ?? token.slice(0, 8)} (#${existing.id}, stato ${existing.status}) — un token può avere UNA sola strategia. Modificala con adjust_position (o chiudila con close_position) prima di aprirne un'altra.` };
      if (openPlans.length >= cfg.POSITION_MAX_OPEN) return { error: `già ${openPlans.length} posizioni aperte (tetto di sanità ${cfg.POSITION_MAX_OPEN}) — chiudine una` };

      // HONEYPOT GATE — the only hard refusal: a token we cannot SELL. Cross-venue buy+sell route check.
      const check = await deps.primitives.checkToken(token as Address).catch((e) => ({ error: (e instanceof Error && e.message) ? e.message : String(e || "errore verifica") } as { error: string }));
      if ("error" in check) return { error: `verifica rotte fallita: ${check.error}. Non apro alla cieca.` };
      if (!check.buyable) return { error: `non comprabile ora: ${check.reasons.join("; ") || "nessuna rotta"} — se transitorio, riprova.` };
      if (!check.canSell) return { refused: true, reason: "HONEYPOT — nessuna rotta di vendita mentre l'acquisto è possibile. Non apro.", detail: check.reasons };

      // HUMAN-STYLE SIZING. size = risk / stop-distance; then cap by concentration (token quality), by
      // pool liquidity (clean exit), by absolute ceiling, and by total portfolio HEAT (open risk budget).
      const stats = await deps.db.tokenStats(chainId, token).catch(() => null);
      const liq = stats?.liqUsd ?? null;
      const isFresh = liq == null || liq < 150_000; // thin/low-liq = fresh-launch risk regime; deep = quality
      const stopFrac = stopLossPct / 100;
      const riskUsd = nav * (cfg.POSITION_RISK_PCT / 100) * convMult;
      let size = riskUsd / stopFrac;
      const caps: string[] = [];
      const concCap = nav * ((isFresh ? cfg.POSITION_MAX_NAV_PCT_FRESH : cfg.POSITION_MAX_NAV_PCT_QUALITY) / 100);
      if (size > concCap) { size = concCap; caps.push(`concentrazione ${isFresh ? "fresh 15%" : "quality 30%"} NAV`); }
      if (liq != null && liq > 0) { const liqCap = liq * (cfg.POSITION_MAX_LIQ_PCT / 100); if (size > liqCap) { size = liqCap; caps.push(`≤${cfg.POSITION_MAX_LIQ_PCT}% liquidità`); } }
      if (size > cfg.POSITION_MAX_USD) { size = cfg.POSITION_MAX_USD; caps.push(`tetto assoluto $${cfg.POSITION_MAX_USD}`); }
      const openRisk = openPlans.reduce((s, p) => s + (p.entryAmountUsd || 0) * ((p.stopLossPct ?? 100) / 100), 0);
      const heatBudget = nav * (cfg.PORTFOLIO_HEAT_PCT / 100);
      if (openRisk + size * stopFrac > heatBudget) { size = Math.max(0, (heatBudget - openRisk) / stopFrac); caps.push("calore di portafoglio"); }
      size = Math.round(size * 100) / 100;
      if (size < cfg.POSITION_MIN_USD) return { error: `budget di rischio quasi esaurito (rischio aperto ~$${openRisk.toFixed(1)} su $${heatBudget.toFixed(1)}). Chiudi una posizione, oppure usa conviction più alta / stop più stretto.` };

      const meta = (await deps.db.tokenMeta(chainId, [token]).catch(() => new Map())).get(token) as { symbol: string | null } | undefined;
      const entryKind = numOrNull(args.limitPrice) ? "limit" : "now";
      const id = await deps.db.createPositionPlan({
        chainId, token, symbol: meta?.symbol ?? null, baseToken: (cfg.WBERA_ADDRESS as string).toLowerCase(),
        entryKind, entryPrice: numOrNull(args.limitPrice), entryAmountUsd: size,
        stopLossPct, takeProfitPct, partials: [], note: `Scarlet (${conviction})`
      }).catch((e) => ({ error: (e instanceof Error && e.message) ? e.message : String(e || "errore DB sconosciuto") }));
      if (typeof id !== "number") return { error: `creazione posizione fallita: ${(id as { error: string }).error || "errore sconosciuto"}` };
      return { ok: true, positionId: id, symbol: meta?.symbol ?? null, sizeUsd: size, conviction,
        tier: isFresh ? "fresh" : "quality", riskUsd: Math.round(riskUsd * 100) / 100,
        entry: entryKind === "now" ? "subito" : `limit ≤ $${numOrNull(args.limitPrice)}`, stopLossPct, takeProfitPct,
        message: `Size $${size} = ${cfg.POSITION_RISK_PCT}%×${conviction} del NAV rischiato / stop ${stopLossPct}%${caps.length ? `, limitata da: ${caps.join(", ")}` : ""}. Il sistema esegue e gestisce stop/target.` };
    }

    case "close_position": {
      const id = Number(args.positionId);
      if (!Number.isInteger(id)) return { error: "positionId non valido" };
      const plan = await deps.db.getPositionPlan(id).catch(() => undefined);
      if (!plan || plan.chainId !== chainId) return { error: `posizione #${id} non trovata` };
      if (["closed", "cancelled"].includes(plan.status)) return { error: `posizione #${id} già ${plan.status}` };
      const pct = Math.min(100, Math.max(1, numOrNull(args.pct) ?? 100));
      const spent = plan.filledPrice != null && plan.remainingPct > 0; // funds emitted → must recover
      if (spent) {
        // Sell to RECOVER the credit — routed through the engine's deterministic exit (retries if transient).
        await deps.db.updatePositionPlan(id, { status: "open", exitNowPct: pct });
        return { ok: true, positionId: id, recovering: true, message: `Recupero credito: il sistema vende ${pct}% di ${plan.symbol ?? "questa posizione"} al prossimo tick e riaccredita il ricavato.` };
      }
      // Never filled → just cancel; no funds were spent.
      await deps.db.updatePositionPlan(id, { status: "cancelled", exitNowPct: null, lastResult: "annullata da Scarlet (mai riempita — nessun credito da recuperare)" });
      return { ok: true, positionId: id, cancelled: true, message: `Strategia #${id} annullata: non era stata riempita, nessun fondo speso.` };
    }

    case "adjust_position": {
      const id = Number(args.positionId);
      if (!Number.isInteger(id)) return { error: "positionId non valido" };
      const plan = await deps.db.getPositionPlan(id).catch(() => undefined);
      if (!plan || plan.chainId !== chainId) return { error: `posizione #${id} non trovata` };
      if (["closed", "cancelled"].includes(plan.status)) return { error: `posizione #${id} già ${plan.status}` };
      const sl = numOrNull(args.stopLossPct), tp = numOrNull(args.takeProfitPct);
      const unblock = plan.status === "error"; // adjusting an errored strategy UNBLOCKS it (retry)
      if (sl == null && tp == null && !unblock) return { error: "specifica almeno stopLossPct o takeProfitPct" };
      const resume = unblock ? { status: plan.filledPrice != null ? "open" : "entering", entryAttempts: 0, exitNowPct: null } : {};
      await deps.db.updatePositionPlan(id, { ...(sl != null ? { stopLossPct: sl } : {}), ...(tp != null ? { takeProfitPct: tp } : {}), ...resume });
      return { ok: true, positionId: id, unblocked: unblock, stopLossPct: sl ?? plan.stopLossPct, takeProfitPct: tp ?? plan.takeProfitPct,
        message: unblock ? "Strategia SBLOCCATA e rimessa in esecuzione dal sistema (con lo stop/target aggiornati)." : "Stop/target aggiornati e riarmati." };
    }

    default:
      return { error: `azione sconosciuta '${name}'` };
  }
}
