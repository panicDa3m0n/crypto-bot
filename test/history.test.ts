import { describe, expect, it } from "vitest";
import { dailyReturnCorrelations, deriveTokenSignal } from "../src/history.js";

describe("official token history signals", () => {
  it("derives 24h/7d/30d/90d returns and a bounded daily series from official price points", () => {
    const now = Date.UTC(2026, 7, 10, 12, 0, 0);
    const point = (daysAgo: number, price: number) => ({ price, timestamp: String(Math.floor((now - daysAgo * 86_400_000) / 1_000)), updatedAt: 0 });
    const signal = deriveTokenSignal({ address: "0x01", prices: [point(90, 1), point(30, 1.1), point(7, 1.2), point(1, 1.25), point(0, 1.3)] }, { nowMs: now });
    expect(signal?.return24h).toBeCloseTo(0.04);
    expect(signal?.return7d).toBeCloseTo(1.3 / 1.2 - 1);
    expect(signal?.return30d).toBeCloseTo(1.3 / 1.1 - 1);
    expect(signal?.return90d).toBeCloseTo(0.3);
    expect(signal?.rangeMinUsd).toBe(1);
    expect(signal?.rangeMaxUsd).toBe(1.3);
    expect(signal?.dailySeries.length).toBeGreaterThan(0);
  });

  it("accepts only a tightly bounded initial bucket for a nominal 90-day return", () => {
    const now = Date.UTC(2026, 7, 10, 12, 0, 0);
    const point = (millisecondsAgo: number, price: number) => ({ price, timestamp: String(Math.floor((now - millisecondsAgo) / 1_000)), updatedAt: 0 });
    const withinTolerance = deriveTokenSignal({ address: "0x01", prices: [point(90 * 86_400_000 - 60 * 60_000, 1), point(0, 1.2)] }, { nowMs: now });
    const outsideTolerance = deriveTokenSignal({ address: "0x01", prices: [point(90 * 86_400_000 - 3 * 60 * 60_000, 1), point(0, 1.2)] }, { nowMs: now });
    expect(withinTolerance?.return90d).toBeCloseTo(0.2);
    expect(outsideTolerance?.return90d).toBeNull();
  });
});

describe("official daily return correlation", () => {
  it("uses only date-aligned observations and excludes degenerate series", () => {
    const correlations = dailyReturnCorrelations([
      { address: "A", sampleCount: 1, latestPriceUsd: 1, return24h: null, return7d: null, return30d: null, return90d: null, realizedVolatility: null, rangeMinUsd: 1, rangeMaxUsd: 1, latestAt: "x", dailySeries: [{ date: "2026-01-01", return: 0.01, realizedVolatility: null }, { date: "2026-01-02", return: 0.02, realizedVolatility: null }, { date: "2026-01-03", return: 0.03, realizedVolatility: null }] },
      { address: "B", sampleCount: 1, latestPriceUsd: 1, return24h: null, return7d: null, return30d: null, return90d: null, realizedVolatility: null, rangeMinUsd: 1, rangeMaxUsd: 1, latestAt: "x", dailySeries: [{ date: "2026-01-01", return: 0.02, realizedVolatility: null }, { date: "2026-01-02", return: 0.04, realizedVolatility: null }, { date: "2026-01-03", return: 0.06, realizedVolatility: null }] }
    ]);
    expect(correlations).toEqual([{ leftAddress: "A", rightAddress: "B", overlappingDays: 3, correlation: 1 }]);
  });
});
