import { BalancerApi, Slippage, Swap, SwapKind, Token, TokenAmount, type ExactInQueryOutput } from "@berachain-foundation/berancer-sdk";
import { keccak256, parseAbi, parseUnits, type Address } from "viem";
import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database, ProtocolVerification } from "./db.js";
import type { ProposedCall } from "./adapters.js";

export const WBERA = "0x6969696969696969696969696969696969696969" as Address;
export const BEX_VAULT = "0x4Be03f781C497A489E3cB0287833452cA9B9E80B" as Address;
const vaultAbi = parseAbi(["function getPausedState() view returns (bool paused, uint256 pauseWindowEndTime, uint256 bufferPeriodEndTime)"]);

export type BexExactInPlan = ProposedCall & {
  amountIn: bigint;
  expectedAmountOut: bigint;
  tokenIn: Address;
  tokenOut: Address;
  routePools: string[];
};

export type BexQuote = {
  blockNumber: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  routePools: string[];
  callTarget: string;
  calldataLength: number;
  value: string;
};

/** Produces a fresh BEX SOR swap plan; execution still requires a separate protocol gate and allowance decision. */
export class BexAdapter {
  constructor(private readonly config: Config, private readonly chain: BerachainClients) {}

  async pausedState(): Promise<{ checked: boolean; paused: boolean; error?: string }> {
    try {
      const [paused] = await this.chain.secondary.readContract({ address: BEX_VAULT, abi: vaultAbi, functionName: "getPausedState" });
      return { checked: true, paused };
    } catch (error) {
      return { checked: false, paused: true, error: error instanceof Error ? error.message : "BEX pause state unavailable" };
    }
  }

  async prepareExactIn(input: { tokenIn: Address; tokenInDecimals: number; tokenOut: Address; tokenOutDecimals: number; amountIn: bigint; sender: Address; recipient: Address; maxSlippagePercent?: `${number}` }): Promise<BexExactInPlan> {
    if (input.amountIn <= 0n) throw new Error("BEX input amount must be positive");
    const paused = await this.pausedState();
    if (!paused.checked || paused.paused) throw new Error("BEX is paused or its pause status cannot be verified");
    const api = new BalancerApi(this.config.BERA_API_URL, 80094);
    const tokenIn = new Token(80094, input.tokenIn, input.tokenInDecimals);
    const tokenOut = new Token(80094, input.tokenOut, input.tokenOutDecimals);
    const { paths } = await api.sorSwapPaths.fetchSorSwapPaths({ chainId: 80094, tokenIn: tokenIn.address, tokenOut: tokenOut.address, swapKind: SwapKind.GivenIn, swapAmount: TokenAmount.fromRawAmount(tokenIn, input.amountIn) });
    if (!paths.length) throw new Error("BEX SOR found no route");
    const swap = new Swap({ chainId: 80094, paths, swapKind: SwapKind.GivenIn, userData: "0x" });
    const blockNumber = await this.chain.secondary.getBlockNumber();
    const query = await swap.query(this.config.SECONDARY_RPC_HTTP_URL, blockNumber) as ExactInQueryOutput;
    const call = swap.buildCall({
      slippage: Slippage.fromPercentage(input.maxSlippagePercent ?? "0.5"),
      deadline: BigInt(Math.floor(Date.now() / 1_000) + 60), queryOutput: query,
      sender: input.sender, recipient: input.recipient, wethIsEth: false
    });
    if (call.to.toLowerCase() !== BEX_VAULT.toLowerCase()) throw new Error("BEX SDK returned an unexpected call target");
    const preflight = await this.chain.preflight({ to: call.to as Address, data: call.callData, value: call.value, account: input.sender });
    return {
      protocolId: `bex:${input.tokenIn.toLowerCase()}:${input.tokenOut.toLowerCase()}`,
      to: call.to as Address, data: call.callData, value: call.value, preflight,
      deadline: new Date(Date.now() + 60_000), maxSlippageBps: Math.ceil(Number(input.maxSlippagePercent ?? "0.5") * 100),
      amountIn: query.amountIn.amount, expectedAmountOut: query.expectedAmountOut.amount,
      tokenIn: input.tokenIn, tokenOut: input.tokenOut, routePools: paths.flatMap((path) => path.pools)
    };
  }
}

export class BexQuoteScanner {
  private timer?: NodeJS.Timeout;
  private current?: { observedAt: string; paused: { checked: boolean; paused: boolean; error?: string }; verification: ProtocolVerification; quotes: Array<BexQuote | { error: string }> };
  private previousPaused?: boolean;
  private readonly pauseListeners = new Set<(paused: boolean) => void>();
  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly logger: Logger) {}
  get latest() { return this.current; }
  onPauseChange(listener: (paused: boolean) => void): () => void { this.pauseListeners.add(listener); return () => this.pauseListeners.delete(listener); }

  async scan(): Promise<void> {
    const [paused, quotes, verification] = await Promise.all([this.pausedState(), Promise.allSettled([
      this.quote(WBERA, 18, this.config.HONEY_ADDRESS, 18, "0.01"),
      this.quote(this.config.HONEY_ADDRESS, 18, this.config.USDC_E_ADDRESS, 6, "0.01"),
      this.quote(WBERA, 18, this.config.USDC_E_ADDRESS, 6, "0.01")
    ]), this.verifyVault()]);
    const snapshot = { observedAt: new Date().toISOString(), paused, verification, quotes: quotes.map((item) => item.status === "fulfilled" ? item.value : { error: item.reason instanceof Error ? item.reason.message : "quote failed" }) };
    await this.db.saveMarketSnapshot("bex-sor", "executable-quotes", snapshot);
    this.current = snapshot;
    if (this.previousPaused !== undefined && this.previousPaused !== paused.paused) for (const listener of this.pauseListeners) listener(paused.paused);
    this.previousPaused = paused.paused;
    this.logger.info({ paused, verification: verification.status, quoteCount: snapshot.quotes.filter((quote) => !("error" in quote)).length }, "BEX mainnet quotes saved");
  }

  start(intervalMs = 60_000): void {
    void this.scan().catch((error) => this.logger.error({ err: error }, "initial BEX quote scan failed"));
    this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "BEX quote scan failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async pausedState() {
    return new BexAdapter(this.config, this.chain).pausedState();
  }

  private async verifyVault(): Promise<ProtocolVerification> {
    const verifiedAt = new Date();
    try {
      const [blockNumber, primaryCode, secondaryCode, paused] = await Promise.all([
        this.chain.secondary.getBlockNumber(), this.chain.primary.getCode({ address: BEX_VAULT }), this.chain.secondary.getCode({ address: BEX_VAULT }), this.pausedState()
      ]);
      if (!primaryCode || primaryCode === "0x" || !secondaryCode || secondaryCode === "0x") throw new Error("BEX Vault bytecode missing from at least one RPC");
      const primaryHash = keccak256(primaryCode);
      const secondaryHash = keccak256(secondaryCode);
      if (primaryHash !== secondaryHash) throw new Error("BEX Vault bytecode differs between RPC sources");
      if (!paused.checked) throw new Error("BEX pause state cannot be verified");
      const result: ProtocolVerification = { protocol: "bex", address: BEX_VAULT, verifiedAt, blockNumber, codeHash: primaryHash, status: "verified", details: { paused: paused.paused, primaryCodeBytes: (primaryCode.length - 2) / 2, secondaryCodeBytes: (secondaryCode.length - 2) / 2 } };
      await this.db.saveProtocolVerification(result);
      return result;
    } catch (error) {
      const result: ProtocolVerification = { protocol: "bex", address: BEX_VAULT, verifiedAt, blockNumber: 0n, codeHash: "0x", status: "rejected", details: { error: error instanceof Error ? error.message : "BEX Vault verification failed" } };
      await this.db.saveProtocolVerification(result);
      return result;
    }
  }

  private async quote(tokenInAddress: string, tokenInDecimals: number, tokenOutAddress: string, tokenOutDecimals: number, amount: `${number}`): Promise<BexQuote> {
    return this.quoteExactIn({ tokenInAddress, tokenInDecimals, tokenOutAddress, tokenOutDecimals, amountIn: parseUnits(amount, tokenInDecimals) });
  }

  /** Mainnet SOR query only: no signer, no preflight and no transaction side effect. */
  async quoteExactIn(input: { tokenInAddress: string; tokenInDecimals: number; tokenOutAddress: string; tokenOutDecimals: number; amountIn: bigint; blockNumber?: bigint }): Promise<BexQuote> {
    const api = new BalancerApi(this.config.BERA_API_URL, 80094);
    const tokenIn = new Token(80094, input.tokenInAddress as `0x${string}`, input.tokenInDecimals);
    const tokenOut = new Token(80094, input.tokenOutAddress as `0x${string}`, input.tokenOutDecimals);
    const { paths } = await api.sorSwapPaths.fetchSorSwapPaths({ chainId: 80094, tokenIn: tokenIn.address, tokenOut: tokenOut.address, swapKind: SwapKind.GivenIn, swapAmount: TokenAmount.fromRawAmount(tokenIn, input.amountIn) });
    if (!paths.length) throw new Error("no BEX SOR path");
    const swap = new Swap({ chainId: 80094, paths, swapKind: SwapKind.GivenIn, userData: "0x" });
    const blockNumber = input.blockNumber ?? await this.chain.secondary.getBlockNumber();
    const query = await swap.query(this.config.SECONDARY_RPC_HTTP_URL, blockNumber) as ExactInQueryOutput;
    const output = query.expectedAmountOut.amount;
    const account = (this.config.WALLET_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
    const call = swap.buildCall({ slippage: Slippage.fromPercentage("1"), deadline: BigInt(Math.floor(Date.now() / 1_000) + 60), queryOutput: query, sender: account, recipient: account, wethIsEth: false });
    return { blockNumber: blockNumber.toString(), tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn: query.amountIn.amount.toString(), amountOut: output.toString(), routePools: paths.flatMap((path) => path.pools), callTarget: call.to, calldataLength: call.callData.length, value: call.value.toString() };
  }
}
