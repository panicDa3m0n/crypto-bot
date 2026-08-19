/**
 * MINIMAL REAL TEST of the KGExecutor flash-loan loop. Flash-borrows a tiny amount of USDC from Morpho
 * (0-fee), runs ZERO calls, and requires minProfit=0 → the contract ends holding exactly the borrowed
 * amount and repays. This validates the whole flash path end-to-end (flashExecute → Morpho.flashLoan →
 * onMorphoFlashLoan auth → _runAndCheck require → approve+repay) at ZERO risk (net cost = gas only).
 * The dry-run's estimateGas SIMULATES the full loop — a clean estimate already proves it works.
 *
 *   ... run --rm brain node dist/scripts/test-kg-flash.js            # dry (simulate)
 *   ... run --rm brain node dist/scripts/test-kg-flash.js --execute  # send on-chain
 */
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";

const ABI = parseAbi(["function flashExecute(uint8 provider, address loanToken, uint256 amount, uint256 minProfit, (address target,uint256 value,bytes data)[] calls)"]);
const EXECUTE = process.argv.includes("--execute");
const AMOUNT = 1_000_000n; // 1 USDC (6 decimals)

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const owner = config.WALLET_ADDRESS as Address;
  const org = await db.getOrgan("kg-executor");
  if (!org) throw new Error("kg-executor organ not deployed — run deploy-kg-executor first");
  const kg = org.address as Address;
  const usdc = config.USDC_E_ADDRESS as Address;

  // provider=0 (Morpho), no calls, minProfit=0 → borrow then repay, net zero.
  const data = encodeFunctionData({ abi: ABI, functionName: "flashExecute", args: [0, usdc, AMOUNT, 0n, []] });
  const gas = await chain.primary.estimateGas({ account: owner, to: kg, data });
  console.log(`[kg-flash] mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"} kg=${kg} flash=${Number(AMOUNT) / 1e6} USDC provider=Morpho calls=0 minProfit=0 → SIMULATED OK, gas=${gas}`);
  if (!EXECUTE) { console.log("[kg-flash] DRY: estimateGas simulated the full flash loop successfully (borrow→callback→check→repay)."); await db.close().catch(() => undefined); process.exit(0); }
  if (!chain.wallet) throw new Error("no signer");

  const h = await chain.wallet.sendTransaction({ to: kg, data, gas: gas * 12n / 10n, gasPrice: await chain.primary.getGasPrice() });
  const r = await chain.waitReceipt({ hash: h, confirmations: 1, timeout: 120_000 });
  console.log(`[kg-flash] flashExecute → ${r.status}  gasUsed=${r.gasUsed}  tx=${h}`);
  await db.close().catch(() => undefined);
  process.exit(r.status === "success" ? 0 : 1);
}
main().catch((e) => { console.error("[kg-flash] fatal:", e?.shortMessage ?? e); process.exit(1); });
