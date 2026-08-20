/**
 * LIQUIDATION CAPTURE (step a1-a4) — the falsifiable, closest-to-money test of the KG thesis. For EVERY watch
 * position it recomputes what we could REALLY capture, size-specific:
 *
 *   position → seized collateral @HF=1 → bestExitSurface AT THAT EXACT SIZE → loan repaid → flash+gas → NET
 *
 * Three exit qualities are kept distinct so we never repeat the opposite error (over-valuing through poisoned
 * pools): rawEconomic (any path) / trustedEconomic (exact ∧ clean) / ownExecutable (encodable ∧ clean).
 *   research profitability = trusted     armable profitability = executable
 *
 * Key identity: at HF=1, repaying the full debt seizes `LIF × lltv × collateralTokens` — price-independent, so
 * the capture of a not-yet-liquidatable position is computable TODAY (pre-arming, which suits our slowness).
 * Also emits the per-asset CUMULATIVE liquidation-capacity surface: how much collateral the market can absorb
 * before impact eats the bonus (a first taste of Class C without the general composer).
 *
 *   ... run --rm brain node dist/scripts/kg-liq-capture.js [nearHfMax=1.10]
 */
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { LocalRouter } from "../router/router.js";
import { loadLiquidityGraph } from "../kg/graph-loader.js";
import { buildSurfaceContext, quoteBestPaths, type SurfaceContext } from "../kg/path-surface.js";
import { lifWad } from "../kg/lending.js";

const WAD = 10n ** 18n;
const GAS_UNITS = 800_000n;        // flash + liquidate + multi-hop exit + repay
const MIN_CAPTURE_USD = 5;         // below this it isn't worth arming

type Klass = "PROFITABLE" | "NEAR_HF_UNPROFITABLE" | "BAD_DEBT_RISK" | "SAFE" | "UNKNOWN";

async function exitAt(ctx: SurfaceContext, collateral: string, loan: string, amount: bigint) {
  const paths = await quoteBestPaths(ctx, collateral, loan, amount, { maxHops: 3, topN: 25, deadline: Date.now() + 6000 });
  if (!paths.length) return null;
  const raw = paths[0];
  const trusted = paths.find((p) => p.exact && p.clean) ?? null;
  // ARMABLE requires exact: without a certified tick map a size-dependent quote is fantasy (see surfaces.ts).
  const executable = paths.find((p) => p.encodable && p.clean && p.exact) ?? null;
  return { raw, trusted, executable };
}

async function main() {
  const nearHfMax = Number(process.argv[2] ?? 1.10);
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  await db.migrate().catch(() => undefined);
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID;
  const router = new LocalRouter(config, logger, db, chain);

  const g = await loadLiquidityGraph(db, cid);
  const bl = await db.listBlacklist().catch(() => [] as Array<{ scope: string; value: string }>);
  const blacklisted = new Set(bl.filter((b) => b.scope === "token").map((b) => b.value.toLowerCase()));
  const ctx = buildSurfaceContext(db, cid, g, (ps) => router.execCapability(ps) != null, blacklisted);
  const gas = await db.getGasState(cid).catch(() => null);

  const positions = await db.positionsForCapture(cid, "watch");
  console.log(`[capture] ${positions.length} watch positions, graph head=${g.head}, gas=${gas?.gasPriceWei ?? 0n}wei`);

  interface Row { sym: string; loanSym: string; hf: number; debtUsd: number; collUsd: number; seizedTokens: bigint;
    oracleSeizedUsd: number; rawUsd: number | null; trustedUsd: number | null; execUsd: number | null;
    captureTrusted: number | null; captureExec: number | null; klass: Klass; path: string; exact: boolean; enc: boolean; collateral: string }
  const rows: Row[] = [];
  const sym = (t: string) => t === config.WBERA_ADDRESS.toLowerCase() ? "WETH" : t === config.USDC_E_ADDRESS.toLowerCase() ? "USDC" : t.slice(0, 8);

  for (const p of positions) {
    if (p.lltv == null || p.collateralRaw == null || p.collateralDec == null || p.debtRaw == null || p.loanDec == null || !p.debtUsd || !p.collateralUsd) continue;
    const lif = lifWad(p.lltv);
    // seized @HF=1 for a FULL repay = LIF × lltv × collateral (price-independent)
    const seized = (p.collateralRaw * lif / WAD) * p.lltv / WAD;
    if (seized <= 0n) continue;
    const usdPerLoanUnit = p.debtUsd / (Number(p.debtRaw) / 10 ** p.loanDec);
    const toUsd = (rawLoan: bigint) => (Number(rawLoan) / 10 ** p.loanDec!) * usdPerLoanUnit;
    const oracleSeizedUsd = p.debtUsd * (Number(lif) / 1e18); // what the protocol thinks we seize

    const ex = await exitAt(ctx, p.collateral, p.loan, seized);
    const gasUsd = gas ? (Number(gas.gasPriceWei * GAS_UNITS) / 1e18) * 2500 : 0; // ETH≈$2500; Base gas is ~0 anyway
    const cap = (out: bigint | null) => (out == null ? null : toUsd(out) - p.debtUsd! - gasUsd); // flash fee = 0 (Morpho)

    const rawUsd = ex ? toUsd(ex.raw.amountOut) : null;
    const trustedUsd = ex?.trusted ? toUsd(ex.trusted.amountOut) : null;
    const execUsd = ex?.executable ? toUsd(ex.executable.amountOut) : null;
    const captureTrusted = cap(ex?.trusted?.amountOut ?? null);
    const captureExec = cap(ex?.executable?.amountOut ?? null);

    let klass: Klass;
    const hf = p.hf ?? 99;
    if (!ex) klass = "UNKNOWN";
    else if ((rawUsd ?? 0) < p.debtUsd) klass = "BAD_DEBT_RISK";           // collateral can't even cover the debt
    else if (hf > nearHfMax) klass = "SAFE";
    else if ((captureExec ?? captureTrusted ?? -1) >= MIN_CAPTURE_USD) klass = "PROFITABLE";
    else klass = "NEAR_HF_UNPROFITABLE";

    rows.push({ sym: p.collateralSymbol ?? sym(p.collateral), loanSym: p.loanSymbol ?? sym(p.loan), hf, debtUsd: p.debtUsd, collUsd: p.collateralUsd,
      seizedTokens: seized, oracleSeizedUsd, rawUsd, trustedUsd, execUsd, captureTrusted, captureExec, klass,
      path: ex?.trusted?.path.map(sym).join("→") ?? ex?.raw.path.map(sym).join("→") ?? "-", exact: !!ex?.trusted, enc: !!ex?.executable, collateral: p.collateral });
  }

  // ── SEGMENTATION ──
  const by = new Map<Klass, Row[]>();
  for (const r of rows) { const a = by.get(r.klass); if (a) a.push(r); else by.set(r.klass, [r]); }
  const usd = (n: number | null | undefined) => n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  console.log(`\n[capture] SEGMENTS (nearHF ≤ ${nearHfMax}):`);
  for (const k of ["PROFITABLE", "NEAR_HF_UNPROFITABLE", "BAD_DEBT_RISK", "SAFE", "UNKNOWN"] as Klass[]) {
    const a = by.get(k) ?? []; if (!a.length) { console.log(`   ${k.padEnd(22)} 0`); continue; }
    const debt = a.reduce((s, r) => s + r.debtUsd, 0);
    const capt = a.reduce((s, r) => s + (r.captureExec ?? r.captureTrusted ?? 0), 0);
    console.log(`   ${k.padEnd(22)} n=${String(a.length).padEnd(4)} debt=${usd(debt).padEnd(14)} potentialCapture=${usd(capt)}`);
  }
  const prof = (by.get("PROFITABLE") ?? []).sort((a, b) => (b.captureExec ?? b.captureTrusted ?? 0) - (a.captureExec ?? a.captureTrusted ?? 0));
  if (prof.length) {
    const caps = prof.map((r) => r.captureExec ?? r.captureTrusted ?? 0).sort((a, b) => a - b);
    const q = (p: number) => caps[Math.min(caps.length - 1, Math.floor(p * caps.length))];
    console.log(`[capture] PROFITABLE: median=${usd(q(0.5))} p95=${usd(q(0.95))} max=${usd(caps[caps.length - 1])}`);
    console.log(`   top:`);
    for (const r of prof.slice(0, 10)) console.log(`     ${r.sym.padEnd(12)} HF=${r.hf.toFixed(4)} debt=${usd(r.debtUsd).padEnd(13)} exec=${usd(r.execUsd).padEnd(13)} capture=${usd(r.captureExec ?? r.captureTrusted)} ${r.enc ? "ENC" : "not-enc"}${r.exact ? "/exact" : ""} ${r.path}`);
  }
  // per-asset summary: is the whole asset class a trap or an opportunity?
  const byAsset = new Map<string, Row[]>();
  for (const r of rows) { const a = byAsset.get(r.sym); if (a) a.push(r); else byAsset.set(r.sym, [r]); }
  console.log(`\n[capture] BY COLLATERAL ASSET (exit/oracle at the REAL seized size):`);
  for (const [s, a] of [...byAsset.entries()].sort((x, y) => y[1].reduce((s2, r) => s2 + r.debtUsd, 0) - x[1].reduce((s2, r) => s2 + r.debtUsd, 0)).slice(0, 12)) {
    const orc = a.reduce((s2, r) => s2 + r.oracleSeizedUsd, 0), tr = a.reduce((s2, r) => s2 + (r.trustedUsd ?? 0), 0);
    const ratio = orc > 0 ? tr / orc : 0;
    console.log(`   ${s.padEnd(12)} n=${String(a.length).padEnd(4)} debt=${usd(a.reduce((s2, r) => s2 + r.debtUsd, 0)).padEnd(14)} seizedOracle=${usd(orc).padEnd(14)} trustedExit=${usd(tr).padEnd(14)} ratio=${(100 * ratio).toFixed(1)}% ${ratio > 0.9745 ? "→ ABOVE break-even ✓" : "→ below break-even ✗"}`);
  }

  // ── (a4) CUMULATIVE LIQUIDATION-CAPACITY SURFACE for the two biggest assets ──
  const topAssets = [...byAsset.entries()].sort((x, y) => y[1].reduce((s2, r) => s2 + r.debtUsd, 0) - x[1].reduce((s2, r) => s2 + r.debtUsd, 0)).slice(0, 2);
  for (const [s, a] of topAssets) {
    const coll = a[0].collateral, loan = positions.find((p) => p.collateral === coll)?.loan;
    if (!loan) continue;
    const dec = g.decimals.get(coll) ?? 18, unit = 10n ** BigInt(dec);
    const total = a.reduce((acc, r) => acc + r.seizedTokens, 0n);
    console.log(`\n[capture] CAPACITY SURFACE ${s} (total seizable ${(Number(total) / Number(unit)).toExponential(2)} tok): how much can the market absorb?`);
    for (const frac of [0.01, 0.05, 0.25, 0.5, 1]) {
      const amt = total * BigInt(Math.round(frac * 1000)) / 1000n;
      if (amt <= 0n) continue;
      const ex = await exitAt(ctx, coll, loan, amt);
      if (!ex?.trusted) { console.log(`   ${(100 * frac).toFixed(0).padStart(3)}% → no trusted exit path`); continue; }
      const ldec = positions.find((p) => p.collateral === coll)?.loanDec ?? 6;
      const outUsd = Number(ex.trusted.amountOut) / 10 ** ldec;
      // oracle-implied value of that slice = its share of the seized oracle value
      const orcUsd = a.reduce((s2, r) => s2 + r.oracleSeizedUsd, 0) * frac;
      const eff = orcUsd > 0 ? outUsd / orcUsd : 0;
      console.log(`   ${(100 * frac).toFixed(0).padStart(3)}% (${usd(orcUsd)} oracle) → exit ${usd(outUsd)}  ratio=${(100 * eff).toFixed(1)}%  ${eff > 0.9745 ? "profittevole" : "sotto break-even"}`);
    }
  }
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[capture] fatal:", e); process.exit(1); });
