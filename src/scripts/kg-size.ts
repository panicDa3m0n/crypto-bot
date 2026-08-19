/**
 * KG SIZE (phase F1, step 2 — verify the Stateful Simulation Kernel on REAL state). Takes the step-1
 * candidate cycles (mere topology hints) and SIZES each on the stateful kernel: true compounding price
 * impact, exact V3 tick-crossing, flash-funded, realized closed-loop PnL. This is where marginal artifacts
 * die — a "16000 bps" cycle on a stale/thin pool collapses to ≤0 realized PnL once sized. READ-ONLY
 * (DB + tick map), no execution.
 *
 *   ... run --rm brain node dist/scripts/kg-size.js [seedTokens=60] [minBps=1]
 */
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import type { Archetype, PoolState } from "../router/types.js";
import { findNegativeCycles, type KGCycle } from "../kg/cycle-finder.js";
import { buildPoolSim, sizeCycle } from "../kg/kernel.js";
import { PoolSim } from "../kg/state.js";

const CONC = new Set<Archetype>(["v3", "v4", "slipstream"]);

/** Rotate a cycle so it STARTS at the first preferred token present (WETH/USDC) — the real, flash-fundable
 * numéraire. Cycle product is rotation-invariant, so this only changes the entry point. */
function rotate(cycle: KGCycle, preferred: string[]): KGCycle {
  const pref = new Set(preferred.map((p) => p.toLowerCase()));
  const k = cycle.tokens.slice(0, cycle.edges.length).findIndex((t) => pref.has(t));
  if (k <= 0) return cycle;
  const edges = [...cycle.edges.slice(k), ...cycle.edges.slice(0, k)];
  return { ...cycle, edges, tokens: [edges[0].from, ...edges.map((e) => e.to)] };
}

async function main() {
  const seedN = Number(process.argv[2] ?? 60);
  const minBps = Number(process.argv[3] ?? 1);
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const cid = config.CHAIN_ID;
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();
  const head = (await db.getIndexerCursor(cid).catch(() => null)) ?? 0;

  // Universe (same as kg-scan).
  const cand = await db.arbCandidateTokens(cid, weth, seedN).catch(() => []);
  const seeds = new Set<string>([weth, usdc, ...cand.map((c) => c.address.toLowerCase())]);
  const raw = new Map<string, { address: string; meta: unknown }>();
  for (const t of seeds) for (const p of await db.poolsForToken(cid, t).catch(() => [])) raw.set(p.address.toLowerCase(), p);
  const states = await db.poolStateBatch(cid, [...raw.keys()]).catch(() => new Map());
  const poolStates = new Map<string, PoolState>();
  for (const [address, { meta }] of raw) {
    const m = (meta ?? {}) as { token0?: string; token1?: string; archetype?: string; fee?: unknown; factory?: string };
    if (!m.token0 || !m.token1) continue;
    const archetype = (m.archetype ?? "v3") as Archetype;
    if (archetype === "aerodrome-stable") continue;
    const st = states.get(address);
    poolStates.set(address, { address, archetype, token0: m.token0.toLowerCase(), token1: m.token1.toLowerCase(), feePpm: Number(m.fee) > 0 ? Number(m.fee) : 0, factory: m.factory?.toLowerCase(), r0: st?.r0 ?? null, r1: st?.r1 ?? null, sqrtPriceX96: st?.sqrtPrice ?? null, liquidity: st?.liquidity ?? null, block: st?.block ?? 0, ageMs: st?.ageMs });
  }
  const cycles = findNegativeCycles([...poolStates.values()], { minGrossBps: minBps, limit: 40 });
  console.log(`[kg-size] head=${head} pools=${poolStates.size} seed-cycles=${cycles.length} → sizing on stateful kernel (flash-funded, exact V3 ticks)…`);

  // ethUsd from the best WETH/USDC pool in the universe (value gas + PnL without external oracle).
  let ethUsd = 0;
  for (const p of poolStates.values()) {
    const set = new Set([p.token0, p.token1]);
    if (!(set.has(weth) && set.has(usdc))) continue;
    const sim = buildPoolSim(p); if (!sim) continue;
    const q = sim.quote(weth, 10n ** 18n); if (!q) continue;
    const px = Number(q.amountOut) / 1e6; if (px > ethUsd) ethUsd = px;
  }
  const chain = new BerachainClients(config, logger);
  const gasPriceWei = await chain.primary.getGasPrice().catch(() => null);

  // Load ticks lazily for concentrated pools we actually size.
  const tickCache = new Map<string, Array<{ tick: number; liquidityNet: bigint }>>();
  const simFor = async (ps: PoolState): Promise<PoolSim | null> => {
    let ticks: Array<{ tick: number; liquidityNet: bigint }> | undefined;
    if (CONC.has(ps.archetype)) { ticks = tickCache.get(ps.address) ?? await db.tickLiquidity(cid, ps.address).catch(() => []); tickCache.set(ps.address, ticks); }
    return buildPoolSim(ps, ticks);
  };

  const decs = await db.tokenMeta(cid, [weth, usdc]).catch(() => new Map());
  const human = (wei: bigint, token: string) => { const d = token === weth ? 18 : token === usdc ? 6 : (decs.get(token)?.decimals ?? 18); return Number(wei) / 10 ** d; };
  const usdOf = (wei: bigint, token: string) => token === usdc ? human(wei, token) : token === weth ? human(wei, token) * ethUsd : NaN;

  const results: Array<{ path: string; venues: string; amountIn: number; pnlNum: number; pnlUsd: number; bps: number; gas: bigint; numeraire: string }> = [];
  for (const c0 of cycles) {
    const c = rotate(c0, [weth, usdc]);
    const num = c.tokens[0];
    // Build sims for the cycle's pools.
    const sims = new Map<string, PoolSim>();
    let ok = true;
    for (const e of c.edges) { const ps = poolStates.get(e.pool); if (!ps) { ok = false; break; } const sim = await simFor(ps); if (!sim) { ok = false; break; } sims.set(sim.poolId, sim); }
    if (!ok) continue;
    const sized = sizeCycle({ chainId: cid, blockNumber: head }, c, sims, { funding: "flash", flashProvider: "morpho", flashFee: 0n });
    if (!sized) continue;
    const bps = Number((sized.realizedPnl * 10_000n) / (sized.amountIn > 0n ? sized.amountIn : 1n));
    results.push({ path: c.tokens.join("→"), venues: c.edges.map((e) => e.archetype).join(","), amountIn: human(sized.amountIn, num), pnlNum: human(sized.realizedPnl, num), pnlUsd: usdOf(sized.realizedPnl, num), bps, gas: sized.gasUnits, numeraire: num });
  }

  results.sort((a, b) => (b.pnlUsd || -1e9) - (a.pnlUsd || -1e9) || b.bps - a.bps);
  const symOf = (t: string) => t === weth ? "WETH" : t === usdc ? "USDC" : t.slice(0, 8);
  console.log(`[kg-size] ethUsd≈${ethUsd.toFixed(2)}  sized cycles with positive realized PnL: ${results.length}`);
  for (const r of results.slice(0, 30)) {
    const gasUsd = ethUsd && gasPriceWei ? Number(r.gas * (gasPriceWei as bigint)) / 1e18 * ethUsd : NaN;
    const usd = Number.isFinite(r.pnlUsd) ? `$${r.pnlUsd.toFixed(4)}` : "n/a";
    const net = Number.isFinite(gasUsd) ? ` netUsd=$${(r.pnlUsd - gasUsd).toFixed(4)}` : "";
    console.log(`  ${symOf(r.numeraire).padEnd(6)} in=${r.amountIn.toPrecision(4)}  pnl=${r.pnlNum.toPrecision(4)} (${usd}, ${r.bps}bps)  gas=${r.gas}u${net}  ${r.path.split("→").map(symOf).join("→")}  (${r.venues})`);
  }
  if (!results.length) console.log("[kg-size] none survived sizing — every marginal seed was a stale/thin artifact (the expected, honest result on an efficient market).");

  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-size] fatal:", e); process.exit(1); });
