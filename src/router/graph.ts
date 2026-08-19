import type { PoolState, QuoteLeg, VenueAdapter, Archetype } from "./types.js";

/**
 * PURE route-finding over a graph of mirrored pools. No I/O — a function of (adapters, pools,
 * tokenIn, tokenOut, amountIn). This is where "we are our own aggregator" lives: enumerate the paths
 * (direct + one-hop through any intermediate present in the candidate set), quote each leg with the
 * right venue adapter, and keep the path that yields the most output. Split routing (spreading one
 * trade across parallel pools) is Phase 5; here each route uses one pool per hop.
 */

export interface RouteResult {
  /** Ordered pools the trade flows through. */
  path: PoolState[];
  /** Ordered token addresses: [tokenIn, mid…, tokenOut]. */
  hops: string[];
  /** Final executable output (raw wei of tokenOut). */
  amountOut: bigint;
  /** Per-hop leg quotes. */
  legs: QuoteLeg[];
  /** True if ANY leg was only an approximation (e.g. a V3 tick-crossing) → router should confirm. */
  approximate: boolean;
}

/** Map archetype → the adapter that serves it (first match wins). */
export function adapterMap(adapters: VenueAdapter[]): Map<Archetype, VenueAdapter> {
  const m = new Map<Archetype, VenueAdapter>();
  for (const a of adapters) for (const arch of a.archetypes) if (!m.has(arch)) m.set(arch, a);
  return m;
}

/** Token → pools that contain it (both directions). Foreign/incomplete pools are dropped. */
export function buildAdjacency(pools: PoolState[]): Map<string, Array<{ pool: PoolState; other: string }>> {
  const adj = new Map<string, Array<{ pool: PoolState; other: string }>>();
  const add = (t: string, pool: PoolState, other: string) => {
    const k = t.toLowerCase();
    const arr = adj.get(k) ?? [];
    arr.push({ pool, other: other.toLowerCase() });
    adj.set(k, arr);
  };
  for (const p of pools) {
    if (!p.token0 || !p.token1) continue;
    add(p.token0, p, p.token1);
    add(p.token1, p, p.token0);
  }
  return adj;
}

/** Quote one ordered path leg-by-leg. null if any leg can't be quoted or the path doesn't land on tokenOut. */
export function quotePath(byArch: Map<Archetype, VenueAdapter>, path: PoolState[], tokenIn: string, tokenOut: string, amountIn: bigint): RouteResult | null {
  let cur = tokenIn.toLowerCase();
  let amt = amountIn;
  let approximate = false;
  const legs: QuoteLeg[] = [];
  const hops: string[] = [cur];
  for (const pool of path) {
    const adapter = byArch.get(pool.archetype);
    if (!adapter) return null;
    const leg = adapter.quoteOut(pool, cur, amt);
    if (!leg || leg.amountOut <= 0n) return null;
    const other = cur === pool.token0.toLowerCase() ? pool.token1.toLowerCase() : pool.token0.toLowerCase();
    legs.push(leg);
    approximate = approximate || leg.approximate;
    amt = leg.amountOut;
    cur = other;
    hops.push(cur);
  }
  if (cur !== tokenOut.toLowerCase()) return null;
  return { path, hops, amountOut: amt, legs, approximate };
}

/**
 * Best route from tokenIn to tokenOut for `amountIn`, over paths of up to `maxHops` pools. Enumerates
 * direct pools and one-intermediate paths from the candidate set, quotes each, returns the max-output
 * route (or null if none). Bounded by the candidate pool set the caller assembles (pools touching
 * in/out/hubs), so the enumeration is small.
 */
export function bestRoute(adapters: VenueAdapter[], pools: PoolState[], tokenIn: string, tokenOut: string, amountIn: bigint, maxHops = 2): RouteResult | null {
  if (amountIn <= 0n) return null;
  const inl = tokenIn.toLowerCase(), outl = tokenOut.toLowerCase();
  if (inl === outl) return null;
  const byArch = adapterMap(adapters);
  const adj = buildAdjacency(pools);
  let best: RouteResult | null = null;
  const consider = (r: RouteResult | null) => { if (r && (!best || r.amountOut > best.amountOut)) best = r; };

  // Direct (1 hop): every pool pairing in↔out.
  for (const { pool, other } of adj.get(inl) ?? []) if (other === outl) consider(quotePath(byArch, [pool], inl, outl, amountIn));

  // One intermediate (2 hops): in → M → out, M ≠ in,out. Quote sequentially so impact compounds.
  if (maxHops >= 2) {
    for (const { pool: p1, other: mid } of adj.get(inl) ?? []) {
      if (mid === outl || mid === inl) continue;
      for (const { pool: p2, other } of adj.get(mid) ?? []) {
        if (other !== outl || p2.address.toLowerCase() === p1.address.toLowerCase()) continue;
        consider(quotePath(byArch, [p1, p2], inl, outl, amountIn));
      }
    }
  }
  return best;
}
