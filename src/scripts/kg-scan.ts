/**
 * KG SCAN (phase F1, step 1 — verify the detector on REAL DB state). Assembles the mirrored pool
 * universe from the DB (base anchors ∪ arb-candidate tokens → their pools → pool_state), runs the
 * negative-cycle finder, and prints the arbitrage cycles it finds with their marginal gross bps and the
 * venues/pools involved. READ-ONLY: no RPC, no execution — proves the graph machinery works end-to-end
 * on live indexed data before we add sizing/exact-sim/execution.
 *
 *   ... run --rm brain node dist/scripts/kg-scan.js [seedTokens=60] [minBps=1]
 */
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import type { Archetype, PoolState } from "../router/types.js";
import { findNegativeCycles } from "../kg/cycle-finder.js";

async function main() {
  const seedN = Number(process.argv[2] ?? 60);
  const minBps = Number(process.argv[3] ?? 1);
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const cid = config.CHAIN_ID;
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();

  // Seed tokens: base anchors ∪ tokens sitting on ≥2 pools (where spatial arb can exist).
  const cand = await db.arbCandidateTokens(cid, weth, seedN).catch(() => []);
  const seeds = new Set<string>([weth, usdc, ...cand.map((c) => c.address.toLowerCase())]);

  // Pool universe: every pool touching a seed token.
  const raw = new Map<string, { address: string; meta: unknown }>();
  for (const t of seeds) for (const p of await db.poolsForToken(cid, t).catch(() => [])) raw.set(p.address.toLowerCase(), p);
  const states = await db.poolStateBatch(cid, [...raw.keys()]).catch(() => new Map());
  const pools: PoolState[] = [];
  for (const [address, { meta }] of raw) {
    const m = (meta ?? {}) as { token0?: string; token1?: string; archetype?: string; fee?: unknown; factory?: string };
    if (!m.token0 || !m.token1) continue;
    const archetype = (m.archetype ?? "v3") as Archetype;
    if (archetype === "aerodrome-stable") continue;
    const st = states.get(address);
    pools.push({
      address, archetype, token0: m.token0.toLowerCase(), token1: m.token1.toLowerCase(),
      feePpm: Number(m.fee) > 0 ? Number(m.fee) : 0, factory: m.factory?.toLowerCase(),
      r0: st?.r0 ?? null, r1: st?.r1 ?? null, sqrtPriceX96: st?.sqrtPrice ?? null, liquidity: st?.liquidity ?? null,
      block: st?.block ?? 0, ageMs: st?.ageMs
    });
  }
  const withState = pools.filter((p) => (p.r0 != null && p.r1 != null) || (p.sqrtPriceX96 != null && p.liquidity != null));
  console.log(`[kg-scan] seeds=${seeds.size} pools=${pools.length} withState=${withState.length} → building graph…`);

  const cycles = findNegativeCycles(pools, { minGrossBps: minBps, limit: 30 });
  console.log(`[kg-scan] negative cycles (marginal, ≥${minBps}bps): ${cycles.length}`);

  // Resolve symbols for pretty printing.
  const allTokens = new Set<string>();
  for (const c of cycles) for (const t of c.tokens) allTokens.add(t);
  const sym = await db.tokenMeta(cid, [...allTokens]).catch(() => new Map());
  const s = (a: string) => sym.get(a)?.symbol ?? a.slice(0, 8);

  for (const c of cycles.slice(0, 30)) {
    const path = c.tokens.map(s).join(" → ");
    const venues = c.edges.map((e) => e.archetype).join(",");
    console.log(`  ${c.grossBps.toFixed(1).padStart(7)} bps  [${c.edges.length} hops]  ${path}   (${venues})`);
    for (const e of c.edges) console.log(`             ${s(e.from)}→${s(e.to)} via ${e.archetype} ${e.pool} fee=${e.feePpm || "?"}`);
  }
  if (!cycles.length) console.log("[kg-scan] none — the mirrored marginal graph is arbitrage-free (expected on an efficient market; sizing/gas would prune most anyway).");

  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-scan] fatal:", e); process.exit(1); });
