/**
 * DIAGNOSTIC: build OUR own-execution calldata for a token (buy native→token, and sell token→native
 * if held) and run the preflight eth_call, printing the DECODED revert reason + the routed pool's
 * factory (to tell Uniswap-V3 from PancakeSwap-V3, which share the archetype). This tells us EXACTLY
 * why local execution falls back — no guessing. Read-only for the buy (preflight never sends); the
 * sell approves the router first (a real approve tx) so the preflight sees the allowance.
 *
 *   ... run --rm brain node dist/scripts/diag-exec.js <tokenAddress> [buyEthAmount]
 */
import { parseAbi, type Address } from "viem";
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

const FACTORY_ABI = parseAbi(["function factory() view returns (address)"]);
const KNOWN_FACTORY: Record<string, string> = {
  "0x33128a8fc17869897dce68ed026d694621f6fdfd": "Uniswap-V3",
  "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865": "Pancake-V3",
  "0x420dd381b31aef6683db6b902084cb0ffece40da": "Aerodrome"
};

function revertOf(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; metaMessages?: string[]; message?: string; cause?: unknown };
  const parts: string[] = [];
  for (let cur: typeof err | undefined = err, i = 0; cur && i < 6; cur = cur.cause as typeof err, i++) {
    if (cur.shortMessage) parts.push(cur.shortMessage);
    if (cur.details) parts.push(`details=${cur.details}`);
    if (cur.metaMessages?.length) parts.push(cur.metaMessages.join(" | "));
  }
  if (!parts.length && err.message) parts.push(err.message);
  return [...new Set(parts)].join(" :: ").slice(0, 600);
}

async function main() {
  const token = (process.argv[2] ?? "").toLowerCase() as Address;
  const buyEth = process.argv[3] ?? "0.0004";
  if (!token || !token.startsWith("0x")) throw new Error("usage: diag-exec <tokenAddress> [buyEthAmount]");
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never }); // keep stdout clean for the report
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const etherscan = new Etherscan(config);
  const positions = new PositionService(config, chain, db, etherscan);
  const WNATIVE = config.WBERA_ADDRESS.toLowerCase(), ROUTER = config.DEX_ROUTER.toLowerCase();
  const risk = new RiskEngine(config, new Map([[WNATIVE, new Set(["0xd0e30db0", "0x2e1a7d4d", "0x095ea7b3"])], [config.USDC_E_ADDRESS.toLowerCase(), new Set(["0x095ea7b3"])], [config.HONEY_ADDRESS.toLowerCase(), new Set(["0x095ea7b3"])]]), new Map([[WNATIVE, new Set([ROUTER])], [config.USDC_E_ADDRESS.toLowerCase(), new Set([ROUTER])], [config.HONEY_ADDRESS.toLowerCase(), new Set([ROUTER])]]));
  const executor = new GuardedExecutor(chain, risk, db, positions, logger, BigInt(config.MAX_PREFLIGHT_BLOCK_LAG));
  const router = new LocalRouter(config, logger, db, chain);
  new Primitives(config, chain, db, executor, positions, new WberaAdapter(config, chain), new ExactAllowanceAdapter(chain), logger, router);
  const owner = config.WALLET_ADDRESS as Address;

  const identify = async (pool: string) => {
    const f = await chain.primary.readContract({ address: pool as Address, abi: FACTORY_ABI, functionName: "factory" }).catch(() => "0x?") as string;
    return `${f} (${KNOWN_FACTORY[f.toLowerCase()] ?? "UNKNOWN-dex"})`;
  };

  // --- BUY leg: native ETH → token (no approval needed) ---
  const buyWei = BigInt(Math.floor(Number(buyEth) * 1e18));
  console.log(`\n=== BUY  ETH(${buyEth}) -> ${token} ===`);
  const buyPlan = await router.execPlan(NATIVE_ETH, token, buyWei, owner, 15);
  if (!buyPlan) console.log("  execPlan=null (no local single-hop route → would fall back)");
  else {
    console.log(`  venue=${buyPlan.venue} pool=${buyPlan.poolAddress} factory=${await identify(buyPlan.poolAddress)}`);
    console.log(`  router=${buyPlan.router} value=${buyPlan.value} expectedOut=${buyPlan.expectedOut} minOut=${buyPlan.minOut}`);
    try { const pf = await chain.preflight({ to: buyPlan.router, data: buyPlan.calldata, value: buyPlan.value, account: owner }); console.log(`  PREFLIGHT OK gas=${pf.gas}`); }
    catch (e) { console.log(`  PREFLIGHT REVERT: ${revertOf(e)}`); }
  }

  // --- SELL leg: token → native ETH (only if held; approves the router first) ---
  const bal = await chain.primary.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }).catch(() => 0n) as bigint;
  console.log(`\n=== SELL ${token} -> ETH  (held balance=${bal}) ===`);
  if (bal <= 0n) console.log("  not held → skipping sell preflight");
  else {
    const sellPlan = await router.execPlan(token, NATIVE_ETH, bal, owner, 15);
    if (!sellPlan) console.log("  execPlan=null (no local single-hop route → would fall back)");
    else {
      console.log(`  venue=${sellPlan.venue} pool=${sellPlan.poolAddress} factory=${await identify(sellPlan.poolAddress)}`);
      console.log(`  router=${sellPlan.router} expectedOut=${sellPlan.expectedOut} minOut=${sellPlan.minOut}`);
      // approve token->router so the preflight's transferFrom isn't the blocker (isolates the real cause)
      const allow = await chain.primary.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, sellPlan.router] }).catch(() => 0n) as bigint;
      console.log(`  allowance(token->router)=${allow}${allow < bal ? " (INSUFFICIENT — preflight transferFrom will revert unless approved)" : ""}`);
      try { const pf = await chain.preflight({ to: sellPlan.router, data: sellPlan.calldata, value: sellPlan.value, account: owner }); console.log(`  PREFLIGHT OK gas=${pf.gas}`); }
      catch (e) { console.log(`  PREFLIGHT REVERT: ${revertOf(e)}`); }
    }
  }
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[diag] fatal:", e); process.exit(1); });
