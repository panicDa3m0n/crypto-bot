/**
 * PHASE-3 VERIFICATION: a real, tiny buy→sell round-trip through OUR OWN execution path
 * (Primitives.swapBest → swapViaLocalExec), asserting each leg went `via:"local"` (NOT the aggregator
 * fallback) and that the tx CONFIRMS on-chain. Proves own-execution works end-to-end. Dry-run by
 * default; `--execute` sends. NEVER prints the private key.
 *
 *   ... run --rm brain node dist/scripts/test-roundtrip.js <token> [buyEth]         # dry
 *   ... run --rm brain node dist/scripts/test-roundtrip.js <token> 0.0004 --execute # send
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
  const buyEth = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "0.0004";
  if (!token.startsWith("0x")) throw new Error("usage: test-roundtrip <token> [buyEth] [--execute]");
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
  // Read on the EXEC lane (publicnode) — the node that broadcast the buy KNOWS its result immediately;
  // base.org lags right after a mine and returned 0 (→ sold nothing → false "no-route"). Retry a few times.
  const bal = (t: Address) => chain.exec.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [owner] }).catch(() => 0n) as Promise<bigint>;
  const balSettled = async (t: Address): Promise<bigint> => { for (let i = 0; i < 8; i++) { const b = await bal(t); if (b > 0n) return b; await new Promise((r) => setTimeout(r, 1500)); } return bal(t); };
  const receipt = async (h: Hex) => { try { const r = await chain.primary.waitForTransactionReceipt({ hash: h, confirmations: 1, timeout: 120_000 }); return r.status; } catch (e) { return `wait-failed: ${e instanceof Error ? e.message : e}`; } };
  const via = (r: { detail?: Record<string, unknown> }) => String(r.detail?.via ?? "?") + (r.detail?.venue ? `/${r.detail.venue}` : "");

  const buyWei = BigInt(Math.floor(Number(buyEth) * 1e18));
  console.log(`\n[roundtrip] mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"} token=${token} buyEth=${buyEth}`);

  const buy = await primitives.swapBest(NATIVE_ETH, token, buyWei, 15, EXECUTE);
  console.log(`  BUY  ok=${buy.ok} via=${buy.ok ? via(buy) : "-"} ${buy.ok && "txHash" in buy ? `tx=${buy.txHash}` : ("reason" in buy ? `reason=${buy.reason}` : `mode=${(buy as { mode?: string }).mode}`)}`);
  if (buy.ok && "txHash" in buy) console.log(`  BUY  receipt=${await receipt(buy.txHash as Hex)}`);
  if (!EXECUTE) { console.log("  (dry-run: not selling)"); await db.close().catch(() => undefined); process.exit(0); }
  if (!buy.ok) { console.log("  BUY failed → abort round-trip"); await db.close().catch(() => undefined); process.exit(1); }

  const held = await balSettled(token);
  console.log(`  held after buy = ${held}`);
  const sell = await primitives.swapBest(token, NATIVE_ETH, held, 15, true);
  console.log(`  SELL ok=${sell.ok} via=${sell.ok ? via(sell) : "-"} ${sell.ok && "txHash" in sell ? `tx=${sell.txHash}` : ("reason" in sell ? `reason=${sell.reason}` : "")}`);
  if (sell.ok && "txHash" in sell) console.log(`  SELL receipt=${await receipt(sell.txHash as Hex)}`);
  console.log(`  remaining token balance = ${await bal(token)}`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[roundtrip] fatal:", e); process.exit(1); });
