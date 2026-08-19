import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { STATE_TOOLS, OPERATIVE_STATES, buildActivationSummary, buildOperativeData, expandBranch, type OperativeState } from "./state.js";

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
  private readonly activationPrompt: string;
  private readonly conclusionPrompt: string;
  private readonly strategyPrompts = new Map<string, string>();
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
    private readonly logger: Logger,
    private readonly isSynced?: () => boolean // indexer at head? — she waits (data-fresh gate) while it realigns
  ) {
    this.systemPrompt = loadPrompt(config.SCARLET_CORE_PROMPT_PATH);
    this.activationPrompt = loadPrompt(config.SCARLET_ACTIVATION_PROMPT_PATH);
    this.conclusionPrompt = loadPrompt(config.SCARLET_CONCLUSION_PROMPT_PATH);
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

  /** One turn = a full agentic cycle through THREE phases: activation (orient + choose the operative
   * state, forced) → operative (enter the chosen strategy, may re-switch) → conclusion (review + seed
   * the next turn). One growing messages array carries cognition across the phases; system[0] is the
   * stable identity, and each phase attaches its own prompt on top of it. */
  async live(reason: string): Promise<void> {
    if (!this.available) { this.logger.info({ reason }, "Scarlet(v2) cannot wake: LLM not configured"); return; }
    if (this.living) { this.logger.debug({ reason }, "Scarlet(v2) already awake; skipping re-entry"); return; }
    if (this.isSynced && !this.isSynced()) { this.logger.info({ reason }, "Scarlet(v2) waiting: indexer realigning (data not fresh)"); return; }
    this.living = true;
    const t0 = Date.now();
    const cycle = randomUUID().slice(0, 8);
    try {
      await this.health.refresh();
      // Wallet/NAV from the DB — the walletHoldings service owns it (Transfer scan + balanceOf on touched
      // tokens) and persists it. NO live RPC in the thinking path. Bootstrap live only if no snapshot yet;
      // reconcile re-values OPEN positions (RPC only when we actually hold some).
      const dailyLoss = await this.db.dailyLossUsd().catch(() => 0);
      const persisted = await this.db.latestPortfolio().catch(() => undefined);
      const base = persisted
        ? { ...persisted, dailyLossUsd: dailyLoss, dataHealthy: this.health.dataHealthy }
        : await this.chain.portfolio(dailyLoss, this.health.dataHealthy);
      const portfolio = await this.positions.reconcile(base);
      const self = selfState(portfolio, this.config);
      const briefing = await buildTradingBriefing(this.db, this.positions, this.config, self);
      // Idle-backoff: unchanged material fingerprint → grow the streak (slower cadence); any change resets.
      const { fingerprint, ...world } = briefing;
      if (fingerprint === this.lastFingerprint) this.idleStreak += 1; else this.idleStreak = 0;
      this.lastFingerprint = fingerprint;
      const history = await this.chronicle.loadContext().catch(() => ({ text: "", tokens: 0, freshCount: 0 }));

      this.logger.info({ reason, cycle, idleStreak: this.idleStreak, nextGapMs: this.nextGapMs, historyTokens: history.tokens, buildMs: Date.now() - t0 }, "Scarlet(v2) activation");

      // Cycle-start marker for the dashboard timeline: WHY she woke (the wake reason).
      await this.db.addJournal("cycle", reason, { idleStreak: this.idleStreak }, cycle, SCARLET_STREAM).catch(() => undefined);

      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: this.systemPrompt },
        ...(history.text ? [{ role: "user" as const, content: `LA TUA STORIA (continuità tra i cicli):\n\n${history.text}` }] : [])
      ];
      const toolsUsed: string[] = [];

      // ── PHASE 1: ACTIVATION — orient over summary data + choose the operative state (forced) ──
      const summary = await buildActivationSummary(this.db, this.config).catch(() => ({}));
      const prevNote = await this.db.latestMarketSnapshot<{ text: string }>("scarlet", "nextNote").catch(() => undefined);
      messages.push({ role: "system", content: this.activationPrompt });
      messages.push({ role: "user", content: JSON.stringify({
        reason, now: new Date().toISOString(), executionEnabled: this.config.EXECUTION_ENABLED,
        portafoglio: world, riassunto: summary, notaPrecedente: prevNote?.text ?? null,
        instruction: "Orientati: leggi storia + riassunto, espandi ciò che serve, poi CHIUDI con set_state(stato, giustificazione). NON operare qui."
      }) });
      const activation = await this.runPhase("activation", messages, cycle, toolsUsed);
      let state = activation.state;

      if (!state) {
        // Forced set_state still not chosen (model refused twice) — end the turn cleanly, no operative phase.
        this.logger.warn({ reason, cycle }, "Scarlet(v2) activation ended without a state; skipping operative phase");
      } else {
        // ── PHASE 2: OPERATIVE — enter the strategy (its prompt + augmented data); may re-switch ──
        await this.injectOperative(messages, state, cycle);
        const operative = await this.runPhase("operative", messages, cycle, toolsUsed, state);
        state = operative.state ?? state;

        // ── PHASE 3: CONCLUSION — review, update memory, seed the next turn's note ──
        messages.push({ role: "system", content: this.conclusionPrompt });
        messages.push({ role: "user", content: JSON.stringify({ instruction: "Fase conclusiva: rivedi l'operato di questo turno, aggiorna memorie/giudizi se hai imparato qualcosa, e prepara set_next_note(testo) come TUA ipotesi da rivalutare al prossimo turno. Poi smetti." }) });
        await this.runPhase("conclusion", messages, cycle, toolsUsed);
      }

      this.logger.info({ reason, cycle, state: state ?? "none", toolsUsed, totalMs: Date.now() - t0 }, "Scarlet(v2) turn complete");
      await this.chronicle.maybeCompact((prior, older) => this.summarize(prior, older)).catch((error) => this.logger.warn({ err: error }, "Scarlet(v2) history compaction failed"));
    } catch (error) {
      this.logger.error({ err: error, reason, cycle }, "Scarlet(v2) activation failed");
    } finally {
      this.living = false;
    }
  }

  /** Run tool rounds for one phase over the shared messages array.
   *  - activation: ends the instant a state is chosen; if she rests without choosing, she's prompted once
   *    to `set_state`, then the phase gives up (returns no state).
   *  - operative: starts inside `currentState`; a fresh `set_state` re-injects the new strategy prompt+data
   *    (a live switch); ends when she stops calling tools (rest).
   *  - conclusion: ends on rest. */
  private async runPhase(mode: "activation" | "operative" | "conclusion", messages: ChatCompletionMessageParam[], cycle: string, toolsUsed: string[], currentState?: OperativeState): Promise<{ state?: OperativeState }> {
    let chosen: OperativeState | undefined = mode === "operative" ? currentState : undefined;
    let forced = false;
    for (let round = 0; round < this.config.SCARLET_MAX_ROUNDS; round += 1) {
      const turn = await this.llm.chat({ messages, tools: SCARLET_TOOLS, temperature: 0.3 });
      messages.push(turn.message);
      if (turn.thought) {
        this.logger.info({ cycle, phase: mode, round, thought: turn.thought.slice(0, 700) }, "Scarlet(v2) thinking");
        await this.db.addJournal("thought", turn.thought, { round, phase: mode }, cycle, SCARLET_STREAM).catch(() => undefined);
      }
      if (!turn.toolCalls.length) {
        if (mode === "activation" && !chosen && !forced) {
          forced = true; // one nudge — she MUST close activation by choosing a state
          messages.push({ role: "user", content: "L'attivazione non può concludersi senza scegliere. Chiama subito set_state(stato, giustificazione)." });
          continue;
        }
        await this.db.addJournal("rest", turn.thought || "—", { round, phase: mode }, cycle, SCARLET_STREAM).catch(() => undefined);
        this.logger.info({ cycle, phase: mode, round, outcome: "rest" }, "Scarlet(v2) phase end");
        break;
      }
      let switched = false;
      for (const call of turn.toolCalls) {
        toolsUsed.push(call.name);
        const result = await this.dispatch(call.name, call.arguments, cycle);
        this.logger.info({ cycle, phase: mode, round, tool: call.name, args: compact(call.arguments), result: compact(result) }, "Scarlet(v2) tool");
        if (call.name === "set_state") {
          const st = (result as { state?: OperativeState }).state;
          if (st) { if (mode === "operative" && st !== chosen) switched = true; chosen = st; }
        } else if (call.name !== "note" && call.name !== "set_next_note") {
          // note/set_next_note self-journal in dispatch; everything else lands on the timeline here.
          const isAct = isActionTool(call.name);
          await this.db.addJournal(isAct ? "action" : "tool", toolLine(call.name, call.arguments, result), { round, name: call.name, phase: mode }, cycle, SCARLET_STREAM).catch(() => undefined);
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      if (mode === "activation" && chosen) break; // state chosen → activation is done
      if (mode === "operative" && switched && chosen) await this.injectOperative(messages, chosen, cycle);
    }
    return { state: chosen };
  }

  /** Attach the chosen strategy's prompt + its augmented data on top of the identity core. */
  private async injectOperative(messages: ChatCompletionMessageParam[], state: OperativeState, cycle: string): Promise<void> {
    const data = await buildOperativeData(this.db, this.config, state).catch(() => ({}));
    messages.push({ role: "system", content: this.loadStrategyPrompt(state) });
    messages.push({ role: "user", content: JSON.stringify({ statoOperativo: state, datiStrategia: data, instruction: "Sei nello stato operativo. Applica le regole della strategia e opera con gli strumenti. Puoi passare a un'altra strategia con set_state se i dati lo giustificano. Quando hai finito di operare, smetti (nessuno strumento)." }) });
    this.logger.info({ cycle, state }, "Scarlet(v2) operative state entered");
  }

  private loadStrategyPrompt(state: string): string {
    const cached = this.strategyPrompts.get(state);
    if (cached) return cached;
    const prompt = loadPrompt(join(this.config.SCARLET_STRATEGY_DIR, `${state}.md`));
    this.strategyPrompts.set(state, prompt);
    return prompt;
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
    if (name === "set_state") {
      const state = String(args.state ?? "");
      const justification = String(args.justification ?? "").trim();
      if (!(OPERATIVE_STATES as readonly string[]).includes(state)) return { error: `stato sconosciuto '${state}'; disponibili: ${OPERATIVE_STATES.join(", ")}` };
      if (!justification) return { error: "manca la giustificazione per lo stato" };
      await this.db.logScarletState(state, justification, cycle).catch(() => undefined);
      await this.db.addJournal("action", `STATO → ${state}: ${justification}`, { tool: "set_state", state }, cycle, SCARLET_STREAM).catch(() => undefined);
      return { ok: true, state, justification };
    }
    if (name === "set_next_note") {
      const text = String(args.text ?? "").trim().slice(0, 1_500);
      if (!text) return { error: "nota vuota" };
      await this.db.saveMarketSnapshot("scarlet", "nextNote", { text, at: new Date().toISOString() }).catch(() => undefined);
      await this.db.addJournal("note", `NOTA PROSSIMO TURNO: ${text}`, { tool: "set_next_note" }, cycle, SCARLET_STREAM).catch(() => undefined);
      return { ok: true, saved: true };
    }
    if (name === "expand") {
      const branch = String(args.branch ?? "");
      return { branch, data: await expandBranch(this.db, this.config, branch).catch(() => ({ error: "expand fallito" })) };
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
  ...ACTION_TOOLS,
  ...STATE_TOOLS
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
