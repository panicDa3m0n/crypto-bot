import type { Logger } from "pino";
import type { Address } from "viem";
import type { Config } from "./config.js";

/**
 * `dexOut` — the universal, cross-venue, SIZED quote primitive. It asks a DEX aggregator
 * (KeySwap-less KyberSwap by default) for the real executable output of tokenIn→tokenOut at a
 * given size, routed across ALL venues on the chain (Aerodrome, Uniswap V3/V4, Pancake, …) —
 * exactly the venues our on-chain reader is blind to. This is the single number every strategy
 * needs: the DEX-executable price at the actual trade size, not an oracle price or a 1-token
 * existence probe. `build()` returns the executable calldata (to the aggregator router) so an
 * atomic executor can fire the same route the quote priced.
 *
 * Every method is failure-tolerant: a network/aggregator hiccup returns null, never throws, so
 * a caller treats "no quote" as "not routable right now" (fail-safe).
 */
export type Quote = { amountIn: bigint; amountOut: bigint; gasUnits: number; gasUsd: number; routerAddress: string; routeSummary: unknown };
export type BuiltSwap = { router: Address; calldata: `0x${string}`; amountIn: bigint; amountOut: bigint; value: bigint };

/** The aggregator's native-currency sentinel: pass this as tokenIn to spend NATIVE ETH (no wrap, no
 * ERC20 approval, no transferFrom — the router receives ETH via msg.value), or as tokenOut to receive it.
 * Kyber/0x/1inch/Odos all use this address. */
export const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
export function isNative(token: string): boolean { return token.toLowerCase() === NATIVE_ETH.toLowerCase(); }

export class Aggregator {
  private readonly base: string; // e.g. https://aggregator-api.kyberswap.com/base/api/v1
  constructor(private readonly config: Config, private readonly logger: Logger) {
    this.base = `${config.AGGREGATOR_API_URL.replace(/\/$/, "")}/${config.AGGREGATOR_CHAIN}/api/v1`;
  }

  /** Sized cross-venue quote for tokenIn→tokenOut. null = not routable / aggregator unavailable. */
  async quote(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote | null> {
    return (await this.quoteResult(tokenIn, tokenOut, amountIn)).quote;
  }

  /**
   * Sized quote that DISTINGUISHES the two failure modes a caller must not conflate:
   *  - "no-route": the aggregator answered and there is genuinely no venue to sell this token
   *    (HTTP 200 but code≠0 / empty route) → the token really is unsellable at this size.
   *  - "error": the call itself failed (HTTP≠200, network, timeout) → we simply DON'T KNOW; the
   *    caller must NOT treat this as unsellable (that's how a liquid token gets falsely junked).
   * Only "ok" carries a quote. This is the fail-SAFE contract sellability checks depend on.
   */
  async quoteResult(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<{ status: "ok" | "no-route" | "error"; quote: Quote | null }> {
    if (amountIn <= 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return { status: "no-route", quote: null };
    const url = `${this.base}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn.toString()}&gasInclude=true`;
    try {
      const r = await fetch(url, { headers: { accept: "application/json", "x-client-id": "scarlet" }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) { this.logger.debug({ status: r.status, tokenIn, tokenOut }, "aggregator quote http error"); return { status: "error", quote: null }; }
      const j = await r.json() as { code?: number; data?: { routeSummary?: { amountOut?: string; gas?: string; gasUsd?: string }; routerAddress?: string } };
      const rs = j?.data?.routeSummary;
      if (j?.code !== 0 || !rs?.amountOut) return { status: "no-route", quote: null };
      return { status: "ok", quote: { amountIn, amountOut: BigInt(rs.amountOut), gasUnits: Number(rs.gas ?? 0), gasUsd: Number(rs.gasUsd ?? 0), routerAddress: j.data!.routerAddress ?? "", routeSummary: rs } };
    } catch (error) { this.logger.debug({ err: error, tokenIn, tokenOut }, "aggregator quote failed"); return { status: "error", quote: null }; }
  }

  /** Turn a quote's routeSummary into executable calldata sending output to `recipient`. */
  async build(routeSummary: unknown, sender: Address, recipient: Address, slippageBps = 100): Promise<BuiltSwap | null> {
    try {
      const r = await fetch(`${this.base}/route/build`, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-client-id": "scarlet" },
        body: JSON.stringify({ routeSummary, sender, recipient, slippageTolerance: slippageBps }), signal: AbortSignal.timeout(10_000)
      });
      if (!r.ok) return null;
      const j = await r.json() as { code?: number; data?: { routerAddress?: string; data?: string; amountIn?: string; amountOut?: string; transactionValue?: string } };
      const d = j?.data;
      if (j?.code !== 0 || !d?.data || !d.routerAddress) return null;
      // `transactionValue` is the msg.value the router expects: = amountIn for a NATIVE-ETH input, "0" for ERC20 in.
      return { router: d.routerAddress as Address, calldata: d.data as `0x${string}`, amountIn: BigInt(d.amountIn ?? "0"), amountOut: BigInt(d.amountOut ?? "0"), value: BigInt(d.transactionValue ?? "0") };
    } catch (error) { this.logger.debug({ err: error }, "aggregator build failed"); return null; }
  }

  /** Quote + build in one call: executable calldata to swap `amountIn` of tokenIn→tokenOut across
   * ALL venues, output to `recipient`. Used to build the collateral→loan swap leg of a liquidation
   * so the organ exits on Aerodrome/V4/etc., not just a single V3 pool. null if unroutable. */
  async swapCalldata(tokenIn: Address, tokenOut: Address, amountIn: bigint, recipient: Address, slippageBps = 100): Promise<BuiltSwap | null> {
    const q = await this.quote(tokenIn, tokenOut, amountIn);
    if (!q) return null;
    return this.build(q.routeSummary, recipient, recipient, slippageBps);
  }

  /**
   * Round-trip a CYCLE base → mids… → base at a fixed input size and return the net.
   * Spatial arb is the 2-node cycle base→X→base; triangular is base→A→B→base. Because each leg
   * is routed optimally across all venues, a cycle that returns MORE base than it put in (net of
   * the aggregator's own gas estimate) is a REAL dislocation — buy-cheap-venue / sell-dear-venue
   * captured automatically. Returns null if any leg is unroutable.
   */
  async cycleNet(base: Address, mids: Address[], amountIn: bigint): Promise<{ amountOut: bigint; netToken: bigint; gasUnits: number; legs: Quote[] } | null> {
    const legs: Quote[] = [];
    let amt = amountIn; let gasUnits = 0;
    const path = [...mids, base];
    let from = base;
    for (const to of path) {
      const q = await this.quote(from, to, amt);
      if (!q) return null;
      legs.push(q); amt = q.amountOut; gasUnits += q.gasUnits; from = to;
    }
    return { amountOut: amt, netToken: amt - amountIn, gasUnits, legs };
  }
}
