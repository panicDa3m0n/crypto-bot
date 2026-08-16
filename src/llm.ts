import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { Logger } from "pino";
import type { Config } from "./config.js";

/** A normalized tool call the agent can dispatch without knowing the provider's wire format. */
export type LlmToolCall = { id: string; name: string; arguments: string };
/** One assistant turn: the raw message to push back into history, the cleaned reasoning, and any tool calls. */
export type LlmTurn = { message: ChatCompletionMessageParam; thought: string; toolCalls: LlmToolCall[] };

/**
 * Thin, provider-swappable LLM client. Today it targets MiniMax via the OpenAI-compatible endpoint and
 * absorbs MiniMax's quirks in ONE place (the `<think>` reasoning wrapper, and the occasional truncated
 * JSON array tool-args). The agent talks only to this seam, so the model can be swapped without touching
 * the agent loop.
 */
export class Llm {
  private readonly client?: OpenAI;

  constructor(private readonly config: Config, private readonly logger: Logger) {
    this.client = config.MINIMAX_API_KEY
      ? new OpenAI({ apiKey: config.MINIMAX_API_KEY, baseURL: config.MINIMAX_BASE_URL, timeout: 150_000, maxRetries: 2 })
      : undefined;
  }

  get available(): boolean { return Boolean(this.client); }

  /** One tool-calling turn. Returns the raw assistant message (push it into your history), the cleaned
   * reasoning text, and the normalized tool calls. Tools are optional (omit for a plain completion). */
  async chat(opts: { messages: ChatCompletionMessageParam[]; tools?: ChatCompletionTool[]; temperature?: number }): Promise<LlmTurn> {
    if (!this.client) throw new Error("LLM client is not configured (no MINIMAX_API_KEY)");
    const response = await this.client.chat.completions.create({
      model: this.config.MINIMAX_MODEL,
      temperature: opts.temperature ?? 0.3,
      messages: opts.messages,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" as const } : {})
    });
    const message = response.choices[0]?.message;
    if (!message) return { message: { role: "assistant", content: "" }, thought: "", toolCalls: [] };
    const toolCalls: LlmToolCall[] = (message.tool_calls ?? [])
      .filter((c) => c.type === "function")
      .map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
    return { message: message as ChatCompletionMessageParam, thought: cleanThought(message.content), toolCalls };
  }

  /** A plain system+user completion (no tools) — used for e.g. history compaction. Returns cleaned text. */
  async complete(system: string, user: string, temperature = 0.2): Promise<string> {
    if (!this.client) throw new Error("LLM client is not configured (no MINIMAX_API_KEY)");
    const response = await this.client.chat.completions.create({
      model: this.config.MINIMAX_MODEL, temperature,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    });
    return cleanThought(response.choices[0]?.message?.content);
  }
}

/** Strips MiniMax-M's `<think>…</think>` wrapper so the journal shows readable reasoning. */
export function cleanThought(content: string | null | undefined): string {
  if (!content) return "";
  const inner = content.match(/<think>([\s\S]*?)<\/think>/i)?.[1];
  const rest = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return [inner?.trim(), rest].filter(Boolean).join("\n\n").trim().slice(0, 4_000);
}

/** MiniMax sometimes serializes an ARRAY tool-arg as a (occasionally truncated) JSON STRING —
 * e.g. `"[\"0x..\""` instead of `["0x.."]`. Left unhandled it becomes an empty list and the call
 * fails. This recovers arrays, JSON-string arrays, and unclosed/one-sided ones. (Kept here for the
 * later gradini whose tools take array args; the Gradino-1 `note` tool doesn't need it.) */
export function coerceArgArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  const s = v.trim();
  if (!s) return [];
  for (const cand of [s, s + "]", "[" + s + "]", s + '"]']) {
    try { const p = JSON.parse(cand); if (Array.isArray(p)) return p; } catch { /* try next repair */ }
  }
  return [];
}
