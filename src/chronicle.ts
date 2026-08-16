import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { Database } from "./db.js";

/**
 * Cross-cycle continuity. Scarlet's journal (thought/note/action/rest, each tagged
 * with a cycle id) IS her chronicle; this manager feeds it back as running context
 * so every cycle builds on the last — past reasoning, actions and transactions stay
 * visible. When the estimated history crosses COMPACT_AT of the model context, the
 * oldest cycles are LLM-summarized down to KEEP_FRESH; the raw cycles remain in the
 * journal and are retrievable by cycle id (recall_cycle), never lost.
 */
export type JournalEntry = { id: number; at: string; cycle: string | null; kind: string; content: string };

export class Chronicle {
  /** `stream` scopes this chronicle to an independent history (e.g. the rebuilt trading core runs on
   * its own stream, detached from the legacy agent's diary, but shares the same compaction machinery). */
  constructor(private readonly config: Config, private readonly db: Database, private readonly logger: Logger, private readonly stream = "main") {}

  /** ~4 chars per token — good enough to pace compaction against a 1M budget. */
  estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

  private label(kind: string): string {
    return kind === "note" ? "NOTA" : kind === "action" ? "AZIONE" : kind === "rest" ? "RIPOSO" : kind === "memory" ? "MEMORIA" : "pensiero";
  }

  /** Group journal entries into a readable per-cycle chronicle (oldest → newest). */
  formatCycles(entries: JournalEntry[]): string {
    const byCycle: Array<{ cycle: string; at: string; lines: string[] }> = [];
    let current: { cycle: string; at: string; lines: string[] } | undefined;
    for (const e of entries) {
      const c = e.cycle ?? "—";
      if (!current || current.cycle !== c) { current = { cycle: c, at: e.at, lines: [] }; byCycle.push(current); }
      current.lines.push(`  [${this.label(e.kind)}] ${e.content.trim()}`);
    }
    return byCycle.map((c) => `▸ Ciclo ${c.cycle} (${new Date(c.at).toISOString().slice(11, 19)}):\n${c.lines.join("\n")}`).join("\n\n");
  }

  /** The running history block injected before each cycle's fresh briefing. */
  async loadContext(): Promise<{ text: string; tokens: number; freshCount: number }> {
    const summary = await this.db.latestSummary(this.stream);
    const boundary = summary?.upToJournalId ?? 0;
    const fresh = await this.db.journalAfter(boundary, 8000, this.stream);
    const chronicle = this.formatCycles(fresh);
    const parts: string[] = [];
    if (summary?.summary) parts.push(`=== RIASSUNTO STORICO (cicli passati, compattati) ===\n${summary.summary}`);
    if (chronicle) parts.push(`=== CRONACA RECENTE (i tuoi cicli, dal più vecchio al più recente) ===\n${chronicle}`);
    const text = parts.join("\n\n");
    return { text, tokens: this.estimateTokens(text), freshCount: fresh.length };
  }

  /** Compacts the oldest cycles into an LLM summary when history crosses the threshold. */
  async maybeCompact(summarize: (priorSummary: string, olderChronicle: string) => Promise<string>): Promise<{ compacted: boolean; upTo?: number; summaryTokens?: number }> {
    const summary = await this.db.latestSummary(this.stream);
    const boundary = summary?.upToJournalId ?? 0;
    const fresh = await this.db.journalAfter(boundary, 20000, this.stream);
    const priorText = summary?.summary ?? "";
    const freshText = this.formatCycles(fresh);
    const total = this.estimateTokens(priorText + freshText);
    const compactAt = this.config.HISTORY_MAX_TOKENS * this.config.HISTORY_COMPACT_AT_PCT;
    if (total <= compactAt || fresh.length === 0) return { compacted: false };

    // Keep the most-recent KEEP_FRESH tokens of whole cycles; summarize everything older.
    const keepTokens = this.config.HISTORY_MAX_TOKENS * this.config.HISTORY_KEEP_FRESH_PCT;
    const cycles = this.groupByCycle(fresh);
    let kept = 0; let splitIdx = cycles.length; // index where "toKeep" begins
    for (let i = cycles.length - 1; i >= 0; i--) {
      kept += this.estimateTokens(cycles[i].entries.map((e) => e.content).join("\n"));
      splitIdx = i;
      if (kept >= keepTokens) break;
    }
    const toCompact = cycles.slice(0, splitIdx).flatMap((c) => c.entries);
    if (toCompact.length === 0) return { compacted: false };

    const olderChronicle = this.formatCycles(toCompact);
    let newSummary: string;
    try { newSummary = await summarize(priorText, olderChronicle); }
    catch (error) { this.logger.warn({ err: error }, "history compaction summary failed; keeping raw history"); return { compacted: false }; }
    const upTo = toCompact[toCompact.length - 1].id;
    await this.db.saveSummary({ upToJournalId: upTo, fromCycle: toCompact[0].cycle, toCycle: toCompact[toCompact.length - 1].cycle, summary: newSummary, tokens: this.estimateTokens(newSummary) }, this.stream);
    this.logger.info({ upTo, compactedEntries: toCompact.length, summaryTokens: this.estimateTokens(newSummary) }, "history compacted");
    return { compacted: true, upTo, summaryTokens: this.estimateTokens(newSummary) };
  }

  private groupByCycle(entries: JournalEntry[]): Array<{ cycle: string; entries: JournalEntry[] }> {
    const out: Array<{ cycle: string; entries: JournalEntry[] }> = [];
    let cur: { cycle: string; entries: JournalEntry[] } | undefined;
    for (const e of entries) {
      const c = e.cycle ?? "—";
      if (!cur || cur.cycle !== c) { cur = { cycle: c, entries: [] }; out.push(cur); }
      cur.entries.push(e);
    }
    return out;
  }
}

/** The instruction that shapes a compaction summary in Scarlet's own terms. */
export const COMPACTION_SYSTEM = `Sei il processo di consolidamento della memoria di Scarlet, un agente di trading su Monad. Ti do il riassunto storico precedente (se esiste) e la cronaca dei cicli più vecchi da compattare. Produci UN riassunto strutturato in ITALIANO che preservi la continuità operativa, condensando senza perdere ciò che conta. Includi, in sezioni brevi:
- TESI E PIANI ancora attivi (strategie in corso, cosa sta aspettando).
- POSIZIONI e loro stato/ragionamento.
- TRANSAZIONI/AZIONI chiave eseguite e il loro esito.
- SCOPERTE e LEZIONI (cosa funziona, cosa evitare, indirizzi/protocolli/trappole).
- QUESTIONI APERTE da riprendere.
Sii denso e fattuale, niente fronzoli. Non inventare nulla che non sia nella cronaca. Questo riassunto SOSTITUISCE i cicli vecchi nella sua memoria, quindi ciò che ometti lo dimentica (ma resta recuperabile per cycle-id).`;
