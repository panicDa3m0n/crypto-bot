import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BalancerApi, ChainId, Swap, SwapKind, Token, TokenAmount, type Address } from "@berachain-foundation/berancer-sdk";
import { BerachainRpc } from "./berachain-rpc.js";
import { BexStore, type BexPoolObservation } from "./bex.js";

const BEX_API = "https://api.berachain.com/";
const MAX_RAW_AMOUNT = 10n ** 60n;

export type BexExactInQuoteRequest = { walletAddress: string; tokenIn: string; tokenOut: string; amountInRaw: string };
export type BexExactInQuote = {
  schemaVersion: 1; id: string; observedAt: string; walletAddress: string;
  request: BexExactInQuoteRequest;
  tokens: { tokenIn: { address: string; symbol: string; decimals: number }; tokenOut: { address: string; symbol: string; decimals: number } };
  source: { sorApi: string; simulation: "BEX SDK Swap.query via two Berachain RPC endpoints" };
  network: { chainId: string; pinnedBlock: string; primaryHead: string; secondaryHead: string; headDifference: string };
  route: { protocolVersion: 2; paths: number; hops: Array<{ poolId: string; symbol: string; tokenIn: string; tokenOut: string }>; priceImpact: string | null; priceImpactError: string | null; totalSwapFee: number };
  apiReturnAmount: string; apiReturnAmountRaw: string; apiVsSimulation: { matchesRaw: boolean; differenceRaw: string; note: string };
  simulated: { primaryAmountOutRaw: string; secondaryAmountOutRaw: string; amountOutRaw: string; agrees: true; queryTo: string };
  integrity: { status: "verified-dual-rpc"; errors: string[] };
  coverage: { included: string[]; excluded: string[] };
};

export class BexQuoteStore {
  constructor(private readonly dataDirectory: string) {}
  async save(quote: BexExactInQuote): Promise<void> { await atomicJson(this.path(quote.walletAddress, quote.id), quote); }
  async get(id: string, walletAddress: string): Promise<BexExactInQuote | undefined> {
    try { return JSON.parse(await readFile(this.path(walletAddress, id), "utf8")) as BexExactInQuote; }
    catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; }
  }
  async recent(walletAddress: string, limit = 20): Promise<BexExactInQuote[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100");
    try {
      const directory = this.directory(walletAddress);
      const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
      const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as BexExactInQuote));
      return records.sort((left, right) => right.observedAt.localeCompare(left.observedAt)).slice(0, limit);
    } catch (error: unknown) { if (isNotFound(error)) return []; throw error; }
  }
  private directory(wallet: string) { return join(this.dataDirectory, "markets", "bex", wallet.toLowerCase(), "quotes"); }
  private path(wallet: string, id: string) { return join(this.directory(wallet), `${id}.json`); }
}

/** Produces a real exact-input quote, but never approval/swap calldata or a transaction. */
export class BexQuoteService {
  constructor(private readonly primary: BerachainRpc, private readonly secondary: BerachainRpc, private readonly pools: BexStore, private readonly store: BexQuoteStore) {}

  async exactIn(request: BexExactInQuoteRequest): Promise<BexExactInQuote> {
    validateRequest(request);
    const snapshot = await this.pools.getLatest(request.walletAddress);
    if (!snapshot || snapshot.integrity.status !== "verified-dual-rpc") throw new Error("No healthy BEX pool scan exists for this wallet. Run a read-only BEX scan first.");
    const tokenIn = tokenMetadata(snapshot.pools, request.tokenIn);
    const tokenOut = tokenMetadata(snapshot.pools, request.tokenOut);
    if (!tokenIn || !tokenOut) throw new Error("Both token addresses must be present in the latest verified BEX scan; do not quote unknown assets.");
    const amountIn = BigInt(request.amountInRaw);
    if (amountIn <= 0n || amountIn > MAX_RAW_AMOUNT) throw new Error("amountInRaw must be a positive integer no greater than 10^60.");

    const api = new BalancerApi(BEX_API, ChainId.BERACHAIN);
    const inToken = new Token(ChainId.BERACHAIN, tokenIn.address as Address, tokenIn.decimals, tokenIn.symbol);
    const outToken = new Token(ChainId.BERACHAIN, tokenOut.address as Address, tokenOut.decimals, tokenOut.symbol);
    const sor = await api.sorSwapPaths.fetchSorSwapPaths({ chainId: ChainId.BERACHAIN, tokenIn: inToken.address, tokenOut: outToken.address, swapKind: SwapKind.GivenIn, swapAmount: TokenAmount.fromRawAmount(inToken, amountIn) });
    if (!sor.paths.length) throw new Error("BEX SOR returned no route for this exact-input quote.");
    if (!sor.paths.every((path) => path.protocolVersion === 2)) throw new Error("The SOR route includes BEX V3. V3 is intentionally excluded until its state adapter is independently verified.");
    const allowed = new Set(snapshot.pools.filter((pool) => pool.state === "verified-dual-rpc" && pool.protocolVersion === 2).map((pool) => pool.id.toLowerCase()));
    const routePoolIds = sor.paths.flatMap((path) => path.pools);
    if (routePoolIds.some((pool) => !allowed.has(pool.toLowerCase()))) throw new Error("The SOR route includes a pool absent from the latest independently verified BEX scan.");

    const [primaryHead, secondaryHead] = await Promise.all([this.primary.chainHead(), this.secondary.chainHead()]);
    if (primaryHead.chainId !== secondaryHead.chainId) throw new Error("Primary and secondary RPC chain IDs disagree.");
    const pinnedBlock = BigInt(primaryHead.blockNumber) <= BigInt(secondaryHead.blockNumber) ? BigInt(primaryHead.blockNumber) : BigInt(secondaryHead.blockNumber);
    const swap = new Swap({ chainId: ChainId.BERACHAIN, paths: sor.paths, swapKind: SwapKind.GivenIn });
    const [primarySimulation, secondarySimulation] = await Promise.all([swap.query(this.primary.endpoint(), pinnedBlock), swap.query(this.secondary.endpoint(), pinnedBlock)]);
    if (primarySimulation.swapKind !== SwapKind.GivenIn || secondarySimulation.swapKind !== SwapKind.GivenIn) throw new Error("Unexpected BEX simulation kind for exact-input quote.");
    const primaryAmount = primarySimulation.expectedAmountOut.amount;
    const secondaryAmount = secondarySimulation.expectedAmountOut.amount;
    if (primaryAmount !== secondaryAmount) throw new Error("BEX quote simulations disagree between RPC endpoints.");
    const apiReturnAmountRaw = humanDecimalToRaw(sor.returnAmount, tokenOut.decimals);

    const quote: BexExactInQuote = {
      schemaVersion: 1, id: `bex_quote_${randomUUID()}`, observedAt: new Date().toISOString(), walletAddress: request.walletAddress,
      request: { ...request, tokenIn: tokenIn.address, tokenOut: tokenOut.address }, tokens: { tokenIn, tokenOut },
      source: { sorApi: BEX_API, simulation: "BEX SDK Swap.query via two Berachain RPC endpoints" },
      network: { chainId: primaryHead.chainId, pinnedBlock: `0x${pinnedBlock.toString(16)}`, primaryHead: primaryHead.blockNumber, secondaryHead: secondaryHead.blockNumber, headDifference: absoluteDifference(primaryHead.blockNumber, secondaryHead.blockNumber).toString() },
      route: { protocolVersion: 2, paths: sor.paths.length, hops: sor.routes.flatMap((route) => route.hops.map((hop) => ({ poolId: hop.poolId, symbol: hop.pool.symbol, tokenIn: hop.tokenIn, tokenOut: hop.tokenOut }))), priceImpact: sor.priceImpact.priceImpact, priceImpactError: sor.priceImpact.error, totalSwapFee: sor.totalSwapFee },
      apiReturnAmount: sor.returnAmount, apiReturnAmountRaw: apiReturnAmountRaw.toString(), apiVsSimulation: { matchesRaw: apiReturnAmountRaw === primaryAmount, differenceRaw: absoluteBigIntDifference(apiReturnAmountRaw, primaryAmount).toString(), note: "The official SOR is route discovery. The pinned-block dual-RPC simulated amountOutRaw is the only executable-output evidence; API human output may differ as state moves or is rounded." },
      simulated: { primaryAmountOutRaw: primaryAmount.toString(), secondaryAmountOutRaw: secondaryAmount.toString(), amountOutRaw: primaryAmount.toString(), agrees: true, queryTo: primarySimulation.to },
      integrity: { status: "verified-dual-rpc", errors: [] },
      coverage: { included: ["Exact-input SOR route from the official BEX API", "Every V2 route pool present in the latest dual-RPC-verified BEX scan", "Identical BEX query simulation at one pinned block through two RPC endpoints"], excluded: ["SOR API human amount as executable output evidence; use simulated.amountOutRaw", "Per-hop human-readable API amounts as an economic output claim", "BEX V3 routes until a separate V3 state adapter is verified", "Token approval, swap calldata construction, signing, broadcast or execution", "Gas estimation and net-profit calculation"] }
    };
    await this.store.save(quote);
    return quote;
  }
}

export function tokenMetadata(pools: BexPoolObservation[], address: string): { address: string; symbol: string; decimals: number } | undefined {
  const normalized = address.toLowerCase();
  const matches = pools.flatMap((pool) => pool.apiTokens).filter((token) => token.address.toLowerCase() === normalized);
  if (!matches.length) return undefined;
  const first = matches[0];
  if (!matches.every((token) => token.decimals === first.decimals && token.symbol === first.symbol)) throw new Error(`BEX API metadata disagrees for token ${address}.`);
  return { address: first.address, symbol: first.symbol, decimals: first.decimals };
}

/** Compact, persisted evidence. Quotes remain point-in-time gross output, never P&L. */
export async function bexQuoteContext(store: BexQuoteStore, walletAddress: string): Promise<unknown> {
  const quotes = await store.recent(walletAddress);
  if (!quotes.length) return { status: "not-collected", instruction: "No persisted BEX quote exists for this wallet. Request a fresh exact-input quote only for a concrete research question." };
  return { status: "available", quoteCount: quotes.length, quotes: quotes.map((quote) => ({ id: quote.id, observedAt: quote.observedAt, request: quote.request, tokens: quote.tokens, network: quote.network, route: quote.route, apiReturnAmountRaw: quote.apiReturnAmountRaw, simulatedAmountOutRaw: quote.simulated.amountOutRaw, integrity: quote.integrity, coverage: quote.coverage })) };
}

function validateRequest(request: BexExactInQuoteRequest): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(request.walletAddress)) throw new Error("walletAddress must be a 20-byte hexadecimal address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(request.tokenIn) || !/^0x[0-9a-fA-F]{40}$/.test(request.tokenOut)) throw new Error("tokenIn and tokenOut must be 20-byte hexadecimal addresses");
  if (request.tokenIn.toLowerCase() === request.tokenOut.toLowerCase()) throw new Error("tokenIn and tokenOut must differ");
  if (!/^[0-9]+$/.test(request.amountInRaw)) throw new Error("amountInRaw must be a base-unit decimal integer string");
}
function humanDecimalToRaw(value: string, decimals: number): bigint {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error("BEX SOR returned a malformed human-readable output amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("BEX SOR output has more decimal places than its output token.");
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}
function absoluteDifference(left: string, right: string): bigint { const difference = BigInt(left) - BigInt(right); return difference < 0n ? -difference : difference; }
function absoluteBigIntDifference(left: bigint, right: bigint): bigint { const difference = left - right; return difference < 0n ? -difference : difference; }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function isNotFound(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"); }
