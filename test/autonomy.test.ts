import { describe, expect, it } from "vitest";
import { boundedWberaUnwrapAmount } from "../src/autonomy.js";

describe("bounded WBERA unwind", () => {
  it("returns a complete $0.025 micro experiment rather than an arbitrary 0.1 WBERA fragment", () => {
    expect(boundedWberaUnwrapAmount(0.1635997172996885, 0.152812)).toBe(163599717299688512n);
  });

  it("caps an unexpectedly larger WBERA balance at the $0.05 reversible-test ceiling", () => {
    expect(boundedWberaUnwrapAmount(1, 0.2)).toBe(250000000000000000n);
    expect(boundedWberaUnwrapAmount(1, 0)).toBe(0n);
  });
});
