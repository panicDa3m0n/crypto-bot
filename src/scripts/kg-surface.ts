/**
 * KG SURFACE (Item 7 — verify the shared path primitive + Pair Surface + Best Exit Surface). Builds, over the
 * full DB graph: (a) a Pair Surface for WETH/USDC (venue-vs-venue round-trip curve, crossovers, optimum), and
 * (b) a Best Exit Surface for a token (economic vs own-executable exit at several sizes + execution_gap).
 * READ-ONLY, no chain RPC (capability + blacklist are DB-only).
 *
 *   ... run --rm brain node dist/scripts/kg-surface.js [exitToken]
 */
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { LocalRouter } from "../router/router.js";
import { loadLiquidityGraph } from "../kg/graph-loader.js";
import { buildSurfaceContext } from "../kg/path-surface.js";
import { bestExitSurface, pairSurface } from "../kg/surfaces.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  await db.migrate().catch(() => undefined);
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID;
  const weth = config.WBERA_ADDRESS.toLowerCase(), usdc = config.USDC_E_ADDRESS.toLowerCase();
  const router = new LocalRouter(config, logger, db, chain);

  const g = await loadLiquidityGraph(db, cid);
  const bl = await db.listBlacklist().catch(() => [] as Array<{ scope: string; value: string }>);
  const blacklisted = new Set(bl.filter((b) => b.scope === "token").map((b) => b.value.toLowerCase()));
  const ctx = buildSurfaceContext(db, cid, g, (ps) => router.execCapability(ps) != null, blacklisted);
  const sym = (t: string) => t === weth ? "WETH" : t === usdc ? "USDC" : t.slice(0, 8);

  // (a) PAIR SURFACE: WETH/USDC
  console.log(`[kg-surface] PAIR SURFACE WETH/USDC:`);
  const t0 = Date.now();
  const ps = await pairSurface(ctx, weth, usdc, { steps: 14 });
  console.log(`  venues=${ps.venues} crossovers=${ps.crossovers} optimalSize=${ps.optimalSize} maxPnl(wei)=${ps.maxPnl}  (${Date.now() - t0}ms)`);
  for (const p of ps.points) console.log(`   ${(Number(p.amountIn) / 1e18).toExponential(2).padStart(9)} WETH  buy=${p.buyPool?.slice(0, 8)} sell=${p.sellPool?.slice(0, 8)} spread=${p.spreadBps}bps pnl=${(Number(p.pnl) / 1e18).toFixed(6)}WETH ${p.encodable ? "enc" : "—"}${p.exact ? "/exact" : ""}`);

  // (b) BEST EXIT SURFACE: token → USDC. Default = the highest-degree token that isn't WETH/USDC (a real hub).
  const hub = [...g.adjacency.entries()].filter(([t]) => t !== weth && t !== usdc).sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const exitToken = (process.argv[2] ?? hub ?? weth).toLowerCase();
  const dec = g.decimals.get(exitToken);
  console.log(`\n[kg-surface] BEST EXIT SURFACE ${sym(exitToken)} → USDC (dec=${dec ?? "?"}):`);
  if (!g.adjacency.has(exitToken)) { console.log(`  token not in graph`); }
  else {
    const unit = dec != null ? 10n ** BigInt(dec) : 10n ** 18n;
    const sizes = [unit * 100n, unit * 1000n, unit * 10000n, unit * 100000n];
    const t1 = Date.now();
    const surf = await bestExitSurface(ctx, exitToken, usdc, sizes, { maxHops: 3 });
    console.log(`  (${Date.now() - t1}ms)`);
    for (const e of surf) {
      const econ = Number(e.economicOut) / 1e6, exe = e.executableOut != null ? Number(e.executableOut) / 1e6 : null;
      const gap = exe != null ? econ - exe : null;
      console.log(`   ${(Number(e.amountIn) / Number(unit)).toString().padStart(7)} tok  econ=$${econ.toFixed(2)} (${e.economicPath.map(sym).join("→")}${e.economicExact ? " exact" : ""}${e.economicEncodable ? "" : " /not-enc"})  exe=${exe != null ? "$" + exe.toFixed(2) : "none"}  execution_gap=${gap != null ? "$" + gap.toFixed(2) : "—"}`);
    }
  }
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-surface] fatal:", e); process.exit(1); });
