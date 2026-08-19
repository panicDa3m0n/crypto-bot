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

/** Encode a flash-liquidation plan into the KGExecutor Call[]: approve loan→Morpho, Morpho.liquidate
 * (seizedAssets path, repaidShares=0), then swap the seized collateral → loan through its SPECIFIC pool.
 * The executor's flashExecute wraps borrow/repay; require(minProfit) is the boundary. Returns null if the
 * collateral→loan hop isn't own-executable. */
export async function encodeLiquidationPlan(router: LocalRouter, morpho: Address, params: MarketParamsLite, borrower: Address, seized: bigint, collPool: PoolState, executor: Address): Promise<ExecutorCall[] | null> {
  const enc = await router.encodeLeg(collPool, params.collateralToken, params.loanToken, seized, 0n, executor);
  if (!enc) return null;
  return [
    { target: params.loanToken, value: 0n, data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [morpho, MAX_UINT] }) },
    { target: morpho, value: 0n, data: encodeFunctionData({ abi: MORPHO_LIQUIDATE, functionName: "liquidate", args: [{ loanToken: params.loanToken, collateralToken: params.collateralToken, oracle: params.oracle, irm: params.irm, lltv: params.lltv }, borrower, seized, 0n, "0x"] }) },
    { target: params.collateralToken, value: 0n, data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [enc.router, seized] }) },
    { target: enc.router, value: enc.value, data: enc.calldata }
  ];
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
