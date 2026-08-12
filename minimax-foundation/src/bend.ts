import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { BerachainRpc } from "./berachain-rpc.js";
import { ProtocolRegistryStore } from "./protocol-registry.js";

const morphoAbi = parseAbi([
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)"
]);

/** Officially published Bend market IDs. Dynamic event discovery supplements this list in a later adapter. */
export const bendPublishedMarkets = [
  { label: "WBTC / HONEY", id: "0x950962c1cf2591f15806e938bfde9b5f9fbbfcc5fb640030952c08b536f1f167" },
  { label: "sUSDe / HONEY", id: "0x1ba7904c73d337c39cb88b00180dffb215fc334a6ff47bbe829cd9ee2af00c97" },
  { label: "wgBERA / HONEY", id: "0x63c2a7c20192095c15d1d668ccce6912999b01ea60eeafcac66eca32015674dd" },
  { label: "WETH / HONEY", id: "0x1f05d324f604bd1654ec040311d2ac4f5820ecfd1801a3d19d2c6f09d4f7a614" },
  { label: "WBERA / HONEY", id: "0x147b032db82d765b9d971eac37c8176260dde0fe91f6a542f20cdd9ede1054df" },
  { label: "iBERA / HONEY", id: "0x594de722a090f8d0df41087c23e2187fb69d9cd6b7b425c6dd56ddc1cff545f0" }
] as const;

type State = "verified-dual-rpc" | "rpc-disagreement" | "rpc-unavailable";
type MarketParams = { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string };
type MarketState = { totalSupplyAssets: string; totalSupplyShares: string; totalBorrowAssets: string; totalBorrowShares: string; lastUpdate: string; fee: string };
type PositionState = { supplyShares: string; borrowShares: string; collateral: string };
export type BendMarketPosition = {
  id: string; label: string; state: State; marketParams?: MarketParams; market?: MarketState; position?: PositionState;
  derived?: { suppliedLoanAssets: string; borrowedLoanAssets: string; collateralAssets: string; active: boolean };
  error?: string;
};
export type BendPositionsSnapshot = {
  schemaVersion: 1; id: string; observedAt: string; walletAddress: string;
  source: { deployedMarkets: string; morphoAddress: string }; network: { chainId: string; pinnedBlock: string; primaryHead: string; secondaryHead: string; headDifference: string };
  integrity: { status: "verified-dual-rpc" | "degraded"; failedMarkets: string[] };
  markets: BendMarketPosition[]; activeMarketCount: number;
  coverage: { included: string[]; excluded: string[] };
};

export class BendPositionsStore {
  constructor(private readonly dataDirectory: string) {}
  async save(snapshot: BendPositionsSnapshot): Promise<void> { await atomicJson(this.snapshotPath(snapshot.walletAddress, snapshot.id), snapshot); await atomicJson(this.latestPath(snapshot.walletAddress), snapshot); }
  async latest(walletAddress: string): Promise<BendPositionsSnapshot | undefined> { try { return JSON.parse(await readFile(this.latestPath(walletAddress), "utf8")) as BendPositionsSnapshot; } catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; } }
  private directory(address: string) { return join(this.dataDirectory, "positions", "bend", address.toLowerCase()); }
  private snapshotPath(address: string, id: string) { return join(this.directory(address), "snapshots", `${id}.json`); }
  private latestPath(address: string) { return join(this.directory(address), "latest.json"); }
}

export class BendPositionsCollector {
  constructor(private readonly primary: BerachainRpc, private readonly secondary: BerachainRpc, private readonly registry: ProtocolRegistryStore, private readonly store: BendPositionsStore) {}

  async collect(walletAddress: string): Promise<BendPositionsSnapshot> {
    assertAddress(walletAddress);
    const registry = await this.registry.latest();
    const morpho = registry?.protocols.find((protocol) => protocol.id === "bend")?.candidates.find((candidate) => candidate.label === "Morpho" && candidate.verification.state === "verified-dual-rpc");
    if (!morpho) throw new Error("Bend Morpho anchor is not dual-RPC verified in the latest protocol registry.");
    const [primaryHead, secondaryHead] = await Promise.all([this.primary.chainHead(), this.secondary.chainHead()]);
    if (primaryHead.chainId !== secondaryHead.chainId) throw new Error("Primary and secondary RPC chain IDs disagree.");
    const pinnedBlock = minBlock(primaryHead.blockNumber, secondaryHead.blockNumber);
    const markets = await mapConcurrent([...bendPublishedMarkets], 3, (market) => this.readMarket(morpho.address, market, walletAddress, pinnedBlock));
    const failedMarkets = markets.filter((market) => market.state !== "verified-dual-rpc").map((market) => `${market.label}: ${market.error ?? market.state}`);
    const snapshot: BendPositionsSnapshot = {
      schemaVersion: 1, id: `bend_${randomUUID()}`, observedAt: new Date().toISOString(), walletAddress,
      source: { deployedMarkets: "https://docs.berachain.com/build/bend/deployed-markets", morphoAddress: morpho.address },
      network: { chainId: primaryHead.chainId, pinnedBlock, primaryHead: primaryHead.blockNumber, secondaryHead: secondaryHead.blockNumber, headDifference: absoluteDifference(primaryHead.blockNumber, secondaryHead.blockNumber).toString() },
      integrity: { status: failedMarkets.length ? "degraded" : "verified-dual-rpc", failedMarkets },
      markets, activeMarketCount: markets.filter((market) => market.derived?.active).length,
      coverage: { included: ["Six published Bend markets", "Direct Morpho supply shares, borrow shares and collateral for this wallet", "Market parameters and market state at a pinned block"], excluded: ["Unpublished or newly created markets until event-based discovery is enabled", "Bend vault (ERC-4626) shares until vault discovery is enabled", "USD valuation, health factor and liquidation price until each market oracle is verified and normalized"] }
    };
    await this.store.save(snapshot);
    return snapshot;
  }

  private async readMarket(morpho: string, seed: typeof bendPublishedMarkets[number], wallet: string, block: string): Promise<BendMarketPosition> {
    try {
      const positionData = encodeFunctionData({ abi: morphoAbi, functionName: "position", args: [seed.id as Hex, wallet as Address] });
      const marketData = encodeFunctionData({ abi: morphoAbi, functionName: "market", args: [seed.id as Hex] });
      const paramsData = encodeFunctionData({ abi: morphoAbi, functionName: "idToMarketParams", args: [seed.id as Hex] });
      const [positionRaw, marketRaw, paramsRaw] = await Promise.all([
        this.dual(morpho, positionData, block), this.dual(morpho, marketData, block), this.dual(morpho, paramsData, block)
      ]);
      const failed = [positionRaw, marketRaw, paramsRaw].find((result) => result.state !== "verified-dual-rpc");
      if (failed || !positionRaw.value || !marketRaw.value || !paramsRaw.value) return { id: seed.id, label: seed.label, state: failed?.state ?? "rpc-unavailable", error: failed?.error ?? "Missing dual-RPC return data" };
      const position = decodePosition(positionRaw.value); const market = decodeMarket(marketRaw.value); const marketParams = decodeMarketParams(paramsRaw.value);
      return { id: seed.id, label: seed.label, state: "verified-dual-rpc", marketParams, market, position, derived: derivePosition(position, market) };
    } catch (error) {
      return { id: seed.id, label: seed.label, state: "rpc-unavailable", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async dual(to: string, data: Hex, block: string): Promise<{ state: State; value?: Hex; error?: string }> {
    try {
      const [primary, secondary] = await Promise.all([this.primary.readContract({ to, data, block }), this.secondary.readContract({ to, data, block })]) as [Hex, Hex];
      if (primary.toLowerCase() !== secondary.toLowerCase()) return { state: "rpc-disagreement", error: "Primary and secondary RPC responses differ" };
      return { state: "verified-dual-rpc", value: primary };
    } catch (error) { return { state: "rpc-unavailable", error: error instanceof Error ? error.message : String(error) }; }
  }
}

export function bendContext(snapshot: BendPositionsSnapshot | undefined): unknown {
  if (!snapshot) return { status: "not-collected", instruction: "Run the read-only Bend position scan before making statements about Bend exposure." };
  return { observedAt: snapshot.observedAt, walletAddress: snapshot.walletAddress, network: snapshot.network, integrity: snapshot.integrity, activeMarketCount: snapshot.activeMarketCount, markets: snapshot.markets, coverage: snapshot.coverage };
}

export function derivePosition(position: PositionState, market: MarketState): { suppliedLoanAssets: string; borrowedLoanAssets: string; collateralAssets: string; active: boolean } {
  const supplyShares = BigInt(position.supplyShares); const borrowShares = BigInt(position.borrowShares);
  const supply = supplyShares === 0n || BigInt(market.totalSupplyShares) === 0n ? 0n : (supplyShares * BigInt(market.totalSupplyAssets)) / BigInt(market.totalSupplyShares);
  const borrow = borrowShares === 0n || BigInt(market.totalBorrowShares) === 0n ? 0n : divideUp(borrowShares * BigInt(market.totalBorrowAssets), BigInt(market.totalBorrowShares));
  return { suppliedLoanAssets: supply.toString(), borrowedLoanAssets: borrow.toString(), collateralAssets: position.collateral, active: supply !== 0n || borrow !== 0n || BigInt(position.collateral) !== 0n };
}

function decodePosition(data: Hex): PositionState { const value = decodeFunctionResult({ abi: morphoAbi, functionName: "position", data }) as readonly [bigint, bigint, bigint]; return { supplyShares: value[0].toString(), borrowShares: value[1].toString(), collateral: value[2].toString() }; }
function decodeMarket(data: Hex): MarketState { const value = decodeFunctionResult({ abi: morphoAbi, functionName: "market", data }) as readonly [bigint, bigint, bigint, bigint, bigint, bigint]; return { totalSupplyAssets: value[0].toString(), totalSupplyShares: value[1].toString(), totalBorrowAssets: value[2].toString(), totalBorrowShares: value[3].toString(), lastUpdate: value[4].toString(), fee: value[5].toString() }; }
function decodeMarketParams(data: Hex): MarketParams { const value = decodeFunctionResult({ abi: morphoAbi, functionName: "idToMarketParams", data }) as readonly [Address, Address, Address, Address, bigint]; return { loanToken: value[0], collateralToken: value[1], oracle: value[2], irm: value[3], lltv: value[4].toString() }; }
function divideUp(numerator: bigint, denominator: bigint): bigint { return (numerator + denominator - 1n) / denominator; }
function minBlock(left: string, right: string): string { return BigInt(left) <= BigInt(right) ? left : right; }
function absoluteDifference(left: string, right: string): bigint { const value = BigInt(left) - BigInt(right); return value < 0n ? -value : value; }
function assertAddress(value: string): void { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("walletAddress must be a 20-byte hexadecimal address"); }
async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> { const output: R[] = new Array(items.length); let next = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; output[index] = await worker(items[index]); } })); return output; }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function isNotFound(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"); }
