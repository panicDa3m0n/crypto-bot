import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, webSocket, type Address, type Hex, type PublicClient, type WebSocketTransport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { NetworkObservation, PortfolioSnapshot } from "./domain.js";

export const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadScan", url: "https://monadscan.com" } }
});

/** Builds the active viem chain from config — a chain switch (e.g. Monad→Base) is env-only. */
function chainFrom(config: Config) {
  return defineChain({
    id: config.CHAIN_ID,
    name: config.CHAIN_NAME,
    nativeCurrency: { name: config.NATIVE_SYMBOL, symbol: config.NATIVE_SYMBOL, decimals: 18 },
    rpcUrls: { default: { http: [config.PRIMARY_RPC_HTTP_URL] } },
    blockExplorers: { default: { name: config.EXPLORER_NAME, url: config.EXPLORER_URL } }
  });
}

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)"
]);

export class BerachainClients {
  readonly primary;
  readonly secondary;
  /** Precision lane: the RPC the oracle / liquidation reads use — deliberately OFF the sensor
   * firehose (primary) so it never starves on shared rate-limits. */
  readonly precision;
  /** The single RPC any lane reroutes to when its reference RPC rate-limits (429) or errors. */
  readonly fallback;
  readonly heads?: PublicClient<WebSocketTransport, ReturnType<typeof chainFrom>>;
  readonly wallet;
  readonly primaryRpc: string;
  readonly secondaryRpc: string;
  readonly precisionRpc: string;
  readonly fallbackRpc: string;
  readonly executionRpc: string;
  private readonly rl = new Map<string, { n: number; at: number }>();
  private readonly priceCache = new Map<string, number>();
  // Concurrency governor for the precision lane: cap in-flight reads so a burst (232 positions ×
  // several pools) can't trip the RPC's rate-limit in the first place. Excess reads queue.
  private readonly PRECISION_CONCURRENCY = 6;
  private readonly PRECISION_MIN_INTERVAL_MS = 70; // pace dispatch starts (~14/s ceiling) under public-RPC limits
  private precisionActive = 0;
  private precisionNextAt = 0;
  private readonly precisionQueue: Array<() => void> = [];
  // Our on-chain price oracle (injected post-construction to avoid a cycle). When set, tokenPrice
  // asks it first — so the WHOLE system reads DEX-exact prices; the off-chain API is the fallback.
  private oracle?: { usdPrice(token: string, atBlock?: bigint): Promise<number | null> };
  setOracle(o: { usdPrice(token: string, atBlock?: bigint): Promise<number | null> }): void { this.oracle = o; }

  constructor(private readonly config: Config, private readonly logger?: Logger) {
    const chain = chainFrom(config);
    this.primaryRpc = config.PRIMARY_RPC_HTTP_URL;
    this.secondaryRpc = config.SECONDARY_RPC_HTTP_URL;
    this.precisionRpc = config.PRECISION_RPC_HTTP_URL ?? config.SECONDARY_RPC_HTTP_URL;
    this.fallbackRpc = config.FALLBACK_RPC_HTTP_URL ?? config.PRIMARY_RPC_HTTP_URL;
    this.executionRpc = config.EXECUTION_RPC_HTTP_URL ?? this.fallbackRpc;
    this.primary = createPublicClient({ chain, transport: http(config.PRIMARY_RPC_HTTP_URL, { timeout: 12_000, retryCount: 1 }) });
    this.secondary = createPublicClient({ chain, transport: http(config.SECONDARY_RPC_HTTP_URL, { timeout: 12_000, retryCount: 1 }) });
    this.precision = createPublicClient({ chain, transport: http(this.precisionRpc, { timeout: 12_000, retryCount: 0, batch: true }) });
    this.fallback = createPublicClient({ chain, transport: http(this.fallbackRpc, { timeout: 12_000, retryCount: 1, batch: true }) });
    this.heads = config.HEADS_RPC_WS_URL ? createPublicClient({ chain, transport: webSocket(config.HEADS_RPC_WS_URL, { retryCount: 2, retryDelay: 1_000 }) }) : undefined;
    const account = config.WALLET_PRIVATE_KEY ? privateKeyToAccount(config.WALLET_PRIVATE_KEY as Hex) : undefined;
    if (account && config.WALLET_ADDRESS && account.address.toLowerCase() !== config.WALLET_ADDRESS.toLowerCase()) {
      throw new Error("The configured signer does not match WALLET_ADDRESS");
    }
    // The signer broadcasts ONLY through the dedicated execution lane — never the read-contended primary.
    this.wallet = account
      ? createWalletClient({ chain, account, transport: http(this.executionRpc, { timeout: 12_000, retryCount: 1 }) })
      : undefined;
    this.logger?.info({ primary: this.primaryRpc, secondary: this.secondaryRpc, precision: this.precisionRpc, fallback: this.fallbackRpc, execution: this.executionRpc, dedicatedExecution: this.executionRpc !== this.primaryRpc }, "RPC lanes");
  }

  /** Rate-limit meter: counts per-lane 429/limit hits and logs (throttled ≤1/30s per lane) so we can
   * SEE which RPC blocks and when — the data to decide where to add a dedicated/paid endpoint. */
  noteRateLimit(lane: string, url: string): void {
    const e = this.rl.get(lane) ?? { n: 0, at: 0 };
    e.n += 1;
    if (Date.now() - e.at > 30_000) { this.logger?.warn({ lane, url, hits: e.n }, "RPC rate-limited"); e.at = Date.now(); }
    this.rl.set(lane, e);
  }

  /**
   * Run a read on the PRECISION lane, governed and self-healing. It (1) waits for a concurrency
   * slot so a burst can't trip the RPC's rate-limit, (2) runs `fn` on the precision client, and
   * (3) on a rate-limit / transient transport error — NOT a revert — reroutes ONCE to the single
   * fallback RPC, logging the reroute. A genuine contract error propagates. `fn` gets the client so
   * the caller can use readContract OR multicall (batched) through the same governed, healing path.
   */
  async precisionRead<T>(fn: (client: typeof this.precision) => Promise<T>, label = "read"): Promise<T> {
    await this.acquirePrecisionSlot();
    try {
      try {
        return await fn(this.precision);
      } catch (err) {
        if (!isTransientOrRateLimit(err)) throw err;
        this.noteRateLimit("precision", this.precisionRpc);
        this.logger?.warn({ label, err: errMsg(err), from: this.precisionRpc, to: this.fallbackRpc }, "precision RPC rate-limited/errored → rerouting to fallback");
        return await fn(this.fallback);
      }
    } finally {
      this.releasePrecisionSlot();
    }
  }

  private async acquirePrecisionSlot(): Promise<void> {
    while (this.precisionActive >= this.PRECISION_CONCURRENCY) await new Promise<void>((resolve) => this.precisionQueue.push(resolve));
    this.precisionActive += 1;
    // Pace dispatch starts so a cold-cache burst can't spike past the RPC's per-second limit.
    const now = Date.now();
    const wait = Math.max(0, this.precisionNextAt - now);
    this.precisionNextAt = Math.max(now, this.precisionNextAt) + this.PRECISION_MIN_INTERVAL_MS;
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
  private releasePrecisionSlot(): void {
    this.precisionActive -= 1;
    const next = this.precisionQueue.shift();
    if (next) next();
  }

  async observe(source: "poll" | "websocket" = "poll"): Promise<NetworkObservation> {
    let [primary, secondary, gas] = await this.readObservationHeads();
    // A three-second block can land between two otherwise healthy HTTP calls.
    // Retry an observed >1-block disagreement once, after a very short delay;
    // persistent disagreement remains unhealthy and still fail-closes writes.
    if (primary.status === "fulfilled" && secondary.status === "fulfilled" && abs(primary.value - secondary.value) > 1n) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      [primary, secondary, gas] = await this.readObservationHeads();
    }
    const primaryBlock = primary.status === "fulfilled" ? primary.value : 0n;
    const secondaryBlock = secondary.status === "fulfilled" ? secondary.value : 0n;
    const gasPriceWei = gas.status === "fulfilled" ? gas.value : 0n;
    return {
      observedAt: new Date(), primaryBlock, secondaryBlock,
      blockGap: primaryBlock >= secondaryBlock ? primaryBlock - secondaryBlock : secondaryBlock - primaryBlock,
      gasPriceWei,
      primaryHealthy: primary.status === "fulfilled" && primaryBlock > 0n,
      secondaryHealthy: secondary.status === "fulfilled" && secondaryBlock > 0n,
      primaryRpc: this.primaryRpc,
      secondaryRpc: this.secondaryRpc,
      source
    };
  }

  private readObservationHeads() {
    return Promise.allSettled([
      this.primary.getBlockNumber(), this.secondary.getBlockNumber(), this.primary.getGasPrice()
    ]);
  }

  /** Uses subscriptions only as a trigger; dual HTTP RPC reads remain the source of truth. */
  watchHeads(onBlock: (blockNumber: bigint) => void, onError: (error: Error) => void): (() => void) | undefined {
    if (!this.heads) return undefined;
    // `heads` is constructed exclusively with `webSocket()`. Viem's public-client
    // decoration widens the method type, so narrow this call back to the WS branch.
    const watch = this.heads.watchBlockNumber as unknown as (args: { poll: false; onBlockNumber: (blockNumber: bigint) => void; onError: (error: Error) => void }) => () => void;
    return watch({ poll: false, onBlockNumber: onBlock, onError });
  }

  async portfolio(dailyLossUsd: number, dataHealthy: boolean): Promise<PortfolioSnapshot> {
    if (!this.config.WALLET_ADDRESS) {
      return { observedAt: new Date().toISOString(), bera: 0, wbera: 0, usdcE: 0, honey: 0, baseAsset: this.config.BASE_ASSET, baseAssetBalance: 0, estimatedNavUsd: 0, beraUsd: 0, honeyUsd: 0, dailyLossUsd, lockedUsd: 0, dataHealthy };
    }
    const address = this.config.WALLET_ADDRESS as Address;
    const [beraRaw, wberaRaw, usdcRaw, honeyRaw] = await Promise.all([
      this.primary.getBalance({ address }),
      this.primary.readContract({ address: this.config.WBERA_ADDRESS as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      this.primary.readContract({ address: this.config.USDC_E_ADDRESS as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      this.primary.readContract({ address: this.config.HONEY_ADDRESS as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] })
    ]);
    const bera = Number(beraRaw) / 1e18;
    const wbera = Number(wberaRaw) / 1e18;
    const usdcE = Number(usdcRaw) / 1e6;
    const honey = Number(honeyRaw) / 10 ** this.config.HONEY_DECIMALS;
    // Native (MON) is priced via its wrapped token; the reserve stable via its own address.
    const [beraUsd, honeyUsd] = await Promise.all([
      this.tokenPrice(this.config.WBERA_ADDRESS),
      this.tokenPrice(this.config.HONEY_ADDRESS)
    ]);
    return {
      observedAt: new Date().toISOString(), walletAddress: address, bera, wbera, usdcE, honey,
      baseAsset: this.config.BASE_ASSET, baseAssetBalance: this.config.BASE_ASSET === "BERA" ? bera + wbera : usdcE,
      estimatedNavUsd: usdcE + honey * honeyUsd + (bera + wbera) * beraUsd, beraUsd, honeyUsd, dailyLossUsd, lockedUsd: 0, dataHealthy
    };
  }

  async tokenPrice(address: string): Promise<number> {
    const key = address.toLowerCase();
    // Prefer our on-chain oracle (DEX-exact, TTL-cached). Fall back to the off-chain API below.
    if (this.oracle) {
      const p = await this.oracle.usdPrice(address).catch(() => null);
      if (p != null && p > 0) { this.priceCache.set(key, p); return p; }
    }
    // The Bera price API rate-limits (429) under boot contention. A transient
    // failure must degrade to the last known price — not abort the whole
    // activation and leave Scarlet blind for a cycle. One quick retry, then the
    // cache; only throw if we have never seen a price for this token.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const price = await this.fetchTokenPrice(address);
        this.priceCache.set(key, price);
        return price;
      } catch (err) {
        lastErr = err;
      }
    }
    const cached = this.priceCache.get(key);
    if (typeof cached === "number") return cached;
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async fetchTokenPrice(address: string): Promise<number> {
    // Keyless DefiLlama coins API: /prices/current/<slug>:<address> -> { coins: { "<slug>:<addr>": { price } } }
    const id = `${this.config.PRICE_CHAIN_SLUG}:${address}`;
    const response = await fetch(`${this.config.PRICE_API_URL}/prices/current/${id}`, { headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`price API request failed: ${response.status}`);
    const json = await response.json() as { coins?: Record<string, { price?: number }> };
    const price = json.coins?.[id]?.price ?? json.coins?.[id.toLowerCase()]?.price;
    if (typeof price !== "number") throw new Error("price API returned no usable token price");
    return price;
  }

  /** Returns a bytecode hash only when both independent RPC sources agree. */
  async verifiedCodeHash(address: Address): Promise<Hex> {
    const [primaryCode, secondaryCode] = await Promise.all([
      this.primary.getCode({ address }), this.secondary.getCode({ address })
    ]);
    if (!primaryCode || primaryCode === "0x" || !secondaryCode || secondaryCode === "0x") throw new Error("contract bytecode is missing from at least one RPC");
    const primaryHash = keccak256(primaryCode);
    const secondaryHash = keccak256(secondaryCode);
    if (primaryHash !== secondaryHash) throw new Error("contract bytecode differs between independent RPC sources");
    return primaryHash;
  }

  async preflight(request: { to: Address; data: Hex; value: bigint; account?: Address }): Promise<{ gas: bigint; gasPriceWei: bigint; blockNumber: bigint }> {
    return this.preflightWith(this.primary, request);
  }

  async preflightSecondary(request: { to: Address; data: Hex; value: bigint; account?: Address }): Promise<{ gas: bigint; gasPriceWei: bigint; blockNumber: bigint }> {
    return this.preflightWith(this.secondary, request);
  }

  private async preflightWith(client: typeof this.primary, request: { to: Address; data: Hex; value: bigint; account?: Address }): Promise<{ gas: bigint; gasPriceWei: bigint; blockNumber: bigint }> {
    const account = request.account ?? this.config.WALLET_ADDRESS as Address | undefined;
    const run = () => Promise.all([
      client.estimateGas({ to: request.to, data: request.data, value: request.value, account }),
      client.getGasPrice(),
      client.getBlockNumber(),
      client.call({ to: request.to, data: request.data, value: request.value, account })
    ]);
    // Monad's public RPC intermittently returns a spurious -32603 "internal error"
    // on eth_call/estimateGas. That is transient, not a revert — retry it so a valid
    // action is not falsely rejected. A genuine revert is deterministic: never retry it.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [gas, gasPriceWei, blockNumber] = await run();
        return { gas, gasPriceWei, blockNumber };
      } catch (err) {
        lastErr = err;
        if (isRevert(err)) throw err;
        await new Promise<void>((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async send(to: Address, data: Hex, value: bigint, gas: bigint, gasPriceWei: bigint): Promise<Hex> {
    if (!this.wallet) throw new Error("Wallet signer is unavailable");
    try { return await this.wallet.sendTransaction({ to, data, value, gas, gasPrice: gasPriceWei }); }
    catch (err) { if (isTransientOrRateLimit(err)) this.noteRateLimit("execution", this.executionRpc); throw err; }
  }

  /** Current base fee per gas (EIP-1559) from the latest block. 0n if unavailable (pre-1559 / RPC gap). */
  async baseFee(): Promise<bigint> {
    const block = await this.primary.getBlock({ blockTag: "latest" });
    return block.baseFeePerGas ?? 0n;
  }

  /** EIP-1559 send with an EXPLICIT priority fee — used by the liquidation fire path to bid competitively
   * for block inclusion. `maxFeePerGas` must already include base-fee headroom + the priority tip. */
  async sendEip1559(to: Address, data: Hex, value: bigint, gas: bigint, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): Promise<Hex> {
    if (!this.wallet) throw new Error("Wallet signer is unavailable");
    try { return await this.wallet.sendTransaction({ to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas }); }
    catch (err) { if (isTransientOrRateLimit(err)) this.noteRateLimit("execution", this.executionRpc); throw err; }
  }
}

function abs(value: bigint): bigint { return value < 0n ? -value : value; }

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

/** True for a rate-limit or transient transport error (safe to reroute to fallback); false for a
 * genuine contract revert or a malformed request (rerouting would just fail identically). */
function isTransientOrRateLimit(err: unknown): boolean {
  const m = errMsg(err).toLowerCase();
  if (m.includes("revert") || m.includes("execution reverted")) return false;
  return m.includes("429") || m.includes("rate limit") || m.includes("too many requests")
    || m.includes("timeout") || m.includes("timed out") || m.includes("fetch failed") || m.includes("network")
    || m.includes("internal error") || m.includes("-32603") || m.includes("502") || m.includes("503") || m.includes("504")
    || m.includes("econnreset") || m.includes("socket");
}

/** A genuine on-chain revert is deterministic and must NOT be retried; a transient
 * RPC/internal/network error is safe to retry. */
function isRevert(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("internal error") || msg.includes("-32603") || msg.includes("timeout") || msg.includes("fetch failed") || msg.includes("network")) return false;
  return msg.includes("revert") || msg.includes("execution reverted") || msg.includes("insufficient") || msg.includes("out of gas");
}

export { erc20Abi };
