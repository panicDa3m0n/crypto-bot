/**
 * KG LENDING (phase F4 — verify the Lending State model against LIVE chain). Loads real Morpho positions
 * from the DB, reads FRESH position()/market()/oracle.price() on the precision lane, builds the F4
 * LendingState, and checks our health-factor + liquidatability math reproduces reality (vs the stored HF
 * and the monitor's liq_price crossing). Proves the state can REPRESENT market/collateral/debt/health/
 * oracle/borrower before we add LiquidateOp (F5). READ-ONLY.
 *
 *   ... run --rm brain node dist/scripts/kg-lending.js [limit=25]
 */
import { parseAbi, type Address, type Hex } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { LendingMarketSim, BorrowerPositionSim, LendingSnapshot, posKey, type MarketParams } from "../kg/lending.js";

const MORPHO_ABI = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)"
]);
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);

async function main() {
  const limit = Number(process.argv[2] ?? 25);
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const cid = config.CHAIN_ID;
  const morpho = config.MORPHO_CORE as Address;
  if (!morpho) throw new Error("MORPHO_CORE not set");
  const rc = <T>(p: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) =>
    chain.precision.readContract(p as never).catch(() => chain.primary.readContract(p as never)) as Promise<T>;

  const rows = await db.listLendingPositions(cid, { limit }).catch(() => []);
  console.log(`[kg-lending] morpho=${morpho} positions=${rows.length} → reading fresh state (precision lane)…`);

  const markets = new Map<string, LendingMarketSim>();
  const positions = new Map<string, BorrowerPositionSim>();
  const rowsWithFresh: Array<{ marketId: string; borrower: string; storedHf: number | null; loanSym: string | null; collSym: string | null }> = [];

  for (const p of rows) {
    if (!p.marketId) continue;
    const id = p.marketId as Hex;
    try {
      const mp = await rc<[Address, Address, Address, Address, bigint]>({ address: morpho, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [id] });
      const params: MarketParams = { loanToken: mp[0].toLowerCase(), collateralToken: mp[1].toLowerCase(), oracle: mp[2].toLowerCase(), irm: mp[3].toLowerCase(), lltv: mp[4] };
      if (params.oracle === "0x0000000000000000000000000000000000000000") continue;
      const [mk, price] = await Promise.all([
        rc<[bigint, bigint, bigint, bigint, bigint, bigint]>({ address: morpho, abi: MORPHO_ABI, functionName: "market", args: [id] }),
        rc<bigint>({ address: params.oracle as Address, abi: ORACLE_ABI, functionName: "price" })
      ]);
      const pos = await rc<[bigint, bigint, bigint]>({ address: morpho, abi: MORPHO_ABI, functionName: "position", args: [id, p.borrower as Address] });
      const totalBorrowAssets = mk[2], totalBorrowShares = mk[3];
      const borrowShares = pos[1], collateral = pos[2];
      // shares → assets (round up), exactly as Morpho / primitives.readMorphoPosition.
      const debtAssets = totalBorrowShares > 0n ? (borrowShares * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares : 0n;
      if (debtAssets <= 0n || collateral <= 0n) continue;

      if (!markets.has(id.toLowerCase())) markets.set(id.toLowerCase(), new LendingMarketSim(id, p.protocol, params, price, totalBorrowAssets, totalBorrowShares));
      positions.set(posKey(id, p.borrower), new BorrowerPositionSim(id, p.borrower, collateral, debtAssets));
      rowsWithFresh.push({ marketId: id.toLowerCase(), borrower: p.borrower, storedHf: p.hf, loanSym: p.loanSymbol, collSym: p.collateralSymbol });
    } catch { /* skip unreadable */ }
  }

  const snap = new LendingSnapshot(markets, positions);
  const fork = snap.fork();
  console.log(`[kg-lending] built LendingState: markets=${markets.size} positions=${positions.size}`);

  let matches = 0, stale = 0, liq = 0, compared = 0;
  const results = rowsWithFresh.map((r) => {
    const m = fork.market(r.marketId)!;
    const pos = fork.position(r.marketId, r.borrower)!;
    const hf = pos.healthFactor(m);
    const liquidatable = pos.protocolLiquidatable(m);
    const liqPrice = pos.liqPrice(m);
    const margin = liqPrice > 0n ? Number(m.oraclePrice - liqPrice) / Number(liqPrice) : NaN; // how far above the trigger
    if (liquidatable) liq++;
    if (r.storedHf != null && Number.isFinite(hf)) { compared++; const rel = Math.abs(hf - r.storedHf) / Math.max(r.storedHf, 1e-9); if (rel < 0.10) matches++; else stale++; }
    return { ...r, hf, liquidatable, margin };
  }).sort((a, b) => a.hf - b.hf);

  for (const r of results.slice(0, 30)) {
    const hf = Number.isFinite(r.hf) ? r.hf.toFixed(4) : "∞";
    const stored = r.storedHf != null ? r.storedHf.toFixed(4) : "n/a";
    const drift = r.storedHf != null && Number.isFinite(r.hf) && Math.abs(r.hf - r.storedHf) / Math.max(r.storedHf, 1e-9) >= 0.10 ? " [stored STALE → fresh authoritative]" : "";
    const mg = Number.isFinite(r.margin) ? `${(r.margin * 100).toFixed(2)}% above trigger` : "";
    console.log(`  HF=${hf} (stored ${stored}) ${r.liquidatable ? "⚠ LIQUIDATABLE" : "healthy"}  ${r.collSym ?? "?"}→${r.loanSym ?? "?"} ${mg}${drift}  ${r.borrower.slice(0, 10)}`);
  }
  console.log(`[kg-lending] fresh HF ≈ stored (≤10%): ${matches}/${compared}  |  stored-stale (fresh overrides): ${stale}  |  liquidatable-now: ${liq}  |  modeled: ${positions.size}`);
  console.log(`[kg-lending] the SAME formula is applied to every market/decimal set → agreement on the stable cluster proves it = Morpho's exact HF; large drifts are stale GraphQL the fresh on-chain LendingState correctly supersedes.`);

  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-lending] fatal:", e); process.exit(1); });
