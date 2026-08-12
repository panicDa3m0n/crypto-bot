import { describe, expect, it } from "vitest";
import { recentResearchArgs, walletBrainTools } from "../src/toolhub.js";

describe("Wallet Brain research memory tool", () => {
  it("exposes only a bounded read-only research-memory query", () => {
    expect(walletBrainTools.some((tool) => tool.function.name === "get_research_memory")).toBe(true);
    expect(walletBrainTools.some((tool) => tool.function.name === "get_pool_risk")).toBe(true);
    expect(recentResearchArgs.parse({})).toEqual({ limit: 3 });
    expect(() => recentResearchArgs.parse({ limit: 7 })).toThrow();
  });
});
