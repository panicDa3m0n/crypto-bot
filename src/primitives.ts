import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, maxUint256, parseAbi, parseUnits, type Address } from "viem";
import { ATOMIC_EXECUTOR_BYTECODE } from "./organs.js";
import { HONEYPOT_PROBE_BYTECODE } from "./honeypot-probe.js";

import { Erc4626Adapter, ExactAllowanceAdapter, WberaAdapter, type ProposedCall } from "./adapters.js";
import { erc20Abi, type BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { Decision, ExecutionRequest, PortfolioSnapshot } from "./domain.js";
import type { GuardedExecutor } from "./executor.js";
import type { PositionService } from "./positions.js";
import { isNative, NATIVE_ETH, type Aggregator } from "./aggregator.js";
import type { LocalExecPlan } from "./router/router.js";

const previewAbi = parseAbi(["function previewDeposit(uint256 assets) view returns (uint256 shares)"]);

/** Pull the raw revert data (0x…) out of a viem/RPC error, whatever nesting the provider uses. */
function extractRevertData(err: unknown): string | null {
  const seen = new Set<unknown>(); const stack: unknown[] = [err];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== "object" || seen.has(o)) continue; seen.add(o);
    for (const k of ["data", "details", "cause", "error", "info", "value"]) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v === "string" && v.startsWith("0x") && v.length > 2) return v;
      if (v && typeof v === "object") stack.push(v);
    }
  }
  const m = String((err as { message?: string })?.message ?? "").match(/0x[0-9a-fA-F]{8,}/);
  return m ? m[0] : null;
}

/** True when a V3 sell-leg revert reason looks like a transfer-BLOCKING honeypot (buy ok, sell blocked at
 * the token's transfer/transferFrom), vs a mere routing/liquidity failure. A transfer-block would also fail
 * the aggregator's REAL execution (though not its quote), so we must reject it hard rather than fall through.
 * An empty/undecodable revert is treated as suspicious (blocking) — classic custom-error honeypots hide there. */
function isTransferBlockRevert(reason?: string): boolean {
  if (!reason) return false;
  if (/^(revert vuoto|vendita reverta \(honeypot\?\)|revert non decodificabile)$/i.test(reason)) return true;
  return /transfer_from_failed|\bstf\b|transfer.?fail|blacklist|not.?whitelist|trading.?(not|disabled)|cannot.?(sell|transfer)|sell.?(disabled|blocked)|max.?(tx|wallet)|bot|cooldown/i.test(reason);
}

/**
 * Scarlet's hands. Each primitive is intent -> trusted-adapter calldata ->
 * (simulate | execute). She never supplies raw calldata; she states an intent
 * and the body builds, checks and — only when execution is enabled — signs it.
 *
 * Two faculties per primitive:
 *  - simulate(): builds the call and runs its on-chain eth_call preflight. This
 *    is her sense of foresight and her executable-price perception; it works even
 *    in observation mode and never sends a transaction.
 *  - execute(): routes the built call through the GuardedExecutor, which re-checks
 *    every invariant (allowlist, exact approval, dual-RPC preflight, code-hash
 *    binding, freshness, slippage, loss budget, energy floor) before broadcasting.
 */
export type ActionOutcome =
  | { ok: true; mode: "simulated"; primitive: string; detail: Record<string, unknown> }
  | { ok: true; mode: "executed"; primitive: string; txHash: string; detail: Record<string, unknown> }
  | { ok: false; primitive: string; stage: "build" | "execute" | "disabled"; reason: string };

type ExecOptions = {
  kind: ExecutionRequest["kind"];
  maxEconomicLossUsd: number;
  expectedNetProfitUsd?: number;
  bindings?: Pick<ExecutionRequest, "contractCodeHash" | "dynamicPolicy" | "position">;
};

export type FlashLiquidationIntent = { organ: Address; loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: string; borrower: Address; seizedAssets: bigint; flashAmount: bigint; swapFeeBps: number; minProfitWei: bigint; swap?: { router: Address; calldata: `0x${string}` } };

export class Primitives {
  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly executor: GuardedExecutor,
    private readonly positions: PositionService,
    private readonly wbera: WberaAdapter,
    private readonly allowance: ExactAllowanceAdapter,
    private readonly logger: Logger,
    private readonly aggregator?: Aggregator
  ) {}

  private get morpho(): Address { return this.config.MORPHO_CORE as Address; }

  get executionEnabled(): boolean { return this.config.EXECUTION_ENABLED; }

  // --- wrap / unwrap (energy <-> wrapped energy) ------------------------------

  async wrap(amountWberaWei: bigint, act: boolean): Promise<ActionOutcome> {
    return this.run("wrap", () => this.wbera.prepareWrap(amountWberaWei), act, { kind: "agent_action", maxEconomicLossUsd: 0 });
  }
  async unwrap(amountWberaWei: bigint, act: boolean): Promise<ActionOutcome> {
    return this.run("unwrap", () => this.wbera.prepareUnwrap(amountWberaWei), act, { kind: "agent_action", maxEconomicLossUsd: 0 });
  }

  // --- approve_exact ----------------------------------------------------------

  async approveExact(token: Address, spender: Address, amount: bigint, act: boolean, spenderCodeHash?: `0x${string}`): Promise<ActionOutcome> {
    const owner = this.owner();
    if (!owner) return { ok: false, primitive: "approve_exact", stage: "build", reason: "no wallet configured" };
    const build = async () => {
      const plan = await this.allowance.prepareIfNeeded(token, owner, spender, amount, spenderCodeHash);
      if (!plan) throw new Error("an exact allowance of at least this amount already exists");
      return plan;
    };
    return this.run("approve_exact", build, act, { kind: "agent_action", maxEconomicLossUsd: 0 });
  }

  /** Ensures an exact ERC-20 allowance exists, executing (and awaiting) an approval if missing. */
  private async ensureAllowance(token: Address, spender: Address, amount: bigint, spenderCodeHash?: `0x${string}`): Promise<void> {
    const owner = this.owner();
    if (!owner) throw new Error("no wallet configured");
    const current = await this.chain.exec.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }); // tx-cycle read → execution lane
    if (current >= amount) return;
    const plan = await this.allowance.prepareIfNeeded(token, owner, spender, amount, spenderCodeHash);
    if (!plan) return;
    const hash = await this.execute("approve_exact", plan, { kind: "agent_action", maxEconomicLossUsd: 0 });
    // The dependent action reads allowance from chain state, so wait for the
    // approval to be mined before proceeding.
    await this.chain.waitReceipt({ hash: hash as `0x${string}`, confirmations: 1, timeout: 120_000 });
  }

  // --- lend / redeem (ERC-4626) ----------------------------------------------

  async lend(vault: Address, assetToken: Address, assets: bigint, act: boolean): Promise<ActionOutcome> {
    const owner = this.owner();
    if (!owner) return { ok: false, primitive: "lend", stage: "build", reason: "no wallet configured" };
    const codeHash = await this.chain.verifiedCodeHash(vault).catch(() => undefined);
    if (!codeHash) return { ok: false, primitive: "lend", stage: "build", reason: "vault bytecode is not dual-RPC verifiable" };
    const adapter = new Erc4626Adapter(this.chain, vault);
    const bindings = { contractCodeHash: codeHash, dynamicPolicy: "erc4626" as const, position: { strategyId: "agent_lend", protocolId: `erc4626:${vault.toLowerCase()}`, vault, asset: assetToken, owner, kind: "erc4626" as const } };
    // Simulation: preview the shares this deposit would mint (a view, no allowance).
    if (!act) {
      try {
        const shares = await this.chain.primary.readContract({ address: vault, abi: previewAbi, functionName: "previewDeposit", args: [assets] });
        return { ok: true, mode: "simulated", primitive: "lend", detail: { vault, asset: assetToken, assets: assets.toString(), expectedShares: shares.toString(), note: "any required allowance is handled automatically when you execute this deposit" } };
      } catch (error) {
        return { ok: false, primitive: "lend", stage: "build", reason: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!this.config.EXECUTION_ENABLED) return { ok: false, primitive: "lend", stage: "disabled", reason: "execution is disabled; only simulation is available" };
    try {
      // The body handles the plumbing: ensure the exact asset allowance to the
      // vault (bound to its verified bytecode), then deposit. One intent.
      await this.ensureAllowance(assetToken, vault, assets, codeHash);
      const plan = await adapter.prepareDeposit(assets, owner);
      const txHash = await this.execute("lend", plan, { kind: "agent_action", maxEconomicLossUsd: 0, bindings });
      return { ok: true, mode: "executed", primitive: "lend", txHash, detail: { vault, shares: plan.previewShares.toString() } };
    } catch (error) {
      return { ok: false, primitive: "lend", stage: "execute", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async redeem(vault: Address, assetToken: Address, assets: bigint, act: boolean): Promise<ActionOutcome> {
    const owner = this.owner();
    if (!owner) return { ok: false, primitive: "redeem", stage: "build", reason: "no wallet configured" };
    const codeHash = await this.chain.verifiedCodeHash(vault).catch(() => undefined);
    if (!codeHash) return { ok: false, primitive: "redeem", stage: "build", reason: "vault bytecode is not dual-RPC verifiable" };
    const adapter = new Erc4626Adapter(this.chain, vault);
    const build = () => adapter.prepareWithdraw(assets, this.owner()!, this.owner()!);
    const bindings = { contractCodeHash: codeHash, dynamicPolicy: "erc4626" as const, position: { strategyId: "agent_lend", protocolId: `erc4626:${vault.toLowerCase()}`, vault, asset: assetToken, owner, kind: "erc4626" as const } };
    return this.run("redeem", build, act, { kind: "agent_action", maxEconomicLossUsd: 0, bindings });
  }

  // --- call_contract: total power — interact with ANY contract ---------------

  /**
   * Generic write to any contract: encode a function call, simulate it on-chain,
   * and (when executing) broadcast it. This is her total-power hand — it lets her
   * use any protocol without a bespoke adapter. Simulation is mandatory so she
   * never wastes gas on a call that would revert; there is no allowlist.
   */
  async callContract(to: Address, signature: string, args: unknown[], valueWei: bigint, act: boolean, fee?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<ActionOutcome> {
    const owner = this.owner();
    if (!owner) return { ok: false, primitive: "call_contract", stage: "build", reason: "no wallet configured" };
    let data: `0x${string}`;
    try {
      const fnName = signature.split("(")[0].trim();
      const abi = parseAbi([`function ${signature}`] as unknown as readonly string[]);
      data = encodeFunctionData({ abi, functionName: fnName as never, args: args as never });
    } catch (error) {
      return { ok: false, primitive: "call_contract", stage: "build", reason: `could not encode ${signature}: ${error instanceof Error ? error.message : String(error)}` };
    }
    let preflight: { gas: bigint; gasPriceWei: bigint; blockNumber: bigint };
    try {
      preflight = await this.chain.preflight({ to, data, value: valueWei, account: owner });
    } catch (error) {
      return { ok: false, primitive: "call_contract", stage: "build", reason: `simulation reverted (call would fail on-chain): ${error instanceof Error ? error.message : String(error)}` };
    }
    const detail = { to, call: signature, valueWei: valueWei.toString(), estimatedGas: preflight.gas.toString() };
    if (!act) return { ok: true, mode: "simulated", primitive: "call_contract", detail };
    if (!this.config.EXECUTION_ENABLED) return { ok: false, primitive: "call_contract", stage: "disabled", reason: "execution is disabled; only simulation is available" };
    const guard = await this.preSendGuard(); if (!guard.ok) return { ok: false, primitive: "call_contract", stage: "execute", reason: guard.reason };
    try {
      const portfolio = await this.positions.reconcile(await this.chain.portfolio(await this.db.dailyLossUsd(), true));
      const decisionId = randomUUID();
      const decision: Decision = { action: "ENTER", strategyId: `call:${signature}`, rationale: `Scarlet raw call ${signature} on ${to}`, confidence: 1, riskUsd: 0, expectedNetProfitUsd: 0, capitalUsd: 0, expiresAt: new Date(Date.now() + 300_000).toISOString(), evidence: ["https://docs.berachain.com/build/getting-started/common-resources"], needsResearch: [] };
      await this.db.saveDecision(decisionId, decision, "agent_action", { primitive: "call_contract", signature, args: args.map(String) }, portfolio, { signature, to, args: args.map(String) }, null);
      const gas = preflight.gas * 125n / 100n; // margin against state drift between preflight and inclusion
      // Liquidations pass an explicit EIP-1559 fee (priority fee scaled to profit) to win block inclusion;
      // everything else keeps the legacy gasPrice path (no need to overbid on a wrap/approve).
      const txHash = fee
        ? await this.chain.sendEip1559(to, data, valueWei, gas, fee.maxFeePerGas, fee.maxPriorityFeePerGas)
        : await this.chain.send(to, data, valueWei, gas, preflight.gasPriceWei);
      await this.db.recordExecution({ decisionId, protocolId: `call:${to.toLowerCase()}:${signature}`, txHash, target: to, calldata: data, valueWei, gasLimit: gas, beraUsdAtSubmission: portfolio.beraUsd, status: "submitted" });
      await this.db.updateDecision(decisionId, "submitted", { hash: txHash, call: signature });
      this.logger.warn({ to, signature, txHash }, "Scarlet raw contract call broadcast on mainnet");
      void this.settleDirect(txHash, portfolio); // realized P&L + gas → ledger
      return { ok: true, mode: "executed", primitive: "call_contract", txHash, detail };
    } catch (error) {
      return { ok: false, primitive: "call_contract", stage: "execute", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // --- deploy_contract: Scarlet extends her own body -------------------------

  /** Deploys a contract (creation bytecode) so she can build atomic executors and helpers. */
  async deployContract(bytecode: `0x${string}`, valueWei: bigint, act: boolean): Promise<ActionOutcome> {
    const owner = this.owner();
    if (!owner) return { ok: false, primitive: "deploy_contract", stage: "build", reason: "no wallet configured" };
    let gas: bigint;
    try { gas = await this.chain.primary.estimateGas({ account: owner, data: bytecode, value: valueWei }); }
    catch (error) { return { ok: false, primitive: "deploy_contract", stage: "build", reason: `deployment would fail: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!act) return { ok: true, mode: "simulated", primitive: "deploy_contract", detail: { estimatedGas: gas.toString(), bytecodeLength: (bytecode.length - 2) / 2 } };
    if (!this.config.EXECUTION_ENABLED) return { ok: false, primitive: "deploy_contract", stage: "disabled", reason: "execution is disabled" };
    const guard = await this.preSendGuard(); if (!guard.ok) return { ok: false, primitive: "deploy_contract", stage: "execute", reason: guard.reason };
    try {
      if (!this.chain.wallet) throw new Error("no signer");
      const gasPrice = await this.chain.primary.getGasPrice();
      const hash = await this.chain.wallet.sendTransaction({ data: bytecode, value: valueWei, gas: gas * 12n / 10n, gasPrice });
      const receipt = await this.chain.waitReceipt({ hash, confirmations: 1, timeout: 120_000 });
      await this.ledgerDeployGas(hash, receipt.gasUsed, receipt.effectiveGasPrice, "deploy_contract");
      this.logger.warn({ hash, address: receipt.contractAddress }, "Scarlet deployed a contract on mainnet");
      return { ok: true, mode: "executed", primitive: "deploy_contract", txHash: hash, detail: { deployedAddress: receipt.contractAddress, status: receipt.status } };
    } catch (error) {
      return { ok: false, primitive: "deploy_contract", stage: "execute", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // --- atomic organs: deploy + drive the AtomicExecutor -----------------------

  /** Deploys Scarlet's AtomicExecutor organ (owner = her wallet, morpho bound) once. */
  async deployOrgan(act: boolean): Promise<ActionOutcome> {
    const owner = this.owner();
    if (!owner) return { ok: false, primitive: "deploy_organ", stage: "build", reason: "no wallet configured" };
    const ctor = encodeAbiParameters([{ type: "address" }], [this.morpho]);
    const deployData = (ATOMIC_EXECUTOR_BYTECODE + ctor.slice(2)) as `0x${string}`;
    let gas: bigint;
    try { gas = await this.chain.primary.estimateGas({ account: owner, data: deployData }); }
    catch (error) { return { ok: false, primitive: "deploy_organ", stage: "build", reason: `organ deploy would fail: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!act) return { ok: true, mode: "simulated", primitive: "deploy_organ", detail: { estimatedGas: gas.toString(), note: "deploys your AtomicExecutor (atomic flash-loan strategy engine)" } };
    if (!this.config.EXECUTION_ENABLED) return { ok: false, primitive: "deploy_organ", stage: "disabled", reason: "execution is disabled" };
    const guard = await this.preSendGuard(); if (!guard.ok) return { ok: false, primitive: "deploy_organ", stage: "execute", reason: guard.reason };
    try {
      if (!this.chain.wallet) throw new Error("no signer");
      const gasPrice = await this.chain.primary.getGasPrice();
      const hash = await this.chain.wallet.sendTransaction({ data: deployData, gas: gas * 12n / 10n, gasPrice });
      const receipt = await this.chain.waitReceipt({ hash, confirmations: 1, timeout: 120_000 });
      if (receipt.status !== "success" || !receipt.contractAddress) return { ok: false, primitive: "deploy_organ", stage: "execute", reason: "organ deployment reverted" };
      await this.db.saveOrgan("atomic-executor", receipt.contractAddress, hash);
      await this.ledgerDeployGas(hash, receipt.gasUsed, receipt.effectiveGasPrice, "deploy_organ");
      this.logger.warn({ organ: receipt.contractAddress, hash }, "Scarlet deployed her AtomicExecutor organ");
      return { ok: true, mode: "executed", primitive: "deploy_organ", txHash: hash, detail: { organ: receipt.contractAddress, note: "your atomic organ is live — drive it with flash_liquidate or flash_execute" } };
    } catch (error) {
      return { ok: false, primitive: "deploy_organ", stage: "execute", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Turn-key capital-free liquidation via the organ: flash-loan the loan token,
   * liquidate, swap the seized collateral back to loan token, repay, keep the bonus.
   * The whole thing is simulated first (call_contract path) so it only fires if it
   * actually nets >= minProfit — otherwise it reverts and costs only gas. */
  async flashLiquidate(intent: FlashLiquidationIntent, act: boolean): Promise<ActionOutcome> {
    const { target, signature, args } = this.buildFlashLiquidation(intent);
    // call_contract simulates the full atomic flow (flashloan→liquidate→swap→repay→
    // profit require) and only broadcasts if it passes — self-verifying.
    return this.callContract(target, signature, args, 0n, act);
  }

  /** Encodes the atomic flash-liquidation as a driveable {target,signature,args} for the
   * organ's flashExecute — used both to execute (flashLiquidate) and to ARM an auto-flash
   * watcher, so the manual and automatic paths build the exact same self-verifying tx. */
  buildFlashLiquidation(intent: FlashLiquidationIntent): { target: Address; signature: string; args: unknown[] } {
    const ercAbi = parseAbi(["function approve(address,uint256) returns (bool)"]);
    const liqAbi = parseAbi(["function liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)"]);
    const routerAbi = parseAbi(["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)"]);
    const router = this.config.DEX_ROUTER as Address;
    const marketParams = [intent.loanToken, intent.collateralToken, intent.oracle, intent.irm, BigInt(intent.lltv)];
    // uint256 values are emitted as decimal STRINGS (not bigints) so the whole args tree
    // is JSON-safe for DB persistence when this is armed as a watcher; viem's
    // encodeFunctionData accepts numeric strings for uint (as buildLiquidateArgs relies on).
    // Swap leg: the AGGREGATOR (all venues — Aerodrome/V4/…) if calldata was built for the exact
    // seized amount, else a single Uniswap-V3 pool. The aggregator path is what lets the organ
    // exit collateral that has no V3 pool (the reason V3-only liquidations reverted).
    const swapCalls = intent.swap
      ? [[intent.collateralToken, "0", encodeFunctionData({ abi: ercAbi, functionName: "approve", args: [intent.swap.router, intent.seizedAssets] })],
         [intent.swap.router, "0", intent.swap.calldata]]
      : [[intent.collateralToken, "0", encodeFunctionData({ abi: ercAbi, functionName: "approve", args: [router, intent.seizedAssets] })],
         [router, "0", encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [[intent.collateralToken, intent.loanToken, intent.swapFeeBps, intent.organ, intent.seizedAssets, 0n, 0n] as never] })]];
    const calls = [
      [intent.loanToken, "0", encodeFunctionData({ abi: ercAbi, functionName: "approve", args: [this.morpho, maxUint256] })],
      [this.morpho, "0", encodeFunctionData({ abi: liqAbi, functionName: "liquidate", args: [marketParams as never, intent.borrower, intent.seizedAssets, 0n, "0x"] })],
      ...swapCalls
    ];
    const feSig = "flashExecute(address,uint256,uint256,(address,uint256,bytes)[])";
    return { target: intent.organ, signature: feSig, args: [intent.loanToken, intent.flashAmount.toString(), intent.minProfitWei.toString(), calls] };
  }

  /** Reads a borrower's live Morpho position (debt in loan-token base units + collateral
   * tokens) so the system can size a liquidation without Scarlet guessing amounts. */
  async readMorphoPosition(marketId: `0x${string}`, borrower: Address): Promise<{ borrowAssets: bigint; collateral: bigint }> {
    const morphoAbi = parseAbi([
      "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
      "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)"
    ]);
    const read = (client: typeof this.chain.primary) => Promise.all([
      client.readContract({ address: this.morpho, abi: morphoAbi, functionName: "market", args: [marketId] }),
      client.readContract({ address: this.morpho, abi: morphoAbi, functionName: "position", args: [marketId, borrower] })
    ]);
    // The primary RPC is often rate-limited by the rest of the system; fall back to the secondary
    // so liquidation arming never starves on a shared-RPC hiccup.
    const [m, p] = await read(this.chain.primary).catch(() => read(this.chain.secondary));
    const totalBorrowAssets = m[2]; const totalBorrowShares = m[3];
    const borrowShares = p[1]; const collateral = p[2];
    const borrowAssets = totalBorrowShares === 0n || borrowShares === 0n ? 0n : (borrowShares * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;
    return { borrowAssets, collateral };
  }

  // --- check_token: the parasite's survival gate (anti-rug / honeypot) --------

  /** Real round-trip honeypot probe: eth_call a contract-CREATION that buys the token then sells it via
   * the V3 router, all in one simulated call. A transfer-blocking honeypot (which fools quote-based
   * checks) reverts on the SELL leg. Returns the V3 buy/sell truth. null if the wallet isn't configured. */
  private async honeypotProbe(token: Address): Promise<{ buyable: boolean; sellable: boolean; feeBps?: number; sellTaxPct?: number; reason?: string } | null> {
    const owner = this.owner(); if (!owner) return null;
    const weth = this.config.WBERA_ADDRESS as Address; const router = this.config.DEX_ROUTER as Address;
    const probe = 10n ** 15n; // ~0.001 WETH
    const args = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint24[]" }], [token, weth, router, [100, 500, 2500, 3000, 10000]]);
    const initcode = (HONEYPOT_PROBE_BYTECODE + args.slice(2)) as `0x${string}`;
    try {
      await (this.chain.tools as unknown as { request: (a: unknown) => Promise<unknown> }).request({ method: "eth_call", params: [{ from: owner, data: initcode, value: "0x" + probe.toString(16) }, "latest", { [owner]: { balance: "0x" + (probe + 10n ** 18n).toString(16) } }] });
      return { buyable: true, sellable: false, reason: "probe non ha revertato (inatteso)" };
    } catch (err) {
      const data = extractRevertData(err);
      if (!data || data.length < 10) return { buyable: false, sellable: false, reason: "revert vuoto" };
      if (data.startsWith("0x08c379a0")) { // Error(string)
        let msg = ""; try { msg = decodeAbiParameters([{ type: "string" }], ("0x" + data.slice(10)) as `0x${string}`)[0] as string; } catch { /* keep empty */ }
        if (/NO_BUY_ROUTE/.test(msg)) return { buyable: false, sellable: false, reason: "nessuna rotta V3 di acquisto" };
        return { buyable: true, sellable: false, reason: `vendita reverta: ${msg || "revert"}` };
      }
      if (data.length >= 2 + 192) { // raw abi.encode(bought, back, fee) → constructor SUCCEEDED
        try {
          const [bought, back, fee] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], data as `0x${string}`);
          const sellable = (back as bigint) > 0n;
          const sellTaxPct = sellable ? Math.max(0, Math.round((1 - Number(back as bigint) / Number(probe)) * 100)) : undefined;
          return { buyable: (bought as bigint) > 0n, sellable, feeBps: Number(fee as bigint), sellTaxPct, reason: "round-trip reale" };
        } catch { return { buyable: true, sellable: false, reason: "revert non decodificabile" }; }
      }
      return { buyable: true, sellable: false, reason: "vendita reverta (honeypot?)" };
    }
  }

  /** Safety gate before buying a token. PRIMARY oracle = the cross-venue AGGREGATOR round-trip (buy
   * NATIVE→token, then sell token→NATIVE at the bought size) — this is what execution ACTUALLY does, so it
   * admits every venue (Uniswap V2/V3/V4, Aerodrome, Curve, …) instead of only WETH↔token V3 pools. A V3
   * honeypot PROBE is kept as a cheap veto: if it can buy on V3 but the sell is transfer-BLOCKED, we reject
   * even when the aggregator quote looks sellable (a quote can't see a transfer block). The empirical
   * `sellBlocked` memory is the final backstop for time/transfer honeypots that fool the quote. */
  async checkToken(token: Address): Promise<{ token: string; safe: boolean; canSell: boolean; buyable: boolean; poolFeeBps?: number; reasons: string[] }> {
    const reasons: string[] = [];
    const probe = 10n ** 15n; // ~0.001 ETH
    // 0) EMPIRICAL memory: a token whose REAL sell already reverted is flagged sell-blocked forever.
    const ent = (await this.db.getEntity(this.config.CHAIN_ID, token).catch(() => []))[0];
    if (ent && (ent.meta as { sellBlocked?: boolean } | null)?.sellBlocked) {
      reasons.push("token già risultato INVENDIBILE in una vendita reale (sell-block/honeypot) — rifiutato definitivamente");
      return { token, safe: false, canSell: false, buyable: true, reasons };
    }
    if (!this.aggregator) { reasons.push("aggregatore non disponibile"); return { token, safe: false, canSell: false, buyable: false, reasons }; }
    // 1) Aggregator round-trip = the real executable route. Buy NATIVE→token, then sell the bought amount back.
    const buy = await this.aggQuoteRetry(NATIVE_ETH, token, probe);
    if (buy.status !== "ok" || !buy.quote || buy.quote.amountOut <= 0n) {
      reasons.push(buy.status === "error" ? "quote di acquisto transitorio — riprova (NON è honeypot)" : "nessuna rotta di acquisto su alcun venue");
      return { token, safe: false, canSell: false, buyable: buy.status === "error", reasons };
    }
    const sell = await this.aggQuoteRetry(token, NATIVE_ETH, buy.quote.amountOut);
    const canSell = sell.status === "ok" && !!sell.quote && sell.quote.amountOut > 0n;
    // 2) Transfer-block VETO: if the V3 probe can buy but its sell is transfer-blocked, it's a real honeypot
    //    the aggregator QUOTE can't see. (For non-V3 tokens the probe simply can't buy → no veto, no false reject.)
    const rt = await this.honeypotProbe(token).catch(() => null);
    if (rt && rt.buyable && !rt.sellable && isTransferBlockRevert(rt.reason)) {
      reasons.push(`HONEYPOT: la vendita è bloccata dal trasferimento (${rt.reason}) — NON comprare`);
      return { token, safe: false, canSell: false, buyable: true, reasons };
    }
    if (!canSell) {
      reasons.push(sell.status === "error" ? "quote di vendita transitorio — riprova" : "ACQUISTO ma non VENDITA (aggregatore) — forte segnale HONEYPOT");
      return { token, safe: false, canSell: false, buyable: true, reasons };
    }
    if (rt?.sellTaxPct != null && rt.sellTaxPct > 25) reasons.push(`⚠️ sell-tax ~${rt.sellTaxPct}%`);
    reasons.push("rotta reale cross-venue OK (aggregatore): comprabile e vendibile");
    return { token, safe: true, canSell: true, buyable: true, poolFeeBps: rt?.feeBps, reasons };
  }

  /** Aggregator quote with retry: only a persistent no-route is real; a transient 'error' is retried,
   * so a momentary aggregator/RPC hiccup is not mistaken for "no route / honeypot". */
  private async aggQuoteRetry(inT: Address, outT: Address, amt: bigint): Promise<{ status: "ok" | "no-route" | "error"; quote: { amountOut: bigint; routeSummary: unknown } | null }> {
    if (!this.aggregator) return { status: "error", quote: null };
    for (let i = 0; i < 3; i += 1) {
      const q = await this.aggregator.quoteResult(inT, outT, amt);
      if (q.status !== "error") return q;
      if (i < 2) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
    return { status: "error", quote: null };
  }

  /** Deepest Uniswap-V3 fee tier for a base/token pair — informational only (dossier display). */
  private async bestV3Fee(base: Address, token: Address): Promise<number | undefined> {
    const factory = this.config.DEX_FACTORY as Address;
    const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
    const poolAbi = parseAbi(["function liquidity() view returns (uint128)"]);
    const ZERO = "0x0000000000000000000000000000000000000000";
    let best: number | undefined; let bestLiq = -1n;
    for (const fee of [100, 500, 3000, 10000]) {
      const pool = await this.chain.primary.readContract({ address: factory, abi: factoryAbi, functionName: "getPool", args: [base, token, fee] }).catch(() => ZERO) as Address;
      if (!pool || pool.toLowerCase() === ZERO) continue;
      const liq = await this.chain.primary.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }).catch(() => 0n) as bigint;
      if (liq > bestLiq) { bestLiq = liq; best = fee; }
    }
    return best;
  }

  // --- swap: one-call Uniswap V3 exact-in (auto best-tier + minOut + approve) --

  /** Swaps tokenIn→tokenOut on Uniswap V3 in one call: quotes the best fee tier, sets
   * amountOutMinimum from the quote and slippage, approves the router, and executes.
   * Removes the hand-built-calldata friction that was blocking her snipes/rotations. */
  async swapV3(tokenIn: Address, tokenOut: Address, amountIn: bigint, maxSlippagePct: number, act: boolean): Promise<ActionOutcome> {
    const owner = this.owner();
    if (!owner) return { ok: false, primitive: "swap", stage: "build", reason: "no wallet configured" };
    const factory = this.config.DEX_FACTORY as Address; const quoter = this.config.DEX_QUOTER as Address; const router = this.config.DEX_ROUTER as Address;
    const ZERO = "0x0000000000000000000000000000000000000000";
    const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
    const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]);
    const swapAbi = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
    let bestFee = 0; let bestOut = 0n;
    for (const fee of [100, 500, 2500, 3000, 10000]) {
      const pool = await this.chain.primary.readContract({ address: factory, abi: factoryAbi, functionName: "getPool", args: [tokenIn, tokenOut, fee] }).catch(() => ZERO) as Address;
      if (!pool || pool.toLowerCase() === ZERO) continue;
      try { const r = await this.chain.primary.simulateContract({ address: quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] }); if (r.result[0] > bestOut) { bestOut = r.result[0]; bestFee = fee; } } catch { /* tier not quotable */ }
    }
    if (!bestFee || bestOut === 0n) return { ok: false, primitive: "swap", stage: "build", reason: "no Uniswap V3 pool quotes this pair — route via the 0x aggregator (call_contract) or verify the token" };
    const slipFrac = Math.max(0, Math.min(0.5, maxSlippagePct / 100));
    const minOut = bestOut * BigInt(Math.floor((1 - slipFrac) * 1_000_000)) / 1_000_000n;
    const detail = { tokenIn, tokenOut, feeBps: bestFee, amountIn: amountIn.toString(), expectedOut: bestOut.toString(), minOut: minOut.toString(), note: "best fee tier auto-selected; allowance handled on execute" };
    if (!act) return { ok: true, mode: "simulated", primitive: "swap", detail };
    if (!this.config.EXECUTION_ENABLED) return { ok: false, primitive: "swap", stage: "disabled", reason: "execution is disabled; only simulation is available" };
    const guard = await this.preSendGuard(this.isExitSwap(tokenOut)); if (!guard.ok) return { ok: false, primitive: "swap", stage: "execute", reason: guard.reason };
    try {
      await this.approveDirect(tokenIn, router, amountIn);
      const data = encodeFunctionData({ abi: swapAbi, functionName: "exactInputSingle", args: [{ tokenIn, tokenOut, fee: bestFee, recipient: owner, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
      const pf = await this.chain.preflight({ to: router, data, value: 0n, account: owner });
      const portfolio = await this.positions.reconcile(await this.chain.portfolio(await this.db.dailyLossUsd(), true));
      const decisionId = randomUUID();
      await this.db.saveDecision(decisionId, { action: "ENTER", strategyId: `swap:${tokenIn}->${tokenOut}`, rationale: `Scarlet swap ${amountIn} ${tokenIn} -> ${tokenOut} (fee ${bestFee})`, confidence: 1, riskUsd: 0, expectedNetProfitUsd: 0, capitalUsd: 0, expiresAt: new Date(Date.now() + 300_000).toISOString(), evidence: [], needsResearch: [] }, "agent_action", { primitive: "swap", intent: detail }, portfolio, { primitive: "swap", intent: detail }, null);
      const txHash = await this.chain.send(router, data, 0n, pf.gas * 125n / 100n, pf.gasPriceWei);
      await this.db.recordExecution({ decisionId, protocolId: `swap:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`, txHash, target: router, calldata: data, valueWei: 0n, gasLimit: pf.gas, beraUsdAtSubmission: portfolio.beraUsd, status: "submitted" });
      await this.db.updateDecision(decisionId, "submitted", { hash: txHash });
      this.logger.warn({ tokenIn, tokenOut, feeBps: bestFee, txHash }, "Scarlet swap broadcast on Monad");
      void this.settleDirect(txHash, portfolio); // realized P&L + gas → ledger
      return { ok: true, mode: "executed", primitive: "swap", txHash, detail };
    } catch (error) {
      return { ok: false, primitive: "swap", stage: "execute", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Best-route swap. OWN EXECUTION is primary (db-first convergence): our local single-hop venue-router
   * route (Uniswap V3 / Aerodrome / Uniswap V2, from the DB-mirror quote) is tried first and broadcast by
   * us. The external aggregator is the FALLBACK — reached only when our path fails BEFORE broadcasting (no
   * local route, or a preflight revert we LOG as an anomaly to fix), covering multi-hop / venues we don't
   * yet execute + native-ETH buys. A post-broadcast failure returns stage "execute" and we stop (never a
   * double-broadcast). Kyber calldata is thus only the safety net now, not the default path. */
  async swapBest(tokenIn: Address, tokenOut: Address, amountIn: bigint, maxSlippagePct: number, act: boolean): Promise<ActionOutcome> {
    // OWN EXECUTION first (Phase 3, flag-gated): our best SINGLE-HOP local route via the venue router
    // (Uniswap V3 / Aerodrome / Uniswap V2). We fall through to the external aggregator ONLY when it
    // failed BEFORE broadcasting (stage build/disabled) — a post-broadcast failure returns stage
    // "execute" and we stop, so there is never a double-broadcast.
    if (this.config.LOCAL_EXECUTION_ENABLED) {
      const local = await this.swapViaLocalExec(tokenIn, tokenOut, amountIn, maxSlippagePct, act);
      if (local.ok) return local;
      if (("stage" in local ? local.stage : "build") === "execute") return local;
    }
    const agg = await this.swapViaAggregator(tokenIn, tokenOut, amountIn, maxSlippagePct, act);
    if (agg.ok) return agg;
    const aggReason = "reason" in agg ? agg.reason : "";
    const aggStage = "stage" in agg ? agg.stage : "build";
    // Retry on V3 ONLY when the aggregator failed before broadcasting (build/quote) AND the pair is
    // V3-eligible (no native sentinel — the V3 router handles WETH, not native ETH).
    const safeToRetry = aggStage === "build" && !isNative(tokenIn) && !isNative(tokenOut);
    if (!safeToRetry) return agg;
    const v3 = await this.swapV3(tokenIn, tokenOut, amountIn, maxSlippagePct, act);
    if (v3.ok) return v3;
    return { ok: false, primitive: "swap", stage: "reason" in v3 ? v3.stage : "build", reason: `aggregatore: ${aggReason.slice(0, 50)}; V3: ${"reason" in v3 ? v3.reason : "fallito"}` };
  }

  /** Cross-venue swap via the aggregator: quote → build calldata → approve → send. Same execution
   * accounting (decision + execution record + settle) as swapV3, so P&L/gas still hit the ledger. */
  async swapViaAggregator(tokenIn: Address, tokenOut: Address, amountIn: bigint, maxSlippagePct: number, act: boolean): Promise<ActionOutcome> {
    const owner = this.owner();
    if (!owner) return { ok: false, primitive: "swap", stage: "build", reason: "no wallet configured" };
    if (!this.aggregator) return { ok: false, primitive: "swap", stage: "build", reason: "aggregator unavailable" };
    const q = await this.aggregator.quoteResult(tokenIn, tokenOut, amountIn);
    if (q.status !== "ok" || !q.quote) return { ok: false, primitive: "swap", stage: "build", reason: `aggregator: ${q.status}` };
    const detail = { tokenIn, tokenOut, amountIn: amountIn.toString(), expectedOut: q.quote.amountOut.toString(), via: "aggregator" };
    if (!act) return { ok: true, mode: "simulated", primitive: "swap", detail };
    if (!this.config.EXECUTION_ENABLED) return { ok: false, primitive: "swap", stage: "disabled", reason: "execution is disabled; only simulation is available" };
    const guard = await this.preSendGuard(this.isExitSwap(tokenOut)); if (!guard.ok) return { ok: false, primitive: "swap", stage: "execute", reason: guard.reason };
    const slippageBps = Math.round(Math.max(0.1, Math.min(50, maxSlippagePct)) * 100);
    const built = await this.aggregator.swapCalldata(tokenIn, tokenOut, amountIn, owner, slippageBps);
    if (!built) { this.logger.warn({ tokenIn, tokenOut }, "aggregator swapCalldata build returned null"); return { ok: false, primitive: "swap", stage: "build", reason: "aggregator calldata build failed" }; }
    try {
      // NATIVE-ETH input (buys): the router is paid via msg.value — NO approval, NO transferFrom, NO wrap.
      // This removes the entire buy-side failure class (missing approval / insufficient WETH). ERC20 input
      // (sells): approve the router MAX once (subsequent sells of that token skip it).
      const native = isNative(tokenIn);
      const value = native ? (built.value > 0n ? built.value : amountIn) : 0n;
      if (!native) await this.approveDirect(tokenIn, built.router, amountIn);
      const pf = await this.chain.preflight({ to: built.router, data: built.calldata, value, account: owner });
      const portfolio = await this.positions.reconcile(await this.chain.portfolio(await this.db.dailyLossUsd(), true));
      const decisionId = randomUUID();
      await this.db.saveDecision(decisionId, { action: "ENTER", strategyId: `agg:${tokenIn}->${tokenOut}`, rationale: `aggregator swap ${amountIn} ${tokenIn} -> ${tokenOut}`, confidence: 1, riskUsd: 0, expectedNetProfitUsd: 0, capitalUsd: 0, expiresAt: new Date(Date.now() + 300_000).toISOString(), evidence: [], needsResearch: [] }, "agent_action", { primitive: "swap", intent: detail }, portfolio, { primitive: "swap", intent: detail }, null);
      const txHash = await this.chain.send(built.router, built.calldata, value, pf.gas * 125n / 100n, pf.gasPriceWei);
      await this.db.recordExecution({ decisionId, protocolId: `agg:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`, txHash, target: built.router, calldata: built.calldata, valueWei: value, gasLimit: pf.gas, beraUsdAtSubmission: portfolio.beraUsd, status: "submitted" });
      await this.db.updateDecision(decisionId, "submitted", { hash: txHash });
      this.logger.warn({ tokenIn, tokenOut, router: built.router, txHash }, "Scarlet aggregator swap broadcast");
      void this.settleDirect(txHash, portfolio);
      return { ok: true, mode: "executed", primitive: "swap", txHash, detail };
    } catch (error) {
      this.logger.warn({ tokenIn, tokenOut, err: error instanceof Error ? error.message : String(error) }, "aggregator swap execute failed");
      return { ok: false, primitive: "swap", stage: "execute", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** OWN EXECUTION: broadcast OUR local single-hop route via the venue router (no aggregator calldata).
   * Native ETH is handled by the router's native path (buy = value, no approval; sell = receive ETH).
   * A failure BEFORE broadcast returns stage "build" (swapBest falls back to the aggregator); a failure
   * AT/AFTER broadcast returns stage "execute" (swapBest stops — no double-broadcast). Same execution
   * accounting (decision + execution record + settle) as the other swap paths. */
  async swapViaLocalExec(tokenIn: Address, tokenOut: Address, amountIn: bigint, maxSlippagePct: number, act: boolean): Promise<ActionOutcome> {
    const owner = this.owner();
    if (!owner) return { ok: false, primitive: "swap", stage: "build", reason: "no wallet configured" };
    const router = this.aggregator as unknown as { execPlan?: (tokenIn: Address, tokenOut: Address, amountIn: bigint, recipient: Address, maxSlippagePct: number) => Promise<LocalExecPlan | null> };
    if (typeof router?.execPlan !== "function") return { ok: false, primitive: "swap", stage: "build", reason: "local execution unavailable" };
    const plan = await router.execPlan(tokenIn, tokenOut, amountIn, owner, maxSlippagePct);
    if (!plan) return { ok: false, primitive: "swap", stage: "build", reason: "no local single-hop route" };
    const detail = { tokenIn, tokenOut, amountIn: amountIn.toString(), expectedOut: plan.expectedOut.toString(), minOut: plan.minOut.toString(), venue: plan.venue, via: "local" };
    if (!act) return { ok: true, mode: "simulated", primitive: "swap", detail };
    if (!this.config.EXECUTION_ENABLED) return { ok: false, primitive: "swap", stage: "disabled", reason: "execution is disabled; only simulation is available" };
    const guard = await this.preSendGuard(this.isExitSwap(tokenOut)); if (!guard.ok) return { ok: false, primitive: "swap", stage: "execute", reason: guard.reason };
    // Approve (sells / ERC20 input) + preflight BEFORE broadcasting. Any revert here is PRE-broadcast →
    // stage "build" so swapBest safely falls back to the aggregator (the preflight eth_call is exactly
    // what catches a mis-encode or a too-tight minOut without spending anything).
    let pf: { gas: bigint; gasPriceWei: bigint; blockNumber: bigint };
    try {
      if (!plan.nativeIn) await this.approveDirect(tokenIn, plan.router, amountIn);
      pf = await this.chain.preflight({ to: plan.router, data: plan.calldata, value: plan.value, account: owner });
    } catch (error) {
      // Log WHY we fall back — a local-exec preflight revert is a bug in OUR path to fix, not silent noise.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn({ tokenIn, tokenOut, venue: plan.venue, router: plan.router, pool: plan.poolAddress, reason: reason.slice(0, 300) }, "local exec preflight reverted → aggregator fallback");
      return { ok: false, primitive: "swap", stage: "build", reason: `local preflight: ${reason}` };
    }
    try {
      const portfolio = await this.positions.reconcile(await this.chain.portfolio(await this.db.dailyLossUsd(), true));
      const decisionId = randomUUID();
      await this.db.saveDecision(decisionId, { action: "ENTER", strategyId: `local:${tokenIn}->${tokenOut}`, rationale: `local-router swap ${amountIn} ${tokenIn} -> ${tokenOut} (${plan.venue})`, confidence: 1, riskUsd: 0, expectedNetProfitUsd: 0, capitalUsd: 0, expiresAt: new Date(Date.now() + 300_000).toISOString(), evidence: [], needsResearch: [] }, "agent_action", { primitive: "swap", intent: detail }, portfolio, { primitive: "swap", intent: detail }, null);
      const txHash = await this.chain.send(plan.router, plan.calldata, plan.value, pf.gas * 125n / 100n, pf.gasPriceWei);
      await this.db.recordExecution({ decisionId, protocolId: `local:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`, txHash, target: plan.router, calldata: plan.calldata, valueWei: plan.value, gasLimit: pf.gas, beraUsdAtSubmission: portfolio.beraUsd, status: "submitted" });
      await this.db.updateDecision(decisionId, "submitted", { hash: txHash });
      this.logger.warn({ tokenIn, tokenOut, venue: plan.venue, router: plan.router, txHash }, "Scarlet local-router swap broadcast");
      void this.settleDirect(txHash, portfolio);
      return { ok: true, mode: "executed", primitive: "swap", txHash, detail };
    } catch (error) {
      // Past preflight: a broadcast may or may not have landed → treat as execute (no fallback).
      return { ok: false, primitive: "swap", stage: "execute", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Direct exact approval to a spender (no allowlist), waiting for it to mine. Used by
   * swapV3 so it works for ANY token (a fresh snipe target has no allowlisted spender). */
  private async approveDirect(token: Address, spender: Address, amount: bigint): Promise<void> {
    const owner = this.owner(); if (!owner) throw new Error("no wallet configured");
    // Read the allowance on the EXECUTION lane — the SAME node the approve+swap broadcast through — so
    // there's no cross-node lag with the tx. (fallback as a resilience net; if all fail, assume 0 and
    // approve anyway — a redundant approve is cheap, a skipped one is fatal.)
    let current: bigint | undefined;
    for (const client of [this.chain.exec, this.chain.fallback]) {
      try { current = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }); break; }
      catch { /* down → next lane */ }
    }
    if (current != null && current >= amount) return;
    // Approve MAX so the (token, spender) pair is approved ONCE; every later trade skips this step,
    // removing the per-trade approve→swap race that compounded the rate-limit failures.
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
    const pf = await this.chain.preflight({ to: token, data, value: 0n, account: owner });
    const hash = await this.chain.send(token, data, 0n, pf.gas * 125n / 100n, pf.gasPriceWei);
    // Confirm on the primary lane, falling back to another read lane if it's rate-limited.
    try { await this.chain.waitReceipt({ hash: hash as `0x${string}`, confirmations: 1, timeout: 120_000 }); }
    catch { await this.chain.fallback.waitForTransactionReceipt({ hash: hash as `0x${string}`, confirmations: 1, timeout: 120_000 }); }
    // Belt-and-suspenders confirm on the EXECUTION lane. (The old cross-lane approval-visibility race is
    // GONE now that approve-send, this read, and the swap preflight all ride the SAME execution node —
    // after the receipt above, the allowance is already visible to the swap's preflight.)
    for (let i = 0; i < 8; i++) {
      const seen = await this.chain.exec.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }).catch(() => 0n);
      if (seen >= amount) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    }
  }

  // --- shared build/simulate/execute engine -----------------------------------

  private async run(primitive: string, build: () => Promise<ProposedCall & { amountIn?: bigint }>, act: boolean, opts: ExecOptions): Promise<ActionOutcome> {
    let plan: ProposedCall & { amountIn?: bigint };
    try {
      // Building runs the adapter's on-chain eth_call preflight: a revert here IS
      // the simulation telling her the action would fail on real mainnet state.
      plan = await build();
    } catch (error) {
      return { ok: false, primitive, stage: "build", reason: error instanceof Error ? error.message : String(error) };
    }
    const simulated = { to: plan.to, protocolId: plan.protocolId, valueWei: plan.value.toString(), estimatedGas: plan.preflight.gas.toString(), gasPriceWei: plan.preflight.gasPriceWei.toString(), preflightBlock: plan.preflight.blockNumber.toString(), maxSlippageBps: plan.maxSlippageBps, maxEconomicLossUsd: opts.maxEconomicLossUsd };
    if (!act) return { ok: true, mode: "simulated", primitive, detail: simulated };
    if (!this.config.EXECUTION_ENABLED) return { ok: false, primitive, stage: "disabled", reason: "execution is disabled; only simulation is available" };
    try {
      const txHash = await this.execute(primitive, plan, opts);
      return { ok: true, mode: "executed", primitive, txHash, detail: simulated };
    } catch (error) {
      return { ok: false, primitive, stage: "execute", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async execute(primitive: string, plan: ProposedCall & { amountIn?: bigint }, opts: ExecOptions): Promise<string> {
    const dailyLoss = await this.db.dailyLossUsd();
    const portfolio = await this.positions.reconcile(await this.chain.portfolio(dailyLoss, true));
    const currentBlock = await this.chain.primary.getBlockNumber();
    const decisionId = randomUUID();
    await this.db.saveDecision(decisionId, agentDecision(primitive, plan, opts), "agent_action", { primitive, intent: simulatedIntent(plan, opts) }, portfolio, { primitive, intent: simulatedIntent(plan, opts) }, null);
    const request: ExecutionRequest = {
      decisionId, kind: opts.kind, protocolId: plan.protocolId, to: plan.to, data: plan.data, value: plan.value,
      gas: plan.preflight.gas, gasPriceWei: plan.preflight.gasPriceWei, quoteObservedAt: new Date(), maxSlippageBps: plan.maxSlippageBps,
      expectedNetProfitUsd: opts.expectedNetProfitUsd ?? 0, maxEconomicLossUsd: opts.maxEconomicLossUsd,
      preflightBlock: plan.preflight.blockNumber, deadline: plan.deadline, approval: plan.approval, ...(opts.bindings ?? {})
    };
    const hash = await this.executor.execute(request, portfolio, currentBlock);
    this.logger.warn({ primitive, hash, decisionId }, "Scarlet executed an agent action on mainnet");
    return hash;
  }

  /** Coherent backstop for the DIRECT-path writes (call_contract, swap, deploy) so
   * they share the guarded path's protection: keep the native gas floor, respect the
   * daily loss budget. Not a per-trade profit gate — growth is the goal, this only
   * stops catastrophic states (out of gas / bleeding past the day's budget). */
  /** Ledger settlement for DIRECT-path txs (call_contract, swap, deploy, and thus
   * flash_liquidate/flash_execute) so EVERY action's realized P&L + gas lands in the
   * ledger and the execution row gets its true status/gas — not left "submitted".
   * Mirrors the GuardedExecutor's settle so the dashboard P&L is complete. */
  private async settleDirect(txHash: string, before: PortfolioSnapshot): Promise<void> {
    try {
      const receipt = await this.chain.waitReceipt({ hash: txHash as `0x${string}`, confirmations: 1, timeout: 120_000 });
      await this.db.settleExecution(txHash, { status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPriceWei: receipt.effectiveGasPrice, receipt, beraUsdAtSubmission: before.beraUsd, outcome: { txHash, receiptStatus: receipt.status, gasUsed: receipt.gasUsed.toString(), settledAt: new Date().toISOString() } });
      const after = await this.positions.reconcile(await this.chain.portfolio(await this.db.dailyLossUsd(), true));
      const gasUsd = Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18 * before.beraUsd;
      const navDeltaUsd = after.estimatedNavUsd - before.estimatedNavUsd;
      await this.db.addExecutionCapitalDelta(txHash, navDeltaUsd + gasUsd, { navDeltaUsd, gasUsd, methodology: "direct-path receipt-time NAV delta excluding separately-ledgered gas" });
      await this.db.savePortfolio({ ...after, dailyLossUsd: await this.db.dailyLossUsd() });
    } catch (error) {
      this.logger.error({ err: error, txHash }, "direct-path settle failed");
    }
  }

  /** One-off deploys don't go through the execution row, but their gas is real spend:
   * ledger it directly so the dashboard P&L accounts for every wei Scarlet burns. */
  private async ledgerDeployGas(txHash: string, gasUsed: bigint, effectiveGasPrice: bigint, primitive: string): Promise<void> {
    try {
      const nativeUsd = await this.chain.tokenPrice(this.config.WBERA_ADDRESS).catch(() => 0);
      const gasUsd = Number(gasUsed * effectiveGasPrice) / 1e18 * nativeUsd;
      await this.db.addLedger("gas", -gasUsd, { primitive, gasUsed: gasUsed.toString(), effectiveGasPriceWei: effectiveGasPrice.toString(), nativeUsd }, txHash);
    } catch (error) {
      this.logger.error({ err: error, txHash }, "deploy gas ledgering failed");
    }
  }

  /** A swap whose OUTPUT is the numéraire (native ETH or WETH) is an EXIT — it turns a token back into
   * cash, i.e. reduces risk. Buys (output = a token) are risk-on. */
  private isExitSwap(tokenOut: Address): boolean {
    return isNative(tokenOut) || tokenOut.toLowerCase() === (this.config.WBERA_ADDRESS as string).toLowerCase();
  }

  /** Pre-broadcast risk gate. `isExit` = this send REDUCES risk (selling a position back to native/cash):
   * a loss-limit must stop opening NEW risk but must NEVER trap an open position — an exit always has to be
   * allowed (a token you can't exit is unsellable-by-policy, and a losing bag only gets worse). The gas
   * floor still applies to everything (you need gas to send even the sell). */
  private async preSendGuard(isExit = false): Promise<{ ok: true } | { ok: false; reason: string }> {
    const portfolio = await this.chain.portfolio(await this.db.dailyLossUsd(), true).catch(() => undefined);
    if (!portfolio) return { ok: true }; // never block on a transient read failure
    if (portfolio.bera < this.config.MIN_BERA_RESERVE) return { ok: false, reason: `native gas reserve below floor (${this.config.MIN_BERA_RESERVE}) — keep gas to keep acting` };
    // NO daily/total loss cap here (it froze the agent for a whole day). Exposure — and therefore max loss —
    // is governed by the PER-CATEGORY budgets (launch/bluechip buckets of NAV) enforced at open_position, plus
    // the gas floor above. She organizes her capital within those buckets.
    void isExit; // exits were already exempt from the (removed) cap; the gas floor applies to every send.
    return { ok: true };
  }

  private owner(): Address | undefined { return this.config.WALLET_ADDRESS as Address | undefined; }
}

function simulatedIntent(plan: ProposedCall, opts: ExecOptions): Record<string, unknown> {
  return { protocolId: plan.protocolId, to: plan.to, valueWei: plan.value.toString(), kind: opts.kind, maxEconomicLossUsd: opts.maxEconomicLossUsd };
}

function agentDecision(primitive: string, plan: ProposedCall, opts: ExecOptions): Decision {
  return {
    action: "ENTER", strategyId: `agent:${primitive}`, rationale: `Scarlet agent action ${primitive} -> ${plan.protocolId}`,
    confidence: 1, riskUsd: Math.max(0, opts.maxEconomicLossUsd), expectedNetProfitUsd: opts.expectedNetProfitUsd ?? 0,
    capitalUsd: 0, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    evidence: ["https://docs.berachain.com/build/getting-started/common-resources"], needsResearch: []
  };
}

