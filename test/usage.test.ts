import { describe, expect, it } from "vitest";
import { summarizeMiniMaxUsage } from "../src/usage.js";

describe("MiniMax usage accounting", () => {
  it("counts direct, tool, and repair API usages", () => {
    const summary = summarizeMiniMaxUsage([{ final: { usage: { prompt_tokens: 1_000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } } }, toolTrace: [{ usage: { prompt_tokens: 100, completion_tokens: 50 } }], repair: { usage: { prompt_tokens: 200, completion_tokens: 100 } } }]);
    expect(summary).toMatchObject({ requests: 3, promptTokens: 1_300, cachedPromptTokens: 200, completionTokens: 650 });
  });
});
