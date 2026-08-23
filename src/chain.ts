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
/** Strip provider credentials from an RPC URL before it is logged. Several providers carry the API key in
 * the PATH (…/v1/<key>), so logging the lane verbatim leaks it into every log file and into the dashboard's
 * problem feed. Keep the host (the useful part) and mask the secret. */
export function redactRpc(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const masked = u.pathname.split("/").map((seg) => (seg.length >= 24 && /^[A-Za-z0-9_-]+$/.test(seg) ? "<key>" : seg)).join("/");
    return `${u.protocol}//${u.host}${masked}${u.search ? "?<redacted>" : ""}`;
  } catch { return url.replace(/[A-Za-z0-9_-]{24,}/g, "<key>"); }
}

function chainFrom(config: Config) {
  return defineChain({
    id: config.CHAIN_ID,
    name: config.CHAIN_NAME,
    nativeCurrency: { name: config.NATIVE_SYMBOL, symbol: config.NATIVE_SYMBOL, decimals: 18 },
    rpcUrls: { default: { http: [config.PRIMARY_RPC_HTTP_URL] } },
    blockExplorers: { default: { name: config.EXPLORER_NAME, url: config.EXPLORER_URL } }
  });
}

/** Multicall3 — same address on every chain we run on. `getBlockNumber` is the POSITIVE CONTROL: a call that
 * cannot revert, so a failure to answer it is proof about the LANE and never about the contracts being read. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const MULTICALL3_PROBE_ABI = parseAbi(["function getBlockNumber() view returns (uint256)"]);

/** Any of our read lanes, seen only through the two calls a batched read needs. */
type ReadClient = Pick<PublicClient, "multicall" | "readContract">;

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)"
]);

export class BerachainClients {
  readonly primary;
  readonly indexer;    // dedicated block-indexer lane (never the shared read pool)
  readonly enrichment; // dedicated enrichment lane (bursty metadata reads; isolated so it never blocks the indexer)
  readonly tools;      // Scarlet's tool reads (probe/balance/allowance); aligned with the indexer lane by default
  readonly secondary;
  /** Precision lane: the RPC the oracle / liquidation reads use — deliberately OFF the sensor
   * firehose (primary) so it never starves on shared rate-limits. */
  readonly precision;
  /** The single RPC any lane reroutes to when its reference RPC rate-limits (429) or errors. */
  readonly fallback;
  readonly heads?: PublicClient<WebSocketTransport, ReturnType<typeof chainFrom>>;
  readonly wallet;
  /** EXECUTION read lane — a PUBLIC client on the SAME RPC the signer broadcasts through. The WHOLE tx
   * lifecycle rides one node: preflight (simulate) + baseFee + receipt wait all read here, so the send
   * sees exactly the state the preflight simulated (no cross-node lag, no approval-visibility race), on
   * the reliable MEV-protected endpoint. Only `preflightSecondary` deliberately uses a DIFFERENT node. */
  readonly exec;
  readonly primaryRpc: string;
  readonly indexerRpc: string;
  readonly enrichmentRpc: string;
  readonly toolsRpc: string;
  readonly secondaryRpc: string;
  readonly precisionRpc: string;
  readonly fallbackRpc: string;
  readonly executionRpc: string;
  private readonly rl = new Map<string, { n: number; at: number }>();
  private readonly priceCache = new Map<string, number>();
  private readonly balCache = new Map<string, bigint>(); // last-known base-asset balances → portfolio never throws on a flaky read
  // Concurrency governor for the precision lane: cap in-flight reads so a burst (232 positions ×
  // several pools) can't trip the RPC's rate-limit in the first place. Excess reads queue.
  private readonly PRECISION_CONCURRENCY = 6;
  private readonly PRECISION_MIN_INTERVAL_MS = 70; // pace dispatch starts (~14/s ceiling) under public-RPC limits
  /** Widest multicall a lane has been PROVEN to answer, learned by bisection the first time one caps out. */
  private readonly bulkWidth = new Map<string, number>();
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
    this.indexerRpc = config.INDEXER_RPC_HTTP_URL;
    this.enrichmentRpc = config.ENRICHMENT_RPC_HTTP_URL;
    // Tools default to the BULK lane, never the indexer's. The indexer is the urgent, per-block component and
    // sharing its endpoint with on-demand tool reads is the exact contention this lane split exists to prevent;
    // defaulting to it meant the separation was opt-in, and therefore usually absent.
    this.toolsRpc = config.TOOLS_RPC_HTTP_URL ?? this.primaryRpc;
    this.primary = createPublicClient({ chain, transport: http(config.PRIMARY_RPC_HTTP_URL, { timeout: 12_000, retryCount: 1 }) });
    // Dedicated indexer lane — ONLY the block-indexer uses this client, so its getLogs/metadata reads never
    // contend with the shared read pool (and vice-versa). retryCount handles transient blips without skipping a block.
    this.indexer = createPublicClient({ chain, transport: http(this.indexerRpc, { timeout: 12_000, retryCount: 2 }) });
    // Dedicated enrichment lane (bursty) + Scarlet-tools lane (aligned with indexer unless overridden).
    this.enrichment = createPublicClient({ chain, transport: http(this.enrichmentRpc, { timeout: 12_000, retryCount: 1 }) });
    this.tools = this.toolsRpc === this.primaryRpc ? this.primary : createPublicClient({ chain, transport: http(this.toolsRpc, { timeout: 12_000, retryCount: 1 }) });
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
    // Public read client on the EXECUTION RPC — the tx lifecycle (preflight/baseFee/receipt) reads here.
    this.exec = createPublicClient({ chain, transport: http(this.executionRpc, { timeout: 12_000, retryCount: 1 }) });
    // TRACEABILITY: one authoritative line mapping every purpose → its endpoint, so we always know which
    // RPC is used for what (and can swap any via env). Grep "RPC lanes" to audit.
    this.logger?.info({ indexer: redactRpc(this.indexerRpc), enrichment: redactRpc(this.enrichmentRpc), tools: redactRpc(this.toolsRpc), execution: redactRpc(this.executionRpc), primary: redactRpc(this.primaryRpc), secondary: redactRpc(this.secondaryRpc), precision: redactRpc(this.precisionRpc), fallback: redactRpc(this.fallbackRpc), dedicatedExecution: this.executionRpc !== this.primaryRpc, dedicatedIndexer: this.indexerRpc !== this.primaryRpc, toolsSharingIndexerLane: this.toolsRpc === this.indexerRpc }, "RPC lanes");
  }

  /** Log an RPC lane failure AT THE MOMENT it happens (rule: no status polling — surface KO on error).
   * `lane` is the purpose (indexer/enrichment/tools/execution), so offline phases are visible in logs. */
  laneError(lane: string, err: unknown): void {
    const endpoint = lane === "indexer" ? this.indexerRpc : lane === "enrichment" ? this.enrichmentRpc : lane === "tools" ? this.toolsRpc : lane === "execution" ? this.executionRpc : this.primaryRpc;
    this.logger?.warn({ lane, endpoint, err: err instanceof Error ? err.message : String(err) }, "RPC lane KO");
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

  /**
   * BATCHED READS, governed and self-diagnosing — the one way the system reads many contracts at once.
   *
   * `multicall({ allowFailure: true })` has a defect that costs money: it converts a TRANSPORT failure into
   * N per-call `status: "failure"` entries and returns normally. Nothing throws, so `precisionRead`'s reroute
   * never fires and the caller reads "these N contracts have no answer" when the truth is "we could not ask".
   * That is not hypothetical: the precision lane silently caps out above ~8 calls per multicall, so the
   * liquidation monitor's 14-oracle read returned 0/14 on EVERY tick and the monitor sat blind for hours
   * while positions it was already tracking were liquidated by someone else.
   *
   * So this never assumes. When a whole chunk comes back empty, it asks which of the two worlds it is in:
   *   • more than one call in the chunk → BISECT. A provider width cap makes the halves succeed; genuine
   *     reverts fail at every width. The answer costs one extra round trip and is conclusive.
   *   • a single call still failing → POSITIVE CONTROL (`Multicall3.getBlockNumber()`, which cannot revert).
   *     It answers ⇒ the lane is alive and the failure is the contract's real verdict. It doesn't ⇒ the lane
   *     is at fault, we reroute to the fallback, and no contract is judged.
   *
   * The proven width is remembered per lane, so a capped provider costs the probe once and not per tick.
   * `laneFailed` is the caller's signal that the read never happened — it must never be read as "no data".
   */
  async bulkRead(
    contracts: readonly unknown[],
    opts: { label?: string; blockNumber?: bigint; client?: ReadClient } = {}
  ): Promise<{ results: Array<{ status: string; result?: unknown }>; laneFailed: boolean }> {
    const label = opts.label ?? "bulk";
    if (!contracts.length) return { results: [], laneFailed: false };
    await this.acquirePrecisionSlot();
    try {
      const client: ReadClient = opts.client ?? (this.precision as ReadClient);
      const laneUrl = client === (this.precision as ReadClient) ? this.precisionRpc : client === (this.primary as ReadClient) ? this.primaryRpc : this.fallbackRpc;
      const results = new Array<{ status: string; result?: unknown }>(contracts.length);
      let laneFailed = false;

      // Read one slice, returning null when the lane — not the contracts — is what failed.
      const readSlice = async (c: ReadClient, slice: readonly unknown[]): Promise<Array<{ status: string; result?: unknown }> | null> => {
        try {
          return await c.multicall({ contracts: slice as never, allowFailure: true, multicallAddress: MULTICALL3_ADDRESS, ...(opts.blockNumber != null ? { blockNumber: opts.blockNumber } : {}) }) as Array<{ status: string; result?: unknown }>;
        } catch (err) {
          if (isTransientOrRateLimit(err)) this.noteRateLimit("bulk", laneUrl);
          return null;
        }
      };

      // Resolve a range, halving on an all-empty answer until the width question is settled.
      const resolve = async (c: ReadClient, from: number, to: number): Promise<void> => {
        const slice = contracts.slice(from, to);
        const r = await readSlice(c, slice);
        if (r && r.some((x) => x?.status === "success")) { for (let i = 0; i < slice.length; i++) results[from + i] = r[i]; return; }
        if (slice.length > 1) {
          // Nothing came back. A width cap and a batch of genuine reverts are indistinguishable here — so split.
          const half = Math.floor(slice.length / 2);
          const mid = from + half;
          // Learn the cap in ONE step, not one call at a time: the halves we are about to try ARE the next
          // candidate width, so remember that instead of `length - 1` (which would re-probe on every tick).
          const before = this.bulkWidth.get(laneUrl) ?? Number.MAX_SAFE_INTEGER;
          if (half < before) { this.bulkWidth.set(laneUrl, half); this.logger?.warn({ label, lane: redactRpc(laneUrl), width: half }, "bulk read: lane cannot answer this width → narrowing"); }
          await resolve(c, from, mid);
          await resolve(c, mid, to);
          return;
        }
        // One call, still nothing. Ask the control question.
        const alive = await c.readContract({ address: MULTICALL3_ADDRESS, abi: MULTICALL3_PROBE_ABI, functionName: "getBlockNumber" }).then(() => true).catch(() => false);
        if (alive) { results[from] = r?.[0] ?? { status: "failure" }; return; } // the chain refused: a real verdict
        if (c !== (this.fallback as ReadClient)) {
          this.logger?.warn({ label, from: redactRpc(laneUrl), to: redactRpc(this.fallbackRpc) }, "bulk read: lane proven down by positive control → rerouting to fallback");
          await resolve(this.fallback as ReadClient, from, to);
          return;
        }
        laneFailed = true;
        results[from] = { status: "failure" };
      };

      const width = Math.max(1, Math.min(contracts.length, this.bulkWidth.get(laneUrl) ?? contracts.length));
      for (let i = 0; i < contracts.length; i += width) await resolve(client, i, Math.min(i + width, contracts.length));
      return { results, laneFailed };
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

  /** `known` (db-first): pre-read ERC-20 balances (lowercased token → raw) from wallet_token_balances so
   * NAV is derived from the indexer's DB, not RPC. Native + any missing token still read on-chain (best-
   * effort, last-known cache). Callers without DB balances pass nothing → the pure-RPC path (unchanged). */
  async portfolio(dailyLossUsd: number, dataHealthy: boolean, known?: Map<string, bigint>): Promise<PortfolioSnapshot> {
    if (!this.config.WALLET_ADDRESS) {
      return { observedAt: new Date().toISOString(), bera: 0, wbera: 0, usdcE: 0, honey: 0, baseAsset: this.config.BASE_ASSET, baseAssetBalance: 0, estimatedNavUsd: 0, beraUsd: 0, honeyUsd: 0, dailyLossUsd, lockedUsd: 0, dataHealthy };
    }
    const address = this.config.WALLET_ADDRESS as Address;
    // Portfolio/NAV is ACCOUNTING (+ the gas-floor check) — it must NEVER abort a transaction. Read on the
    // reliable execution lane (not the rate-limited general-reads lane), and make every read best-effort:
    // on failure fall back to the last-known value (a stale NAV is fine; a thrown read killing a send is not).
    // TODO(DB-first): derive these balances from indexed Transfers instead of RPC (see rpc-lane-assignment).
    const resilient = async (key: string, fn: () => Promise<bigint>): Promise<bigint> => {
      try { const v = await fn(); this.balCache.set(key, v); return v; }
      catch { return this.balCache.get(key) ?? 0n; }
    };
    // DB-first per ERC-20: use the indexed balance when the caller provided it; RPC only for the ones the DB
    // doesn't have (and always for native, which has no Transfer log). Keeps the last-known cache resilience.
    const erc20Bal = (key: string, token: string): Promise<bigint> => {
      const dbBal = known?.get(token.toLowerCase());
      if (dbBal != null) { this.balCache.set(key, dbBal); return Promise.resolve(dbBal); }
      return resilient(key, () => this.exec.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] }) as Promise<bigint>);
    };
    const [beraRaw, wberaRaw, usdcRaw, honeyRaw] = await Promise.all([
      resilient("native", () => this.exec.getBalance({ address })),
      erc20Bal("wbera", this.config.WBERA_ADDRESS),
      erc20Bal("usdc", this.config.USDC_E_ADDRESS),
      erc20Bal("honey", this.config.HONEY_ADDRESS)
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
    // Simulate on the EXECUTION lane — the same node that will broadcast → the send sees the exact state
    // the preflight validated (allowance/balance/gas), on the reliable MEV endpoint. No cross-node lag.
    return this.preflightWith(this.exec, request);
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

  /** Local nonce sequencer so a rapid sequence (buy → approve → sell) never reuses a nonce even when the
   * exec node's pending count hasn't caught up (publicnode's MEV-protected mempool lags, which reported
   * "replacement transaction underpriced" on the second tx). Cleared on any send error → resynced from chain. */
  private trackedNonce?: number;
  private async nextNonce(): Promise<number> {
    const address = this.config.WALLET_ADDRESS as Address;
    const chainCount = await this.exec.getTransactionCount({ address, blockTag: "pending" }).catch(() => this.trackedNonce ?? 0);
    return this.trackedNonce != null ? Math.max(chainCount, this.trackedNonce) : chainCount;
  }

  async send(to: Address, data: Hex, value: bigint, gas: bigint, gasPriceWei: bigint): Promise<Hex> {
    if (!this.wallet) throw new Error("Wallet signer is unavailable");
    const nonce = await this.nextNonce();
    try { const hash = await this.wallet.sendTransaction({ to, data, value, gas, gasPrice: gasPriceWei, nonce }); this.trackedNonce = nonce + 1; return hash; }
    catch (err) { this.trackedNonce = undefined; if (isTransientOrRateLimit(err)) this.noteRateLimit("execution", this.executionRpc); throw err; }
  }

  /** Receipt confirmation for a sent tx. Prefers the EXECUTION lane, but is RESILIENT: some RPCs (e.g.
   * publicnode) reject viem's receipt-polling with "Invalid parameters" — the tx is still mined, so we
   * fall back to the indexer/general lanes. Any lane can find a mined tx; post-send there's no consistency
   * requirement. Returns the full viem receipt (callers read status/gasUsed/logs). */
  async waitReceipt(args: { hash: Hex; confirmations?: number; timeout?: number }) {
    let lastErr: unknown;
    for (const client of [this.exec, this.indexer, this.primary, this.fallback]) {
      try { return await client.waitForTransactionReceipt(args); }
      catch (e) { lastErr = e; } // this lane can't serve receipt polling → try the next
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Current base fee per gas (EIP-1559) from the latest block. 0n if unavailable (pre-1559 / RPC gap). */
  async baseFee(): Promise<bigint> {
    const block = await this.exec.getBlock({ blockTag: "latest" }); // gas for the tx → execution lane
    return block.baseFeePerGas ?? 0n;
  }

  /** EIP-1559 send with an EXPLICIT priority fee — used by the liquidation fire path to bid competitively
   * for block inclusion. `maxFeePerGas` must already include base-fee headroom + the priority tip. */
  async sendEip1559(to: Address, data: Hex, value: bigint, gas: bigint, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): Promise<Hex> {
    if (!this.wallet) throw new Error("Wallet signer is unavailable");
    const nonce = await this.nextNonce();
    try { const hash = await this.wallet.sendTransaction({ to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas, nonce }); this.trackedNonce = nonce + 1; return hash; }
    catch (err) { this.trackedNonce = undefined; if (isTransientOrRateLimit(err)) this.noteRateLimit("execution", this.executionRpc); throw err; }
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
