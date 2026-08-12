import { describe, expect, it } from "vitest";
import { jsonSafe } from "../src/json.js";

describe("jsonSafe", () => {
  it("preserves receipt structure while converting bigint RPC fields", () => {
    expect(jsonSafe({ status: "reverted", gasUsed: 50_658n, nested: [1n] })).toEqual({ status: "reverted", gasUsed: "50658", nested: ["1"] });
  });

  it("makes nested on-chain verification snapshots safe for PostgreSQL JSON", () => {
    expect(jsonSafe({ verification: { blockNumber: 24_684_270n }, quotes: [{ amountIn: 1n }] })).toEqual({ verification: { blockNumber: "24684270" }, quotes: [{ amountIn: "1" }] });
  });
});
