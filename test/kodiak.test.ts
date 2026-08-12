import { describe, expect, it } from "vitest";
import { parseKodiakReadQuote } from "../src/kodiak.js";

describe("Kodiak read-only quote parser", () => {
  it("accepts only a matching Kodiak raw-unit quote", () => {
    const result = parseKodiakReadQuote({ provider: "Kodiak", amount: "100", quote: "99", gasUseEstimate: "113000", priceImpact: "0.2", routeString: "[V3] route" }, 100n, new Date("2026-01-01T00:00:00.000Z"));
    expect(result).toMatchObject({ provider: "Kodiak", amountIn: 100n, amountOut: 99n, gasEstimate: 113000n, route: "[V3] route", observedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("rejects a provider or amount mismatch", () => {
    expect(() => parseKodiakReadQuote({ provider: "Other", amount: "100", quote: "99" }, 100n)).toThrow("provider");
    expect(() => parseKodiakReadQuote({ provider: "Kodiak", amount: "101", quote: "99" }, 100n)).toThrow("does not match");
  });
});
