import { describe, expect, it } from "vitest";
import { rollingWindowCovered } from "../src/db.js";

describe("rolling evidence window coverage", () => {
  it("accepts a continuously sampled window whose oldest row is one cadence inside the SQL boundary", () => {
    expect(rollingWindowCovered(1_199.4, 1_200, 15)).toBe(true);
  });

  it("rejects a material missing prefix instead of making a rolling gate permanently unreachable", () => {
    expect(rollingWindowCovered(1_184.9, 1_200, 15)).toBe(false);
    expect(rollingWindowCovered(21_000, 21_600, 600)).toBe(true);
    expect(rollingWindowCovered(20_999.9, 21_600, 600)).toBe(false);
  });
});
