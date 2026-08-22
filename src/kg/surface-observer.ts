import type { Database } from "../db.js";
import type { Config } from "../config.js";
import type { LiquidityGraph } from "./graph-loader.js";
import type { SurfaceContext } from "./path-surface.js";
import { pairSurface, bestExitSurface } from "./surfaces.js";
import { MODELABLE } from "../archetypes.js";

/**
 * SURFACE OBSERVER (Item 7 steps 3/5/6) — turns the surface detectors into a permanent economic-intelligence
 * time series. Each block it (a) picks a BOUNDED set of targets (top pairs by venue count, top non-numéraire
 * tokens by degree), (b) computes their Pair / Best-Exit surfaces, (c) persists run + points stamped with the
 * surface_model_version, and (d) raises an economic_anomaly SIGNAL when an asset's execution_gap is material
 * (economic exit value the graph sees that we cannot yet capture). Best Exit is INTELLIGENCE, not arbitrage —
 * it lives in kg_signals, not kg_candidates. Pair-surface trade opportunities remain the pair-curve detector's
 * job (this layer records the curve/crossover STRUCTURE). READ-ONLY (surfaces are DB-only).
 */

// Bump when beam width / maxEdgesPerToken / maxHops / hub ranking / sizing ladder changes — so we never
// compare surfaces from different algorithms as one series.
export const SURFACE_MODEL_VERSION = "v1:beam4/edge32/pairhop3/exithop2/cap4s/geo7-3";
const PAIR_K = 12, EXIT_K = 12;
const MATERIAL_GAP_USD = 2, MIN_ECON_USD = 5; // signal only meaningful, capturable-looking value with a real gap
const DEFAULT_BUDGET_MS = 45_000;             // cap surface work per cycle so the observer loop stays bounded
const PER_TARGET_MS = 4_000;                  // hard cap per best-exit target (a hub's beam can be huge otherwise)

export interface SurfaceRunSummary { pairRuns: number; exitRuns: number; signals: number; skipped: number }

export async function runSurfaces(db: Database, config: Config, graph: LiquidityGraph, ctx: SurfaceContext, opts: { budgetMs?: number } = {}): Promise<SurfaceRunSummary> {
  const cid = config.CHAIN_ID, block = graph.head;
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();

  // ── target selection (bounded) ──
  const byPair = new Map<string, Set<string>>();
  for (const p of graph.pools.values()) { if (!MODELABLE.has(p.archetype)) continue; const [a, b] = [p.token0, p.token1].sort(); const k = `${a}|${b}`; (byPair.get(k) ?? byPair.set(k, new Set()).get(k)!).add(p.address); }
  const pairTargets = [...byPair.entries()].filter(([, v]) => v.size >= 2).sort((a, b) => b[1].size - a[1].size).slice(0, PAIR_K).map(([k]) => k.split("|") as [string, string]);
  const exitTargets = [...graph.adjacency.entries()].filter(([t]) => t !== weth && t !== usdc).sort((a, b) => b[1].length - a[1].length).slice(0, EXIT_K).map(([t]) => t);

  let pairRuns = 0, exitRuns = 0, signals = 0, skipped = 0;

  // ── PAIR SURFACES (curve/crossover structure) ──
  for (const [t0, t1] of pairTargets) {
    if (Date.now() > deadline) { skipped += pairTargets.length - pairRuns; break; }
    const surf = await pairSurface(ctx, t0, t1, { steps: 12 }).catch(() => null);
    if (!surf || !surf.points.length) continue;
    const runId = await db.recordSurfaceRun({ chainId: cid, block, kind: "pair", target: `${t0}|${t1}`, modelVersion: SURFACE_MODEL_VERSION, venues: surf.venues, crossovers: surf.crossovers, optimalSize: surf.optimalSize, maxPnl: surf.maxPnl }).catch(() => 0);
    if (runId) { await db.recordSurfacePoints(runId, surf.points.map((p) => ({ amountIn: p.amountIn, economicOut: p.roundTripOut, exact: p.exact, encodable: p.encodable, dominantBuy: p.buyPool, dominantSell: p.sellPool, spreadBps: p.spreadBps }))).catch(() => undefined); pairRuns++; }
  }

  // ── BEST-EXIT SURFACES (economic vs executable → execution_gap signal) ──
  for (const asset of exitTargets) {
    if (Date.now() > deadline) { skipped += exitTargets.length - exitRuns; break; }
    const dec = graph.decimals.get(asset) ?? 18;
    const unit = 10n ** BigInt(dec);
    const sizes = [unit * 100n, unit * 1000n, unit * 10000n, unit * 100000n];
    const surf = await bestExitSurface(ctx, asset, usdc, sizes, { maxHops: 2, deadline: Math.min(deadline, Date.now() + PER_TARGET_MS) }).catch(() => null);
    if (!surf || !surf.length) continue;
    const ref = [...surf].reverse().find((e) => e.economicOut > 0n) ?? surf[0]; // largest size that quotes
    const gap = (o: { economicOut: bigint; executableOut: bigint | null }) => o.economicOut - (o.executableOut ?? 0n);
    const runId = await db.recordSurfaceRun({ chainId: cid, block, kind: "best-exit", target: asset, numeraire: usdc, modelVersion: SURFACE_MODEL_VERSION, economicBest: ref.economicOut, executableBest: ref.executableOut, executionGap: gap(ref) }).catch(() => 0);
    if (runId) { await db.recordSurfacePoints(runId, surf.map((e) => ({ amountIn: e.amountIn, economicOut: e.economicOut, executableOut: e.executableOut, economicPath: e.economicPath, executablePath: e.executablePath ?? undefined, exact: e.economicExact, encodable: e.economicEncodable, executionGap: gap(e) }))).catch(() => undefined); exitRuns++; }

    // SIGNAL: material execution gap (numéraire = USDC, 6 dec ⇒ USD directly).
    const econUsd = Number(ref.economicOut) / 1e6, exeUsd = ref.executableOut != null ? Number(ref.executableOut) / 1e6 : null;
    const gapUsd = exeUsd != null ? econUsd - exeUsd : econUsd; // no executable path ⇒ the whole economic value is a gap
    if (econUsd >= MIN_ECON_USD && gapUsd >= MATERIAL_GAP_USD) {
      await db.upsertSignal({ chainId: cid, skey: `exec-gap:${asset}`, kind: "execution_gap", asset, numeraire: usdc, economicUsd: econUsd, executableUsd: exeUsd, executionGapUsd: gapUsd, refSize: ref.amountIn, block }).catch(() => undefined);
      signals++;
    }
  }
  return { pairRuns, exitRuns, signals, skipped };
}
