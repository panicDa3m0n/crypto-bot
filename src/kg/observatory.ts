import type { Database } from "../db.js";
import type { Config } from "../config.js";
import type { Archetype, PoolState } from "../router/types.js";
import type { LiquidityGraph } from "./graph-loader.js";
import { PoolSim, type SwapTrace } from "./state.js";
import { buildPoolSim, sizeCycle } from "./kernel.js";
import { findNegativeCycles, type KGCycle, type KGEdge } from "./cycle-finder.js";
import { evaluateExecutable, type GateContext } from "./opportunity.js";
import { CONCENTRATED as CONC, MODELABLE } from "../archetypes.js";

/**
 * KG OPPORTUNITY OBSERVATORY (Item 4.2) — reads the ONE full liquidity graph many different ways and turns
 * each economic reading into a sized, gated, persistable candidate. Detectors so far:
 *   • cycle       — spatial/cyclic arb (2..N-hop negative cycles) sized on the REAL curve, not the margin.
 *   • pair-curve  — same-pair cross-venue disagreement: seed best-buy/best-sell venues from the margin, then
 *                   size the exact round-trip. Catches spreads a purely-marginal cycle finder mishandles.
 * Every candidate flows the same pipeline: exact simulation → economic gate (DB-first gas) → lifecycle row.
 * READ-ONLY: no chain RPC; gas comes from gas_state (a write-side poller fills it).
 */

/** Compact deterministic hash (djb2 → hex) — for the candidate state fingerprint, not security. */
function hash(s: string): string { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }

export interface Candidate {
  detector: "cycle" | "pair-curve";
  ckey: string; numeraire: string; route: string; pools: string[];
  amountIn: bigint; grossUsd: number | null; gasUnits: bigint; gasUsd: number; netUsd: number | null;
  simulationExact: boolean; executable: boolean; rejectionReason?: string;
  legs: SwapTrace[];            // per-hop exact amounts — lets the shadow-preflight re-encode without re-sizing
  minProfitNumeraire: bigint;   // the on-chain minProfit floor the execution calldata would carry
  fingerprint: string;          // hash(route pools + their state blocks + amountIn + minProfit) — preflight dedup
}
export interface ObserveStats {
  aborted?: boolean;
  skippedUnchanged?: number;       // branches whose pools all sat still — reused, not recomputed               // the cycle was cut short (mirror went stale); its numbers are partial
  detectors: Record<string, number>; sized: number; economic: number;
  economicallyPositive: number;    // economic edge (net > threshold) before encodability
  routeEncodable: number;          // of those, we can build calldata for the whole route
  executable: number;              // encodable ∧ exact ∧ fresh ∧ flash-fundable (the honest gate)
  gasPriceWei: string; gasAgeMs: number | null; gasStale: boolean; ethUsd: number; multiVenuePairs: number;
  // "profit lost to unsupported forks": factories that carry a positive edge we CANNOT encode.
  unsupportedForks: Array<{ factory: string; candidates: number; peakUsd: number }>;
  // Coverage Value: economic edge blocked ONLY by partial tick coverage — the demand signal for certification.
  blockedByTicks: { candidates: number; sumPeakUsd: number; topFactories: Array<{ factory: string; usd: number }>; topPools: Array<{ pool: string; usd: number }> };
}

export interface ObserveOpts { minGrossBps?: number; cycleLimit?: number; gasMaxAgeMs?: number;
  /** Return true to stop the cycle early (see runObservatory). */ abort?: () => boolean;
  /**
   * What the last block changed. When given, a branch is only RE-PRICED if it touches this set — a pool that
   * did not move produces the same numbers it produced last cycle, so recomputing it is pure cost.
   *
   * Detection still runs over the whole graph: a cycle through a changed pool is made of other, unchanged
   * pools, so restricting the SEARCH would hide real opportunities. It is the sizing that is expensive
   * (tens of simulations per candidate) and that is what the dirty set gates.
   */
  dirty?: { pools: Set<string>; tokens: Set<string> };
}

/** capability: DB-only own-execution capability of a pool (null = unsupported fork / unenriched). Injected so
 * the observatory stays decoupled from LocalRouter yet can fold encodability into the gate. */
/**
 * `opts.abort` lets the caller stop a cycle that has become pointless. The mirror can go stale WHILE this
 * runs — a cycle takes minutes — and every number produced after that describes a world that no longer
 * exists. Worse, on a single core the work competes with the indexer that is trying to catch up, so
 * continuing actively delays the freshness the cycle depends on. Checked between candidates, which is where
 * the time goes.
 */
export async function runObservatory(db: Database, config: Config, graph: LiquidityGraph, opts: ObserveOpts = {}, capability?: (ps: PoolState) => { venue: string } | null): Promise<{ candidates: Candidate[]; stats: ObserveStats }> {
  const cid = config.CHAIN_ID;
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();
  const minGrossBps = opts.minGrossBps ?? 1, gasMaxAgeMs = opts.gasMaxAgeMs ?? 120_000;

  // ── sim cache (lazy ticks for concentrated) ──
  const tickCache = new Map<string, Array<{ tick: number; liquidityNet: bigint }>>();
  const simCache = new Map<string, PoolSim | null>();
  const simFor = async (id: string): Promise<PoolSim | null> => {
    if (simCache.has(id)) return simCache.get(id)!;
    const ps = graph.pools.get(id); if (!ps || !MODELABLE.has(ps.archetype)) { simCache.set(id, null); return null; }
    let ticks: Array<{ tick: number; liquidityNet: bigint }> | undefined;
    if (CONC.has(ps.archetype)) { ticks = tickCache.get(id) ?? await db.tickLiquidity(cid, id).catch(() => []); tickCache.set(id, ticks); }
    const s = buildPoolSim(ps, ticks); simCache.set(id, s); return s;
  };

  // ── valuation refs (DB-first) ──
  // ONE source for spot value. This used to scan all 25,390 pools for a WETH/USDC pair and take max(quote):
  // a duplicate of a number the DB already holds, obtained by the most expensive means available, and biased
  // by construction (max over pools favours whichever is deepest OR stalest).
  const ethUsd = graph.prices.get(weth) ?? 0;
  const gas = await db.getGasState(cid).catch(() => null);
  const gasStale = !gas || gas.ageMs > gasMaxAgeMs;
  const gasPriceWei = gas?.gasPriceWei ?? 0n;
  // Executability-layer token gate (Item 4.4): a route token blocks `executable` ONLY when it is CERTAIN-bad,
  // i.e. blacklisted (incl. tokens the preflight learning loop flagged from a behavior mismatch). Unenriched
  // tokens are NOT blocked — a round-trip's PnL is numéraire-in/out so an intermediate token's decimals don't
  // affect it; such a token reaches preflight once, and if it misbehaves the loop blacklists it. Blacklisted
  // tokens stay VISIBLE in the graph (economic layer) — we just never pretend they trade.
  const bl = await db.listBlacklist().catch(() => [] as Array<{ scope: string; value: string }>);
  const blacklisted = new Set(bl.filter((b) => b.scope === "token").map((b) => b.value.toLowerCase()));

  const ctx: GateContext = {
    flashFundable: new Set([weth, usdc]),
    gasPriceWei, ethUsd,
    // Every token the indexer has anchored is now valuable, not just the two hardcoded ones — which is what
    // limited every cycle's numeraire to WETH or USDC.
    numeraireUsd: (t) => t === usdc ? 1 : (graph.prices.get(t.toLowerCase()) ?? null),
    decimalsOf: (t) => t === weth ? 18 : t === usdc ? 6 : (graph.decimals.get(t) ?? null),
    minNetUsd: 0.01, safetyUsd: 0.005, flashFeeBps: 0,
    execMinProfitBps: 7000, lag: graph.lag, maxLagBlocks: 3,
  };

  const candidates: Candidate[] = [];
  const detectors: Record<string, number> = { cycle: 0, "pair-curve": 0 };
  let sized = 0, executable = 0, economic = 0, economicallyPositive = 0, routeEncodableN = 0;
  const unsupported = new Map<string, { candidates: number; peakUsd: number }>(); // unencodable positive edges by fork
  const blocked = { candidates: 0, sumPeakUsd: 0 }; const blockedFactory = new Map<string, number>(), blockedPool = new Map<string, number>();
  const observations: Array<{ ckey: string; detector: string; netUsd: number | null; grossUsd: number | null; executable: boolean; simulationExact: boolean; rejectionReason?: string }> = [];
  const seenKeys = new Set<string>();
  const sym = (t: string) => t === weth ? "WETH" : t === usdc ? "USDC" : t.slice(0, 8);

  // Turn a sized cycle into a gated Candidate + record it (dedup by normalized key within this pass).
  // Gate pipeline: economicEdge → simulationExact → economicallyPositive → routeEncodable → executable.
  const emit = async (detector: Candidate["detector"], cycle: KGCycle, sims: Map<string, PoolSim>): Promise<void> => {
    const sizedCyc = sizeCycle({ chainId: cid, blockNumber: graph.head }, cycle, sims, { funding: "flash", flashProvider: "morpho", flashFee: 0n });
    if (!sizedCyc) return;
    sized++;
    const opp = evaluateExecutable(sizedCyc, ctx);
    const num = sizedCyc.numeraire;
    const pools = cycle.edges.map((e) => e.pool);
    const ckey = `${detector}:${num}:${[...pools].sort().join(",")}`;
    if (seenKeys.has(ckey)) return; seenKeys.add(ckey);
    // ROUTE-ENCODABLE (Item 4, semantic fix): a route we can't even build calldata for is NOT executable, no
    // matter how profitable the sim says. Fold own-encodability (DB-only capability) into the gate.
    const legPools = cycle.edges.map((e) => graph.pools.get(e.pool)).filter((p): p is PoolState => !!p);
    const unenc = capability ? legPools.filter((p) => !capability(p)) : [];
    const routeEncodable = unenc.length === 0;
    const econPositive = opp.executable; // the OLD gate (exact ∧ fresh ∧ flash-fundable ∧ net>threshold)
    // Token exec-quality: block ONLY on a CERTAIN-bad token (blacklisted, incl. those the learning loop flagged
    // from a behavior mismatch). A round-trip's PnL is numéraire-in/out, so an intermediate token's decimals
    // don't affect it — an unenriched token is NOT blocked here; it reaches preflight once, and if it misbehaves
    // the loop blacklists it. Certain-bad only, never guess.
    const badToks = cycle.tokens.map((t) => t.toLowerCase()).filter((t) => !ctx.flashFundable.has(t) && blacklisted.has(t));
    const tokenQuality = badToks.length === 0;
    let isExec = econPositive && routeEncodable && tokenQuality;
    let reason = opp.rejectionReason;
    if (econPositive && !routeEncodable) reason = `route not encodable: ${unenc.length} hop(s) on unsupported fork`;
    else if (econPositive && routeEncodable && !tokenQuality) reason = `route token blacklisted (exec layer): ${badToks.map((t) => t.slice(0, 10)).join(",")}`;
    if (gasStale && isExec) { isExec = false; reason = "gas_state unavailable/stale — net not trustable"; }

    if (opp.economicEdge) economic++;
    if (econPositive) economicallyPositive++;
    if (econPositive && routeEncodable) routeEncodableN++;
    if (isExec) executable++;
    // Metric: profit lost to unsupported forks (economically positive but we can't encode the route).
    if (econPositive && !routeEncodable) for (const p of unenc) { const f = p.factory ?? "(unknown)"; const e = unsupported.get(f) ?? { candidates: 0, peakUsd: 0 }; e.candidates++; e.peakUsd = Math.max(e.peakUsd, opp.netPnlUsd ?? opp.grossPnlUsd ?? 0); unsupported.set(f, e); }
    // Coverage Value: economic edge blocked ONLY by partial tick coverage → what certifying WOULD unlock.
    if (opp.economicEdge && /partial tick coverage/.test(opp.rejectionReason ?? "")) {
      const usd = Math.max(0, opp.netPnlUsd ?? opp.grossPnlUsd ?? 0); blocked.candidates++; blocked.sumPeakUsd += usd;
      for (const e of cycle.edges) if (CONC.has(e.archetype as Archetype)) { const p = graph.pools.get(e.pool); const f = p?.factory ?? "(unknown)"; blockedFactory.set(f, (blockedFactory.get(f) ?? 0) + usd); blockedPool.set(e.pool, (blockedPool.get(e.pool) ?? 0) + usd); }
    }
    detectors[detector]++;
    // State fingerprint: same route pools @ same state blocks + same amount + same floor ⇒ same on-chain
    // result → the observer can REUSE the last preflight instead of spending another eth_call.
    const fp = hash(cycle.edges.map((e) => `${e.pool}@${graph.pools.get(e.pool)?.block ?? 0}`).sort().join("|") + `|${sizedCyc.amountIn}|${opp.minProfitNumeraire}`);
    const cand: Candidate = {
      detector, ckey, numeraire: num, route: cycle.tokens.map(sym).join("→"), pools,
      amountIn: sizedCyc.amountIn, grossUsd: opp.grossPnlUsd, gasUnits: sizedCyc.gasUnits, gasUsd: opp.gasCostUsd,
      netUsd: opp.netPnlUsd, simulationExact: sizedCyc.simulationExact, executable: isExec, rejectionReason: reason,
      legs: sizedCyc.legs, minProfitNumeraire: opp.minProfitNumeraire, fingerprint: fp,
    };
    candidates.push(cand);
    observations.push({ ckey, detector, netUsd: cand.netUsd, grossUsd: cand.grossUsd, executable: isExec, simulationExact: cand.simulationExact, rejectionReason: reason });
    await db.upsertCandidate({ chainId: cid, ckey, detector, numeraire: num, route: cand.route, pools, amountIn: cand.amountIn, grossUsd: cand.grossUsd, gasUnits: cand.gasUnits, gasUsd: cand.gasUsd, netUsd: cand.netUsd, simulationExact: cand.simulationExact, executable: isExec, rejectionReason: reason, block: graph.head }).catch(() => undefined);
    // Demand-driven certification (Item 3, via DB): a positive edge blocked ONLY by partial coverage → P0 its
    // concentrated legs so the enricher certifies them; it re-qualifies once complete.
    if (!isExec && /partial tick coverage/.test(reason ?? "") && opp.economicEdge) for (const e of cycle.edges) if (CONC.has(e.archetype as Archetype)) await db.setPoolTickPriority(cid, e.pool, 0).catch(() => undefined);
  };

  let aborted = false;
  // ── DETECTOR 1: spatial/cyclic arb (negative cycles on the FULL modelable graph) ──
  const modelablePriced = [...graph.pools.values()].filter((p) => MODELABLE.has(p.archetype) && ((p.r0 != null && p.r1 != null && p.r0 > 0n && p.r1 > 0n) || (p.sqrtPriceX96 != null && p.liquidity != null && p.liquidity > 0n)));
  const cycles = findNegativeCycles(modelablePriced, { minGrossBps, limit: opts.cycleLimit ?? 300 });
  let skippedUnchanged = 0;
  for (const c0 of cycles) {
    if (opts.abort?.()) { aborted = true; break; }
    // A cycle whose every pool is unchanged prices exactly as it did last cycle.
    if (opts.dirty && !c0.edges.some((e) => opts.dirty!.pools.has(e.pool.toLowerCase()))) { skippedUnchanged++; continue; }
    const c = rotate(c0, [weth, usdc]);
    const sims = new Map<string, PoolSim>(); let ok = true;
    for (const e of c.edges) { const s = await simFor(e.pool); if (!s) { ok = false; break; } sims.set(s.poolId, s); }
    if (ok) await emit("cycle", c, sims);
  }

  // ── DETECTOR 2: same-pair cross-venue disagreement (seed from margin, size the exact round-trip) ──
  const byPair = new Map<string, string[]>();
  for (const p of modelablePriced) { const [a, b] = [p.token0, p.token1].sort(); const k = `${a}|${b}`; (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p.address); }
  const multiVenue = [...byPair.entries()].filter(([, v]) => v.length >= 2);
  for (const [pairKey, poolIds] of multiVenue) {
    if (opts.abort?.()) { aborted = true; break; }
    if (opts.dirty && !poolIds.some((id) => opts.dirty!.pools.has(id.toLowerCase()))) { skippedUnchanged++; continue; }
    const [t0, t1] = pairKey.split("|");
    // marginal spot per venue (small probe in each direction), then best-buy / best-sell venues.
    const probe0 = (graph.decimals.has(t0) ? 10n ** BigInt(graph.decimals.get(t0)!) : 10n ** 18n) / 1000n || 1n;
    const probe1 = (graph.decimals.has(t1) ? 10n ** BigInt(graph.decimals.get(t1)!) : 10n ** 18n) / 1000n || 1n;
    let bestBuy: { id: string; out: bigint } | null = null;   // most t1 per t0
    let bestSell: { id: string; out: bigint } | null = null;  // most t0 per t1
    for (const id of poolIds) {
      const s = await simFor(id); if (!s) continue;
      const q01 = s.quote(t0, probe0); if (q01 && (!bestBuy || q01.amountOut > bestBuy.out)) bestBuy = { id, out: q01.amountOut };
      const q10 = s.quote(t1, probe1); if (q10 && (!bestSell || q10.amountOut > bestSell.out)) bestSell = { id, out: q10.amountOut };
    }
    if (!bestBuy || !bestSell || bestBuy.id === bestSell.id) continue; // need two distinct venues disagreeing
    // Build the round-trip t0 →(buy on bestBuy)→ t1 →(sell on bestSell)→ t0 and size it exactly.
    const pB = graph.pools.get(bestBuy.id)!, pS = graph.pools.get(bestSell.id)!;
    const edges: KGEdge[] = [
      { pool: pB.address, archetype: pB.archetype, from: t0, to: t1, feePpm: pB.feePpm, lnRate: 0, state: pB },
      { pool: pS.address, archetype: pS.archetype, from: t1, to: t0, feePpm: pS.feePpm, lnRate: 0, state: pS },
    ];
    const cycle: KGCycle = { tokens: [t0, t1, t0], edges, product: 0, grossBps: 0 };
    const rc = rotate(cycle, [weth, usdc]);
    const sims = new Map<string, PoolSim>(); let ok = true;
    for (const e of rc.edges) { const s = await simFor(e.pool); if (!s) { ok = false; break; } sims.set(s.poolId, s); }
    if (ok) await emit("pair-curve", rc, sims);
  }

  await db.recordObservations(cid, graph.head, observations).catch(() => undefined); // time-series (Item 5)
  const top = <V,>(m: Map<string, V>, val: (v: V) => number, n = 8) => [...m.entries()].sort((a, b) => val(b[1]) - val(a[1])).slice(0, n);
  return {
    candidates,
    stats: {
      aborted, skippedUnchanged,
      detectors, sized, economic, economicallyPositive, routeEncodable: routeEncodableN, executable,
      gasPriceWei: gasPriceWei.toString(), gasAgeMs: gas?.ageMs ?? null, gasStale, ethUsd, multiVenuePairs: multiVenue.length,
      unsupportedForks: top(unsupported, (v) => v.peakUsd).map(([factory, v]) => ({ factory, candidates: v.candidates, peakUsd: v.peakUsd })),
      blockedByTicks: {
        candidates: blocked.candidates, sumPeakUsd: blocked.sumPeakUsd,
        topFactories: top(blockedFactory, (v) => v).map(([factory, usd]) => ({ factory, usd })),
        topPools: top(blockedPool, (v) => v).map(([pool, usd]) => ({ pool, usd })),
      },
    },
  };
}

/** Rotate a cycle so it starts at a preferred numéraire (WETH/USDC) when present. */
function rotate(cycle: KGCycle, preferred: string[]): KGCycle {
  const pref = new Set(preferred.map((p) => p.toLowerCase()));
  const k = cycle.tokens.slice(0, cycle.edges.length).findIndex((t) => pref.has(t));
  if (k <= 0) return cycle;
  const edges = [...cycle.edges.slice(k), ...cycle.edges.slice(0, k)];
  return { ...cycle, edges, tokens: [edges[0].from, ...edges.map((e) => e.to)] };
}
