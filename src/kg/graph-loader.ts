import type { Database } from "../db.js";
import type { PoolState, Archetype } from "../router/types.js";
import { CONCENTRATED as CONC, MODELABLE } from "../archetypes.js";

/**
 * FULL LIQUIDITY GRAPH LOADER (Item 4.1) — the DB-only foundation of the KG Reality Observatory. Loads the
 * COMPLETE graph the system knows how to model: every supported pool, its mirrored state, capability
 * (archetype / fee / factory / tickSpacing), exactness (tickCoverage from pool_tick_status), decimals
 * (fail-closed — never guessed), and freshness (state block vs indexer head). NO RPC, NO seed/sampling limits,
 * stable INCLUDED. Every detector reads THIS one graph; nothing hides liquidity for arbitrary reasons.
 *
 * v4 (bytes32 poolId) is excluded here (separate own-execution path). "solidly" and other non-core archetypes
 * are LOADED and visible but flagged unmodeled (buildPoolSim can't simulate them yet) — honesty over hiding.
 */

// Everything we surface. Modelable-by-buildPoolSim = v2/aerodrome (CP) + aerodrome-stable + v3/slipstream.
const GRAPH_ARCHETYPES = ["v2", "aerodrome", "aerodrome-stable", "solidly", "v3", "slipstream"];

export interface GraphStats {
  poolsTotal: number;      // pools loaded (edges)
  poolsPriced: number;     // have usable reserves / sqrtPrice+liquidity
  modelable: number;       // buildPoolSim can simulate the archetype
  unmodeled: number;       // surfaced but not simulatable yet (e.g. solidly)
  tokens: number;          // distinct token nodes
  edges: number;           // graph edges (= poolsTotal; each pool is one edge)
  byArchetype: Record<string, number>;
  concentrated: number;    // v3/slipstream edges
  tickComplete: number;    // concentrated edges certified exact
  stable: number;          // aerodrome-stable edges
  decimalsMissing: number; // edges with ≥1 token of unknown decimals (fail-closed downstream)
  stalePools: number;      // edges older than the staleBlocks threshold (0 if unset)
  staleMirror: boolean;    // indexer not synced
}

export interface LiquidityGraph {
  pools: Map<string, PoolState>;    // poolId → full DB-only state (dec0/dec1/tickCoverage/freshness set)
  adjacency: Map<string, string[]>; // token → [poolId] edges touching it
  decimals: Map<string, number>;    // token → decimals (DB, fail-closed; ABSENT when unknown, never defaulted)
  /** token → USD spot, from the ONE place that holds it (token_prices, written by the indexer for exactly the
   * tokens whose pools moved). ABSENT when the indexer has never anchored the token — never defaulted. */
  prices: Map<string, number>;
  head: number;                     // indexer indexed block (mirror head)
  lag: number;                      // blocks behind network head (999_999 if de-synced)
  synced: boolean;
  stats: GraphStats;
}

export interface LoadOpts { staleBlocks?: number } // freshness threshold for the stat (never a filter)

/** Load the complete liquidity graph from the DB. Pure read-side: no chain RPC. */
export async function loadLiquidityGraph(db: Database, cid: number, opts: LoadOpts = {}): Promise<LiquidityGraph> {
  const rows = await db.graphPools(cid, GRAPH_ARCHETYPES).catch(() => []);
  const cs = await db.getChainStatus(cid).catch(() => null);
  const head = cs?.indexedBlock ?? 0;
  const lag = cs && cs.synced ? cs.lag : 999_999;   // de-synced ⇒ treat as maximally stale (gates reject)
  const synced = !!cs?.synced;

  // One decimals batch for all touched tokens (fail-closed: absent stays absent).
  const tokens = new Set<string>();
  const parsed: Array<{ address: string; m: PoolMeta; row: (typeof rows)[number] }> = [];
  for (const r of rows) {
    const m = (r.meta ?? {}) as PoolMeta;
    if (!m.token0 || !m.token1) continue; // a pool with unknown tokens can't be an edge
    tokens.add(m.token0.toLowerCase()); tokens.add(m.token1.toLowerCase());
    parsed.push({ address: r.address.toLowerCase(), m, row: r });
  }
  // Protocol-level fees (factory → ppm). A constant-product pool has NO per-pool fee, so its real fee comes
  // from its protocol. Resolving it HERE is what lets every consumer stop falling back to a guessed 0.30%.
  const protoFees = await db.protocolFees(cid).catch(() => new Map<string, number>());
  const decMeta = await db.tokenMeta(cid, [...tokens]).catch(() => new Map());
  // The spot price comes from the single source, in ONE batch. The observatory used to derive ETH/USD by
  // scanning every pool in the graph for a WETH/USDC pair and taking the max quote — a second answer to a
  // question the DB already answers, for two tokens only, at the cost of a full-graph scan per cycle.
  const priceRows = await db.getTokenPrices(cid, [...tokens]).catch(() => new Map());
  const prices = new Map<string, number>();
  for (const [t, row] of priceRows) if (row?.priceUsd != null && row.priceUsd > 0) prices.set(t.toLowerCase(), row.priceUsd);
  const decimals = new Map<string, number>();
  for (const [t, meta] of decMeta) if (meta.decimals != null) decimals.set(t.toLowerCase(), meta.decimals);
  const scale = (t: string): bigint | undefined => { const d = decimals.get(t); return d != null ? 10n ** BigInt(d) : undefined; };

  const pools = new Map<string, PoolState>();
  const adjacency = new Map<string, string[]>();
  const link = (t: string, pool: string) => { const a = adjacency.get(t); if (a) a.push(pool); else adjacency.set(t, [pool]); };
  const byArchetype: Record<string, number> = {};
  const concIds: string[] = [];
  let poolsPriced = 0, decimalsMissing = 0, stable = 0;

  for (const { address, m, row } of parsed) {
    const archetype = (m.archetype ?? "v3") as Archetype;
    const t0 = m.token0!.toLowerCase(), t1 = m.token1!.toLowerCase();
    const d0 = scale(t0), d1 = scale(t1);
    if (d0 === undefined || d1 === undefined) decimalsMissing++;
    if (archetype === "aerodrome-stable") stable++;
    const factory = m.factory?.toLowerCase();
    // Per-pool fee when the archetype has one; otherwise the PROTOCOL fee of its factory. 0 stays 0 (unknown)
    // so downstream can fail closed — but with the protocol fee resolved, "unknown" is now genuinely rare.
    // A V4 pool can have a HOOK-CONTROLLED fee: there is no static fee to read, only the one actually charged
    // on the last observed swap (pool_state.fee_ppm). It must come first for such a pool, because the fallback
    // chain below would otherwise land on 0 — and 0 is the dangerous direction: a zero fee makes a pool look
    // MORE profitable than it is, where the old fabricated 838% only made it invisible. Unknown stays 0 so the
    // consumer fails closed rather than quoting a free swap.
    const feePpm = m.dynamicFee === true
      ? (Number(row.feePpm) > 0 ? Number(row.feePpm) : 0)
      : Number(m.fee) > 0 ? Number(m.fee) : (factory ? protoFees.get(factory) ?? 0 : 0);
    const ps: PoolState = {
      address, archetype, token0: t0, token1: t1,
      feePpm,
      factory,
      r0: row.r0, r1: row.r1, sqrtPriceX96: row.sqrtPrice, liquidity: row.liquidity,
      tickSpacing: Number(m.tickSpacing) > 0 ? Number(m.tickSpacing) : undefined,
      dec0: d0, dec1: d1,
      block: row.block, ageMs: row.ageMs ?? undefined,
    };
    const priced = (ps.r0 != null && ps.r1 != null) || (ps.sqrtPriceX96 != null && ps.liquidity != null);
    if (priced) poolsPriced++;
    pools.set(address, ps);
    byArchetype[archetype] = (byArchetype[archetype] ?? 0) + 1;
    if (CONC.has(archetype)) concIds.push(address);
    link(t0, address); link(t1, address);
  }

  // Item 3 exactness overlay — certified tick completeness (NEVER inferred from ticks.length).
  const tickComplete = await db.poolTickCompleteBatch(cid, concIds).catch(() => new Map<string, boolean>());
  let tickCompleteN = 0;
  for (const id of concIds) { const p = pools.get(id)!; const c = tickComplete.get(id) === true; p.tickCoverage = c ? "complete" : "partial"; if (c) tickCompleteN++; }

  const stalePools = opts.staleBlocks != null ? [...pools.values()].filter((p) => head - p.block > opts.staleBlocks!).length : 0;
  const modelable = [...pools.values()].filter((p) => MODELABLE.has(p.archetype)).length;

  return {
    pools, adjacency, decimals, prices, head, lag, synced,
    stats: {
      poolsTotal: pools.size, poolsPriced, modelable, unmodeled: pools.size - modelable,
      tokens: adjacency.size, edges: pools.size, byArchetype,
      concentrated: concIds.length, tickComplete: tickCompleteN, stable, decimalsMissing, stalePools, staleMirror: !synced,
    },
  };
}

interface PoolMeta { token0?: string; token1?: string; archetype?: string; fee?: unknown; factory?: string; tickSpacing?: unknown; dynamicFee?: boolean }

/** What a block changed, and everything that therefore has to be recomputed. */
export interface GraphDelta {
  /** Pools whose state moved since the graph was last refreshed. */
  dirtyPools: Set<string>;
  /** Tokens whose spot price was recomputed, or that sit on a dirty pool. */
  dirtyTokens: Set<string>;
  /** Block the graph is now current to. */
  head: number;
  /** True when the graph was rebuilt wholesale rather than patched (first run, or a coverage break). */
  full: boolean;
}

/**
 * REFRESH BY DIFFERENCE. The governing rule is that a block is the only event: what it touched is recomputed,
 * what it did not is still valid and is reused. Reloading the whole graph every cycle contradicted that at the
 * worst possible ratio — 17 pools move per block against 25,390 reloaded.
 *
 * Patches the pools the indexer has written since `graph.head`, refreshes the spot prices that moved with them,
 * and returns the DELTA so the caller can recompute branches instead of everything. The graph object is
 * mutated in place: it is a long-lived mirror, not a per-cycle snapshot.
 *
 * Falls back to a full load when there is nothing to patch onto (first cycle) or when the mirror is further
 * behind than a patch can honestly express — a rebuild is the correct answer to "I do not know what changed".
 */
export async function refreshLiquidityGraph(db: Database, cid: number, graph: LiquidityGraph | null, opts: LoadOpts & { maxPatchBlocks?: number } = {}): Promise<{ graph: LiquidityGraph; delta: GraphDelta }> {
  const cs = await db.getChainStatus(cid).catch(() => null);
  const head = cs?.indexedBlock ?? 0;
  const gap = graph ? head - graph.head : Infinity;
  // A very large gap means patching would be more work than rebuilding AND the price map would be widely
  // stale; rebuild rather than pretend the delta is small.
  if (!graph || gap < 0 || gap > (opts.maxPatchBlocks ?? 5_000)) {
    const g = await loadLiquidityGraph(db, cid, opts);
    return { graph: g, delta: { dirtyPools: new Set(g.pools.keys()), dirtyTokens: new Set(g.adjacency.keys()), head: g.head, full: true } };
  }

  const changed = await db.poolsChangedSince(cid, graph.head, GRAPH_ARCHETYPES).catch(() => []);
  const dirtyPools = new Set<string>(), dirtyTokens = new Set<string>();
  for (const row of changed) {
    const address = row.address.toLowerCase();
    const prev = graph.pools.get(address);
    if (!prev) continue; // a pool the graph has never seen: it enters on the next full load, with its metadata
    // Only STATE moves block to block. Identity (tokens, fee, decimals, tickSpacing) is metadata the enricher
    // owns and does not change per block, so patching state alone keeps the mirror correct and cheap.
    prev.r0 = row.r0; prev.r1 = row.r1;
    prev.sqrtPriceX96 = row.sqrtPrice; prev.liquidity = row.liquidity;
    if (row.feePpm != null && row.feePpm > 0) prev.feePpm = row.feePpm; // V4: the fee is per-swap state
    prev.block = row.block; prev.ageMs = row.ageMs ?? undefined;
    dirtyPools.add(address);
    dirtyTokens.add(prev.token0); dirtyTokens.add(prev.token1);
  }
  // Prices move with the pools that produced them; a token can also be repriced by a backfill.
  const repriced = await db.tokensRepricedSince(cid, graph.head).catch(() => new Map<string, number>());
  for (const [t, usd] of repriced) { graph.prices.set(t, usd); dirtyTokens.add(t); }

  graph.head = head;
  graph.lag = cs && cs.synced ? cs.lag : 999_999;
  graph.synced = !!cs?.synced;
  return { graph, delta: { dirtyPools, dirtyTokens, head, full: false } };
}
