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
      description: "Apri una posizione: COMPRA un token. Dichiari solo l'intento — il sistema sceglie pool/rotta, slippage, gas, approva, wrappa WETH, verifica la vendibilità (anti-honeypot) e poi gestisce da solo stop-loss / take-profit. Usa sizeUsd in dollari. stopLossPct/takeProfitPct opzionali (es. 30 = -30% stop / +30% target). limitPrice opzionale: compra solo se il prezzo scende ≤ limitPrice (altrimenti compra subito). Ritorna l'id posizione; il sistema esegue al prossimo tick e ti sveglia al fill.",
      parameters: { type: "object", additionalProperties: false, properties: {
        token: { type: "string", description: "indirizzo del token da comprare (0x…)" },
        sizeUsd: { type: "number", description: "quanto investire, in USD" },
        stopLossPct: { type: "number", description: "stop-loss in % sotto l'entry (opzionale, es. 30)" },
        takeProfitPct: { type: "number", description: "take-profit in % sopra l'entry (opzionale, es. 50)" },
        limitPrice: { type: "number", description: "prezzo USD limite d'ingresso: compra solo se ≤ questo (opzionale = compra subito)" }
      }, required: ["token", "sizeUsd"] }
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
      const token = normalizeAddr(args.token);
      if (!token) return { error: "indirizzo token non valido" };
      const sizeUsd = Number(args.sizeUsd);
      if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return { error: "sizeUsd deve essere un numero positivo" };
      const min = deps.config.POSITION_MIN_USD, max = deps.config.POSITION_MAX_USD;
      if (sizeUsd < min) return { error: `size troppo piccola: minimo $${min}` };
      if (sizeUsd > max) return { error: `size oltre il limite di sicurezza per posizione ($${max}). Riduci sizeUsd o apri in più tranche.` };
      const open = await deps.db.countOpenPositionPlans(chainId).catch(() => 0);
      if (open >= deps.config.POSITION_MAX_OPEN) return { error: `hai già ${open} posizioni aperte (max ${deps.config.POSITION_MAX_OPEN}). Chiudine una prima.` };

      // HONEYPOT GATE — the only hard refusal: a token we cannot SELL. Cross-venue buy+sell route check.
      const check = await deps.primitives.checkToken(token as Address).catch((e) => ({ error: (e instanceof Error && e.message) ? e.message : String(e || "errore verifica") } as { error: string }));
      if ("error" in check) return { error: `verifica rotte fallita: ${check.error}. Non apro alla cieca.` };
      if (!check.buyable) return { error: `non comprabile ora: ${check.reasons.join("; ") || "nessuna rotta"} — se transitorio, riprova.` };
      if (!check.canSell) return { refused: true, reason: "HONEYPOT — nessuna rotta di vendita mentre l'acquisto è possibile. Non apro.", detail: check.reasons };

      const meta = (await deps.db.tokenMeta(chainId, [token]).catch(() => new Map())).get(token) as { symbol: string | null } | undefined;
      const entryKind = numOrNull(args.limitPrice) ? "limit" : "now";
      const id = await deps.db.createPositionPlan({
        chainId, token, symbol: meta?.symbol ?? null, baseToken: (deps.config.WBERA_ADDRESS as string).toLowerCase(),
        entryKind, entryPrice: numOrNull(args.limitPrice), entryAmountUsd: sizeUsd,
        stopLossPct: numOrNull(args.stopLossPct), takeProfitPct: numOrNull(args.takeProfitPct), partials: [], note: "aperta da Scarlet"
      }).catch((e) => ({ error: (e instanceof Error && e.message) ? e.message : String(e || "errore DB sconosciuto") }));
      if (typeof id !== "number") return { error: `creazione posizione fallita: ${(id as { error: string }).error || "errore sconosciuto"}` };
      return { ok: true, positionId: id, symbol: meta?.symbol ?? null, sizeUsd,
        entry: entryKind === "now" ? "subito" : `limit ≤ $${numOrNull(args.limitPrice)}`,
        stopLossPct: numOrNull(args.stopLossPct), takeProfitPct: numOrNull(args.takeProfitPct),
        message: "Intento registrato. Il sistema esegue l'entry al prossimo tick (rotta/slippage/gas/wrap automatici) e gestirà stop/target. Ti sveglierà al fill." };
    }

    case "close_position": {
      const id = Number(args.positionId);
      if (!Number.isInteger(id)) return { error: "positionId non valido" };
      const plan = await deps.db.getPositionPlan(id).catch(() => undefined);
      if (!plan || plan.chainId !== chainId) return { error: `posizione #${id} non trovata` };
      if (plan.status !== "open") return { error: `posizione #${id} non è aperta (stato: ${plan.status}) — nulla da vendere` };
      const pct = Math.min(100, Math.max(1, numOrNull(args.pct) ?? 100));
      await deps.db.updatePositionPlan(id, { exitNowPct: pct });
      return { ok: true, positionId: id, message: `Il sistema venderà ${pct}% di ${plan.symbol ?? "questa posizione"} al prossimo tick e ti aggiornerà.` };
    }

    case "adjust_position": {
      const id = Number(args.positionId);
      if (!Number.isInteger(id)) return { error: "positionId non valido" };
      const plan = await deps.db.getPositionPlan(id).catch(() => undefined);
      if (!plan || plan.chainId !== chainId) return { error: `posizione #${id} non trovata` };
      const sl = numOrNull(args.stopLossPct), tp = numOrNull(args.takeProfitPct);
      if (sl == null && tp == null) return { error: "specifica almeno stopLossPct o takeProfitPct" };
      await deps.db.updatePositionPlan(id, { ...(sl != null ? { stopLossPct: sl } : {}), ...(tp != null ? { takeProfitPct: tp } : {}) });
      return { ok: true, positionId: id, stopLossPct: sl ?? plan.stopLossPct, takeProfitPct: tp ?? plan.takeProfitPct, message: "Stop/target aggiornati e riarmati dal sistema." };
    }

    default:
      return { error: `azione sconosciuta '${name}'` };
  }
}
