/**
 * FRESHNESS — the cross-cutting "as of which block is this datum" primitive.
 *
 * We are a domain light-node: our pool_state / prices are a LOCAL MIRROR of on-chain AMM state,
 * only as fresh as the last block we indexed for each pool. Every quote/route is only as trustworthy
 * as its STALEST leg. This module turns per-leg update-blocks into one verdict the router logs and
 * gates on: how many blocks behind the indexer head are we, and is that beyond tolerance.
 *
 * Reference "head" is the INDEXER cursor (our own latest applied block), NOT a live RPC head — the
 * question is "how far behind is this pool vs everything else we've indexed", answerable from the DB
 * with zero extra network calls.
 */

export interface Freshness {
  /** Oldest (min) update-block across the legs — the route is only as fresh as this. 0 if unknown. */
  asOfBlock: number;
  /** head − asOfBlock, clamped ≥0. Infinity when head/asOfBlock is unknown (treat as maximally stale). */
  blocksBehind: number;
  /** Wall-clock age of the stalest leg in ms (from updated_at), when available. */
  maxAgeMs: number;
  /** True when blocksBehind exceeds the tolerance → caller must refresh on-chain or skip. */
  stale: boolean;
}

export interface FreshnessLeg {
  /** The block at which this pool's state was last updated (pool_state.block_number). */
  block: number;
  /** Wall-clock age of that state in ms (pool_state age), if known. */
  ageMs?: number;
}

/**
 * Compute the freshness verdict for a set of legs against the indexer head.
 * @param headBlock the indexer cursor (latest applied block); 0/undefined → unknown head.
 * @param legs      per-leg update-blocks (+ optional ages).
 * @param maxBlocksBehind tolerance (config.ROUTE_MAX_BLOCKS_BEHIND).
 */
export function freshness(headBlock: number, legs: FreshnessLeg[], maxBlocksBehind: number): Freshness {
  if (!legs.length) return { asOfBlock: 0, blocksBehind: Infinity, maxAgeMs: 0, stale: true };
  const blocks = legs.map((l) => (Number.isFinite(l.block) && l.block > 0 ? l.block : 0));
  const asOfBlock = Math.min(...blocks);
  const maxAgeMs = Math.max(0, ...legs.map((l) => (Number.isFinite(l.ageMs ?? NaN) ? (l.ageMs as number) : 0)));
  // Unknown head or a leg with no block → we cannot prove freshness → maximally stale (fail safe).
  const blocksBehind = headBlock > 0 && asOfBlock > 0 ? Math.max(0, headBlock - asOfBlock) : Infinity;
  return { asOfBlock, blocksBehind, maxAgeMs, stale: blocksBehind > maxBlocksBehind };
}

/** Compact structured payload for logs — attach under a `fresh` key so every route line is verifiable. */
export function freshnessLog(f: Freshness): { asOfBlock: number; blocksBehind: number | string; maxAgeMs: number; stale: boolean } {
  return { asOfBlock: f.asOfBlock, blocksBehind: Number.isFinite(f.blocksBehind) ? f.blocksBehind : "unknown", maxAgeMs: Math.round(f.maxAgeMs), stale: f.stale };
}
