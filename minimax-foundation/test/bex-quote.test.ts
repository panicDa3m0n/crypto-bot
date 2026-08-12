import { describe, expect, it } from "vitest";
import { tokenMetadata } from "../src/bex-quote.js";
import type { BexPoolObservation } from "../src/bex.js";

const pool = (symbol: string, decimals = 18): BexPoolObservation => ({ id: "0x".padEnd(66, "1"), address: "0x0000000000000000000000000000000000000001", name: "test", symbol: "BPT", protocolVersion: 2, api: { totalLiquidity: "0", volume24h: "0", fees24h: "0" }, rewardVault: null, apiTokens: [{ address: "0x00000000000000000000000000000000000000aa", symbol, decimals }], state: "verified-dual-rpc" });

describe("BEX quote metadata gate", () => {
  it("returns metadata only when a scanned pool contains the asset", () => {
    expect(tokenMetadata([pool("TOK")], "0x00000000000000000000000000000000000000AA")).toEqual({ address: "0x00000000000000000000000000000000000000aa", symbol: "TOK", decimals: 18 });
    expect(tokenMetadata([pool("TOK")], "0x00000000000000000000000000000000000000bb")).toBeUndefined();
  });
  it("rejects conflicting API metadata instead of selecting one arbitrarily", () => {
    expect(() => tokenMetadata([pool("TOK", 18), pool("TOK", 6)], "0x00000000000000000000000000000000000000aa")).toThrow("metadata disagrees");
  });
});
