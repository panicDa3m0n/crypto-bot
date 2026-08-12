import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { MiniMaxConfig } from "./config.js";

export type LlmReply = {
  model: string;
  promptSha256: string;
  content: string;
  usage: unknown;
};

/**
 * A deliberately small OpenAI-compatible MiniMax client.
 * No max_tokens/token-budget parameter is sent: completion length remains a
 * provider/model concern until the product defines an explicit policy.
 */
export class MiniMaxClient {
  private readonly client: OpenAI;
  private readonly systemPrompt: string;
  readonly promptSha256: string;

  constructor(private readonly config: MiniMaxConfig) {
    this.systemPrompt = readFileSync(config.systemPromptPath, "utf8").trim();
    if (!this.systemPrompt) throw new Error(`System prompt is empty: ${config.systemPromptPath}`);
    this.promptSha256 = createHash("sha256").update(this.systemPrompt).digest("hex");
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 0 });
  }

  async ask(input: string): Promise<LlmReply> {
    if (!input.trim()) throw new Error("A non-empty user request is required.");
    const response = await this.complete([
      { role: "system", content: this.systemPrompt },
      { role: "user", content: input }
    ]);
    const content = response.choices[0]?.message.content?.trim();
    if (!content) throw new Error("MiniMax returned an empty response.");
    return { model: response.model || this.config.model, promptSha256: this.promptSha256, content, usage: response.usage ?? null };
  }

  /** Makes one provider request without imposing an application token limit. */
  complete(messages: ChatCompletionMessageParam[], tools?: ChatCompletionTool[]) {
    return this.client.chat.completions.create({
      model: this.config.model,
      messages,
      ...(tools?.length ? { tools, tool_choice: "auto" as const } : {})
    });
  }

  get systemInstructions(): string { return this.systemPrompt; }
}
