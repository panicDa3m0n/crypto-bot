import type { SurfaceContext } from "./path-surface.js";
import { quoteBestPaths } from "./path-surface.js";

/**
 * SURFACE DETECTORS (Item 7) — thin views over the shared path primitive.
 *   • bestExitSurface: for an asset, the ExecutableValueSurface toward a numéraire at several sizes — the real
 *     economic property of the asset (exitValue($100)…$100k), with BOTH the economic best (any path) and the
 *     own-executable best (encodable + blacklist-clean). Their gap = execution_gap: value the graph sees that
 *     we cannot yet capture (fork/infra gap). Reusable by liquidations / collateral / risk / oracle-vs-exit.
 *   • pairSurface: venue-vs-venue on ONE pair, adaptive sizing — the curve of best-buy/best-sell/spread as size
 *     grows, so we keep the STRUCTURE (where the dominant venue flips, where the optimum is), not just one size.
 */

export interface ExitPoint {
  amountIn: bigint;
  economicOut: bigint; economicPath: string[]; economicExact: boolean; economicEncodable: boolean;
  executableOut: bigint | null; executablePath: string[] | null; // best path that is encodable AND clean
}

export async function bestExitSurface(ctx: SurfaceContext, asset: string, numeraire: string, sizes: bigint[], opts: { maxHops?: number; deadline?: number } = {}): Promise<ExitPoint[]> {
  const out: ExitPoint[] = [];
  for (const sz of sizes) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const paths = await quoteBestPaths(ctx, asset, numeraire, sz, { maxHops: opts.maxHops ?? 3, topN: 20, deadline: opts.deadline });
    if (!paths.length) { out.push({ amountIn: sz, economicOut: 0n, economicPath: [], economicExact: false, economicEncodable: false, executableOut: null, executablePath: null }); continue; }
    const econ = paths[0]; // sorted desc by amountOut
    // ARMABLE value REQUIRES exact: a size-dependent number from a non-certified tick map is fantasy (an
    // uncertified v3 pool quotes any size with ~no impact, which once produced a $18M quote at 0% slippage).
    // economicOut keeps its own `economicExact` flag so research still sees the uncertified number, labelled.
    const exe = paths.find((p) => p.encodable && p.clean && p.exact) ?? null;
    out.push({ amountIn: sz, economicOut: econ.amountOut, economicPath: econ.path, economicExact: econ.exact, economicEncodable: econ.encodable, executableOut: exe?.amountOut ?? null, executablePath: exe?.path ?? null });
  }
  return out;
}

export interface PairPoint {
  amountIn: bigint; buyPool: string | null; buyOut: bigint; sellPool: string | null; roundTripOut: bigint;
  pnl: bigint; spreadBps: number; exact: boolean; encodable: boolean;
}
export interface PairSurface { t0: string; t1: string; venues: number; points: PairPoint[]; crossovers: number; optimalSize: bigint | null; maxPnl: bigint }

/** Venue-vs-venue round-trip curve for a pair, over a coarse geometric size ladder. Best-buy venue (max t1
 * per t0) then best-sell on a DIFFERENT venue (max t0 for that t1); records where the dominant venue flips
 * (crossovers) and the pnl-maximising size. Adaptive: stops the ladder once liquidity is exhausted. */
export async function pairSurface(ctx: SurfaceContext, t0: string, t1: string, opts: { steps?: number } = {}): Promise<PairSurface> {
  const a = t0.toLowerCase(), b = t1.toLowerCase();
  const venues = (ctx.graph.adjacency.get(a) ?? []).filter((id) => { const p = ctx.graph.pools.get(id); return p && ((p.token0 === a && p.token1 === b) || (p.token0 === b && p.token1 === a)); });
  if (venues.length < 2) return { t0: a, t1: b, venues: venues.length, points: [], crossovers: 0, optimalSize: null, maxPnl: 0n };
  const dec0 = ctx.graph.decimals.get(a);
  const unit = dec0 != null ? 10n ** BigInt(dec0) : 10n ** 18n;
  const steps = opts.steps ?? 14;
  const points: PairPoint[] = [];
  for (let i = 0, m = unit / 1000n > 0n ? unit / 1000n : 1n; i < steps; i++, m = (m * 7n) / 3n) {
    const S = m;
    let buy: { v: string; out: bigint; exact: boolean } | null = null;
    for (const v of venues) { const sim = await ctx.simFor(v); if (!sim) continue; const q = sim.quote(a, S); if (q && q.amountOut > 0n && (!buy || q.amountOut > buy.out)) buy = { v, out: q.amountOut, exact: q.exact }; }
    if (!buy) break; // liquidity exhausted at this size on every venue
    let sell: { v: string; out: bigint; exact: boolean } | null = null;
    for (const v of venues) { if (v === buy.v) continue; const sim = await ctx.simFor(v); if (!sim) continue; const q = sim.quote(b, buy.out); if (q && q.amountOut > 0n && (!sell || q.amountOut > sell.out)) sell = { v, out: q.amountOut, exact: q.exact }; }
    if (!sell) continue;
    const pnl = sell.out - S;
    const spreadBps = S > 0n ? Number((pnl * 10000n) / S) : 0;
    const encodable = ctx.capability(ctx.graph.pools.get(buy.v)!) && ctx.capability(ctx.graph.pools.get(sell.v)!);
    points.push({ amountIn: S, buyPool: buy.v, buyOut: buy.out, sellPool: sell.v, roundTripOut: sell.out, pnl, spreadBps, exact: buy.exact && sell.exact, encodable });
  }
  let crossovers = 0; for (let i = 1; i < points.length; i++) if (points[i].buyPool !== points[i - 1].buyPool || points[i].sellPool !== points[i - 1].sellPool) crossovers++;
  let optimalSize: bigint | null = null, maxPnl = -(2n ** 255n);
  for (const p of points) if (p.pnl > maxPnl) { maxPnl = p.pnl; optimalSize = p.amountIn; }
  return { t0: a, t1: b, venues: venues.length, points, crossovers, optimalSize, maxPnl: maxPnl === -(2n ** 255n) ? 0n : maxPnl };
}
