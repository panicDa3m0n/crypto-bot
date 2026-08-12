import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, webSocket, type Address, type Hex, type PublicClient, type WebSocketTransport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.js";
import type { NetworkObservation, PortfolioSnapshot } from "./domain.js";

export const berachain = defineChain({
  id: 80094,
  name: "Berachain",
  nativeCurrency: { name: "BERA", symbol: "BERA", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.berachain.com"] } },
  blockExplorers: { default: { name: "Berascan", url: "https://berascan.com" } }
});

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)"
]);

export class BerachainClients {
  readonly primary;
  readonly secondary;
  readonly heads?: PublicClient<WebSocketTransport, typeof berachain>;
  readonly wallet;
  readonly primaryRpc: string;
  readonly secondaryRpc: string;

  constructor(private readonly config: Config) {
    this.primaryRpc = config.PRIMARY_RPC_HTTP_URL;
    this.secondaryRpc = config.SECONDARY_RPC_HTTP_URL;
    this.primary = createPublicClient({ chain: berachain, transport: http(config.PRIMARY_RPC_HTTP_URL, { timeout: 12_000, retryCount: 1 }) });
    this.secondary = createPublicClient({ chain: berachain, transport: http(config.SECONDARY_RPC_HTTP_URL, { timeout: 12_000, retryCount: 1 }) });
    this.heads = config.HEADS_RPC_WS_URL ? createPublicClient({ chain: berachain, transport: webSocket(config.HEADS_RPC_WS_URL, { retryCount: 2, retryDelay: 1_000 }) }) : undefined;
    const account = config.WALLET_PRIVATE_KEY ? privateKeyToAccount(config.WALLET_PRIVATE_KEY as Hex) : undefined;
    if (account && config.WALLET_ADDRESS && account.address.toLowerCase() !== config.WALLET_ADDRESS.toLowerCase()) {
      throw new Error("The configured signer does not match WALLET_ADDRESS");
    }
    this.wallet = account
      ? createWalletClient({ chain: berachain, account, transport: http(config.PRIMARY_RPC_HTTP_URL) })
      : undefined;
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
    const honey = Number(honeyRaw) / 1e18;
    const [beraUsd, honeyUsd] = await Promise.all([
      this.tokenPrice("0x6969696969696969696969696969696969696969"),
      this.tokenPrice(this.config.HONEY_ADDRESS)
    ]);
    return {
      observedAt: new Date().toISOString(), walletAddress: address, bera, wbera, usdcE, honey,
      baseAsset: this.config.BASE_ASSET, baseAssetBalance: this.config.BASE_ASSET === "BERA" ? bera + wbera : usdcE,
      estimatedNavUsd: usdcE + honey * honeyUsd + (bera + wbera) * beraUsd, beraUsd, honeyUsd, dailyLossUsd, lockedUsd: 0, dataHealthy
    };
  }

  async tokenPrice(address: string): Promise<number> {
    const query = { query: `query Price($address: String!) { tokenGetCurrentPrice(chain: BERACHAIN, address: $address) { price updatedAt } }`, variables: { address } };
    const response = await fetch(this.config.BERA_API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(query) });
    if (!response.ok) throw new Error(`Bera API price request failed: ${response.status}`);
    const json = await response.json() as { data?: { tokenGetCurrentPrice?: { price?: number } }; errors?: unknown[] };
    if (json.errors?.length || typeof json.data?.tokenGetCurrentPrice?.price !== "number") throw new Error("Bera API returned no usable token price");
    return json.data.tokenGetCurrentPrice.price;
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
    const [gas, gasPriceWei, blockNumber] = await Promise.all([
      client.estimateGas({ to: request.to, data: request.data, value: request.value, account }),
      client.getGasPrice(),
      client.getBlockNumber(),
      client.call({ to: request.to, data: request.data, value: request.value, account })
    ]);
    return { gas, gasPriceWei, blockNumber };
  }

  async send(to: Address, data: Hex, value: bigint, gas: bigint, gasPriceWei: bigint): Promise<Hex> {
    if (!this.wallet) throw new Error("Wallet signer is unavailable");
    return this.wallet.sendTransaction({ to, data, value, gas, gasPrice: gasPriceWei });
  }
}

function abs(value: bigint): bigint { return value < 0n ? -value : value; }

export { erc20Abi };
