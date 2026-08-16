import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { encodeAbiParameters, encodeFunctionData, maxUint256, parseAbi, parseUnits, type Address } from "viem";
import { ATOMIC_EXECUTOR_BYTECODE } from "./organs.js";

import { Erc4626Adapter, ExactAllowanceAdapter, WberaAdapter, type ProposedCall } from "./adapters.js";
import { erc20Abi, type BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { Decision, ExecutionRequest, PortfolioSnapshot } from "./domain.js";
import type { GuardedExecutor } from "./executor.js";
import type { PositionService } from "./positions.js";

const previewAbi = parseAbi(["function previewDeposit(uint256 assets) view returns (uint256 shares)"]);

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
    private readonly logger: Logger
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
    const current = await this.chain.primary.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    if (current >= amount) return;
    const plan = await this.allowance.prepareIfNeeded(token, owner, spender, amount, spenderCodeHash);
    if (!plan) return;
    const hash = await this.execute("approve_exact", plan, { kind: "agent_action", maxEconomicLossUsd: 0 });
    // The dependent action reads allowance from chain state, so wait for the
    // approval to be mined before proceeding.
    await this.chain.primary.waitForTransactionReceipt({ hash: hash as `0x${string}`, confirmations: 1, timeout: 120_000 });
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
      const receipt = await this.chain.primary.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
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
      const receipt = await this.chain.primary.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
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

  /** Safety gate before buying a token: confirms it has a wrapped-native pool with liquidity
   * and, critically, that it can be SOLD BACK (honeypot detection) via an on-chain quote.
   * Routes the sell simulation through the DEEPEST pool (by liquidity), never the first one
   * found, so a thin/empty pool is not mistaken for a transfer-blocking honeypot. */
  async checkToken(token: Address): Promise<{ token: string; safe: boolean; canSell: boolean; buyable: boolean; poolFeeBps?: number; reasons: string[] }> {
    const reasons: string[] = [];
    const base = this.config.WBERA_ADDRESS as Address; // wrapped native (WMON)
    const factory = this.config.DEX_FACTORY as Address; // Uniswap V3-style factory
    const quoter = this.config.DEX_QUOTER as Address; // QuoterV2
    const ZERO = "0x0000000000000000000000000000000000000000";
    const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
    const poolAbi = parseAbi(["function liquidity() view returns (uint128)"]);
    const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]);
    // Find EVERY fee-tier pool and pick the deepest by in-range liquidity.
    let poolFeeBps: number | undefined; let bestLiq = -1n;
    for (const fee of [100, 500, 3000, 10000]) {
      const pool = await this.chain.primary.readContract({ address: factory, abi: factoryAbi, functionName: "getPool", args: [base, token, fee] }).catch(() => ZERO) as Address;
      if (!pool || pool.toLowerCase() === ZERO) continue;
      const liq = await this.chain.primary.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }).catch(() => 0n) as bigint;
      if (liq > bestLiq) { bestLiq = liq; poolFeeBps = fee; }
    }
    if (poolFeeBps === undefined) { reasons.push("no wrapped-native V3 pool found here — it may only trade on venues we cannot read (Uniswap V4, Kuru CLOB, Curve). Check via the 0x aggregator before buying; do not buy blind."); return { token, safe: false, canSell: false, buyable: false, reasons }; }
    // Simulate a buy (base->token) and, above all, a sell back (token->base) on the DEEPEST pool.
    const probe = 10n * 10n ** 18n; // ~10 wrapped-native, small but above dust
    let buyOut = 0n; let buyable = false; let canSell = false;
    try { const r = await this.chain.primary.simulateContract({ address: quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: base, tokenOut: token, amountIn: probe, fee: poolFeeBps, sqrtPriceLimitX96: 0n }] }); buyOut = r.result[0]; buyable = buyOut > 0n; }
    catch { reasons.push("buy quote failed on the deepest V3 pool — token may not be tradable via this DEX"); }
    if (buyable) {
      try { const r = await this.chain.primary.simulateContract({ address: quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: token, tokenOut: base, amountIn: buyOut, fee: poolFeeBps, sqrtPriceLimitX96: 0n }] }); const back = r.result[0]; canSell = back > 0n; const retention = Number(back) / Number(probe); if (canSell && retention < 0.7) reasons.push(`high round-trip loss (~${((1 - retention) * 100).toFixed(0)}%): likely a heavy sell tax`); }
      catch { reasons.push("SELL quote reverts on the SAME deepest pool where the buy succeeded — strong honeypot signal (buy but not sell). Do not touch."); }
    }
    const safe = buyable && canSell;
    if (safe && reasons.length === 0) reasons.push("has a wrapped-native V3 pool and is sellable in simulation on the deepest pool; still size cautiously");
    return { token, safe, canSell, buyable, poolFeeBps, reasons };
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
    const guard = await this.preSendGuard(); if (!guard.ok) return { ok: false, primitive: "swap", stage: "execute", reason: guard.reason };
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

  /** Direct exact approval to a spender (no allowlist), waiting for it to mine. Used by
   * swapV3 so it works for ANY token (a fresh snipe target has no allowlisted spender). */
  private async approveDirect(token: Address, spender: Address, amount: bigint): Promise<void> {
    const owner = this.owner(); if (!owner) throw new Error("no wallet configured");
    const current = await this.chain.primary.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    if (current >= amount) return;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
    const pf = await this.chain.preflight({ to: token, data, value: 0n, account: owner });
    const hash = await this.chain.send(token, data, 0n, pf.gas * 125n / 100n, pf.gasPriceWei);
    await this.chain.primary.waitForTransactionReceipt({ hash: hash as `0x${string}`, confirmations: 1, timeout: 120_000 });
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
      const receipt = await this.chain.primary.waitForTransactionReceipt({ hash: txHash as `0x${string}`, confirmations: 1, timeout: 120_000 });
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

  private async preSendGuard(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const portfolio = await this.chain.portfolio(await this.db.dailyLossUsd(), true).catch(() => undefined);
    if (!portfolio) return { ok: true }; // never block on a transient read failure
    if (portfolio.bera < this.config.MIN_BERA_RESERVE) return { ok: false, reason: `native gas reserve below floor (${this.config.MIN_BERA_RESERVE}) — keep gas to keep acting` };
    const effLimit = Math.min(this.config.DAILY_LOSS_LIMIT_USD, portfolio.estimatedNavUsd * 0.25);
    if (portfolio.dailyLossUsd >= effLimit) return { ok: false, reason: `daily loss budget $${effLimit.toFixed(2)} reached — pause until tomorrow or reassess` };
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

