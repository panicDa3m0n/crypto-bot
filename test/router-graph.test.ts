import { describe, expect, it } from "vitest";
import { bestRoute, buildAdjacency, adapterMap } from "../src/router/graph.js";
import { ConstantProductAdapter } from "../src/router/adapters/constant-product.js";
import { V3Adapter } from "../src/router/adapters/v3.js";
import type { PoolState } from "../src/router/types.js";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const C = "0x00000000000000000000000000000000000000cc";
const adapters = [new ConstantProductAdapter(), new V3Adapter()];
const cp = new ConstantProductAdapter();

let n = 0;
function v2(t0: string, t1: string, r0: bigint, r1: bigint, feePpm = 3000): PoolState {
  return { address: `0xpool${(n++).toString(16).padStart(2, "0")}`, archetype: "v2", token0: t0, token1: t1, feePpm, r0, r1, block: 100 };
}
const E18 = 10n ** 18n;

describe("route-finder (pure)", () => {
  it("adjacency indexes both directions of a pool", () => {
    const adj = buildAdjacency([v2(A, B, E18, E18)]);
    expect(adj.get(A)?.[0].other).toBe(B);
    expect(adj.get(B)?.[0].other).toBe(A);
  });

  it("picks the deeper of two parallel direct pools (max output)", () => {
    const deep = v2(A, B, 1000n * E18, 1000n * E18);
    const thin = v2(A, B, 100n * E18, 100n * E18);
    const r = bestRoute(adapters, [thin, deep], A, B, E18);
    expect(r).not.toBeNull();
    expect(r!.hops).toEqual([A, B]);
    expect(r!.amountOut).toBe(cp.quoteOut(deep, A, E18)!.amountOut); // the deep pool wins
    expect(r!.amountOut).toBeGreaterThan(cp.quoteOut(thin, A, E18)!.amountOut);
  });

  it("finds a one-hop route through an intermediate when there is no direct pool", () => {
    const p1 = v2(A, C, 1000n * E18, 1000n * E18);
    const p2 = v2(C, B, 1000n * E18, 1000n * E18);
    const r = bestRoute(adapters, [p1, p2], A, B, E18);
    expect(r).not.toBeNull();
    expect(r!.hops).toEqual([A, C, B]);
    expect(r!.path.map((p) => p.address)).toEqual([p1.address, p2.address]);
    // two 0.3% hops through equal-depth pools: output < a single equivalent hop
    expect(r!.amountOut).toBeLessThan(cp.quoteOut(p1, A, E18)!.amountOut);
  });

  it("prefers a good direct pool over a lossy two-hop", () => {
    const direct = v2(A, B, 1000n * E18, 1000n * E18);
    const h1 = v2(A, C, 50n * E18, 50n * E18);   // thin → high impact
    const h2 = v2(C, B, 50n * E18, 50n * E18);
    const r = bestRoute(adapters, [direct, h1, h2], A, B, E18);
    expect(r!.hops).toEqual([A, B]);
    expect(r!.amountOut).toBe(cp.quoteOut(direct, A, E18)!.amountOut);
  });

  it("routes a V3 pool via its virtual reserves (mixed adapters)", () => {
    // sqrtPriceX96 for price 1 (P=1) is exactly 2^96; liquidity sets the depth.
    const Q96 = 2n ** 96n;
    const v3: PoolState = { address: "0xv3", archetype: "v3", token0: A, token1: B, feePpm: 3000, sqrtPriceX96: Q96, liquidity: 1000n * E18, block: 100 };
    const r = bestRoute(adapters, [v3], A, B, E18);
    expect(r).not.toBeNull();
    expect(r!.amountOut).toBe(new V3Adapter().quoteOut(v3, A, E18)!.amountOut);
  });

  it("returns null when tokenOut is unreachable", () => {
    expect(bestRoute(adapters, [v2(A, C, E18, E18)], A, B, E18)).toBeNull();
    expect(bestRoute(adapters, [], A, B, E18)).toBeNull();
    expect(bestRoute(adapters, [v2(A, B, E18, E18)], A, A, E18)).toBeNull();
  });

  it("adapterMap routes each archetype to its adapter", () => {
    const m = adapterMap(adapters);
    expect(m.get("v2")).toBeInstanceOf(ConstantProductAdapter);
    expect(m.get("aerodrome")).toBeInstanceOf(ConstantProductAdapter);
    expect(m.get("v3")).toBeInstanceOf(V3Adapter);
    expect(m.get("aerodrome-stable")).toBeUndefined();
  });
});
