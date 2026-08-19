/**
 * EXTERNAL TICK SEED (Item 3.4e) — a subgraph gives us a pool's initialized-tick list in ~1-3 HTTP queries
 * instead of hundreds of storage reads. This is DISCOVERY ONLY: a subgraph is an external indexer (can lag,
 * have indexing errors, or mapping bugs), so its snapshot is a SEED that MUST be certified against the chain
 * (bitmap-set match + Quoter) before we ever set complete=true. The DB stays the source of truth after
 * certification; the Indexer then maintains it via live Mint/Burn. No subgraph endpoint ⇒ no seed ⇒ the
 * storage scanner is the universal fallback.
 */

export interface SubgraphTickSnapshot {
  ticks: Array<{ tick: number; liquidityNet: bigint }>;
  providerBlock: number;   // the block the seed is pinned to (the subgraph's indexed head, ≤ our cursor)
  indexingErrors: boolean;
  provider: string;
}

/** Build the gateway endpoint for a subgraph id (The Graph Network). The API key lives ONLY in the URL path
 * passed to fetch — never logged. Returns null if no key/id (provider unavailable → storage-scan fallback). */
export function graphNetworkEndpoint(apiKey: string | undefined, subgraphId: string | undefined): string | null {
  if (!apiKey || !subgraphId) return null;
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function gql(endpoint: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
      if (r.status === 429) { await sleep(1000 * (attempt + 1)); continue; } // rate-limited (esp. keyless Studio) → back off
      if (!r.ok) return null;
      const j = await r.json() as { data?: Record<string, unknown>; errors?: unknown };
      if (j.errors || !j.data) return null;
      return j.data;
    } catch { await sleep(500 * (attempt + 1)); }
  }
  return null;
}

const META_Q = `query { _meta { block { number } hasIndexingErrors } }`;
const TICKS_Q = `query PoolTicks($pool: String!, $block: Int!, $skip: Int!) {
  ticks(first: 1000, skip: $skip, where: { poolAddress: $pool, liquidityGross_gt: "0" }, block: { number: $block }, orderBy: tickIdx, orderDirection: asc) {
    tickIdx liquidityNet
  }
}`;
// Uniswap/Pancake V3 subgraphs key ticks by `poolAddress` (string). Some schemas use `pool: { id }`; the
// caller can override the where-clause via `poolField` if a fork differs.
const TICKS_Q_POOLID = `query PoolTicks($pool: String!, $block: Int!, $skip: Int!) {
  ticks(first: 1000, skip: $skip, where: { pool: $pool, liquidityGross_gt: "0" }, block: { number: $block }, orderBy: tickIdx, orderDirection: asc) {
    tickIdx liquidityNet
  }
}`;

/**
 * Fetch a pool's initialized ticks from a V3 subgraph @ a block ≤ `maxBlock` (our cursor). Pins to the
 * subgraph's own indexed head when it lags us (the certification then pins there too). Returns null on
 * indexing errors, empty result, or fetch failure → the caller falls back to the storage scan.
 */
export async function fetchSubgraphTicks(endpoint: string, pool: string, maxBlock: number, provider = "thegraph"): Promise<SubgraphTickSnapshot | null> {
  const meta = await gql(endpoint, META_Q, {});
  const m = (meta?._meta ?? null) as { block?: { number?: number }; hasIndexingErrors?: boolean } | null;
  if (!m?.block?.number) return null;
  if (m.hasIndexingErrors) return { ticks: [], providerBlock: m.block.number, indexingErrors: true, provider };
  const B = Math.min(m.block.number, maxBlock);

  const ticks: Array<{ tick: number; liquidityNet: bigint }> = [];
  for (const q of [TICKS_Q, TICKS_Q_POOLID]) {          // try poolAddress schema, then pool.id schema
    let ok = true, empty = true;
    for (let skip = 0; skip < 100_000; skip += 1000) {
      const d = await gql(endpoint, q, { pool: pool.toLowerCase(), block: B, skip });
      const rows = (d?.ticks ?? null) as Array<{ tickIdx: string; liquidityNet: string }> | null;
      if (rows == null) { ok = false; break; }           // this schema variant errored → try the other
      empty = empty && rows.length === 0;
      for (const t of rows) { const net = BigInt(t.liquidityNet); if (net !== 0n) ticks.push({ tick: Number(t.tickIdx), liquidityNet: net }); }
      if (rows.length < 1000) break;                      // last page
    }
    if (ok && !empty) return { ticks, providerBlock: B, indexingErrors: false, provider };
    if (ok && empty) return { ticks: [], providerBlock: B, indexingErrors: false, provider }; // genuinely no ticks
    ticks.length = 0;                                      // schema mismatch → reset and try the next variant
  }
  return null;
}
