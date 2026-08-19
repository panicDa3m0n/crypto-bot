import { describe, expect, it } from "vitest";
import { freshness, freshnessLog } from "../src/freshness.js";

describe("freshness", () => {
  it("computes blocksBehind from the STALEST leg and stays within tolerance", () => {
    const f = freshness(100, [{ block: 98, ageMs: 3000 }, { block: 99, ageMs: 1000 }], 5);
    expect(f.asOfBlock).toBe(98);      // oldest leg
    expect(f.blocksBehind).toBe(2);    // 100 - 98
    expect(f.maxAgeMs).toBe(3000);     // stalest leg's age
    expect(f.stale).toBe(false);
  });

  it("flags stale when the oldest leg exceeds the tolerance", () => {
    const f = freshness(100, [{ block: 90 }, { block: 99 }], 5);
    expect(f.blocksBehind).toBe(10);
    expect(f.stale).toBe(true);
  });

  it("fails safe (maximally stale) when head is unknown", () => {
    const f = freshness(0, [{ block: 99 }], 5);
    expect(f.blocksBehind).toBe(Infinity);
    expect(f.stale).toBe(true);
  });

  it("fails safe when a leg has no known block", () => {
    const f = freshness(100, [{ block: 0 }], 5);
    expect(f.blocksBehind).toBe(Infinity);
    expect(f.stale).toBe(true);
  });

  it("fails safe when there are no legs", () => {
    const f = freshness(100, [], 5);
    expect(f.asOfBlock).toBe(0);
    expect(f.stale).toBe(true);
  });

  it("serializes Infinity blocksBehind to a readable token for logs", () => {
    expect(freshnessLog(freshness(0, [{ block: 1 }], 5)).blocksBehind).toBe("unknown");
    expect(freshnessLog(freshness(100, [{ block: 98, ageMs: 2500.7 }], 5))).toEqual({ asOfBlock: 98, blocksBehind: 2, maxAgeMs: 2501, stale: false });
  });
});
