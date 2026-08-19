/**
 * ONE-OFF: liquidate Scarlet's non-base token holdings back to native ETH, via the PRODUCTION swap
 * path (Primitives.swapBest → local execution first, aggregator fallback). Used to clean the wallet
 * before a test reset so stale positions don't poison behavior. Run with the brain STOPPED (no nonce
 * races). Dry-run by default; pass `--execute` to actually send. NEVER prints the private key.
 *
 *   docker compose -p bera-bot -f docker-compose.yml -f docker-compose.vps.yml run --rm brain \
 *     node dist/scripts/liquidate.js            # dry-run
 *   ... run --rm brain node dist/scripts/liquidate.js --execute   # send
 */
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
import type { Address } from "viem";

const MIN_USD = Number(process.env.LIQUIDATE_MIN_USD ?? "0.5"); // skip dust below this (unsellable/not worth gas)
const EXECUTE = process.argv.includes("--execute");

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const etherscan = new Etherscan(config);
  const positions = new PositionService(config, chain, db, etherscan);
  const WNATIVE = config.WBERA_ADDRESS.toLowerCase(), ROUTER = config.DEX_ROUTER.toLowerCase();
  const risk = new RiskEngine(config, new Map([
    [WNATIVE, new Set(["0xd0e30db0", "0x2e1a7d4d", "0x095ea7b3"])],
    [config.USDC_E_ADDRESS.toLowerCase(), new Set(["0x095ea7b3"])],
    [config.HONEY_ADDRESS.toLowerCase(), new Set(["0x095ea7b3"])]
  ]), new Map([
    [WNATIVE, new Set([ROUTER])], [config.USDC_E_ADDRESS.toLowerCase(), new Set([ROUTER])], [config.HONEY_ADDRESS.toLowerCase(), new Set([ROUTER])]
  ]));
  const executor = new GuardedExecutor(chain, risk, db, positions, logger, BigInt(config.MAX_PREFLIGHT_BLOCK_LAG));
  const wbera = new WberaAdapter(config, chain);
  const allowance = new ExactAllowanceAdapter(chain);
  const aggregator = new LocalRouter(config, logger, db, chain);
  const primitives = new Primitives(config, chain, db, executor, positions, wbera, allowance, logger, aggregator);

  if (!config.WALLET_ADDRESS) throw new Error("WALLET_ADDRESS not configured");
  const owner = config.WALLET_ADDRESS as Address;
  const KEEP = new Set([WNATIVE, config.USDC_E_ADDRESS.toLowerCase(), config.HONEY_ADDRESS.toLowerCase(), "native"]);
  const snap = await db.latestMarketSnapshot<{ holdings: Array<{ token: string; symbol: string; balance: number; valueUsd: number }> }>("wallet", "holdings");
  const holdings = (snap?.holdings ?? []).filter((h) => !KEEP.has(h.token.toLowerCase()) && (h.valueUsd ?? 0) >= MIN_USD);
  holdings.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

  console.log(`[liquidate] mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"} owner=${owner} candidates=${holdings.length} (valueUsd>=${MIN_USD})`);
  let recovered = 0;
  for (const h of holdings) {
    const token = h.token as Address;
    // Robust balance: a single flaky lane (base.org) returning 0/throwing must not skip a real holding.
    let bal = 0n;
    for (const client of [chain.exec, chain.primary, chain.fallback]) {
      try { const b = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) as bigint; if (b > 0n) { bal = b; break; } } catch { /* next lane */ }
    }
    if (bal <= 0n) { console.log(`  SKIP ${h.symbol} (${token}) balance=0`); continue; }
    if (!EXECUTE) { console.log(`  WOULD SELL ${h.symbol} ~$${h.valueUsd.toFixed(2)} bal=${bal} (${token})`); continue; }
    const r = await primitives.swapBest(token, NATIVE_ETH, bal, 15, true).catch((e) => ({ ok: false as const, reason: String(e), stage: "build" as const, primitive: "swap" }));
    if (r.ok && "txHash" in r) { recovered += h.valueUsd ?? 0; console.log(`  SOLD ${h.symbol} ~$${h.valueUsd.toFixed(2)} tx=${r.txHash} via=${JSON.stringify((r as { detail?: { venue?: string; via?: string } }).detail?.venue ?? (r as { detail?: { via?: string } }).detail?.via ?? "?")}`); }
    else console.log(`  FAIL ${h.symbol} (${token}): ${"reason" in r ? r.reason : "unknown"}`);
  }
  console.log(`[liquidate] done. ${EXECUTE ? `~$${recovered.toFixed(2)} routed to ETH.` : "dry-run only — pass --execute to send."}`);
  await db.close().catch(() => undefined);
  process.exit(0);
}

main().catch((e) => { console.error("[liquidate] fatal:", e); process.exit(1); });
