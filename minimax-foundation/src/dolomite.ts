import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { BerachainRpc } from "./berachain-rpc.js";
import { ProtocolRegistryStore } from "./protocol-registry.js";

const dolomiteAbi = parseAbi([
  "function getAccountBalances((address owner,uint256 number) account) view returns (uint256[] marketIds, address[] tokenAddresses, (bool sign,uint128 value)[] pars, (bool sign,uint256 value)[] weis)",
  "function getAccountStatus((address owner,uint256 number) account) view returns (uint8)",
  "function getAccountValues((address owner,uint256 number) account) view returns ((uint256 value) supplied, (uint256 value) borrowed)",
  "function getAdjustedAccountValues((address owner,uint256 number) account) view returns ((uint256 value) supplied, (uint256 value) borrowed)",
  "function getMarginRatio() view returns (uint256)"
]);

type State = "verified-dual-rpc" | "rpc-disagreement" | "rpc-unavailable";
type SignedAmount = { sign: boolean; value: string };
export type DolomiteBalance = { marketId: string; tokenAddress: string; par: SignedAmount; wei: SignedAmount };
export type DolomiteAccountSnapshot = {
  schemaVersion: 1; id: string; observedAt: string; walletAddress: string; accountNumber: string;
  source: { dolomiteMargin: string }; network: { chainId: string; pinnedBlock: string; primaryHead: string; secondaryHead: string; headDifference: string };
  integrity: { status: "verified-dual-rpc" | "degraded"; errors: string[] };
  accountStatus?: "normal" | "liquidating" | "vaporizing" | "unknown"; balances: DolomiteBalance[];
  values?: { suppliedUsd36: string; borrowedUsd36: string; adjustedSuppliedUsd36: string; adjustedBorrowedUsd36: string; requiredMarginWad: string; actualMarginWad?: string; meetsGlobalMarginRequirement?: boolean };
  coverage: { included: string[]; excluded: string[] };
};

export class DolomiteAccountStore {
  constructor(private readonly dataDirectory: string) {}
  async save(snapshot: DolomiteAccountSnapshot): Promise<void> { await atomicJson(this.snapshotPath(snapshot.walletAddress, snapshot.accountNumber, snapshot.id), snapshot); await atomicJson(this.latestPath(snapshot.walletAddress, snapshot.accountNumber), snapshot); }
  async latest(walletAddress: string, accountNumber = "0"): Promise<DolomiteAccountSnapshot | undefined> { try { return JSON.parse(await readFile(this.latestPath(walletAddress, accountNumber), "utf8")) as DolomiteAccountSnapshot; } catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; } }
  private directory(address: string, accountNumber: string) { return join(this.dataDirectory, "positions", "dolomite", address.toLowerCase(), accountNumber); }
  private snapshotPath(address: string, accountNumber: string, id: string) { return join(this.directory(address, accountNumber), "snapshots", `${id}.json`); }
  private latestPath(address: string, accountNumber: string) { return join(this.directory(address, accountNumber), "latest.json"); }
}

export class DolomiteAccountCollector {
  constructor(private readonly primary: BerachainRpc, private readonly secondary: BerachainRpc, private readonly registry: ProtocolRegistryStore, private readonly store: DolomiteAccountStore) {}

  async collect(walletAddress: string, accountNumber = "0"): Promise<DolomiteAccountSnapshot> {
    assertAddress(walletAddress); if (!/^\d+$/.test(accountNumber)) throw new Error("accountNumber must be a non-negative decimal integer");
    const registry = await this.registry.latest();
    const margin = registry?.protocols.find((protocol) => protocol.id === "dolomite")?.candidates.find((candidate) => candidate.label === "Dolomite Margin" && candidate.verification.state === "verified-dual-rpc");
    if (!margin) throw new Error("Dolomite Margin anchor is not dual-RPC verified in the latest protocol registry.");
    const [primaryHead, secondaryHead] = await Promise.all([this.primary.chainHead(), this.secondary.chainHead()]);
    if (primaryHead.chainId !== secondaryHead.chainId) throw new Error("Primary and secondary RPC chain IDs disagree.");
    const block = minBlock(primaryHead.blockNumber, secondaryHead.blockNumber);
    const account = { owner: walletAddress as Address, number: BigInt(accountNumber) };
    const calls = {
      balances: encodeFunctionData({ abi: dolomiteAbi, functionName: "getAccountBalances", args: [account] }),
      status: encodeFunctionData({ abi: dolomiteAbi, functionName: "getAccountStatus", args: [account] }),
      values: encodeFunctionData({ abi: dolomiteAbi, functionName: "getAccountValues", args: [account] }),
      adjustedValues: encodeFunctionData({ abi: dolomiteAbi, functionName: "getAdjustedAccountValues", args: [account] }),
      marginRatio: encodeFunctionData({ abi: dolomiteAbi, functionName: "getMarginRatio" })
    };
    const [balancesRaw, statusRaw, valuesRaw, adjustedRaw, marginRaw] = await Promise.all(Object.values(calls).map((data) => this.dual(margin.address, data, block)));
    const all = [balancesRaw, statusRaw, valuesRaw, adjustedRaw, marginRaw];
    const errors = all.flatMap((result) => result.state === "verified-dual-rpc" ? [] : [result.error ?? result.state]);
    let balances: DolomiteBalance[] = []; let accountStatus: DolomiteAccountSnapshot["accountStatus"]; let values: DolomiteAccountSnapshot["values"];
    if (!errors.length && balancesRaw.value && statusRaw.value && valuesRaw.value && adjustedRaw.value && marginRaw.value) {
      balances = decodeBalances(balancesRaw.value); accountStatus = decodeStatus(statusRaw.value);
      values = deriveValues(decodeValuePair(valuesRaw.value, "getAccountValues"), decodeValuePair(adjustedRaw.value, "getAdjustedAccountValues"), decodeSingle(marginRaw.value, "getMarginRatio"));
    }
    const snapshot: DolomiteAccountSnapshot = {
      schemaVersion: 1, id: `dolomite_${randomUUID()}`, observedAt: new Date().toISOString(), walletAddress, accountNumber,
      source: { dolomiteMargin: margin.address }, network: { chainId: primaryHead.chainId, pinnedBlock: block, primaryHead: primaryHead.blockNumber, secondaryHead: secondaryHead.blockNumber, headDifference: absoluteDifference(primaryHead.blockNumber, secondaryHead.blockNumber).toString() },
      integrity: { status: errors.length ? "degraded" : "verified-dual-rpc", errors }, accountStatus, balances, values,
      coverage: { included: [`Dolomite account number ${accountNumber}`, "All non-zero internal market balances returned by DolomiteMargin", "Protocol-provided supplied, borrowed and adjusted account values"], excluded: ["Additional account numbers for this wallet until event/indexer-based account discovery is enabled", "External wallet balances, which are collected separately", "Protocol modules, expiry positions and rewards until their dedicated adapters are implemented"] }
    };
    await this.store.save(snapshot); return snapshot;
  }

  private async dual(to: string, data: Hex, block: string): Promise<{ state: State; value?: Hex; error?: string }> {
    try { const [primary, secondary] = await Promise.all([this.primary.readContract({ to, data, block }), this.secondary.readContract({ to, data, block })]) as [Hex, Hex]; return primary.toLowerCase() === secondary.toLowerCase() ? { state: "verified-dual-rpc", value: primary } : { state: "rpc-disagreement", error: "Primary and secondary RPC responses differ" }; }
    catch (error) { return { state: "rpc-unavailable", error: error instanceof Error ? error.message : String(error) }; }
  }
}

export function dolomiteContext(snapshot: DolomiteAccountSnapshot | undefined): unknown { return snapshot ? { observedAt: snapshot.observedAt, walletAddress: snapshot.walletAddress, accountNumber: snapshot.accountNumber, network: snapshot.network, integrity: snapshot.integrity, accountStatus: snapshot.accountStatus, balances: snapshot.balances, values: snapshot.values, coverage: snapshot.coverage } : { status: "not-collected", instruction: "Run the read-only Dolomite scan for account number 0 before making statements about Dolomite exposure." }; }
export function deriveValues(values: { supplied: bigint; borrowed: bigint }, adjusted: { supplied: bigint; borrowed: bigint }, requiredMarginWad: bigint): NonNullable<DolomiteAccountSnapshot["values"]> {
  const actualMarginWad = adjusted.borrowed === 0n ? undefined : (adjusted.supplied * 10n ** 18n) / adjusted.borrowed - 10n ** 18n;
  return { suppliedUsd36: values.supplied.toString(), borrowedUsd36: values.borrowed.toString(), adjustedSuppliedUsd36: adjusted.supplied.toString(), adjustedBorrowedUsd36: adjusted.borrowed.toString(), requiredMarginWad: requiredMarginWad.toString(), ...(actualMarginWad === undefined ? {} : { actualMarginWad: actualMarginWad.toString(), meetsGlobalMarginRequirement: actualMarginWad >= requiredMarginWad }) };
}
function decodeBalances(data: Hex): DolomiteBalance[] { const value = decodeFunctionResult({ abi: dolomiteAbi, functionName: "getAccountBalances", data }) as unknown as [readonly bigint[], readonly Address[], readonly { sign: boolean; value: bigint }[], readonly { sign: boolean; value: bigint }[]]; return value[0].map((marketId, index) => ({ marketId: marketId.toString(), tokenAddress: value[1][index], par: { sign: value[2][index].sign, value: value[2][index].value.toString() }, wei: { sign: value[3][index].sign, value: value[3][index].value.toString() } })); }
function decodeStatus(data: Hex): DolomiteAccountSnapshot["accountStatus"] { const result = Number(decodeFunctionResult({ abi: dolomiteAbi, functionName: "getAccountStatus", data })); return result === 0 ? "normal" : result === 1 ? "liquidating" : result === 2 ? "vaporizing" : "unknown"; }
function decodeValuePair(data: Hex, functionName: "getAccountValues" | "getAdjustedAccountValues"): { supplied: bigint; borrowed: bigint } { const value = decodeFunctionResult({ abi: dolomiteAbi, functionName, data }) as unknown as readonly [{ value: bigint }, { value: bigint }]; return { supplied: value[0].value, borrowed: value[1].value }; }
function decodeSingle(data: Hex, functionName: "getMarginRatio"): bigint { return decodeFunctionResult({ abi: dolomiteAbi, functionName, data }) as bigint; }
function minBlock(left: string, right: string): string { return BigInt(left) <= BigInt(right) ? left : right; }
function absoluteDifference(left: string, right: string): bigint { const value = BigInt(left) - BigInt(right); return value < 0n ? -value : value; }
function assertAddress(value: string): void { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("walletAddress must be a 20-byte hexadecimal address"); }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function isNotFound(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"); }
