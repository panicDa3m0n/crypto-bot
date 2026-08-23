import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirtyLiquidationNodes, liquidationIncentive, seizeAndRepay, type LiquidationNode } from "../src/kg/liquidation-nodes.js";
import type { LiquidityGraph } from "../src/kg/graph-loader.js";
import type { PoolState } from "../src/router/types.js";

/**
 * THE GOVERNING RULE, as a test.
 *
 * A block is the only event. What it touches is recomputed; what it does not is still valid and is reused.
 * Two things had drifted from that and neither was visible from any single function: the graph reloaded all
 * 25,390 pools when 17 had moved, and the spot price was computed in three different places that disagreed.
 * Both are architecture, so both are checked here as architecture.
 */

const pool = (address: string, t0: string, t1: string): PoolState => ({
  address, archetype: "v2", token0: t0, token1: t1, feePpm: 3000,
  r0: 10n ** 20n, r1: 10n ** 20n, sqrtPriceX96: null, liquidity: null,
  dec0: 10n ** 18n, dec1: 10n ** 18n, block: 1,
} as PoolState);

function graphOf(pools: PoolState[]): LiquidityGraph {
  const m = new Map(pools.map((p) => [p.address, p]));
  const adjacency = new Map<string, string[]>();
  for (const p of pools) for (const t of [p.token0, p.token1]) adjacency.set(t, [...(adjacency.get(t) ?? []), p.address]);
  return { pools: m, adjacency, decimals: new Map(), prices: new Map(), head: 1, lag: 0, synced: true, stats: {} as never };
}

const node = (over: Partial<LiquidationNode> = {}): LiquidationNode => ({
  key: "morpho:m1:0xb", protocol: "morpho", marketId: "m1", borrower: "0xb",
  collateralToken: "0xcoll", loanToken: "0xloan",
  collateralRaw: 1_000_000_000n, debtRaw: 500_000_000n, lltv: 0.625, oracle: "0xo", hf: 1.2, tier: "watch",
  ...over,
});

describe("a position is dirtied by the same events as everything else", () => {
  const g = graphOf([pool("0xp1", "0xcoll", "0xweth"), pool("0xp2", "0xother", "0xweth")]);

  it("is dirty when its own token was repriced", () => {
    const out = dirtyLiquidationNodes([node()], g, { pools: new Set(), tokens: new Set(["0xcoll"]) });
    expect(out).toHaveLength(1);
  });

  it("is dirty when a pool it must SELL THROUGH moved, even with its price unchanged", () => {
    // The subtle half: the collateral can be worth the same while the depth it must exit into has shifted,
    // and depth is what decides whether the liquidation actually profits.
    const out = dirtyLiquidationNodes([node()], g, { pools: new Set(["0xp1"]), tokens: new Set() });
    expect(out).toHaveLength(1);
  });

  it("is NOT recomputed when nothing it depends on moved", () => {
    const out = dirtyLiquidationNodes([node()], g, { pools: new Set(["0xp2"]), tokens: new Set(["0xother"]) });
    expect(out).toHaveLength(0);
  });

  it("recomputes nothing at all on an empty delta", () => {
    expect(dirtyLiquidationNodes([node()], g, { pools: new Set(), tokens: new Set() })).toHaveLength(0);
  });
});

describe("liquidation arithmetic follows the protocol, not our conventions", () => {
  it("prices the incentive from LLTV and caps it at 1.15", () => {
    expect(liquidationIncentive(0.625)).toBeCloseTo(1 / (1 - 0.3 * 0.375), 6);
    expect(liquidationIncentive(0.01)).toBe(1.15);   // capped
    expect(liquidationIncentive(0)).toBe(1.05);      // unknown LLTV → conservative
  });

  it("never seizes more collateral than exists, nor repays more than is owed", () => {
    const oracle = 10n ** 36n; // 1:1
    const r = seizeAndRepay(node({ collateralRaw: 100n, debtRaw: 10n ** 9n }), oracle, 18, 18)!;
    expect(r.seizeRaw).toBeLessThanOrEqual(100n);
    const r2 = seizeAndRepay(node({ collateralRaw: 10n ** 12n, debtRaw: 500n }), oracle, 18, 18)!;
    expect(r2.repayRaw).toBeLessThanOrEqual(500n);
  });

  it("refuses to size anything without a protocol price — liquidatability is the contract's call", () => {
    expect(seizeAndRepay(node(), 0n, 18, 18)).toBeNull();
  });
});

describe("the spot price has exactly one source", () => {
  it("the KG reads token_prices and does not derive its own", () => {
    const obs = readFileSync("src/kg/observatory.ts", "utf8");
    // It used to scan every pool for a WETH/USDC pair and take max(quote) — a second answer to a question
    // the DB already holds, obtained by the most expensive means available.
    expect(obs).not.toMatch(/ethUsd = Math\.max/);
    expect(obs).toMatch(/graph\.prices\.get/);
  });

  it("the price oracle serves the unpinned price from the table, not from a recomputation", () => {
    const po = readFileSync("src/price-oracle.ts", "utf8");
    expect(po).toMatch(/getTokenPrices/);
  });
});
