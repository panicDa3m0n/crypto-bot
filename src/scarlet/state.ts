import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { Database } from "../db.js";
import type { Config } from "../config.js";

/** The operative states (strategies) Scarlet can enter. Add a strategy → add a state + its /strategy file. */
export const OPERATIVE_STATES = ["bluechip", "launchtoken"] as const;
export type OperativeState = typeof OPERATIVE_STATES[number];
const BLUECHIP_LIQ = 150_000; // liquidity floor that separates a bluechip/quality token from a fresh launch

/** Control tools for the state machine. `set_state` routes the turn; `set_next_note` seeds the next turn;
 * `expand` opens a summary branch fully during activation. They are dispatched by the agent (control flow). */
export const STATE_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "set_state",
      description: "Scegli/cambia lo STATO OPERATIVO (la strategia su cui operare). Obbligatorio per concludere la fase di attivazione. Puoi richiamarlo anche durante l'operatività per passare a un'altra strategia. La giustificazione (una frase concreta: quale evidenza nei dati lo motiva) viene loggata e mostrata in dashboard.",
      parameters: { type: "object", additionalProperties: false, properties: {
        state: { type: "string", enum: [...OPERATIVE_STATES], description: "lo stato operativo" },
        justification: { type: "string", description: "perché questo stato ORA (evidenza concreta)" }
      }, required: ["state", "justification"] }
    }
  },
  {
    type: "function",
    function: {
      name: "set_next_note",
      description: "Solo in fase CONCLUSIVA: prepara una nota per il tuo prossimo turno (ti sarà ripresentata come TUA ipotesi da rivalutare, non un ordine). Serve a impostare bene il prossimo risveglio ed evitare cicli identici.",
      parameters: { type: "object", additionalProperties: false, properties: { text: { type: "string", description: "l'indicazione per il prossimo turno" } }, required: ["text"] }
    }
  },
  {
    type: "function",
    function: {
      name: "expand",
      description: "Espandi COMPLETAMENTE un ramo dei dati riassuntivi per esaminarlo (solo lettura, utile in attivazione prima di scegliere lo stato). Rami: launches | bluechip | launchtoken | positions | blocked.",
      parameters: { type: "object", additionalProperties: false, properties: { branch: { type: "string", enum: ["launches", "bluechip", "launchtoken", "positions", "blocked"], description: "quale ramo aprire" } }, required: ["branch"] }
    }
  }
];

export function isStateTool(name: string): boolean { return name === "set_state" || name === "set_next_note" || name === "expand"; }

/** Compact cross-turn summary for the ACTIVATION phase — quick evidence to route the turn, expandable. */
export async function buildActivationSummary(db: Database, config: Config): Promise<Record<string, unknown>> {
  const chainId = config.CHAIN_ID;
  const [launches, opps, plans, blocked] = await Promise.all([
    db.recentDiscoveredPools(120, 6).catch(() => []),
    db.topOpportunities(chainId, { windowMin: 30, limit: 40 }).catch(() => []),
    db.activePositionPlans(chainId).catch(() => []),
    db.erroredPositionPlans(chainId).catch(() => [])
  ]);
  const big = opps.filter((o) => o.liqUsd != null && o.liqUsd > BLUECHIP_LIQ);
  const bluechipMovers = big.slice().sort((a, b) => Math.abs(b.change1h ?? 0) - Math.abs(a.change1h ?? 0)).slice(0, 5)
    .map((o) => ({ symbol: o.symbol, chg1h: o.change1h != null ? Math.round(o.change1h * 10) / 10 : null, netFlowUsd: o.netFlow1h }));
  const freshCount = opps.filter((o) => o.bucket === "fresh").length;
  return {
    ultimiLanci: launches.length ? launches.map((p) => ({ symbol: p.newSymbol, token: p.newToken, liqUsd: p.liquidityUsd })) : "nessuno recentissimo",
    bluechipInMovimento: bluechipMovers.length ? bluechipMovers : "nessun bluechip in movimento marcato",
    lanciAttiviInMomentum: freshCount,
    tuePosizioni: plans.length ? { aperte: plans.length, simboli: plans.map((p) => `${p.symbol ?? "?"}(#${p.id}:${p.status})`) } : "nessuna posizione aperta",
    strategieInErrore: blocked.length ? blocked.map((p) => `${p.symbol ?? "?"}(#${p.id})`) : "nessuna",
    espandibili: "usa expand(branch) con: launches | bluechip | launchtoken | positions | blocked"
  };
}

/** Full detail of one summary branch (for `expand`). */
export async function expandBranch(db: Database, config: Config, branch: string): Promise<unknown> {
  const chainId = config.CHAIN_ID;
  if (branch === "launches") return db.recentDiscoveredPools(240, 20).catch(() => []);
  if (branch === "positions") return { active: await db.activePositionPlans(chainId).catch(() => []) };
  if (branch === "blocked") return db.erroredPositionPlans(chainId).catch(() => []);
  const opps = await db.topOpportunities(chainId, { windowMin: 60, limit: 40 }).catch(() => []);
  if (branch === "bluechip") return opps.filter((o) => o.liqUsd != null && o.liqUsd > BLUECHIP_LIQ);
  if (branch === "launchtoken") return opps.filter((o) => o.bucket === "fresh" || (o.liqUsd != null && o.liqUsd <= BLUECHIP_LIQ));
  return { error: "ramo sconosciuto" };
}

/** State-specific data ADDED to the summary in the OPERATIVE phase (she keeps the general summary too). */
export async function buildOperativeData(db: Database, config: Config, state: OperativeState): Promise<Record<string, unknown>> {
  const chainId = config.CHAIN_ID;
  const opps = await db.topOpportunities(chainId, { windowMin: 30, limit: 40 }).catch(() => []);
  if (state === "launchtoken") {
    const justLaunched = await db.recentDiscoveredPools(120, 10).catch(() => []);
    return {
      note: "Feed lanci freschi (indexer). score alto = momentum+pressione buona; ⚠️ liqChg1h molto negativo = liquidità in prosciugamento (rug).",
      opportunita: opps.filter((o) => o.bucket === "fresh" || (o.liqUsd != null && o.liqUsd <= BLUECHIP_LIQ)).slice(0, 14),
      appenaCreati: justLaunched.map((p) => ({ symbol: p.newSymbol, token: p.newToken, liqUsd: p.liquidityUsd }))
    };
  }
  return {
    note: "Bluechip in movimento (liquidità profonda). Cerca setup reali (dip su supporto, breakout sostenuto) — niente churning.",
    bluechip: opps.filter((o) => o.liqUsd != null && o.liqUsd > BLUECHIP_LIQ).slice(0, 12)
  };
}
