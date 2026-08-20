import type { Database } from "../db.js";
import type { PoolState, Archetype } from "../router/types.js";
import type { LiquidityGraph } from "./graph-loader.js";
import { PoolSim } from "./state.js";
import { buildPoolSim } from "./kernel.js";

/**
 * SHARED VALUE/PATH SURFACE PRIMITIVE (Item 7) — the one economic-evaluation core under BOTH Pair Surface and
 * Best Exit Surface. It answers "for `amountIn` of assetIn, what is the best amountOut to assetOut, by what
 * path, and is that path exact / own-encodable / blacklist-clean?" using the same PoolSims, chaining swaps
 * correctly (each hop consumes the prior hop's output; simple paths ⇒ no pool reused ⇒ non-mutating quote is
 * exact for compounding), and always tracking simulationExact + encodability + blacklist. Detectors are just
 * different VIEWS over this: Pair Surface reads venue-by-venue on one pair; Best Exit reads token→numéraire.
 */

const CONC = new Set<Archetype>(["v3", "v4", "slipstream"]);
const MODELABLE = new Set(["v2", "aerodrome", "aerodrome-stable", "v3", "slipstream"]);

export interface PathQuotePoint {
  amountIn: bigint;
  amountOut: bigint;
  path: string[];      // token hops [assetIn, …, assetOut] (lowercased)
  pools: string[];     // pool per hop
  exact: boolean;      // every hop certifiably exact (complete coverage / v2 / stable, in-envelope)
  encodable: boolean;  // every hop on an own-executable fork
  clean: boolean;      // no blacklisted token on the path
  inexactReason?: string;
}
export interface ValueSurface { assetIn: string; assetOut: string; points: PathQuotePoint[] }

/** Shared context: the graph + a lazy PoolSim provider (ticks loaded on demand) + own-encodability + blacklist
 * + a depth-sorted adjacency (so the beam expands the DEEPEST pools of a hub first, not all 10k edges). */
export interface SurfaceContext {
  graph: LiquidityGraph;
  simFor: (poolId: string) => Promise<PoolSim | null>;
  capability: (ps: PoolState) => boolean;
  blacklisted: Set<string>;
  adjSorted: (token: string) => string[]; // token's pools, deepest-first
}

/** Rough T-side depth of a pool, for routing priority (comparable only among pools sharing token T). */
function poolDepthFor(ps: PoolState, token: string): bigint {
  if (ps.sqrtPriceX96 != null && ps.liquidity != null) return ps.liquidity; // v3: in-range liquidity proxy
  const r0 = ps.r0 ?? 0n, r1 = ps.r1 ?? 0n;
  return ps.token0 === token ? r0 : r1;                                      // CP/stable: the T-side reserve
}

export function buildSurfaceContext(db: Database, cid: number, graph: LiquidityGraph, capability: (ps: PoolState) => boolean, blacklisted: Set<string>): SurfaceContext {
  const tickCache = new Map<string, Array<{ tick: number; liquidityNet: bigint }>>();
  const simCache = new Map<string, PoolSim | null>();
  const simFor = async (id: string): Promise<PoolSim | null> => {
    if (simCache.has(id)) return simCache.get(id)!;
    const ps = graph.pools.get(id); if (!ps || !MODELABLE.has(ps.archetype)) { simCache.set(id, null); return null; }
    let ticks: Array<{ tick: number; liquidityNet: bigint }> | undefined;
    if (CONC.has(ps.archetype)) { ticks = tickCache.get(id) ?? await db.tickLiquidity(cid, id).catch(() => []); tickCache.set(id, ticks); }
    const s = buildPoolSim(ps, ticks); simCache.set(id, s); return s;
  };
  const adjCache = new Map<string, string[]>();
  const adjSorted = (token: string): string[] => {
    const c = adjCache.get(token); if (c) return c;
    const pools = (graph.adjacency.get(token) ?? []).filter((id) => { const p = graph.pools.get(id); return p && MODELABLE.has(p.archetype); });
    pools.sort((a, b) => { const da = poolDepthFor(graph.pools.get(a)!, token), db2 = poolDepthFor(graph.pools.get(b)!, token); return da > db2 ? -1 : da < db2 ? 1 : 0; });
    adjCache.set(token, pools); return pools;
  };
  return { graph, simFor, capability, blacklisted, adjSorted };
}

export interface PathOpts { maxHops?: number; beamPerToken?: number; maxEdgesPerToken?: number; topN?: number; deadline?: number }

/**
 * Best path(s) from assetIn to assetOut for a GIVEN amountIn — bounded beam search. Expands the DEEPEST
 * `maxEdgesPerToken` pools of each token (hubs like WETH have 10k edges; the depth-sorted beam keeps it
 * tractable), keeps the top `beamPerToken` states PER intermediate token (dominance: more of token X ⇒ ≥ out
 * downstream, so the best-amount route to X survives), and returns the top terminals reaching assetOut. Simple
 * paths only (no token revisited) ⇒ each pool used once ⇒ chaining non-mutating quotes is exact for impact.
 */
export async function quoteBestPaths(ctx: SurfaceContext, assetIn: string, assetOut: string, amountIn: bigint, opts: PathOpts = {}): Promise<PathQuotePoint[]> {
  const maxHops = opts.maxHops ?? 3, beam = opts.beamPerToken ?? 4, maxEdges = opts.maxEdgesPerToken ?? 32;
  interface St { token: string; amount: bigint; path: string[]; pools: string[]; exact: boolean; encodable: boolean; clean: boolean }
  const cmp = (x: St, y: St) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0);
  let frontier: St[] = [{ token: assetIn.toLowerCase(), amount: amountIn, path: [assetIn.toLowerCase()], pools: [], exact: true, encodable: true, clean: true }];
  const terminals: St[] = [];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    if (opts.deadline && Date.now() > opts.deadline) break; // time-bounded: stop expanding, keep terminals so far
    const next: St[] = [];
    for (const st of frontier) {
      if (opts.deadline && Date.now() > opts.deadline) break;
      const pools = ctx.adjSorted(st.token).slice(0, maxEdges);
      for (const pid of pools) {
        const ps = ctx.graph.pools.get(pid); if (!ps) continue;
        const other = ps.token0 === st.token ? ps.token1 : ps.token0;
        if (st.path.includes(other)) continue;                 // simple path
        const sim = await ctx.simFor(pid); if (!sim) continue;
        const q = sim.quote(st.token, st.amount); if (!q || q.amountOut <= 0n) continue;
        const ns: St = { token: other, amount: q.amountOut, path: [...st.path, other], pools: [...st.pools, pid], exact: st.exact && q.exact, encodable: st.encodable && ctx.capability(ps), clean: st.clean && !ctx.blacklisted.has(other) };
        if (other === assetOut.toLowerCase()) terminals.push(ns); else next.push(ns);
      }
    }
    const byTok = new Map<string, St[]>();
    for (const s of next) { const a = byTok.get(s.token); if (a) a.push(s); else byTok.set(s.token, [s]); }
    frontier = [];
    for (const arr of byTok.values()) { arr.sort(cmp); for (const s of arr.slice(0, beam)) frontier.push(s); }
  }
  terminals.sort(cmp);
  const out: PathQuotePoint[] = [];
  const seen = new Set<string>();
  for (const t of terminals) { const k = t.pools.join(","); if (seen.has(k)) continue; seen.add(k); out.push({ amountIn, amountOut: t.amount, path: t.path, pools: t.pools, exact: t.exact, encodable: t.encodable, clean: t.clean }); if (out.length >= (opts.topN ?? 6)) break; }
  return out;
}
