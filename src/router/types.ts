/**
 * ROUTER — venue-adapter contract. We are our own aggregator: a local route-finder over a graph of
 * pools whose AMM state we mirror from the indexer. Each AMM FAMILY (constant-product, concentrated,
 * stable, CLOB, …) plugs in via a `VenueAdapter` so adding V4/Kuru never rewrites the router.
 *
 * Adapters are PURE and decimal-agnostic on the quote path: raw wei in → raw wei out, computed with
 * the family's own invariant — exactly what the DEX contract computes. No RPC, no DB, no I/O → each
 * adapter is a unit-testable function of (pool state, tokenIn, amountIn). Decimals enter only for the
 * human-unit `spot` helper. Execution encoding (build calldata for the venue's router) is added to
 * this interface in Phase 3; Phase 1 is the quote surface only.
 */

/** AMM family of a pool, as classified by the indexer (entities.meta.archetype). "slipstream" is not a
 * pool archetype (SlipStream pools classify as "v3" for pricing) — it's an EXECUTION venue: the same V3
 * concentrated-liquidity math, but the router keys pools by int24 tickSpacing (not uint24 fee). */
export type Archetype = "v2" | "aerodrome" | "aerodrome-stable" | "v3" | "v4" | "slipstream";

/**
 * The raw AMM state of one pool — our LOCAL MIRROR of on-chain state, assembled by the router from
 * `pool_state` (reserves / sqrtPrice+liquidity, with its update-block) + `entities.meta`
 * (token0/token1/archetype/fee). `feePpm` is the pool's real fee in parts-per-million (30 bps = 3000);
 * the router sources it (entities.meta.fee for V3; factory `getFee` for Solidly) so the adapter math
 * is bit-exact, never a guessed fee.
 */
export interface PoolState {
  address: string;
  archetype: Archetype;
  token0: string;
  token1: string;
  feePpm: number;
  /** The pool's factory address (which DEX created it) — resolves the correct router for OWN execution,
   * since one archetype ("v3") is shared by many forks (Uniswap/Pancake/others). May be undefined for
   * pools discovered before we stored it; the router resolves it live in that case. */
  factory?: string;
  // constant-product (v2 / aerodrome volatile), raw wei:
  r0?: bigint | null;
  r1?: bigint | null;
  // concentrated liquidity (v3), raw:
  sqrtPriceX96?: bigint | null;
  liquidity?: bigint | null;
  /** SlipStream pools key by int24 tickSpacing (not fee) for own-execution. DB-first: filled by the
   * enricher into entities.meta.tickSpacing; the router NEVER reads it live. undefined = not yet enriched. */
  tickSpacing?: number;
  /** Token decimal SCALES (10**decimals) for token0/token1 — REQUIRED for aerodrome-stable math (which
   * normalises reserves by decimals). From the enriched token entities; undefined = can't quote stable. */
  dec0?: bigint;
  dec1?: bigint;
  // FRESHNESS: the block this state was last updated at, and its wall-clock age (see src/freshness.ts).
  block: number;
  ageMs?: number;
}

/** The result of quoting a single pool leg. */
export interface QuoteLeg {
  /** Executable output in raw wei of the OTHER token. */
  amountOut: bigint;
  /** The fee (ppm) actually applied — echoed back for logging/verification. */
  feePpm: number;
  /**
   * True when the quote is only an APPROXIMATION of the on-chain result — e.g. a V3 trade that
   * crosses out of the current tick's liquidity (exact only once Phase 4's tick map lands). The
   * router uses this to decide whether to confirm the leg with an on-chain quote before trusting it.
   */
  approximate: boolean;
}

/** One AMM family's math. Pure: no I/O; a function of (pool state, tokenIn, amountIn). */
export interface VenueAdapter {
  /** The archetypes this adapter serves (e.g. constant-product handles both "v2" and "aerodrome"). */
  readonly archetypes: readonly Archetype[];

  /**
   * EXACT executable output for swapping `amountIn` (raw wei) of `tokenIn` through `pool`, in raw wei
   * of the other token. null when this pool can't quote the pair (missing/zero state, wrong token,
   * or the family isn't locally quotable yet). Same integer math the DEX contract runs.
   */
  quoteOut(pool: PoolState, tokenIn: string, amountIn: bigint): QuoteLeg | null;

  /**
   * Marginal (spot) price of `base` denominated in the pool's OTHER token, in HUMAN units. Needs the
   * two tokens' decimals (dec0 = token0's, dec1 = token1's). null if not computable. Display/ranking
   * only — routing decisions use `quoteOut` (sized, executable), never spot × amount.
   */
  spot(pool: PoolState, base: string, dec0: number, dec1: number): number | null;
}
