import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("MiniMax configuration", () => {
  it("uses the official endpoint, M2.7 and the external prompt by default", () => {
    const config = loadConfig({ MINIMAX_API_KEY: "unit-test-key" });
    expect(config).toMatchObject({ baseURL: "https://api.minimax.io/v1", model: "MiniMax-M2.7" });
    expect(config.systemPromptPath).toMatch(/prompts\/wallet-brain\.md$/);
  });

  it("does not accept an absent credential", () => {
    expect(() => loadConfig({})).toThrow("MINIMAX_API_KEY");
  });
});
