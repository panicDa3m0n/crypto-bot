import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BerachainRpc } from "./berachain-rpc.js";
import { ProtocolRegistryStore, type VerifiedContract } from "./protocol-registry.js";

type DualState = "verified-dual-rpc" | "rpc-disagreement" | "rpc-unavailable";
type TokenObservation = {
  address: string; label: string; protocols: string[]; symbol?: string; decimals?: number;
  balanceWei?: string; balanceFormatted?: string; metadataState: DualState; balanceState: DualState; error?: string;
};
type AllowanceObservation = { token: string; spender: string; spenderLabel: string; amountWei: string; amountFormatted?: string; state: DualState };

export type PortfolioSnapshot = {
  schemaVersion: 1;
  id: string;
  observedAt: string;
  walletAddress: string;
  network: { chainId: string; pinnedBlock: string; primaryHead: string; secondaryHead: string; headDifference: string };
  integrity: { status: "verified-dual-rpc" | "degraded"; failedObservations: string[] };
  nativeBera: { wei: string; formatted: string; state: DualState };
  nonce: { value: string; state: DualState };
  gas: { primaryWei?: string; secondaryWei?: string; state: DualState };
  tokens: TokenObservation[];
  allowances: { scope: string; checkedPairs: number; failures: number; nonZero: AllowanceObservation[] };
  positions: { status: "not-yet-adapted"; reason: string };
  valuation: { status: "not-priced"; reason: string };
  changeSincePrevious?: { previousSnapshotId: string; nativeBeraWeiDelta: string; tokenWeiDeltas: Array<{ token: string; deltaWei: string }> };
  coverage: { includedTokenSource: string; excluded: string[] };
};

export class PortfolioStore {
  constructor(private readonly dataDirectory: string) {}

  async save(snapshot: PortfolioSnapshot): Promise<void> {
    await atomicJson(this.snapshotPath(snapshot.walletAddress, snapshot.id), snapshot);
    await atomicJson(this.latestPath(snapshot.walletAddress), snapshot);
  }

  async latest(walletAddress: string): Promise<PortfolioSnapshot | undefined> {
    try { return JSON.parse(await readFile(this.latestPath(walletAddress), "utf8")) as PortfolioSnapshot; }
    catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; }
  }

  private walletDirectory(address: string) { return join(this.dataDirectory, "portfolio", address.toLowerCase()); }
  private snapshotPath(address: string, id: string) { return join(this.walletDirectory(address), "snapshots", `${id}.json`); }
  private latestPath(address: string) { return join(this.walletDirectory(address), "latest.json"); }
}

/**
 * Reconciles a bounded, documented token/spender universe at one common block.
 * It never reports an exhaustive wallet inventory: unknown ERC-20s and protocol
 * positions require their dedicated discovery adapters.
 */
export class PortfolioCollector {
  constructor(
    private readonly primary: BerachainRpc,
    private readonly secondary: BerachainRpc,
    private readonly registry: ProtocolRegistryStore,
    private readonly store: PortfolioStore
  ) {}

  async collect(walletAddress: string): Promise<PortfolioSnapshot> {
    assertAddress(walletAddress);
    const registry = await this.registry.latest();
    if (!registry) throw new Error("Protocol registry is missing. Run registry-scan before collecting a portfolio.");
    const [primaryHead, secondaryHead] = await Promise.all([this.primary.chainHead(), this.secondary.chainHead()]);
    if (primaryHead.chainId !== secondaryHead.chainId) throw new Error("Primary and secondary RPC chain IDs disagree.");
    const pinnedBlock = minBlock(primaryHead.blockNumber, secondaryHead.blockNumber);
    const tokens = tokenUniverse(registry.protocols.flatMap((protocol) => protocol.candidates.map((candidate) => ({ ...candidate, protocol: protocol.id }))));
    const spenders = spenderUniverse(registry.protocols.flatMap((protocol) => protocol.candidates.map((candidate) => ({ ...candidate, protocol: protocol.id }))));
    const [nativeBera, nonce, gas, tokenObservations] = await Promise.all([
      this.dual("native BERA", (rpc) => rpc.nativeBalanceAt(walletAddress, pinnedBlock), (value) => value.wei),
      this.dual("wallet nonce", (rpc) => rpc.transactionCount(walletAddress, pinnedBlock)),
      this.observeGas(),
      mapConcurrent(tokens, 3, (token) => this.observeToken(token, walletAddress, pinnedBlock))
    ]);
    const allowanceResult = await this.observeAllowances(tokenObservations, spenders, walletAddress, pinnedBlock);
    const previous = await this.store.latest(walletAddress);
    const failedObservations = [nativeBera, nonce].flatMap((item) => item.state === "verified-dual-rpc" ? [] : [item.error ?? "dual RPC observation failed"]);
    for (const token of tokenObservations) {
      if (token.metadataState !== "verified-dual-rpc" || token.balanceState !== "verified-dual-rpc") failedObservations.push(token.error ?? `token observation failed for ${token.address}`);
    }
    const snapshot: PortfolioSnapshot = {
      schemaVersion: 1,
      id: `portfolio_${randomUUID()}`,
      observedAt: new Date().toISOString(),
      walletAddress,
      network: { chainId: primaryHead.chainId, pinnedBlock, primaryHead: primaryHead.blockNumber, secondaryHead: secondaryHead.blockNumber, headDifference: absoluteDifference(primaryHead.blockNumber, secondaryHead.blockNumber).toString() },
      integrity: { status: failedObservations.length || allowanceResult.failures ? "degraded" : "verified-dual-rpc", failedObservations: [...failedObservations, ...(allowanceResult.failures ? [`${allowanceResult.failures} allowance observations failed`] : [])] },
      nativeBera: { wei: nativeBera.value?.wei ?? "0", formatted: nativeBera.value?.bera ?? "0", state: nativeBera.state },
      nonce: { value: nonce.value ?? "0x0", state: nonce.state },
      gas: { primaryWei: gas.primaryWei, secondaryWei: gas.secondaryWei, state: gas.state },
      tokens: tokenObservations,
      allowances: { scope: "All token anchors and potential spender anchors verified in the latest protocol registry; this is not an exhaustive chain-wide approval index.", checkedPairs: allowanceResult.checkedPairs, failures: allowanceResult.failures, nonZero: allowanceResult.nonZero },
      positions: { status: "not-yet-adapted", reason: "Protocol-specific position adapters are required before positions, debt, rewards and health factors can be asserted." },
      valuation: { status: "not-priced", reason: "No price/oracle adapter has yet met the dual-source freshness and market-specific validation gate." },
      ...(previous ? { changeSincePrevious: changes(previous, { native: nativeBera.value?.wei ?? "0", tokens: tokenObservations }) } : {}),
      coverage: {
        includedTokenSource: "Verified token-role anchors in the latest dual-RPC protocol registry.",
        excluded: ["Unknown ERC-20/ERC-721/ERC-1155 assets not present in the verified registry", "Protocol positions, claimable rewards, debt and collateral until their adapters are implemented", "USD values and net P&L until price and ledger modules are verified"]
      }
    };
    await this.store.save(snapshot);
    return snapshot;
  }

  private async observeToken(token: TokenSeed, walletAddress: string, block: string): Promise<TokenObservation> {
    const metadata = await this.dual(`metadata ${token.address}`, async (rpc) => {
      const [symbolRaw, decimalsRaw] = await Promise.all([
        rpc.readContract({ to: token.address, data: "0x95d89b41", block }),
        rpc.readContract({ to: token.address, data: "0x313ce567", block })
      ]);
      return { symbol: decodeAbiString(symbolRaw as string), decimals: Number(BigInt(decimalsRaw as string)) };
    });
    const balance = await this.dual<string>(`balance ${token.address}`, async (rpc) => rpc.readContract({ to: token.address, data: balanceOfCalldata(walletAddress), block }) as Promise<string>);
    const decimals = metadata.value?.decimals;
    const balanceWei = balance.value ? BigInt(balance.value).toString() : undefined;
    return {
      address: token.address, label: token.label, protocols: token.protocols,
      symbol: metadata.value?.symbol, decimals, balanceWei,
      ...(balanceWei !== undefined && decimals !== undefined ? { balanceFormatted: formatUnits(BigInt(balanceWei), decimals) } : {}),
      metadataState: metadata.state, balanceState: balance.state,
      ...(metadata.error || balance.error ? { error: metadata.error ?? balance.error } : {})
    };
  }

  private async observeGas(): Promise<{ primaryWei?: string; secondaryWei?: string; state: DualState; error?: string }> {
    try {
      const [primaryWei, secondaryWei] = await Promise.all([this.primary.gasPrice(), this.secondary.gasPrice()]);
      return { primaryWei, secondaryWei, state: primaryWei === secondaryWei ? "verified-dual-rpc" : "rpc-disagreement" };
    } catch (error) {
      return { state: "rpc-unavailable", error: `gas price: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async observeAllowances(tokens: TokenObservation[], spenders: SpenderSeed[], walletAddress: string, block: string): Promise<{ checkedPairs: number; failures: number; nonZero: AllowanceObservation[] }> {
    const usable = tokens.filter((token) => token.decimals !== undefined && token.balanceState === "verified-dual-rpc");
    const pairs = usable.flatMap((token) => spenders.map((spender) => ({ token, spender })));
    const observations = await mapConcurrent(pairs, 4, async ({ token, spender }) => {
      const result = await this.dual<string>(`allowance ${token.address}:${spender.address}`, (rpc) => rpc.readContract({ to: token.address, data: allowanceCalldata(walletAddress, spender.address), block }) as Promise<string>);
      return { token, spender, result };
    });
    return {
      checkedPairs: observations.length,
      failures: observations.filter((observation) => observation.result.state !== "verified-dual-rpc").length,
      nonZero: observations.flatMap(({ token, spender, result }) => {
        if (!result.value || BigInt(result.value) === 0n) return [];
        return [{ token: token.address, spender: spender.address, spenderLabel: spender.label, amountWei: BigInt(result.value).toString(), ...(token.decimals !== undefined ? { amountFormatted: formatUnits(BigInt(result.value), token.decimals) } : {}), state: result.state }];
      })
    };
  }

  private async dual<T>(label: string, read: (rpc: BerachainRpc) => Promise<T>, normalize: (value: T) => string = (value) => JSON.stringify(value)): Promise<{ value?: T; state: DualState; primary?: string; secondary?: string; error?: string }> {
    try {
      const [primary, secondary] = await Promise.all([read(this.primary), read(this.secondary)]);
      const normalizedPrimary = normalize(primary); const normalizedSecondary = normalize(secondary);
      if (normalizedPrimary !== normalizedSecondary) return { state: "rpc-disagreement", primary: normalizedPrimary, secondary: normalizedSecondary, error: `${label}: primary and secondary results differ` };
      return { value: primary, state: "verified-dual-rpc", primary: normalizedPrimary, secondary: normalizedSecondary };
    } catch (error) {
      return { state: "rpc-unavailable", error: `${label}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

/** Prompt-safe portfolio state. It preserves raw amounts and explicit coverage limits. */
export function portfolioContext(snapshot: PortfolioSnapshot | undefined): unknown {
  if (!snapshot) return { status: "not-collected", instruction: "Run a read-only portfolio scan before drawing conclusions about wallet capital or positions." };
  return {
    observedAt: snapshot.observedAt, walletAddress: snapshot.walletAddress, network: snapshot.network, integrity: snapshot.integrity,
    nativeBera: snapshot.nativeBera, nonce: snapshot.nonce, gas: snapshot.gas,
    tokens: snapshot.tokens.map((token) => ({ address: token.address, symbol: token.symbol, label: token.label, balanceWei: token.balanceWei, balanceFormatted: token.balanceFormatted, metadataState: token.metadataState, balanceState: token.balanceState, error: token.error })),
    allowances: snapshot.allowances, positions: snapshot.positions, valuation: snapshot.valuation, changeSincePrevious: snapshot.changeSincePrevious, coverage: snapshot.coverage
  };
}

type TokenSeed = { address: string; label: string; protocols: string[] };
type SpenderSeed = { address: string; label: string };
function tokenUniverse(candidates: Array<VerifiedContract & { protocol: string }>): TokenSeed[] {
  const output = new Map<string, TokenSeed>();
  for (const candidate of candidates) {
    if (candidate.role !== "token" || candidate.verification.state !== "verified-dual-rpc") continue;
    const key = candidate.address.toLowerCase(); const existing = output.get(key);
    output.set(key, existing ? { ...existing, protocols: [...new Set([...existing.protocols, candidate.protocol])] } : { address: candidate.address, label: candidate.label, protocols: [candidate.protocol] });
  }
  return [...output.values()];
}
function spenderUniverse(candidates: Array<VerifiedContract & { protocol: string }>): SpenderSeed[] {
  const roles = new Set(["core", "router", "vault", "position-manager"]);
  const output = new Map<string, SpenderSeed>();
  for (const candidate of candidates) if (roles.has(candidate.role) && candidate.verification.state === "verified-dual-rpc") output.set(candidate.address.toLowerCase(), { address: candidate.address, label: candidate.label });
  return [...output.values()];
}
function balanceOfCalldata(address: string): string { return `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`; }
function allowanceCalldata(owner: string, spender: string): string { return `0xdd62ed3e${owner.slice(2).toLowerCase().padStart(64, "0")}${spender.slice(2).toLowerCase().padStart(64, "0")}`; }
export function decodeAbiString(raw: string): string {
  if (!/^0x[0-9a-fA-F]*$/.test(raw)) throw new Error("Contract response is not hexadecimal");
  const data = raw.slice(2);
  if (data.length === 64) return Buffer.from(data, "hex").toString("utf8").replace(/\0+$/, "");
  if (data.length < 128) throw new Error("Contract response is too short for an ABI string");
  const offset = Number(BigInt(`0x${data.slice(0, 64)}`)) * 2;
  if (offset + 64 > data.length) throw new Error("ABI string offset is outside response");
  const length = Number(BigInt(`0x${data.slice(offset, offset + 64)}`)) * 2;
  if (offset + 64 + length > data.length) throw new Error("ABI string length is outside response");
  return Buffer.from(data.slice(offset + 64, offset + 64 + length), "hex").toString("utf8");
}
function changes(previous: PortfolioSnapshot, current: { native: string; tokens: TokenObservation[] }): PortfolioSnapshot["changeSincePrevious"] {
  const before = new Map(previous.tokens.map((token) => [token.address.toLowerCase(), token.balanceWei ?? "0"]));
  return {
    previousSnapshotId: previous.id,
    nativeBeraWeiDelta: (BigInt(current.native) - BigInt(previous.nativeBera.wei)).toString(),
    tokenWeiDeltas: current.tokens.map((token) => ({ token: token.address, deltaWei: (BigInt(token.balanceWei ?? "0") - BigInt(before.get(token.address.toLowerCase()) ?? "0")).toString() }))
  };
}
function minBlock(left: string, right: string): string { return BigInt(left) <= BigInt(right) ? left : right; }
function absoluteDifference(left: string, right: string): bigint { const difference = BigInt(left) - BigInt(right); return difference < 0n ? -difference : difference; }
function formatUnits(value: bigint, decimals: number): string { const base = 10n ** BigInt(decimals); const whole = value / base; const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, ""); return fraction ? `${whole}.${fraction}` : whole.toString(); }
async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> { const output: R[] = new Array(items.length); let next = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; output[index] = await worker(items[index]); } })); return output; }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function assertAddress(value: string): void { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("walletAddress must be a 20-byte hexadecimal address"); }
function isNotFound(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"); }
