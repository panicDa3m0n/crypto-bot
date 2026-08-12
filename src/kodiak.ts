import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { Database } from "./db.js";

const KODIAK_QUOTE_URL = "https://backend.kodiak.finance/quote";
const CHAIN_ID = "80094";

export type KodiakReadQuote = {
  provider: "Kodiak";
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate?: bigint;
  priceImpactPercent?: number;
  route: string;
  observedAt: string;
};

type KodiakApiResponse = {
  provider?: unknown;
  amount?: unknown;
  quote?: unknown;
  gasUseEstimate?: unknown;
  priceImpact?: unknown;
  routeString?: unknown;
};

/**
 * Read-only access to Kodiak's public quote API.  It intentionally omits
 * recipient, deadline and slippage parameters, so the provider cannot return
 * executable calldata that an agent might mistake for an authorised order.
 */
export class KodiakQuoteScanner {
  private cooldownUntil = 0;
  constructor(private readonly config: Config, private readonly db: Database, private readonly logger: Logger) {}

  async quoteExactIn(input: { tokenIn: string; tokenOut: string; amountIn: bigint }): Promise<KodiakReadQuote> {
    if (input.amountIn <= 0n) throw new Error("Kodiak quote amount must be positive");
    if (Date.now() < this.cooldownUntil) throw new Error("Kodiak source cooldown is active after a declared rate limit");
    const url = new URL(KODIAK_QUOTE_URL);
    url.searchParams.set("tokenInAddress", input.tokenIn);
    url.searchParams.set("tokenInChainId", CHAIN_ID);
    url.searchParams.set("tokenOutAddress", input.tokenOut);
    url.searchParams.set("tokenOutChainId", CHAIN_ID);
    // The documented endpoint expects raw token units for its example.  The
    // result is checked against this exact raw amount before it is retained.
    url.searchParams.set("amount", input.amountIn.toString());
    url.searchParams.set("type", "exactIn");
    url.searchParams.set("providers", "Kodiak");

    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    const bodyText = await response.text();
    if (!response.ok) {
      if (response.status === 404 && /rate limit/i.test(bodyText)) {
        this.cooldownUntil = Date.now() + 5 * 60_000;
        this.logger.warn({ cooldownUntil: new Date(this.cooldownUntil).toISOString() }, "Kodiak quote source declared a rate limit; excluded during cooldown");
      }
      throw new Error(`Kodiak quote HTTP ${response.status}`);
    }
    let body: KodiakApiResponse;
    try { body = JSON.parse(bodyText) as KodiakApiResponse; } catch { throw new Error("Kodiak quote returned invalid JSON"); }
    const quote = parseKodiakReadQuote(body, input.amountIn);
    await this.db.saveMarketSnapshot("kodiak-kx", `${input.tokenIn.toLowerCase()}:${input.tokenOut.toLowerCase()}`, {
      ...quote, amountIn: quote.amountIn.toString(), amountOut: quote.amountOut.toString(), gasEstimate: quote.gasEstimate?.toString()
    });
    return quote;
  }

  async observeWberaHoney(wbera: string, honey: string, amountIn: bigint): Promise<void> {
    try {
      const [inQuote, outQuote] = await Promise.all([
        this.quoteExactIn({ tokenIn: wbera, tokenOut: honey, amountIn }),
        this.quoteExactIn({ tokenIn: honey, tokenOut: wbera, amountIn })
      ]);
      this.logger.info({ inAmountOut: inQuote.amountOut.toString(), outAmountOut: outQuote.amountOut.toString() }, "Kodiak read-only mainnet quotes saved");
    } catch (error) {
      this.logger.warn({ err: error }, "Kodiak read-only quote scan failed");
    }
  }
}

/** Exported for deterministic parser tests; never accepts calldata or a target. */
export function parseKodiakReadQuote(body: KodiakApiResponse, expectedAmountIn: bigint, now = new Date()): KodiakReadQuote {
  if (body.provider !== "Kodiak") throw new Error("Kodiak response did not select the Kodiak provider");
  const amountIn = strictBigInt(body.amount, "amount");
  const amountOut = strictBigInt(body.quote, "quote");
  if (amountIn !== expectedAmountIn) throw new Error("Kodiak response amount does not match the request");
  if (amountOut <= 0n) throw new Error("Kodiak response quote must be positive");
  const gasEstimate = body.gasUseEstimate === undefined ? undefined : strictBigInt(body.gasUseEstimate, "gasUseEstimate");
  const priceImpactPercent = body.priceImpact === undefined ? undefined : strictFiniteNumber(body.priceImpact, "priceImpact");
  const route = typeof body.routeString === "string" && body.routeString.length <= 4_000 ? body.routeString : "unavailable";
  return { provider: "Kodiak", amountIn, amountOut, gasEstimate, priceImpactPercent, route, observedAt: now.toISOString() };
}

function strictBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`Kodiak ${field} is not an unsigned integer string`);
  return BigInt(value);
}

function strictFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`Kodiak ${field} is not numeric`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Kodiak ${field} is not finite`);
  return parsed;
}
