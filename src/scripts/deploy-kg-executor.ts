/**
 * DEPLOY the Liquidity-Graph EXECUTOR (contracts/KGExecutor.sol): the generic, multi-provider flash-loan
 * atomic engine the KG drives. Steps: (1) deploy KGExecutor(morpho, balancer) + register as organ
 * "kg-executor"; (2) approveMax — ROBUST pre-approval of the base tokens (WETH/USDC) → every known venue
 * router, so a swap never blocks on a missing allowance. Dry-run default; `--execute` sends.
 *
 *   ... run --rm brain node dist/scripts/deploy-kg-executor.js            # dry
 *   ... run --rm brain node dist/scripts/deploy-kg-executor.js --execute  # deploy + approve
 */
import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { KG_EXECUTOR_BYTECODE } from "../organs-kg.js";

const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Address; // Balancer V2 Vault (universal) — seam
const APPROVE_ABI = parseAbi(["function approveMax(address[] tokens, address[] spenders)"]);
const EXECUTE = process.argv.includes("--execute");

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const owner = config.WALLET_ADDRESS as Address;
  const morpho = config.MORPHO_CORE as Address | undefined;
  if (!morpho) throw new Error("MORPHO_CORE not set in the network profile");

  // Known venue routers to pre-approve (WETH + USDC → each).
  const routers = new Set<string>([config.DEX_ROUTER, config.AERODROME_ROUTER, config.UNIV2_ROUTER, config.SLIPSTREAM_ROUTER].map((r) => r.toLowerCase()));
  try { for (const d of JSON.parse(config.VENUE_EXTRA_JSON ?? "[]") as Array<{ meta?: { swapRouter?: string } }>) if (d.meta?.swapRouter) routers.add(d.meta.swapRouter.toLowerCase()); } catch { /* no extras */ }
  const tokens = [config.WBERA_ADDRESS.toLowerCase(), config.USDC_E_ADDRESS.toLowerCase()];

  // Idempotent: reuse an already-deployed KGExecutor (so a re-run only tops up approvals).
  const existing = await db.getOrgan("kg-executor").catch(() => undefined);
  const ctor = encodeAbiParameters([{ type: "address" }, { type: "address" }], [morpho as Address, BALANCER_VAULT]);
  const deployData = (KG_EXECUTOR_BYTECODE + ctor.slice(2)) as Hex;
  const gas = existing ? 0n : await chain.primary.estimateGas({ account: owner, data: deployData });
  console.log(`[kg-deploy] mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"} owner=${owner} morpho=${morpho} balancer=${BALANCER_VAULT} ${existing ? `reuse=${existing.address}` : `deployGas=${gas}`} approvals=${tokens.length * routers.size}`);
  if (!EXECUTE) { console.log(`[kg-deploy] DRY: would ${existing ? "reuse existing organ" : "deploy KGExecutor"} + approveMax ${tokens.length}×${routers.size} (token,router) pairs.`); await db.close().catch(() => undefined); process.exit(0); }
  if (!chain.wallet) throw new Error("no signer");

  // 1) Deploy (unless already present).
  let kg: Address;
  if (existing) { kg = existing.address as Address; console.log(`[kg-deploy] KGExecutor already LIVE @ ${kg} — skipping deploy.`); }
  else {
    const gp = await chain.primary.getGasPrice();
    const dh = await chain.wallet.sendTransaction({ data: deployData, gas: gas * 12n / 10n, gasPrice: gp });
    const dr = await chain.waitReceipt({ hash: dh, confirmations: 1, timeout: 120_000 });
    if (dr.status !== "success" || !dr.contractAddress) throw new Error(`deploy reverted (status=${dr.status})`);
    kg = dr.contractAddress as Address;
    await db.saveOrgan("kg-executor", kg, dh).catch(() => undefined);
    console.log(`[kg-deploy] KGExecutor LIVE @ ${kg}  tx=${dh}`);
  }

  // 2) approveMax (robust pre-approval) — pairwise (token, router). Same send path as the deploy
  // (direct wallet send, auto nonce) — the exec-lane nonce/value shape was rejected by the RPC.
  const at: Address[] = [], asp: Address[] = [];
  for (const t of tokens) for (const r of routers) { at.push(t as Address); asp.push(r as Address); }
  const data = encodeFunctionData({ abi: APPROVE_ABI, functionName: "approveMax", args: [at, asp] });
  const ag = await chain.primary.estimateGas({ account: owner, to: kg, data }).catch(() => 800_000n);
  const ah = await chain.wallet.sendTransaction({ to: kg, data, gas: ag * 12n / 10n, gasPrice: await chain.primary.getGasPrice() });
  const ar = await chain.waitReceipt({ hash: ah, confirmations: 1, timeout: 120_000 });
  console.log(`[kg-deploy] approveMax ${at.length} pairs → ${ar.status}  tx=${ah}`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-deploy] fatal:", e); process.exit(1); });
