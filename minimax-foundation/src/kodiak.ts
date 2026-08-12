import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { BerachainRpc } from "./berachain-rpc.js";
import { ProtocolRegistryStore } from "./protocol-registry.js";

const positionManagerAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"
]);
type State = "verified-dual-rpc" | "rpc-disagreement" | "rpc-unavailable" | "unsupported";
type Position = { tokenId: string; token0: string; token1: string; fee: string; tickLower: number; tickUpper: number; liquidity: string; tokensOwed0: string; tokensOwed1: string };
export type KodiakPositionsSnapshot = {
  schemaVersion: 1; id: string; observedAt: string; walletAddress: string;
  source: { positionManager: string; contracts: string }; network: { chainId: string; pinnedBlock: string; primaryHead: string; secondaryHead: string; headDifference: string };
  integrity: { status: "verified-dual-rpc" | "degraded"; errors: string[] };
  v3NftPositions: { state: State; ownerNftCount?: string; positions: Position[]; error?: string };
  coverage: { included: string[]; excluded: string[] };
};

export class KodiakPositionsStore {
  constructor(private readonly dataDirectory: string) {}
  async save(snapshot: KodiakPositionsSnapshot): Promise<void> { await atomicJson(this.path(snapshot.walletAddress, snapshot.id), snapshot); if (snapshot.integrity.status === "verified-dual-rpc") await atomicJson(this.latestPath(snapshot.walletAddress), snapshot); }
  async latest(walletAddress: string): Promise<KodiakPositionsSnapshot | undefined> { try { return JSON.parse(await readFile(this.latestPath(walletAddress), "utf8")) as KodiakPositionsSnapshot; } catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; } }
  private directory(address: string) { return join(this.dataDirectory, "positions", "kodiak", address.toLowerCase()); }
  private path(address: string, id: string) { return join(this.directory(address), "snapshots", `${id}.json`); }
  private latestPath(address: string) { return join(this.directory(address), "latest.json"); }
}

/**
 * Kodiak uses the published Uniswap V3 position manager. balanceOf establishes
 * whether the wallet owns any manager NFTs. Enumeration is deliberately not
 * guessed: the deployed NFPM does not expose ERC721Enumerable; owned IDs need
 * an event-index adapter before their positions can be asserted.
 */
export class KodiakPositionsCollector {
  constructor(private readonly primary: BerachainRpc, private readonly secondary: BerachainRpc, private readonly registry: ProtocolRegistryStore, private readonly store: KodiakPositionsStore) {}

  async collect(walletAddress: string): Promise<KodiakPositionsSnapshot> {
    assertAddress(walletAddress);
    const registry = await this.registry.latest();
    const manager = registry?.protocols.find((protocol) => protocol.id === "kodiak")?.candidates.find((candidate) => candidate.label === "Position Manager" && candidate.verification.state === "verified-dual-rpc");
    if (!manager) throw new Error("Kodiak Position Manager is not dual-RPC verified in the latest protocol registry.");
    const [primaryHead, secondaryHead] = await Promise.all([this.primary.chainHead(), this.secondary.chainHead()]);
    if (primaryHead.chainId !== secondaryHead.chainId) throw new Error("Primary and secondary RPC chain IDs disagree.");
    const block = minBlock(primaryHead.blockNumber, secondaryHead.blockNumber);
    const balanceRaw = await this.dual(manager.address, encodeFunctionData({ abi: positionManagerAbi, functionName: "balanceOf", args: [walletAddress as Address] }), block);
    let v3NftPositions: KodiakPositionsSnapshot["v3NftPositions"];
    if (balanceRaw.state !== "verified-dual-rpc" || !balanceRaw.value) {
      v3NftPositions = { state: balanceRaw.state, positions: [], error: balanceRaw.error ?? "Missing dual-RPC response" };
    } else {
      const count = decodeFunctionResult({ abi: positionManagerAbi, functionName: "balanceOf", data: balanceRaw.value }) as bigint;
      v3NftPositions = count === 0n
        ? { state: "verified-dual-rpc", ownerNftCount: "0", positions: [] }
        : { state: "unsupported", ownerNftCount: count.toString(), positions: [], error: "The position manager proves owner NFT count but does not expose ERC721Enumerable. A Transfer-log ownership index is required before listing token IDs and positions." };
    }
    const errors = v3NftPositions.state === "verified-dual-rpc" ? [] : [v3NftPositions.error ?? v3NftPositions.state];
    const snapshot: KodiakPositionsSnapshot = {
      schemaVersion: 1, id: `kodiak_${randomUUID()}`, observedAt: new Date().toISOString(), walletAddress,
      source: { positionManager: manager.address, contracts: "https://documentation.kodiak.finance/overview/kodiak-contracts" },
      network: { chainId: primaryHead.chainId, pinnedBlock: block, primaryHead: primaryHead.blockNumber, secondaryHead: secondaryHead.blockNumber, headDifference: absoluteDifference(primaryHead.blockNumber, secondaryHead.blockNumber).toString() },
      integrity: { status: errors.length ? "degraded" : "verified-dual-rpc", errors }, v3NftPositions,
      coverage: { included: ["Kodiak published Uniswap V3 Position Manager owner NFT count at a pinned block", "Definitive proof of no managed V3 NFT position when ownerNftCount is zero"], excluded: ["Token IDs and fields when ownerNftCount is non-zero, until Transfer-log ownership indexing is implemented", "Kodiak V2 LP ERC-20 balances until factory/pair discovery is implemented", "Kodiak Island ERC-4626 shares, pending rewards, USD value, price/range risk and collectability"] }
    };
    await this.store.save(snapshot); return snapshot;
  }

  private async dual(to: string, data: Hex, block: string): Promise<{ state: State; value?: Hex; error?: string }> {
    try { const [primary, secondary] = await Promise.all([this.primary.readContract({ to, data, block }), this.secondary.readContract({ to, data, block })]) as [Hex, Hex]; return primary.toLowerCase() === secondary.toLowerCase() ? { state: "verified-dual-rpc", value: primary } : { state: "rpc-disagreement", error: "Primary and secondary RPC responses differ" }; }
    catch (error) { return { state: "rpc-unavailable", error: error instanceof Error ? error.message : String(error) }; }
  }
}

export function kodiakContext(snapshot: KodiakPositionsSnapshot | undefined): unknown {
  if (!snapshot) return { status: "not-collected", instruction: "Run the read-only Kodiak scan before making claims about Kodiak V3 NFT exposure." };
  return { observedAt: snapshot.observedAt, walletAddress: snapshot.walletAddress, network: snapshot.network, integrity: snapshot.integrity, v3NftPositions: snapshot.v3NftPositions, coverage: snapshot.coverage };
}

function minBlock(left: string, right: string): string { return BigInt(left) <= BigInt(right) ? left : right; }
function absoluteDifference(left: string, right: string): bigint { const value = BigInt(left) - BigInt(right); return value < 0n ? -value : value; }
function assertAddress(value: string): void { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("walletAddress must be a 20-byte hexadecimal address"); }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function isNotFound(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"); }
