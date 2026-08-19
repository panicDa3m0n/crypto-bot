import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "../config.js";
import type { Database } from "../db.js";
import type { BerachainClients } from "../chain.js";
import { Aggregator, isNative, type Quote } from "../aggregator.js";
import { freshness, freshnessLog } from "../freshness.js";
import { ConstantProductAdapter } from "./adapters/constant-product.js";
import { V3Adapter } from "./adapters/v3.js";
import { bestRoute } from "./graph.js";
import { buildExec } from "./execution.js";
import type { Archetype, PoolState, VenueAdapter } from "./types.js";

/** A ready-to-broadcast own-execution plan built from a single-hop local route. */
export interface LocalExecPlan {
  router: Address;
  calldata: `0x${string}`;
  value: bigint;
  expectedOut: bigint;
  minOut: bigint;
  nativeIn: boolean;
  nativeOut: boolean;
  venue: Archetype;
  poolAddress: string;
}

/**
 * LocalRouter — WE are the aggregator. It computes quotes from our LOCAL MIRROR of AMM state
 * (pool_state + entities topology) via the venue adapters, over a small candidate graph, with ZERO
 * external calls. This is what kills the KyberSwap quote firehose (the 400/429 storm): every
 * sellability probe / entry-exit sim that used to hit the API is now answered from the DB.
 *
 * Drop-in: it EXTENDS Aggregator, so every consumer keeps its `Aggregator` type. It overrides only:
 *  - `quoteResult` → LOCAL-first; the external aggregator (`super`) is the FALLBACK, used only when we
 *    find no route on OUR venues (a token that lives on Curve/V4/Kuru we don't index yet). So the
 *    firehose for the 99% of tokens that ARE on our venues drops to zero external calls.
 *  - `swapCalldata` → still routes EXECUTION through the external aggregator in Phase 2 (build a real
 *    on-chain route). Own-execution via Universal/Aerodrome routers is Phase 3.
 *
 * Freshness: every local quote is stamped with how many blocks behind the indexer head its stalest
 * leg is (src/freshness.ts) and logged, so a quote served from old mirror state is never silent. The
 * single-tick V3 quote UNDER-states large trades (conservative) → safe for decision quotes; execution
 * exactness (preflight eth_call) is enforced in Phase 3.
 */
const FACTORY_ABI = parseAbi(["function factory() view returns (address)"]);
const TICKSPACING_ABI = parseAbi(["function tickSpacing() view returns (int24)"]);

export class LocalRouter extends Aggregator {
  private readonly adapters: VenueAdapter[] = [new ConstantProductAdapter(), new V3Adapter()];
  private head = { block: 0, at: 0 }; // short-TTL cache of the indexer cursor (avoid a DB hit per quote)
  private readonly factoryCache = new Map<string, string>(); // pool → factory (immutable), avoids re-reads
  private readonly tickSpacingCache = new Map<string, number>(); // slipstream pool → tickSpacing (immutable)
  private execVenuesCache: Map<string, { router: Address; venue: Archetype }> | null = null;

  constructor(private readonly cfg: Config, private readonly log: Logger, private readonly database: Database, private readonly chain?: BerachainClients) {
    super(cfg, log);
  }

  /** factory(lowercased) → {router, venue} for the DEXes whose router we can encode. A pool on any
   * OTHER fork (e.g. AERO's deepest pool sits on an unknown V3 fork) is NOT own-executable → excluded,
   * so we route through an executable pool instead of blindly hitting the wrong router (which reverts). */
  private execVenues(): Map<string, { router: Address; venue: Archetype }> {
    if (this.execVenuesCache) return this.execVenuesCache;
    const m = new Map<string, { router: Address; venue: Archetype }>();
    m.set(this.cfg.DEX_FACTORY.toLowerCase(), { router: this.cfg.DEX_ROUTER as Address, venue: "v3" });
    m.set(this.cfg.AERODROME_POOL_FACTORY.toLowerCase(), { router: this.cfg.AERODROME_ROUTER as Address, venue: "aerodrome" });
    m.set(this.cfg.UNIV2_FACTORY.toLowerCase(), { router: this.cfg.UNIV2_ROUTER as Address, venue: "v2" });
    m.set(this.cfg.SLIPSTREAM_POOL_FACTORY.toLowerCase(), { router: this.cfg.SLIPSTREAM_ROUTER as Address, venue: "slipstream" }); // Aerodrome CL (tickSpacing router)
    // ALL other DEXes the network profile registers (e.g. PancakeSwap V3) — factory → its OWN swapRouter —
    // so own-execution covers every venue we know, not a hardcoded three. A V3 fork shares the SwapRouter02
    // encoding; only the router address differs. Unknown-type / router-less dexes (V4, aggregators) are
    // skipped, so those pools route through an executable pool instead of hitting the wrong router.
    const venueOf = (t: string | undefined): Archetype | null => t === "uni-v3" ? "v3" : (t ?? "").startsWith("aerodrome") ? "aerodrome" : t === "uni-v2" ? "v2" : null;
    try {
      const extra = this.cfg.VENUE_EXTRA_JSON ? JSON.parse(this.cfg.VENUE_EXTRA_JSON) as Array<{ type?: string; address?: string; meta?: { swapRouter?: string } }> : [];
      for (const d of extra) {
        const factory = d.address?.toLowerCase(), router = d.meta?.swapRouter?.toLowerCase(), venue = venueOf(d.type);
        if (factory && router && venue && !m.has(factory)) m.set(factory, { router: router as Address, venue });
      }
    } catch { /* malformed profile extras → keep the core three */ }
    this.execVenuesCache = m;
    return m;
  }

  /** STARTUP WORKLIST (venue coverage): log which ACTIVE DEXes we can own-execute vs the ones we ingest +
   * quote but CANNOT execute yet (their factory isn't in our executable registry). Every unknown-but-active
   * factory is a protocol to curate — add its {factory, router, type} to the network profile (execVenues
   * reads the profile), and a distinct-ABI fork (e.g. SlipStream = tickSpacing) also needs its own encoder.
   * The aggregator fallback covers them meanwhile (logged as an anomaly), so nothing is un-tradeable. */
  async reportVenueCoverage(): Promise<void> {
    const act = await this.database.poolFactoryActivity(this.cfg.CHAIN_ID).catch(() => []);
    const known = this.execVenues();
    const unknown = act.filter((a) => a.factory !== "(missing)" && a.fresh > 0 && !known.has(a.factory));
    const executable = act.filter((a) => a.factory !== "(missing)" && known.has(a.factory));
    this.log.info({ executableFactories: executable.length, executableFreshPools: executable.reduce((s, a) => s + a.fresh, 0), knownVenues: known.size }, "own-execution venue coverage");
    if (unknown.length) this.log.warn({ count: unknown.length, top: unknown.slice(0, 12).map((a) => ({ factory: a.factory, archetype: a.archetype, freshPools: a.fresh, pools: a.pools })) }, "UNKNOWN active DEXes — pools ingested + quotable but NOT own-executable; curate factory→router (+encoder if a distinct-ABI fork) in the network profile to cover");
  }

  /** Resolve the pool's factory (stored meta → cache → live read) and map it to an executable router.
   * null = we can't own-execute this pool (unknown/unsupported fork). */
  private async resolveExec(pool: PoolState): Promise<{ router: Address; venue: Archetype } | null> {
    let factory = pool.factory?.toLowerCase() ?? this.factoryCache.get(pool.address);
    if (!factory && this.chain) {
      // Read lanes only (precision/primary/fallback) — NOT the dedicated indexer (drpc) lane, so a factory
      // resolution can't steal the indexer's block-ingestion budget. Enrichment fills factory in the DB anyway.
      for (const client of [this.chain.precision, this.chain.primary, this.chain.fallback]) {
        try { factory = (await client.readContract({ address: pool.address as Address, abi: FACTORY_ABI, functionName: "factory" }) as string).toLowerCase(); break; }
        catch { /* lane down → next */ }
      }
      if (factory) this.factoryCache.set(pool.address, factory);
    }
    if (!factory) return null;
    return this.execVenues().get(factory) ?? null;
  }

  /** SlipStream pools key by tickSpacing (immutable) — read it ONCE on a READ lane (never the dedicated
   * indexer lane), cached. null = unresolved → can't own-execute this pool (caller falls back). */
  private async resolveTickSpacing(pool: string): Promise<number | null> {
    const c = this.tickSpacingCache.get(pool); if (c != null) return c;
    if (!this.chain) return null;
    for (const client of [this.chain.precision, this.chain.primary, this.chain.fallback]) {
      try { const ts = Number(await client.readContract({ address: pool as Address, abi: TICKSPACING_ABI, functionName: "tickSpacing" })); if (Number.isFinite(ts) && ts !== 0) { this.tickSpacingCache.set(pool, ts); return ts; } }
      catch { /* lane down → next */ }
    }
    return null;
  }

  /** The indexer cursor (our head), cached ~1 block so the firehose doesn't re-read it every quote. */
  private async headBlock(): Promise<number> {
    if (Date.now() - this.head.at < 2_000) return this.head.block;
    const b = (await this.database.getIndexerCursor(this.cfg.CHAIN_ID).catch(() => null)) ?? 0;
    this.head = { block: b, at: Date.now() };
    return b;
  }

  /** Native-ETH sentinel → WETH so the graph (which only knows ERC20 pool tokens) can route it. */
  private norm(token: string): string {
    return isNative(token) ? this.cfg.WBERA_ADDRESS.toLowerCase() : token.toLowerCase();
  }

  /** Assemble the candidate PoolState set: pools touching tokenIn OR tokenOut covers every direct and
   * one-hop route (in↔M ∈ in's pools, M↔out ∈ out's pools). Fee + reserves + freshness come from the DB. */
  private async candidatePools(tokenIn: string, tokenOut: string): Promise<PoolState[]> {
    const cid = this.cfg.CHAIN_ID;
    const raw = new Map<string, { address: string; meta: unknown }>();
    for (const t of [tokenIn, tokenOut]) {
      for (const p of await this.database.poolsForToken(cid, t).catch(() => [])) raw.set(p.address.toLowerCase(), p);
    }
    if (!raw.size) return [];
    const states = await this.database.poolStateBatch(cid, [...raw.keys()]).catch(() => new Map());
    const pools: PoolState[] = [];
    for (const [address, { meta }] of raw) {
      const m = (meta ?? {}) as { token0?: string; token1?: string; archetype?: string; fee?: unknown; factory?: string };
      if (!m.token0 || !m.token1) continue;
      const archetype = (m.archetype ?? "v3") as Archetype;
      if (archetype === "aerodrome-stable") continue; // stable invariant + no pool_state → not locally quotable
      const st = states.get(address);
      pools.push({
        address, archetype, token0: m.token0.toLowerCase(), token1: m.token1.toLowerCase(),
        feePpm: Number(m.fee) > 0 ? Number(m.fee) : 0, factory: m.factory?.toLowerCase(),
        r0: st?.r0 ?? null, r1: st?.r1 ?? null, sqrtPriceX96: st?.sqrtPrice ?? null, liquidity: st?.liquidity ?? null,
        block: st?.block ?? 0, ageMs: st?.ageMs
      });
    }
    return pools;
  }

  override async quoteResult(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<{ status: "ok" | "no-route" | "error"; quote: Quote | null }> {
    if (amountIn <= 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return { status: "no-route", quote: null };
    const inN = this.norm(tokenIn), outN = this.norm(tokenOut);
    if (inN === outN) return { status: "no-route", quote: null }; // native↔WETH is a wrap, not a swap

    try {
      const pools = await this.candidatePools(inN, outN);
      const route = bestRoute(this.adapters, pools, inN, outN, amountIn, 2);
      if (route && route.amountOut > 0n) {
        const f = freshness(await this.headBlock(), route.path.map((p) => ({ block: p.block, ageMs: p.ageMs })), this.cfg.ROUTE_MAX_BLOCKS_BEHIND);
        this.log.debug({ tokenIn, tokenOut, amountOut: route.amountOut.toString(), hops: route.hops.length - 1, approximate: route.approximate, fresh: freshnessLog(f), source: "local" }, "local route quote");
        const quote: Quote = { amountIn, amountOut: route.amountOut, gasUnits: 0, gasUsd: 0, routerAddress: "", routeSummary: { local: true, hops: route.hops, pools: route.path.map((p) => p.address), approximate: route.approximate } };
        return { status: "ok", quote };
      }
    } catch (error) {
      this.log.debug({ err: error, tokenIn, tokenOut }, "local route error → aggregator fallback");
    }

    // No route on OUR venues → the token may live on a venue we don't index. Defer to the external
    // aggregator (the rare call), preserving its exact no-route/error semantics. This is the ONLY path
    // that still touches the API on the quote side.
    this.log.debug({ tokenIn, tokenOut, source: "aggregator-fallback" }, "no local route → external aggregator");
    return super.quoteResult(tokenIn, tokenOut, amountIn);
  }

  /**
   * OWN EXECUTION (Phase 3): build broadcastable venue-router calldata from OUR best SINGLE-HOP local
   * route. Returns null when we can't own-execute it — no direct pool, an archetype we don't route
   * (v4/exotic), or a zero quote — so the caller falls back to the external aggregator (which can do
   * multi-hop / cross-venue). Native ETH is handled by each router's native path (buy = value, no
   * approval; sell = receive ETH). minOut = local quote × (1 − slippage); the caller's preflight
   * eth_call is the final gate (a mis-encode or too-tight minOut reverts in simulation → fallback).
   */
  async execPlan(tokenIn: Address, tokenOut: Address, amountIn: bigint, recipient: Address, maxSlippagePct: number): Promise<LocalExecPlan | null> {
    if (amountIn <= 0n) return null;
    const nativeIn = isNative(tokenIn), nativeOut = isNative(tokenOut);
    const inN = this.norm(tokenIn), outN = this.norm(tokenOut);
    if (inN === outN) return null;
    const pools = await this.candidatePools(inN, outN);

    // Keep only pools we can OWN-EXECUTE: each pool routed to ITS dex's router (resolved by factory).
    // A "v3" pool on an unknown fork would revert if sent to the Uniswap router, so we EXCLUDE it and
    // route through an executable pool instead. Then pick the best route AMONG the executable ones.
    const execMap = new Map<string, { router: Address; venue: Archetype }>();
    const executable: PoolState[] = [];
    const excluded = new Set<string>();
    for (const p of pools) {
      const r = await this.resolveExec(p);
      if (r) { execMap.set(p.address, r); executable.push(p); }
      else excluded.add(p.factory ?? this.factoryCache.get(p.address) ?? "unknown");
    }
    const route = bestRoute(this.adapters, executable, inN, outN, amountIn, 1); // single-hop, executable pools only
    if (!route || route.path.length !== 1 || route.amountOut <= 0n) {
      this.log.debug({ tokenIn, tokenOut, candidates: pools.length, executable: executable.length, excludedFactories: [...excluded] }, "no executable local single-hop route → aggregator fallback");
      return null;
    }
    const pool = route.path[0];
    const { router, venue } = execMap.get(pool.address)!;

    const slip = Math.max(0, Math.min(0.5, maxSlippagePct / 100));
    const minOut = (route.amountOut * BigInt(Math.floor((1 - slip) * 1_000_000))) / 1_000_000n;
    if (minOut <= 0n) return null;
    // SlipStream pools need their tickSpacing (immutable) for the router — resolve it (cached); if we can't,
    // we can't own-execute this pool → fall back to the aggregator.
    let tickSpacing: number | undefined;
    if (venue === "slipstream") {
      const ts = await this.resolveTickSpacing(pool.address);
      if (ts == null) { this.log.debug({ pool: pool.address }, "slipstream tickSpacing unresolved → aggregator fallback"); return null; }
      tickSpacing = ts;
    }
    const weth = this.cfg.WBERA_ADDRESS as Address;
    const call = buildExec({
      venue: venue as "v3" | "aerodrome" | "v2" | "slipstream", router, weth,
      tokenIn: (nativeIn ? weth : tokenIn), tokenOut: (nativeOut ? weth : tokenOut),
      amountIn, minOut, recipient, deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
      nativeIn, nativeOut, feePpm: pool.feePpm, tickSpacing,
      stable: venue === "aerodrome" ? (pool.archetype === "aerodrome-stable") : false,
      factory: (pool.factory ?? this.factoryCache.get(pool.address)) as Address
    });
    const f = freshness(await this.headBlock(), [{ block: pool.block, ageMs: pool.ageMs }], this.cfg.ROUTE_MAX_BLOCKS_BEHIND);
    this.log.debug({ tokenIn, tokenOut, venue, pool: pool.address, router, expectedOut: route.amountOut.toString(), minOut: minOut.toString(), value: call.value.toString(), fresh: freshnessLog(f) }, "local exec plan built");
    return { router, calldata: call.calldata, value: call.value, expectedOut: route.amountOut, minOut, nativeIn, nativeOut, venue, poolAddress: pool.address };
  }

  /**
   * EXECUTION calldata for the aggregator path. Builds from a REAL external-aggregator route (super),
   * so the aggregator fallback in swapBest is unchanged. Own execution goes through `execPlan` above,
   * invoked by Primitives.swapViaLocalExec BEFORE this fallback.
   */
  override async swapCalldata(tokenIn: Address, tokenOut: Address, amountIn: bigint, recipient: Address, slippageBps = 100) {
    const { quote } = await super.quoteResult(tokenIn, tokenOut, amountIn);
    if (!quote) return null;
    return super.build(quote.routeSummary, recipient, recipient, slippageBps);
  }
}
