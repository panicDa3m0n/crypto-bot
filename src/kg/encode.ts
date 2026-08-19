import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { PoolState } from "../router/types.js";
import type { LocalRouter } from "../router/router.js";
import type { SwapTrace } from "./state.js";

/**
 * PLAN COMPILATION — turn the winning cycle (per-hop exact amounts from the kernel trace) into the
 * KGExecutor's Call[]. This is the SEPARATE "compilation" concern: only the winner is encoded, never the
 * millions of search candidates. Each hop emits [approve(tokenIn→router, amountIn), swap] routed to that
 * pool's SPECIFIC venue router (via LocalRouter.encodeLeg), with outputs landing in the executor so the
 * next hop spends them. Per-leg minOut is 0 — the executor's require(minProfit) is the only boundary.
 *
 * Amounts are the exact simulated per-hop values: correct AT the mirror's block. If chain state has moved,
 * the final eth_call / on-chain require(minProfit) rejects it — the coherence gate, not this encoder.
 */

export interface ExecutorCall { target: Address; value: bigint; data: Hex }
const ERC20_APPROVE = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const MORPHO_LIQUIDATE = parseAbi(["function liquidate((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes data) returns (uint256, uint256)"]);
const MAX_UINT = (1n << 256n) - 1n;

export interface MarketParamsLite { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint }

/** Encode a flash-liquidation plan into the KGExecutor Call[] = LIQUIDATION PREFIX (approve loan→Morpho,
 * Morpho.liquidate seizedAssets-path) + the GENERIC swap-trace compiler over the exit legs (1..n hops).
 * Reuses `encodeCycle` for the swaps — no second multi-hop compiler. Returns null if any exit hop isn't
 * own-executable. require(minProfit) on the loan token is the boundary. */
export async function encodeLiquidationPlan(router: LocalRouter, morpho: Address, params: MarketParamsLite, borrower: Address, seized: bigint, exitLegs: SwapTrace[], poolStates: Map<string, PoolState>, executor: Address): Promise<ExecutorCall[] | null> {
  const swaps = await encodeCycle(router, poolStates, exitLegs, executor); // same compiler as arb cycles
  if (!swaps) return null;
  const prefix: ExecutorCall[] = [
    { target: params.loanToken, value: 0n, data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [morpho, MAX_UINT] }) },
    { target: morpho, value: 0n, data: encodeFunctionData({ abi: MORPHO_LIQUIDATE, functionName: "liquidate", args: [{ loanToken: params.loanToken, collateralToken: params.collateralToken, oracle: params.oracle, irm: params.irm, lltv: params.lltv }, borrower, seized, 0n, "0x"] }) }
  ];
  return [...prefix, ...swaps];
}

export async function encodeCycle(router: LocalRouter, poolStates: Map<string, PoolState>, legs: SwapTrace[], executor: Address): Promise<ExecutorCall[] | null> {
  const calls: ExecutorCall[] = [];
  for (const leg of legs) {
    const ps = poolStates.get(leg.poolId.toLowerCase());
    if (!ps) return null;
    const enc = await router.encodeLeg(ps, leg.tokenIn as Address, leg.tokenOut as Address, leg.amountIn, 0n, executor);
    if (!enc) return null; // a hop we can't own-execute (unknown fork) → whole cycle non-encodable
    calls.push({ target: leg.tokenIn as Address, value: 0n, data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [enc.router, leg.amountIn] }) });
    calls.push({ target: enc.router, value: enc.value, data: enc.calldata });
  }
  return calls;
}
