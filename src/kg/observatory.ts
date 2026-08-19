import type { Database } from "../db.js";
import type { Config } from "../config.js";
import type { Archetype } from "../router/types.js";
import type { LiquidityGraph } from "./graph-loader.js";
import { PoolSim, type SwapTrace } from "./state.js";
import { buildPoolSim, sizeCycle } from "./kernel.js";
import { findNegativeCycles, type KGCycle, type KGEdge } from "./cycle-finder.js";
import { evaluateExecutable, type GateContext } from "./opportunity.js";

/**
 * KG OPPORTUNITY OBSERVATORY (Item 4.2) — reads the ONE full liquidity graph many different ways and turns
 * each economic reading into a sized, gated, persistable candidate. Detectors so far:
 *   • cycle       — spatial/cyclic arb (2..N-hop negative cycles) sized on the REAL curve, not the margin.
 *   • pair-curve  — same-pair cross-venue disagreement: seed best-buy/best-sell venues from the margin, then
 *                   size the exact round-trip. Catches spreads a purely-marginal cycle finder mishandles.
 * Every candidate flows the same pipeline: exact simulation → economic gate (DB-first gas) → lifecycle row.
 * READ-ONLY: no chain RPC; gas comes from gas_state (a write-side poller fills it).
 */

const CONC = new Set<Archetype>(["v3", "v4", "slipstream"]);
const MODELABLE = new Set(["v2", "aerodrome", "aerodrome-stable", "v3", "slipstream"]);

export interface Candidate {
  detector: "cycle" | "pair-curve";
  ckey: string; numeraire: string; route: string; pools: string[];
  amountIn: bigint; grossUsd: number | null; gasUnits: bigint; gasUsd: number; netUsd: number | null;
  simulationExact: boolean; executable: boolean; rejectionReason?: string;
  legs: SwapTrace[];            // per-hop exact amounts — lets the shadow-preflight re-encode without re-sizing
  minProfitNumeraire: bigint;   // the on-chain minProfit floor the execution calldata would carry
}
export interface ObserveStats {
  detectors: Record<string, number>; sized: number; executable: number; economic: number;
  gasPriceWei: string; gasAgeMs: number | null; gasStale: boolean; ethUsd: number; multiVenuePairs: number;
}

export interface ObserveOpts { minGrossBps?: number; maxCycleLen?: number; cycleLimit?: number; gasMaxAgeMs?: number }

export async function runObservatory(db: Database, config: Config, graph: LiquidityGraph, opts: ObserveOpts = {}): Promise<{ candidates: Candidate[]; stats: ObserveStats }> {
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
  let ethUsd = 0;
  for (const p of graph.pools.values()) { const set = new Set([p.token0, p.token1]); if (!(set.has(weth) && set.has(usdc))) continue; const s = await simFor(p.address); if (!s) continue; const q = s.quote(weth, 10n ** 18n); if (q) ethUsd = Math.max(ethUsd, Number(q.amountOut) / 1e6); }
  const gas = await db.getGasState(cid).catch(() => null);
  const gasStale = !gas || gas.ageMs > gasMaxAgeMs;
  const gasPriceWei = gas?.gasPriceWei ?? 0n;

  const ctx: GateContext = {
    flashFundable: new Set([weth, usdc]),
    gasPriceWei, ethUsd,
    numeraireUsd: (t) => t === usdc ? 1 : t === weth ? ethUsd : null,
    decimalsOf: (t) => t === weth ? 18 : t === usdc ? 6 : (graph.decimals.get(t) ?? 18),
    minNetUsd: 0.01, safetyUsd: 0.005, flashFeeBps: 0,
    execMinProfitBps: 7000, lag: graph.lag, maxLagBlocks: 3,
  };

  const candidates: Candidate[] = [];
  const detectors: Record<string, number> = { cycle: 0, "pair-curve": 0 };
  let sized = 0, executable = 0, economic = 0;
  const seenKeys = new Set<string>();
  const sym = (t: string) => t === weth ? "WETH" : t === usdc ? "USDC" : t.slice(0, 8);

  // Turn a sized cycle into a gated Candidate + record it (dedup by normalized key within this pass).
  const emit = async (detector: Candidate["detector"], cycle: KGCycle, sims: Map<string, PoolSim>): Promise<void> => {
    const sizedCyc = sizeCycle({ chainId: cid, blockNumber: graph.head }, cycle, sims, { funding: "flash", flashProvider: "morpho", flashFee: 0n });
    if (!sizedCyc) return;
    sized++;
    const opp = evaluateExecutable(sizedCyc, ctx);
    const num = sizedCyc.numeraire;
    const pools = cycle.edges.map((e) => e.pool);
    const ckey = `${detector}:${num}:${[...pools].sort().join(",")}`;
    if (seenKeys.has(ckey)) return; seenKeys.add(ckey);
    // Honesty: with no fresh gas we CANNOT claim executable (net would be optimistic). Force fail-closed.
    let isExec = opp.executable, reason = opp.rejectionReason;
    if (gasStale && isExec) { isExec = false; reason = "gas_state unavailable/stale — net not trustable"; }
    if (opp.economicEdge) economic++;
    if (isExec) executable++;
    detectors[detector]++;
    const cand: Candidate = {
      detector, ckey, numeraire: num, route: cycle.tokens.map(sym).join("→"), pools,
      amountIn: sizedCyc.amountIn, grossUsd: opp.grossPnlUsd, gasUnits: sizedCyc.gasUnits, gasUsd: opp.gasCostUsd,
      netUsd: opp.netPnlUsd, simulationExact: sizedCyc.simulationExact, executable: isExec, rejectionReason: reason,
      legs: sizedCyc.legs, minProfitNumeraire: opp.minProfitNumeraire,
    };
    candidates.push(cand);
    await db.upsertCandidate({ chainId: cid, ckey, detector, numeraire: num, route: cand.route, pools, amountIn: cand.amountIn, grossUsd: cand.grossUsd, gasUnits: cand.gasUnits, gasUsd: cand.gasUsd, netUsd: cand.netUsd, simulationExact: cand.simulationExact, executable: isExec, rejectionReason: reason, block: graph.head }).catch(() => undefined);
    // Demand-driven certification (Item 3, via DB): a positive edge blocked ONLY by partial coverage → P0 its
    // concentrated legs so the enricher certifies them; it re-qualifies once complete.
    if (!isExec && /partial tick coverage/.test(reason ?? "") && opp.economicEdge) for (const e of cycle.edges) if (CONC.has(e.archetype as Archetype)) await db.setPoolTickPriority(cid, e.pool, 0).catch(() => undefined);
  };

  // ── DETECTOR 1: spatial/cyclic arb (negative cycles on the FULL modelable graph) ──
  const modelablePriced = [...graph.pools.values()].filter((p) => MODELABLE.has(p.archetype) && ((p.r0 != null && p.r1 != null && p.r0 > 0n && p.r1 > 0n) || (p.sqrtPriceX96 != null && p.liquidity != null && p.liquidity > 0n)));
  const cycles = findNegativeCycles(modelablePriced, { minGrossBps, limit: opts.cycleLimit ?? 300 });
  for (const c0 of cycles) {
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

  return {
    candidates,
    stats: { detectors, sized, executable, economic, gasPriceWei: gasPriceWei.toString(), gasAgeMs: gas?.ageMs ?? null, gasStale, ethUsd, multiVenuePairs: multiVenue.length },
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
