export type MiniMaxUsageSummary = {
  requests: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
};

const empty = (): MiniMaxUsageSummary => ({ requests: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 });

/** Aggregates every persisted MiniMax API usage object, including tool and repair calls. */
export function summarizeMiniMaxUsage(records: unknown[]): MiniMaxUsageSummary {
  const result = empty();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const record = value as Record<string, unknown>;
    const usage = record.usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) {
      const u = usage as Record<string, unknown>;
      const prompt = numeric(u.prompt_tokens);
      const completion = numeric(u.completion_tokens);
      const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
      const cached = Math.min(prompt, numeric(details?.cached_tokens));
      result.requests += 1;
      result.promptTokens += prompt;
      result.cachedPromptTokens += cached;
      result.completionTokens += completion;
    }
    for (const child of Object.values(record)) visit(child);
  };
  for (const record of records) visit(record);
  return result;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
