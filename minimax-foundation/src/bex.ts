import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { BerachainRpc } from "./berachain-rpc.js";
import { ProtocolRegistryStore } from "./protocol-registry.js";

const BEX_API = "https://api.berachain.com/";
const vaultAbi = parseAbi(["function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)"]);
const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
type State = "verified-dual-rpc" | "rpc-disagreement" | "rpc-unavailable" | "not-supported";
type ApiToken = { address: string; symbol: string; decimals: number };
type ApiPool = { id: string; address: string; name: string; symbol: string; protocolVersion: number; allTokens: ApiToken[]; dynamicData: { totalLiquidity: string; volume24h: string; fees24h: string }; rewardVault: { vaultAddress: string; stakingTokenAddress: string } | null };
export type BexPoolObservation = { id: string; address: string; name: string; symbol: string; protocolVersion: number; api: ApiPool["dynamicData"]; rewardVault: ApiPool["rewardVault"]; apiTokens: ApiToken[]; state: State; poolBytecodeSha256?: string; onchain?: { tokens: string[]; balances: string[]; lastChangeBlock: string; apiTokenSetMatches: boolean }; walletPoolShares?: string; error?: string };
export type BexSnapshot = {
  schemaVersion: 1; id: string; observedAt: string; walletAddress: string;
  source: { api: string; vault: string }; network: { chainId: string; pinnedBlock: string; primaryHead: string; secondaryHead: string; headDifference: string };
  api: { reportedPoolCount: number; scannedPoolCount: number; limit: number }; integrity: { status: "verified-dual-rpc" | "degraded"; errors: string[] };
  pools: BexPoolObservation[]; walletPositions: Array<{ poolId: string; poolAddress: string; name: string; shares: string }>;
  coverage: { included: string[]; excluded: string[] };
};

export class BexStore {
  constructor(private readonly dataDirectory: string) {}
  /** Every run is retained; only a non-degraded snapshot becomes the model's latest market context. */
  async save(snapshot: BexSnapshot): Promise<void> { await atomicJson(this.path(snapshot.walletAddress, snapshot.id), snapshot); if (snapshot.integrity.status === "verified-dual-rpc") await atomicJson(this.latest(snapshot.walletAddress), snapshot); }
  async getLatest(walletAddress: string): Promise<BexSnapshot | undefined> { try { return JSON.parse(await readFile(this.latest(walletAddress), "utf8")) as BexSnapshot; } catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; } }
  private directory(wallet: string) { return join(this.dataDirectory, "markets", "bex", wallet.toLowerCase()); }
  private path(wallet: string, id: string) { return join(this.directory(wallet), "snapshots", `${id}.json`); }
  private latest(wallet: string) { return join(this.directory(wallet), "latest.json"); }
}

export class BexCollector {
  constructor(private readonly primary: BerachainRpc, private readonly secondary: BerachainRpc, private readonly registry: ProtocolRegistryStore, private readonly store: BexStore) {}

  async collect(walletAddress: string, limit = 50): Promise<BexSnapshot> {
    assertAddress(walletAddress); if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer from 1 to 500");
    const registry = await this.registry.latest();
    const vault = registry?.protocols.find((protocol) => protocol.id === "bex")?.candidates.find((candidate) => candidate.label === "BEX Vault" && candidate.verification.state === "verified-dual-rpc");
    if (!vault) throw new Error("BEX Vault anchor is not dual-RPC verified in the latest protocol registry.");
    const [primaryHead, secondaryHead, api] = await Promise.all([this.primary.chainHead(), this.secondary.chainHead(), fetchPools(limit)]);
    if (primaryHead.chainId !== secondaryHead.chainId) throw new Error("Primary and secondary RPC chain IDs disagree.");
    const block = minBlock(primaryHead.blockNumber, secondaryHead.blockNumber);
    // Public endpoints rate-limit broad scans. Keep calls serial and retry only
    // transient 429s; a dedicated RPC can raise this throughput later.
    const pools = await mapConcurrent(api.pools, 1, (pool) => this.observePool(vault.address, pool, walletAddress, block));
    const errors = pools.flatMap((pool) => pool.state === "verified-dual-rpc" ? [] : [`${pool.name}: ${pool.error ?? pool.state}`]);
    const snapshot: BexSnapshot = {
      schemaVersion: 1, id: `bex_${randomUUID()}`, observedAt: new Date().toISOString(), walletAddress,
      source: { api: BEX_API, vault: vault.address }, network: { chainId: primaryHead.chainId, pinnedBlock: block, primaryHead: primaryHead.blockNumber, secondaryHead: secondaryHead.blockNumber, headDifference: absoluteDifference(primaryHead.blockNumber, secondaryHead.blockNumber).toString() },
      api: { reportedPoolCount: api.total, scannedPoolCount: pools.length, limit }, integrity: { status: errors.length ? "degraded" : "verified-dual-rpc", errors }, pools,
      walletPositions: pools.flatMap((pool) => pool.walletPoolShares && BigInt(pool.walletPoolShares) !== 0n ? [{ poolId: pool.id, poolAddress: pool.address, name: pool.name, shares: pool.walletPoolShares }] : []),
      coverage: { included: ["Official BEX API discovery ordered by total liquidity", "BEX Vault getPoolTokens state at a pinned block for each BEX V2 pool scanned", "Wallet BPT balance for each scanned pool"], excluded: ["Pools outside the configured scan limit", "BEX V3 pools until their separate state adapter is implemented", "Reward-vault user stakes and pending rewards until the reward-vault adapter is implemented", "A quoted trade or executable transaction"] }
    };
    await this.store.save(snapshot); return snapshot;
  }

  private async observePool(vault: string, pool: ApiPool, wallet: string, block: string): Promise<BexPoolObservation> {
    if (pool.protocolVersion !== 2) return { ...basePool(pool), state: "not-supported", error: `BEX protocol version ${pool.protocolVersion} needs a dedicated adapter` };
    try {
      const code = await this.dualCode(pool.address);
      const tokens = await this.dualCall(vault, encodeFunctionData({ abi: vaultAbi, functionName: "getPoolTokens", args: [pool.id as Hex] }), block);
      const shares = await this.dualCall(pool.address, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [wallet as Address] }), block);
      const failed = [code, tokens, shares].find((result) => result.state !== "verified-dual-rpc");
      if (failed || !tokens.value || !shares.value || !code.value) return { ...basePool(pool), state: failed?.state ?? "rpc-unavailable", error: failed?.error ?? "Missing dual-RPC data" };
      const state = decodeFunctionResult({ abi: vaultAbi, functionName: "getPoolTokens", data: tokens.value }) as readonly [readonly Address[], readonly bigint[], bigint];
      const onchainTokens = [...state[0]].map((token) => token.toLowerCase());
      return { ...basePool(pool), state: "verified-dual-rpc", poolBytecodeSha256: code.value, onchain: { tokens: onchainTokens, balances: state[1].map((balance) => balance.toString()), lastChangeBlock: state[2].toString(), apiTokenSetMatches: addressesMatch(pool.allTokens.map((token) => token.address), onchainTokens) }, walletPoolShares: (decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: shares.value }) as bigint).toString() };
    } catch (error) { return { ...basePool(pool), state: "rpc-unavailable", error: error instanceof Error ? error.message : String(error) }; }
  }

  private async dualCall(to: string, data: Hex, block: string): Promise<{ state: State; value?: Hex; error?: string }> {
    try { const [primary, secondary] = await retry(() => Promise.all([this.primary.readContract({ to, data, block }), this.secondary.readContract({ to, data, block })]) as Promise<[Hex, Hex]>); return primary.toLowerCase() === secondary.toLowerCase() ? { state: "verified-dual-rpc", value: primary } : { state: "rpc-disagreement", error: "Primary and secondary RPC responses differ" }; }
    catch (error) { return { state: "rpc-unavailable", error: error instanceof Error ? error.message : String(error) }; }
  }
  private async dualCode(address: string): Promise<{ state: State; value?: string; error?: string }> {
    try { const [primary, secondary] = await retry(() => Promise.all([this.primary.code(address), this.secondary.code(address)])); if (primary === "0x" || secondary === "0x") return { state: "rpc-unavailable", error: "Pool address has no bytecode" }; return primary === secondary ? { state: "verified-dual-rpc", value: sha256(primary) } : { state: "rpc-disagreement", error: "Primary and secondary bytecode differ" }; }
    catch (error) { return { state: "rpc-unavailable", error: error instanceof Error ? error.message : String(error) }; }
  }
}

export function bexContext(snapshot: BexSnapshot | undefined): unknown {
  if (!snapshot) return { status: "not-collected", instruction: "Run the read-only BEX scan before making claims about BEX liquidity or wallet BPT positions." };
  const topPools = [...snapshot.pools].sort((left, right) => Number(right.api.totalLiquidity) - Number(left.api.totalLiquidity)).slice(0, 20);
  return { observedAt: snapshot.observedAt, walletAddress: snapshot.walletAddress, network: snapshot.network, api: snapshot.api, integrity: snapshot.integrity, walletPositions: snapshot.walletPositions, topPools: topPools.map((pool) => ({ id: pool.id, address: pool.address, name: pool.name, api: pool.api, state: pool.state, apiTokenSetMatches: pool.onchain?.apiTokenSetMatches, rewardVault: pool.rewardVault })), coverage: snapshot.coverage };
}

async function fetchPools(limit: number): Promise<{ total: number; pools: ApiPool[] }> {
  const query = `query Pools($first: Int!) { poolGetPoolsCount poolGetPools(first: $first, orderBy: totalLiquidity, orderDirection: desc) { id address name symbol protocolVersion allTokens { address symbol decimals } dynamicData { totalLiquidity volume24h fees24h } rewardVault { vaultAddress stakingTokenAddress } } }`;
  const response = await fetch(BEX_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables: { first: limit } }) });
  if (!response.ok) throw new Error(`BEX API HTTP ${response.status}`);
  const body = await response.json() as { data?: { poolGetPoolsCount?: number; poolGetPools?: ApiPool[] }; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(`BEX API GraphQL: ${body.errors.map((error) => error.message).join("; ")}`);
  if (!body.data?.poolGetPools || typeof body.data.poolGetPoolsCount !== "number") throw new Error("BEX API returned an incomplete pool response");
  return { total: body.data.poolGetPoolsCount, pools: body.data.poolGetPools };
}
function basePool(pool: ApiPool): Omit<BexPoolObservation, "state" | "poolBytecodeSha256" | "onchain" | "walletPoolShares" | "error"> { return { id: pool.id, address: pool.address, name: pool.name, symbol: pool.symbol, protocolVersion: pool.protocolVersion, api: pool.dynamicData, rewardVault: pool.rewardVault, apiTokens: pool.allTokens }; }
export function addressesMatch(api: string[], onchain: string[]): boolean { return [...new Set(api.map((address) => address.toLowerCase()))].sort().join(",") === [...new Set(onchain.map((address) => address.toLowerCase()))].sort().join(","); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function minBlock(left: string, right: string): string { return BigInt(left) <= BigInt(right) ? left : right; }
function absoluteDifference(left: string, right: string): bigint { const value = BigInt(left) - BigInt(right); return value < 0n ? -value : value; }
function assertAddress(value: string): void { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("walletAddress must be a 20-byte hexadecimal address"); }
async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> { const output: R[] = new Array(items.length); let next = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; output[index] = await worker(items[index]); } })); return output; }
async function retry<T>(operation: () => Promise<T>, attempts = 5): Promise<T> { let lastError: unknown; for (let attempt = 0; attempt < attempts; attempt += 1) { try { return await operation(); } catch (error) { lastError = error; if (!(error instanceof Error) || !error.message.includes("RPC HTTP 429") || attempt === attempts - 1) throw error; await sleep(400 * 2 ** attempt); } } throw lastError; }
async function sleep(milliseconds: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function isNotFound(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"); }
