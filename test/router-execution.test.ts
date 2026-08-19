import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, type Address } from "viem";
import { buildExec, type ExecParams } from "../src/router/execution.js";

const WETH = "0x4200000000000000000000000000000000000006" as Address;
const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const OWNER = "0x2222222222222222222222222222222222222222" as Address;
const V3_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
const AERO_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Address;
const AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address;
const V2_ROUTER = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as Address;
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const E18 = 10n ** 18n;

const V3_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[])"
]);
const SOLIDLY_ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) returns (uint256[])"
]);
const V2_ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])"
]);

function base(over: Partial<ExecParams>): ExecParams {
  return { venue: "v3", router: V3_ROUTER, weth: WETH, tokenIn: TOKEN, tokenOut: TOKEN, amountIn: E18, minOut: 900n * 10n ** 15n, recipient: OWNER, deadline: 1_900_000_000n, nativeIn: false, nativeOut: false, feePpm: 3000, stable: false, factory: AERO_FACTORY, ...over };
}

describe("execution encoders", () => {
  it("V3 native buy → exactInputSingle payable, value=amountIn, tokenIn=WETH, minOut enforced", () => {
    const c = buildExec(base({ venue: "v3", nativeIn: true, tokenIn: WETH, tokenOut: TOKEN }));
    expect(c.to).toBe(V3_ROUTER);
    expect(c.value).toBe(E18);
    const d = decodeFunctionData({ abi: V3_ABI, data: c.calldata });
    expect(d.functionName).toBe("exactInputSingle");
    const a = d.args[0] as { tokenIn: string; tokenOut: string; recipient: string; amountIn: bigint; amountOutMinimum: bigint; fee: number };
    expect(a.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
    expect(a.tokenOut.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(a.recipient.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(a.amountIn).toBe(E18);
    expect(a.amountOutMinimum).toBe(900n * 10n ** 15n);
    expect(a.fee).toBe(3000);
  });

  it("V3 native sell → multicall[exactInputSingle→ADDRESS_THIS, unwrapWETH9(minOut,owner)], value=0", () => {
    const c = buildExec(base({ venue: "v3", nativeOut: true, tokenIn: TOKEN, tokenOut: WETH }));
    expect(c.value).toBe(0n);
    const top = decodeFunctionData({ abi: V3_ABI, data: c.calldata });
    expect(top.functionName).toBe("multicall");
    const inner = (top.args[0] as `0x${string}`[]);
    expect(inner.length).toBe(2);
    const swap = decodeFunctionData({ abi: V3_ABI, data: inner[0] });
    expect(swap.functionName).toBe("exactInputSingle");
    const sa = swap.args[0] as { tokenIn: string; tokenOut: string; recipient: string; amountOutMinimum: bigint };
    expect(sa.tokenIn.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(sa.tokenOut.toLowerCase()).toBe(WETH.toLowerCase());
    expect(sa.recipient.toLowerCase()).toBe(ADDRESS_THIS);        // WETH stays in the router
    expect(sa.amountOutMinimum).toBe(0n);                         // min enforced by unwrap, not the swap
    const unwrap = decodeFunctionData({ abi: V3_ABI, data: inner[1] });
    expect(unwrap.functionName).toBe("unwrapWETH9");
    expect(unwrap.args[0]).toBe(900n * 10n ** 15n);              // amountMinimum = minOut
    expect((unwrap.args[1] as string).toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it("Aerodrome native buy → swapExactETHForTokens with a (from,to,stable,factory) route, value=amountIn", () => {
    const c = buildExec(base({ venue: "aerodrome", router: AERO_ROUTER, nativeIn: true, tokenIn: WETH, tokenOut: TOKEN }));
    expect(c.to).toBe(AERO_ROUTER);
    expect(c.value).toBe(E18);
    const d = decodeFunctionData({ abi: SOLIDLY_ABI, data: c.calldata });
    expect(d.functionName).toBe("swapExactETHForTokens");
    const routes = d.args[1] as ReadonlyArray<{ from: string; to: string; stable: boolean; factory: string }>;
    expect(routes[0].from.toLowerCase()).toBe(WETH.toLowerCase());
    expect(routes[0].to.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(routes[0].stable).toBe(false);
    expect(routes[0].factory.toLowerCase()).toBe(AERO_FACTORY.toLowerCase());
    expect((d.args[2] as string).toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it("Aerodrome native sell → swapExactTokensForETH(amountIn,minOut,route), value=0", () => {
    const c = buildExec(base({ venue: "aerodrome", router: AERO_ROUTER, nativeOut: true, tokenIn: TOKEN, tokenOut: WETH }));
    expect(c.value).toBe(0n);
    const d = decodeFunctionData({ abi: SOLIDLY_ABI, data: c.calldata });
    expect(d.functionName).toBe("swapExactTokensForETH");
    expect(d.args[0]).toBe(E18);
    expect(d.args[1]).toBe(900n * 10n ** 15n);
    const routes = d.args[2] as ReadonlyArray<{ from: string; to: string }>;
    expect(routes[0].from.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(routes[0].to.toLowerCase()).toBe(WETH.toLowerCase());
  });

  it("Uniswap V2 native buy → swapExactETHForTokens with a plain [WETH, token] path", () => {
    const c = buildExec(base({ venue: "v2", router: V2_ROUTER, nativeIn: true, tokenIn: WETH, tokenOut: TOKEN }));
    expect(c.to).toBe(V2_ROUTER);
    expect(c.value).toBe(E18);
    const d = decodeFunctionData({ abi: V2_ABI, data: c.calldata });
    expect(d.functionName).toBe("swapExactETHForTokens");
    const path = d.args[1] as readonly string[];
    expect(path.map((x) => x.toLowerCase())).toEqual([WETH.toLowerCase(), TOKEN.toLowerCase()]);
  });

  it("ERC20→ERC20 on V3 → exactInputSingle to owner, value=0", () => {
    const c = buildExec(base({ venue: "v3", tokenIn: TOKEN, tokenOut: WETH, nativeIn: false, nativeOut: false }));
    expect(c.value).toBe(0n);
    const d = decodeFunctionData({ abi: V3_ABI, data: c.calldata });
    expect(d.functionName).toBe("exactInputSingle");
    const a = d.args[0] as { recipient: string };
    expect(a.recipient.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it("SlipStream erc20→erc20 → exactInputSingle with tickSpacing + deadline (NOT fee)", () => {
    const SLIP_ABI = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
    const c = buildExec(base({ venue: "slipstream", router: "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5" as Address, tokenIn: TOKEN, tokenOut: WETH, tickSpacing: 100 }));
    expect(c.value).toBe(0n);
    const d = decodeFunctionData({ abi: SLIP_ABI, data: c.calldata });
    expect(d.functionName).toBe("exactInputSingle");
    const a = d.args[0] as { tickSpacing: number; deadline: bigint; amountOutMinimum: bigint; recipient: string };
    expect(a.tickSpacing).toBe(100);
    expect(a.deadline).toBe(1_900_000_000n);
    expect(a.amountOutMinimum).toBe(900n * 10n ** 15n);
    expect(a.recipient.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it("SlipStream native-out sell → multicall[exactInputSingle→router, unwrapWETH9→owner]", () => {
    const SLIP_ABI = parseAbi([
      "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
      "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
      "function multicall(bytes[] data) payable returns (bytes[])"
    ]);
    const SLIP_ROUTER = "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5";
    const c = buildExec(base({ venue: "slipstream", router: SLIP_ROUTER as Address, tokenIn: TOKEN, tokenOut: WETH, nativeOut: true, tickSpacing: 200 }));
    const outer = decodeFunctionData({ abi: SLIP_ABI, data: c.calldata });
    expect(outer.functionName).toBe("multicall");
    const calls = outer.args[0] as `0x${string}`[];
    const swap = decodeFunctionData({ abi: SLIP_ABI, data: calls[0] });
    // SlipStream has no ADDRESS_THIS sentinel → swap output goes to the ROUTER's own address before unwrap.
    expect((swap.args[0] as { recipient: string }).recipient.toLowerCase()).toBe(SLIP_ROUTER);
    const unwrap = decodeFunctionData({ abi: SLIP_ABI, data: calls[1] });
    expect(unwrap.functionName).toBe("unwrapWETH9");
    expect((unwrap.args as [bigint, string])[1].toLowerCase()).toBe(OWNER.toLowerCase());
  });
});
