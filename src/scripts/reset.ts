/**
 * DEV COMMAND: `reset` — full system reset for a clean development slate.
 *   1) LIQUIDATE the wallet: sell every non-base token back to native ETH (production path, robust reads).
 *   2) WIPE Scarlet's DYNAMIC state: agent cycles/history/cognition, annotations, positions DB, follows,
 *      NAV history (db.resetScarletState). Objective indexer data (entities/pool_state/prices/ticks/cursors)
 *      and logs (self-rotating) are PRESERVED.
 * Dry-run by default; `--execute` actually sells + wipes. Companion of the `resync` command.
 *
 *   ... run --rm brain node dist/scripts/reset.js            # dry-run (shows what it would do)
 *   ... run --rm brain node dist/scripts/reset.js --execute  # sell all + wipe Scarlet state
 */
import type { Address } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients, erc20Abi } from "../chain.js";
import { Etherscan } from "../etherscan.js";
import { PositionService } from "../positions.js";
import { RiskEngine } from "../risk.js";
import { GuardedExecutor } from "../executor.js";
import { ExactAllowanceAdapter, WberaAdapter } from "../adapters.js";
import { LocalRouter } from "../router/router.js";
import { Primitives } from "../primitives.js";
import { NATIVE_ETH } from "../aggregator.js";

const MIN_USD = Number(process.env.RESET_MIN_USD ?? "0.05");
const EXECUTE = process.argv.includes("--execute");

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const positions = new PositionService(config, chain, db, new Etherscan(config));
  const WNATIVE = config.WBERA_ADDRESS.toLowerCase(), ROUTER = config.DEX_ROUTER.toLowerCase();
  const risk = new RiskEngine(config, new Map([[WNATIVE, new Set(["0xd0e30db0", "0x2e1a7d4d", "0x095ea7b3"])], [config.USDC_E_ADDRESS.toLowerCase(), new Set(["0x095ea7b3"])], [config.HONEY_ADDRESS.toLowerCase(), new Set(["0x095ea7b3"])]]), new Map([[WNATIVE, new Set([ROUTER])], [config.USDC_E_ADDRESS.toLowerCase(), new Set([ROUTER])], [config.HONEY_ADDRESS.toLowerCase(), new Set([ROUTER])]]));
  const executor = new GuardedExecutor(chain, risk, db, positions, logger, BigInt(config.MAX_PREFLIGHT_BLOCK_LAG));
  const router = new LocalRouter(config, logger, db, chain);
  const primitives = new Primitives(config, chain, db, executor, positions, new WberaAdapter(config, chain), new ExactAllowanceAdapter(chain), logger, router);
  const owner = config.WALLET_ADDRESS as Address;
  const KEEP = new Set([WNATIVE, config.USDC_E_ADDRESS.toLowerCase(), config.HONEY_ADDRESS.toLowerCase(), "native"]);

  console.log(`[reset] mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"}  owner=${owner}  minUsd=${MIN_USD}`);

  // ── 1) LIQUIDATE: sell every non-base token → native ETH ────────────────────
  const snap = await db.latestMarketSnapshot<{ holdings: Array<{ token: string; symbol: string; valueUsd: number }> }>("wallet", "holdings");
  const holdings = (snap?.holdings ?? []).filter((h) => !KEEP.has(h.token.toLowerCase()) && (h.valueUsd ?? 0) >= MIN_USD).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  console.log(`[reset] liquidation candidates: ${holdings.length}`);
  let recovered = 0, sold = 0, failed = 0;
  for (const h of holdings) {
    const token = h.token as Address;
    let bal = 0n;
    for (const client of [chain.exec, chain.primary, chain.fallback]) {
      try { const b = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) as bigint; if (b > 0n) { bal = b; break; } } catch { /* next */ }
    }
    if (bal <= 0n) { console.log(`  SKIP ${h.symbol} balance=0`); continue; }
    if (!EXECUTE) { console.log(`  WOULD SELL ${h.symbol} ~$${h.valueUsd.toFixed(2)} (${token})`); continue; }
    const r = await primitives.swapBest(token, NATIVE_ETH, bal, 15, true).catch((e) => ({ ok: false as const, reason: String(e), stage: "build" as const, primitive: "swap" }));
    if (r.ok && "txHash" in r) { recovered += h.valueUsd ?? 0; sold++; console.log(`  SOLD ${h.symbol} ~$${h.valueUsd.toFixed(2)} tx=${r.txHash} via=${JSON.stringify((r as { detail?: { venue?: string; via?: string } }).detail?.venue ?? (r as { detail?: { via?: string } }).detail?.via ?? "?")}`); }
    else { failed++; console.log(`  FAIL ${h.symbol} (${token}): ${"reason" in r ? String(r.reason).split("\n")[0] : "unknown"}`); }
  }
  console.log(`[reset] liquidation: sold=${sold} failed=${failed} ~$${recovered.toFixed(2)} to ETH${failed ? " (FAILs are likely honeypots — blacklist them)" : ""}`);

  // ── 2) WIPE Scarlet dynamic state ───────────────────────────────────────────
  if (!EXECUTE) { console.log("[reset] DRY-RUN: would WIPE all non-indexer/enrichment data — Scarlet cognition/history/positions/annotations, wallet transfers+balances (Movimenti), market_snapshots, network_observations, liquidation_events, autoflash, bend_*. KEEPS indexer/enrichment (entities/pool_state/prices/stats/ticks/cursors/venues/pools/lending) + system infra (signal_blacklist honeypot-memory, organs deployed contracts) + logs (self-rotate)."); }
  else { await db.resetScarletState(); console.log("[reset] System reset to CLEAN slate (indexer/enrichment data + system infra + logs preserved; wallet transfers/balances and all agent/derived/history data WIPED)."); }

  await db.close().catch(() => undefined);
  console.log(`[reset] done.`);
  process.exit(0);
}
main().catch((e) => { console.error("[reset] fatal:", e); process.exit(1); });
