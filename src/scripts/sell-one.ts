/**
 * TARGETED SELL of one held token → native ETH, via the production path (swapBest). Robust balance read
 * across lanes (the flaky single-lane read is exactly what breaks production sells). Sim first, then
 * execute with --execute. Surfaces the exact revert reason (honeypot vs approval vs route). NEVER prints keys.
 *   ... run --rm brain node dist/scripts/sell-one.js <token> [--execute]
 */
import type { Address, Hex } from "viem";
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

const EXECUTE = process.argv.includes("--execute");

async function main() {
  const token = (process.argv[2] ?? "").toLowerCase() as Address;
  if (!token.startsWith("0x")) throw new Error("usage: sell-one <token> [--execute]");
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

  // Robust balance: try several lanes; a single flaky read must not zero the sell.
  let bal = 0n;
  for (const client of [chain.exec, chain.primary, chain.fallback]) {
    try { const b = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) as bigint; if (b > 0n) { bal = b; break; } } catch { /* next lane */ }
  }
  console.log(`[sell-one] token=${token} balance=${bal} mode=${EXECUTE ? "EXECUTE" : "SIM"}`);
  if (bal <= 0n) { console.log("  balance 0 across all lanes → nothing to sell"); await db.close().catch(() => undefined); process.exit(0); }

  const sim = await primitives.swapBest(token, NATIVE_ETH, bal, 15, false);
  console.log(`  SIM ok=${sim.ok} ${sim.ok ? "expectedOut=" + JSON.stringify((sim as { detail?: Record<string, unknown> }).detail) : "reason=" + ("reason" in sim ? sim.reason : "?")}`);
  if (!EXECUTE) { await db.close().catch(() => undefined); process.exit(0); }

  const r = await primitives.swapBest(token, NATIVE_ETH, bal, 15, true);
  if (r.ok && "txHash" in r) {
    console.log(`  SOLD tx=${r.txHash} detail=${JSON.stringify((r as { detail?: Record<string, unknown> }).detail)}`);
    try { const rc = await chain.waitReceipt({ hash: r.txHash as Hex, confirmations: 1, timeout: 120_000 }); console.log(`  receipt=${rc.status}`); } catch (e) { console.log(`  receipt wait: ${e instanceof Error ? e.message : e}`); }
  } else console.log(`  SELL FAILED: ${"reason" in r ? r.reason : "?"} (stage=${"stage" in r ? r.stage : "?"})`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[sell-one] fatal:", e); process.exit(1); });
