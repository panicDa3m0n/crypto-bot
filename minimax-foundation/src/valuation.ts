import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BexQuoteService, BexQuoteStore } from "./bex-quote.js";
import { BexStore } from "./bex.js";
import { BerachainRpc } from "./berachain-rpc.js";
import { PortfolioStore } from "./portfolio.js";

const WBERA = "0x6969696969696969696969696969696969696969";
const USDCE = "0x549943e04f40284185054145c6e4e9568c1d3241";
type State = "quoted-dual-rpc" | "zero" | "unpriced";
export type WalletValuationSnapshot = {
  schemaVersion: 1; id: string; observedAt: string; walletAddress: string;
  unit: { asset: "USDC.e"; address: string; decimals: number; usdStatus: "not-attested"; warning: string };
  portfolioSnapshotId: string; quoteAssets: Array<{ asset: string; sourceAddress: string; amountRaw: string; amountFormatted: string; routeTokenIn: string; state: State; quoteId?: string; outputUsdceRaw?: string; outputUsdceFormatted?: string; error?: string }>;
  totalUsdceRaw: string; totalUsdceFormatted: string; integrity: { status: "verified-dual-rpc" | "degraded"; errors: string[] };
  coverage: { included: string[]; excluded: string[] };
};

export class WalletValuationStore {
  constructor(private readonly dataDirectory: string) {}
  async save(snapshot: WalletValuationSnapshot): Promise<void> { await atomicJson(this.path(snapshot.walletAddress, snapshot.id), snapshot); if (snapshot.integrity.status === "verified-dual-rpc") await atomicJson(this.latestPath(snapshot.walletAddress), snapshot); }
  async latest(walletAddress: string): Promise<WalletValuationSnapshot | undefined> { try { return JSON.parse(await readFile(this.latestPath(walletAddress), "utf8")) as WalletValuationSnapshot; } catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; } }
  private directory(address: string) { return join(this.dataDirectory, "valuation", address.toLowerCase()); }
  private path(address: string, id: string) { return join(this.directory(address), "snapshots", `${id}.json`); }
  private latestPath(address: string) { return join(this.directory(address), "latest.json"); }
}

/** BEX on-chain quote-derived inventory in USDC.e units; deliberately not USD NAV. */
export class WalletValuationCollector {
  private readonly quote: BexQuoteService;
  constructor(primary: BerachainRpc, secondary: BerachainRpc, portfolio: PortfolioStore, bex: BexStore, dataDirectory: string, private readonly store: WalletValuationStore) { this.portfolio = portfolio; this.quote = new BexQuoteService(primary, secondary, bex, new BexQuoteStore(dataDirectory)); }
  private readonly portfolio: PortfolioStore;

  async collect(walletAddress: string): Promise<WalletValuationSnapshot> {
    const portfolio = await this.portfolio.latest(walletAddress);
    if (!portfolio || portfolio.integrity.status !== "verified-dual-rpc") throw new Error("A healthy portfolio snapshot is required before valuation.");
    const assets: Array<{ asset: string; sourceAddress: string; routeTokenIn: string; amountRaw: string; amountFormatted: string }> = [];
    if (BigInt(portfolio.nativeBera.wei) > 0n) assets.push({ asset: "BERA", sourceAddress: "native", routeTokenIn: WBERA, amountRaw: BigInt(portfolio.nativeBera.wei).toString(), amountFormatted: portfolio.nativeBera.formatted });
    for (const token of portfolio.tokens) if (token.balanceWei && BigInt(token.balanceWei) > 0n && token.decimals !== undefined && token.symbol) assets.push({ asset: token.symbol, sourceAddress: token.address, routeTokenIn: token.address, amountRaw: token.balanceWei, amountFormatted: token.balanceFormatted ?? token.balanceWei });
    const quoteAssets = await Promise.all(assets.map((asset) => this.quoteAsset(walletAddress, asset)));
    const errors = quoteAssets.filter((asset) => asset.state === "unpriced").map((asset) => `${asset.asset}: ${asset.error ?? "unpriced"}`);
    const total = quoteAssets.reduce((sum, asset) => sum + BigInt(asset.outputUsdceRaw ?? "0"), 0n);
    const snapshot: WalletValuationSnapshot = {
      schemaVersion: 1, id: `valuation_${randomUUID()}`, observedAt: new Date().toISOString(), walletAddress,
      unit: { asset: "USDC.e", address: USDCE, decimals: 6, usdStatus: "not-attested", warning: "This is a BEX quote-derived USDC.e equivalent, not an independently attested USD NAV. It must not satisfy USD risk gates." },
      portfolioSnapshotId: portfolio.id, quoteAssets, totalUsdceRaw: total.toString(), totalUsdceFormatted: formatUnits(total, 6), integrity: { status: errors.length ? "degraded" : "verified-dual-rpc", errors },
      coverage: { included: ["Current non-zero native BERA represented as WBERA for quote purposes", "Current non-zero registry-token balances that have an allowed BEX V2 route to USDC.e", "Official BEX SOR output required to match two pinned-block on-chain simulations"], excluded: ["USD attestation of USDC.e", "Assets without a supported BEX V2 route", "Fees/gas for hypothetical conversion, protocol positions outside portfolio coverage, unclaimed rewards, realised or unrealised P&L"] }
    };
    await this.store.save(snapshot); return snapshot;
  }

  private async quoteAsset(walletAddress: string, asset: { asset: string; sourceAddress: string; routeTokenIn: string; amountRaw: string; amountFormatted: string }): Promise<WalletValuationSnapshot["quoteAssets"][number]> {
    if (asset.routeTokenIn.toLowerCase() === USDCE) return { ...asset, state: "zero", outputUsdceRaw: asset.amountRaw, outputUsdceFormatted: formatUnits(BigInt(asset.amountRaw), 6) };
    try { const quote = await this.quote.exactIn({ walletAddress, tokenIn: asset.routeTokenIn, tokenOut: USDCE, amountInRaw: asset.amountRaw }); return { ...asset, state: "quoted-dual-rpc", quoteId: quote.id, outputUsdceRaw: quote.simulated.amountOutRaw, outputUsdceFormatted: formatUnits(BigInt(quote.simulated.amountOutRaw), 6) }; }
    catch (error) { return { ...asset, state: "unpriced", error: error instanceof Error ? error.message : String(error) }; }
  }
}

export function valuationContext(snapshot: WalletValuationSnapshot | undefined): unknown {
  if (!snapshot) return { status: "not-collected", instruction: "Run read-only wallet valuation after a fresh portfolio and BEX scan; do not call USDC.e equivalent USD NAV." };
  return { observedAt: snapshot.observedAt, walletAddress: snapshot.walletAddress, unit: snapshot.unit, portfolioSnapshotId: snapshot.portfolioSnapshotId, quoteAssets: snapshot.quoteAssets, totalUsdceRaw: snapshot.totalUsdceRaw, totalUsdceFormatted: snapshot.totalUsdceFormatted, integrity: snapshot.integrity, coverage: snapshot.coverage };
}
function formatUnits(value: bigint, decimals: number): string { const base = 10n ** BigInt(decimals); const whole = value / base; const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, ""); return fraction ? `${whole}.${fraction}` : whole.toString(); }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function isNotFound(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"); }
