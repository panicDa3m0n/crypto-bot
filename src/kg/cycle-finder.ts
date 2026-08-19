import type { PoolState, Archetype } from "../router/types.js";
import { stableProbe } from "../router/solidly-math.js";

/**
 * KG CYCLE-FINDER (Liquidity-Graph, phase F1 — the detector). We model the mirrored pool universe as a
 * DIRECTED graph: node = token, edge = a swap direction through one pool. An arbitrage is a CYCLE
 * A→B→…→A whose product of marginal (raw-unit, fee-adjusted) exchange rates is > 1 — i.e. one wei of A
 * returns more than one wei of A around the loop. Taking edge weight = −ln(rate), such a cycle is exactly
 * a NEGATIVE-WEIGHT cycle, which Bellman-Ford detects. This module is PURE (no I/O): a function of the
 * PoolState set the caller assembles from the DB. It reuses the SAME AMM math as the router adapters
 * (constant-product on real reserves for v2/aerodrome; on virtual reserves L·2⁹⁶/√P, L·√P/2⁹⁶ for v3/v4).
 *
 * The rate here is MARGINAL (infinitesimal-size) — it answers "does a profitable loop exist?", not "how
 * much". Sizing + exact tick-crossing simulation + gas gating are the next F1 steps; a marginal negative
 * cycle is the necessary precondition they refine.
 */

const Q96 = 2n ** 96n;

export interface KGEdge {
  pool: string;            // pool address
  archetype: Archetype;
  from: string;            // tokenIn (lowercased)
  to: string;              // tokenOut (lowercased)
  feePpm: number;
  lnRate: number;          // ln(marginal fee-adjusted raw rate); edge weight = −lnRate
  state: PoolState;        // kept for later sizing / exact-sim / calldata
}

export interface KGCycle {
  tokens: string[];        // [A, B, …, A] lowercased, closed
  edges: KGEdge[];
  product: number;         // ∏ marginal rate around the loop (>1 ⇒ marginal profit)
  grossBps: number;        // (product − 1) · 1e4
}

/** Natural log of a bigint, overflow/underflow-safe at any magnitude (raw reserves exceed 2⁵³). */
function lnBig(x: bigint): number {
  if (x <= 0n) return -Infinity;
  const bits = x.toString(2).length;
  if (bits <= 52) return Math.log(Number(x));
  const shift = bits - 52;
  return Math.log(Number(x >> BigInt(shift))) + shift * Math.LN2;
}

/** Raw (real for cp, virtual for concentrated) reserves of a pool, or null if state is missing/zero. */
function rawReserves(p: PoolState): { r0: bigint; r1: bigint } | null {
  if (p.archetype === "v2" || p.archetype === "aerodrome") {
    if (p.r0 == null || p.r1 == null || p.r0 <= 0n || p.r1 <= 0n) return null;
    return { r0: p.r0, r1: p.r1 };
  }
  if (p.archetype === "aerodrome-stable") return null; // non-cp invariant, no state — out of scope
  const sp = p.sqrtPriceX96, L = p.liquidity; // v3 / v4 / slipstream (v3-classified)
  if (sp == null || L == null || sp <= 0n || L <= 0n) return null;
  const r0 = (L * Q96) / sp, r1 = (L * sp) / Q96;
  return r0 > 0n && r1 > 0n ? { r0, r1 } : null;
}

/** ln of the marginal fee-adjusted rate (raw wei out per wei in) = ln(rOut/rIn) + ln(1−fee). */
function lnMarginal(rIn: bigint, rOut: bigint, feePpm: number): number {
  const fee = feePpm > 0 && feePpm < 1_000_000 ? feePpm : 3000;
  return lnBig(rOut) - lnBig(rIn) + Math.log((1_000_000 - fee) / 1_000_000);
}

/** Two directed edges per usable pool (token0→token1 and token1→token0). */
export function buildEdges(pools: PoolState[]): KGEdge[] {
  const edges: KGEdge[] = [];
  for (const p of pools) {
    if (!p.token0 || !p.token1) continue;
    const t0 = p.token0.toLowerCase(), t1 = p.token1.toLowerCase();
    const fee = p.feePpm;
    const id = p.address.toLowerCase();
    if (p.archetype === "aerodrome-stable") {
      // Stable curve: reserve ratio ≠ marginal rate → probe the exact math. FAIL-CLOSED without dec/fee.
      if (p.r0 == null || p.r1 == null || p.r0 <= 0n || p.r1 <= 0n || p.dec0 == null || p.dec1 == null || fee <= 0) continue;
      const bps = fee / 100;
      const a = stableProbe(p.r0, p.r1, p.dec0, p.dec1, bps, true);
      const b = stableProbe(p.r0, p.r1, p.dec0, p.dec1, bps, false);
      if (a) edges.push({ pool: id, archetype: p.archetype, from: t0, to: t1, feePpm: fee, lnRate: lnBig(a.outWei) - lnBig(a.inWei), state: p });
      if (b) edges.push({ pool: id, archetype: p.archetype, from: t1, to: t0, feePpm: fee, lnRate: lnBig(b.outWei) - lnBig(b.inWei), state: p });
      continue;
    }
    const rr = rawReserves(p);
    if (!rr) continue;
    edges.push({ pool: id, archetype: p.archetype, from: t0, to: t1, feePpm: fee, lnRate: lnMarginal(rr.r0, rr.r1, fee), state: p });
    edges.push({ pool: id, archetype: p.archetype, from: t1, to: t0, feePpm: fee, lnRate: lnMarginal(rr.r1, rr.r0, fee), state: p });
  }
  return edges;
}

export interface FindOpts {
  /** Minimum gross basis-points to report (filters numerical noise near 0). Default 1 bp. */
  minGrossBps?: number;
  /** Max distinct cycles to return, best-first. Default 25. */
  limit?: number;
  /** Ignore an edge whose marginal rate is non-finite. */
}

/**
 * Bellman-Ford negative-cycle detection over the token graph. Initialising every node's distance to 0 is
 * equivalent to a virtual super-source with 0-weight edges to all nodes, so cycles in ANY component are
 * found. After |V|−1 relaxations, any edge that still relaxes lies on (or downstream of) a negative
 * cycle; we walk predecessors |V| steps to land inside the loop, extract it, and dedupe by pool-set.
 */
export function findNegativeCycles(pools: PoolState[], opts: FindOpts = {}): KGCycle[] {
  const minGrossBps = opts.minGrossBps ?? 1;
  const limit = opts.limit ?? 25;
  const edges = buildEdges(pools).filter((e) => Number.isFinite(e.lnRate));
  if (!edges.length) return [];

  // Index nodes.
  const nodes = new Set<string>();
  for (const e of edges) { nodes.add(e.from); nodes.add(e.to); }
  const idx = new Map<string, number>();
  let i = 0; for (const n of nodes) idx.set(n, i++);
  const V = idx.size;

  const dist = new Array<number>(V).fill(0);
  const pred = new Array<KGEdge | null>(V).fill(null);
  const EPS = 1e-12; // only accept a strictly-better relaxation (avoids float-noise churn)

  // |V|−1 relaxations.
  for (let iter = 0; iter < V - 1; iter++) {
    let changed = false;
    for (const e of edges) {
      const u = idx.get(e.from)!, v = idx.get(e.to)!;
      const cand = dist[u] - e.lnRate; // weight = −lnRate
      if (cand < dist[v] - EPS) { dist[v] = cand; pred[v] = e; changed = true; }
    }
    if (!changed) break;
  }

  // Nodes whose incoming edge still relaxes → on/after a negative cycle.
  const seeds: number[] = [];
  for (const e of edges) {
    const u = idx.get(e.from)!, v = idx.get(e.to)!;
    if (dist[u] - e.lnRate < dist[v] - EPS) { dist[v] = dist[u] - e.lnRate; pred[v] = e; seeds.push(v); }
  }

  const out: KGCycle[] = [];
  const seenKeys = new Set<string>();
  for (const seed of seeds) {
    // Walk V steps back to guarantee we're inside the cycle.
    let x = seed;
    for (let k = 0; k < V; k++) { const e = pred[x]; if (!e) { x = -1; break; } x = idx.get(e.from)!; }
    if (x < 0) continue;

    // Extract the cycle by following predecessors from x until we return to x.
    const cycleEdges: KGEdge[] = [];
    const guard = new Set<number>();
    let cur = x;
    for (let k = 0; k <= V; k++) {
      const e = pred[cur]; if (!e) break;
      cycleEdges.push(e);
      const prev = idx.get(e.from)!;
      if (prev === x) break;
      if (guard.has(prev)) break; // safety: malformed pred chain
      guard.add(prev);
      cur = prev;
    }
    if (cycleEdges.length < 2) continue;
    cycleEdges.reverse(); // now in traversal order A→B→…→A

    // Dedupe by the set of pools used (rotations/entry-points collapse to one).
    const key = cycleEdges.map((e) => e.pool).sort().join("|");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const lnSum = cycleEdges.reduce((s, e) => s + e.lnRate, 0);
    const product = Math.exp(lnSum);
    const grossBps = (product - 1) * 1e4;
    if (!(grossBps >= minGrossBps)) continue;
    const tokens = [cycleEdges[0].from, ...cycleEdges.map((e) => e.to)];
    out.push({ tokens, edges: cycleEdges, product, grossBps });
  }

  out.sort((a, b) => b.grossBps - a.grossBps);
  return out.slice(0, limit);
}
