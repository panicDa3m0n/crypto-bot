import { describe, expect, it } from "vitest";
import { deriveValues } from "../src/dolomite.js";

describe("Dolomite account value derivation", () => {
  it("computes adjusted margin and enforces the global threshold", () => {
    const values = deriveValues({ supplied: 300n, borrowed: 200n }, { supplied: 230n, borrowed: 200n }, 150_000_000_000_000_000n);
    expect(values.actualMarginWad).toBe("150000000000000000");
    expect(values.meetsGlobalMarginRequirement).toBe(true);
  });

  it("does not invent a margin for an account without debt", () => {
    const values = deriveValues({ supplied: 1n, borrowed: 0n }, { supplied: 1n, borrowed: 0n }, 0n);
    expect(values.actualMarginWad).toBeUndefined();
    expect(values.meetsGlobalMarginRequirement).toBeUndefined();
  });
});
