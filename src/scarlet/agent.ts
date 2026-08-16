import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { BerachainClients } from "../chain.js";
import type { Database } from "../db.js";
import type { NetworkHealthSource } from "../health.js";
import type { PositionService } from "../positions.js";
import type { MarketData } from "../market-data.js";
import type { Primitives } from "../primitives.js";
import type { Blockscout } from "../blockscout.js";
import { COMPACTION_SYSTEM, type Chronicle } from "../chronicle.js";
import type { Llm } from "../llm.js";
import { selfState } from "../self.js";
import { buildTradingBriefing } from "./briefing.js";
import { VISION_TOOLS, dispatchVisionTool, isVisionTool, type ToolDeps } from "./tools.js";
import { TOKEN_TOOLS, dispatchTokenTool, isTokenTool } from "./tokens.js";
import { ACTION_TOOLS, dispatchActionTool, isActionTool } from "./actions.js";

const FALLBACK_PROMPT = "Sei Scarlet, un'agente di trading on-chain. Osserva il briefing, ragiona, annota o riposa.";
const WAKE_DEBOUNCE_MS = 5 * 60_000; // per-key debounce so a flapping position can't spam activations
/** The rebuilt trading core's OWN chronology stream — detached from the legacy agent's diary. Its
 * journal + compaction live here; the legacy 'main' history is not inherited. */
export const SCARLET_STREAM = "trader-v2";

/**
 * ScarletAgent — the rebuilt agentic core (Gradino 1: loop + activation only).
 *
 * Activation has two channels:
 *  - A (periodic heartbeat): the caller reschedules `live("continuous cycle")` every `nextGapMs`, which
 *    grows while the material state is unchanged (idle-backoff) and snaps back the instant it changes.
 *  - B (event wake): `wake(key, reason)` — a debounced reflex fired ONLY by the agent's own concerns
 *    (position events, watchlist triggers). Each activation is reason-first: the model is handed WHY it
 *    woke, foregrounded over the rest of the read-only briefing.
 *
 * This gradino carries a MINIMAL tool surface (`note`) — enough to prove the loop receives the briefing,
 * reasons, dispatches a tool, and rests. Trading tools / positions / the final prompt come next.
 */
export class ScarletAgent {
  private readonly systemPrompt: string;
  private living = false;
  private lastFingerprint = "";
  private idleStreak = 0;
  private readonly wokenAt = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly health: NetworkHealthSource,
    private readonly positions: PositionService,
    private readonly chronicle: Chronicle,
    private readonly llm: Llm,
    private readonly marketData: MarketData,
    private readonly primitives: Primitives,
    private readonly blockscout: Blockscout,
    private readonly logger: Logger
  ) {
    this.systemPrompt = loadPrompt(config.SCARLET_CORE_PROMPT_PATH);
    this.toolDeps = { config, db, marketData, primitives, blockscout };
  }

  private readonly toolDeps: ToolDeps;

  get available(): boolean { return this.llm.available; }

  /** Channel A cadence: base gap doubled per idle streak, capped. Snaps back to base on any real change. */
  get nextGapMs(): number {
    return Math.min(this.config.SCARLET_CYCLE_GAP_MS * 2 ** Math.min(this.idleStreak, 8), this.config.SCARLET_MAX_CYCLE_GAP_MS);
  }

  /** Channel B: a material event (own position / watchlist trigger) wakes the agent with its reason,
   * debounced per key so a flapping source can't spam it. */
  wake(key: string, reason: string): void {
    const now = Date.now();
    if (now - (this.wokenAt.get(key) ?? 0) < WAKE_DEBOUNCE_MS) return;
    this.wokenAt.set(key, now);
    void this.live(`evento — ${reason}`).catch((error) => this.logger.error({ err: error, key }, "Scarlet(v2) event activation failed"));
  }

  /** One activation: perceive (reason-first briefing from the DB), reason over tool rounds, rest. */
  async live(reason: string): Promise<void> {
    if (!this.available) { this.logger.info({ reason }, "Scarlet(v2) cannot wake: LLM not configured"); return; }
    if (this.living) { this.logger.debug({ reason }, "Scarlet(v2) already awake; skipping re-entry"); return; }
    this.living = true;
    const t0 = Date.now();
    const cycle = randomUUID().slice(0, 8);
    try {
      await this.health.refresh();
      // Wallet/NAV from the DB — the walletHoldings service owns it (Transfer scan + balanceOf on touched
      // tokens) and persists it. NO live RPC in the thinking path: recomputing chain.portfolio() every
      // activation was 6 RPC calls/cycle on the shared public RPC → the eth_getBalance rate-limit. We
      // bootstrap live only if no snapshot exists yet; reconcile re-values OPEN positions (RPC only when
      // we actually hold some — none in this gradino).
      const dailyLoss = await this.db.dailyLossUsd().catch(() => 0);
      const persisted = await this.db.latestPortfolio().catch(() => undefined);
      const base = persisted
        ? { ...persisted, dailyLossUsd: dailyLoss, dataHealthy: this.health.dataHealthy }
        : await this.chain.portfolio(dailyLoss, this.health.dataHealthy);
      const portfolio = await this.positions.reconcile(base);
      const self = selfState(portfolio, this.config);
      // Focused TRADING briefing (subset of the legacy perception; DB-read, no liquidation/arb noise).
      const briefing = await buildTradingBriefing(this.db, this.positions, this.config, self);
      // Idle-backoff: unchanged material fingerprint → grow the streak (slower cadence); any change resets.
      const { fingerprint, ...world } = briefing;
      if (fingerprint === this.lastFingerprint) this.idleStreak += 1; else this.idleStreak = 0;
      this.lastFingerprint = fingerprint;
      const history = await this.chronicle.loadContext().catch(() => ({ text: "", tokens: 0, freshCount: 0 }));

      this.logger.info({ reason, cycle, idleStreak: this.idleStreak, nextGapMs: this.nextGapMs, briefingKeys: Object.keys(world), historyTokens: history.tokens, buildMs: Date.now() - t0 }, "Scarlet(v2) activation");

      // Reason-first: the wake reason leads the payload so the model focuses on WHY it's awake.
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: this.systemPrompt },
        ...(history.text ? [{ role: "user" as const, content: `LA TUA STORIA (continuità tra i cicli):\n\n${history.text}` }] : []),
        { role: "user", content: JSON.stringify({ reason, now: new Date().toISOString(), executionEnabled: this.config.EXECUTION_ENABLED, briefing: world, instruction: "Parti dal 'reason'. Osserva il briefing, continua dalla tua storia. Se c'è qualcosa di materiale da annotare, usa 'note'; altrimenti riposa (nessuno strumento)." }) }
      ];

      // Cycle-start marker for the dashboard timeline: WHY she woke (the wake reason).
      await this.db.addJournal("cycle", reason, { idleStreak: this.idleStreak }, cycle, SCARLET_STREAM).catch(() => undefined);

      const toolsUsed: string[] = [];
      let rounds = 0;
      for (let round = 0; round < this.config.SCARLET_MAX_ROUNDS; round += 1) {
        rounds = round + 1;
        const turn = await this.llm.chat({ messages, tools: SCARLET_TOOLS, temperature: 0.3 });
        messages.push(turn.message);
        // MAX OBSERVABILITY: her reasoning is logged every round (not only at rest) + persisted to her
        // own journal stream, so we can watch HOW she thinks — the dashboard reads it from the DB.
        if (turn.thought) {
          this.logger.info({ cycle, round, thought: turn.thought.slice(0, 700) }, "Scarlet(v2) thinking");
          await this.db.addJournal("thought", turn.thought, { round }, cycle, SCARLET_STREAM).catch(() => undefined);
        }
        if (!turn.toolCalls.length) {
          await this.db.addJournal("rest", turn.thought || "Riposata senza sommario.", { round }, cycle, SCARLET_STREAM).catch(() => undefined);
          this.logger.info({ reason, cycle, rounds, toolsUsed, totalMs: Date.now() - t0, outcome: "rest", summary: turn.thought.slice(0, 300) }, "Scarlet(v2) rested");
          break;
        }
        for (const call of turn.toolCalls) {
          toolsUsed.push(call.name);
          const result = await this.dispatch(call.name, call.arguments, cycle);
          this.logger.info({ cycle, round, tool: call.name, args: compact(call.arguments), result: compact(result) }, "Scarlet(v2) tool");
          // Persist every tool/action to her timeline (the dashboard reads it) — `note` self-journals, so
          // skip it here to avoid a duplicate. State-changing actions are tagged 'action', reads 'tool'.
          if (call.name !== "note") {
            const isAct = isActionTool(call.name);
            await this.db.addJournal(isAct ? "action" : "tool", toolLine(call.name, call.arguments, result), { round, name: call.name }, cycle, SCARLET_STREAM).catch(() => undefined);
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
        if (rounds >= this.config.SCARLET_MAX_ROUNDS) this.logger.info({ reason, cycle, rounds, toolsUsed, totalMs: Date.now() - t0, outcome: "max-rounds" }, "Scarlet(v2) reached max rounds");
      }
      await this.chronicle.maybeCompact((prior, older) => this.summarize(prior, older)).catch((error) => this.logger.warn({ err: error }, "Scarlet(v2) history compaction failed"));
    } catch (error) {
      this.logger.error({ err: error, reason, cycle }, "Scarlet(v2) activation failed");
    } finally {
      this.living = false;
    }
  }

  /** Tool surface: `note` (journal) + the read-only VISION tools (inspect/chart/verify/discover/memory).
   * Buy/sell + position management arrive in the next gradino. */
  private async dispatch(name: string, rawArgs: string, cycle: string): Promise<unknown> {
    let args: Record<string, unknown> = {};
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return { error: "tool arguments are not valid JSON" }; }
    if (name === "note") {
      const text = String(args.text ?? "").trim().slice(0, 2_000);
      if (!text) return { error: "note text is empty" };
      await this.db.addJournal("action", `NOTA: ${text}`, { tool: "note" }, cycle, SCARLET_STREAM).catch(() => undefined);
      return { ok: true, noted: true };
    }
    if (isTokenTool(name)) return dispatchTokenTool(name, args, this.toolDeps);
    if (isVisionTool(name)) return dispatchVisionTool(name, args, this.toolDeps);
    if (isActionTool(name)) return dispatchActionTool(name, args, this.toolDeps);
    return { error: `unknown tool '${name}'` };
  }

  private async summarize(priorSummary: string, olderChronicle: string): Promise<string> {
    const user = `${priorSummary ? `RIASSUNTO STORICO PRECEDENTE:\n${priorSummary}\n\n` : ""}CICLI DA COMPATTARE (dal più vecchio):\n${olderChronicle}`;
    const out = await this.llm.complete(COMPACTION_SYSTEM, user, 0.2);
    if (!out) throw new Error("empty compaction summary");
    return out;
  }
}

const SCARLET_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "note",
      description: "Registra una breve osservazione, tesi o piano nel tuo diario. Usalo per ragionare ad alta voce o annotare un'intenzione.",
      parameters: { type: "object", properties: { text: { type: "string", description: "il testo della nota" } }, required: ["text"] }
    }
  },
  ...TOKEN_TOOLS,
  ...VISION_TOOLS,
  ...ACTION_TOOLS
];

function loadPrompt(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return FALLBACK_PROMPT; }
}

function compact(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > 400 ? `${text.slice(0, 400)}…` : (text ?? "");
}

/** A concise, human-readable one-liner for a tool call + its outcome — for the dashboard timeline. */
function toolLine(name: string, rawArgs: string, result: unknown): string {
  let args: Record<string, unknown> = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { /* keep empty */ }
  const arg = Object.entries(args).map(([k, v]) => `${k}=${typeof v === "string" && v.length > 14 ? v.slice(0, 8) + "…" + v.slice(-4) : String(v)}`).join(", ");
  const r = result as Record<string, unknown> | null;
  let out = "ok";
  if (r && typeof r === "object") {
    if ("error" in r) out = `errore: ${String(r.error).slice(0, 70)}`;
    else if ("refused" in r) out = `RIFIUTATO: ${String(r.reason ?? "").slice(0, 70)}`;
    else if ("ok" in r && r.ok) out = "positionId" in r ? `ok → posizione #${r.positionId}` : "ok";
  }
  return `${name}(${arg}) → ${out}`;
}
