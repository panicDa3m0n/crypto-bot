import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

/**
 * OWN EXECUTION — turn a chosen local route into venue-router calldata, so WE broadcast the swap
 * (no external aggregator calldata). Native ETH is handled by each router's native path so buys need
 * no wrap/approval and sells receive ETH directly:
 *   - Uniswap V3 (SwapRouter02): buy = exactInputSingle payable (router wraps msg.value); sell =
 *     multicall[exactInputSingle→router, unwrapWETH9→owner] so the min-out is enforced on the ETH out.
 *   - Aerodrome / Uniswap V2 routers: swapExactETHForTokens / swapExactTokensForETH /
 *     swapExactTokensForTokens with the venue's route/path.
 * These are PURE calldata builders — no I/O. Correctness is unit-tested by decoding the calldata, and
 * the preflight eth_call is the runtime safety net (a mis-encode reverts in simulation, never sends).
 */

// SwapRouter02 recipient sentinel meaning "this router" — used to keep WETH in the router before unwrap.
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;

const V3_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[])"
]);
// Aerodrome SlipStream (Base CL) SwapRouter — UniV3-style but the pool key is int24 tickSpacing (not fee)
// and the struct carries a deadline. Same multicall+unwrapWETH9 periphery for native-out sells.
const SLIPSTREAM_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[])"
]);
// Solidly (Aerodrome/Velodrome) router — routes carry the pool's (stable, factory).
const SOLIDLY_ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) returns (uint256[])"
]);
// Uniswap V2 router — plain address path.
const V2_ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])"
]);

export interface ExecCall { to: Address; calldata: Hex; value: bigint }

export interface ExecParams {
  venue: "v3" | "aerodrome" | "v2" | "slipstream";
  router: Address;
  weth: Address;         // wrapped-native (WETH9) address
  tokenIn: Address;      // ERC20 address of the input (native already mapped to WETH by the caller)
  tokenOut: Address;     // ERC20 address of the output (native already mapped to WETH)
  amountIn: bigint;
  minOut: bigint;
  recipient: Address;    // the wallet
  deadline: bigint;      // unix seconds
  nativeIn: boolean;     // spend native ETH (buy)
  nativeOut: boolean;    // receive native ETH (sell)
  feePpm?: number;       // v3 fee tier
  tickSpacing?: number;  // slipstream pool key (int24) — required for the slipstream router
  stable?: boolean;      // aerodrome pool stable flag
  factory?: Address;     // aerodrome pool factory (part of its Route struct)
}

/** Build the router call (to/calldata/value) for a single-hop swap on the given venue. */
export function buildExec(p: ExecParams): ExecCall {
  if (p.venue === "slipstream") return buildSlipstream(p);
  if (p.venue === "v3") return buildV3(p);
  return buildSolidlyOrV2(p);
}

/** SlipStream (Base CL) — like buildV3 but the exactInputSingle struct uses int24 tickSpacing + a deadline. */
function buildSlipstream(p: ExecParams): ExecCall {
  const tickSpacing = p.tickSpacing ?? 0;
  if (p.nativeOut) {
    // SlipStream's SwapRouter is the ORIGINAL UniV3 SwapRouter (no address(2) ADDRESS_THIS sentinel — that
    // is a SwapRouter02 feature). To keep WETH in the router before unwrapWETH9 (which unwraps address(this)),
    // send the swap output to the ROUTER's own address; then unwrapWETH9 pays the owner with min-out enforced.
    const swap = encodeFunctionData({ abi: SLIPSTREAM_ABI, functionName: "exactInputSingle", args: [{ tokenIn: p.tokenIn, tokenOut: p.weth, tickSpacing, recipient: p.router, deadline: p.deadline, amountIn: p.amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
    const unwrap = encodeFunctionData({ abi: SLIPSTREAM_ABI, functionName: "unwrapWETH9", args: [p.minOut, p.recipient] });
    const calldata = encodeFunctionData({ abi: SLIPSTREAM_ABI, functionName: "multicall", args: [[swap, unwrap]] });
    return { to: p.router, calldata, value: 0n };
  }
  const tokenIn = p.nativeIn ? p.weth : p.tokenIn;
  const calldata = encodeFunctionData({ abi: SLIPSTREAM_ABI, functionName: "exactInputSingle", args: [{ tokenIn, tokenOut: p.tokenOut, tickSpacing, recipient: p.recipient, deadline: p.deadline, amountIn: p.amountIn, amountOutMinimum: p.minOut, sqrtPriceLimitX96: 0n }] });
  return { to: p.router, calldata, value: p.nativeIn ? p.amountIn : 0n };
}

function buildV3(p: ExecParams): ExecCall {
  const fee = p.feePpm && p.feePpm > 0 ? p.feePpm : 3000;
  if (p.nativeOut) {
    // token → WETH into the router, then unwrap the WETH to owner with the min-out enforced there.
    const swap = encodeFunctionData({ abi: V3_ABI, functionName: "exactInputSingle", args: [{ tokenIn: p.tokenIn, tokenOut: p.weth, fee, recipient: ADDRESS_THIS, amountIn: p.amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
    const unwrap = encodeFunctionData({ abi: V3_ABI, functionName: "unwrapWETH9", args: [p.minOut, p.recipient] });
    const calldata = encodeFunctionData({ abi: V3_ABI, functionName: "multicall", args: [[swap, unwrap]] });
    return { to: p.router, calldata, value: 0n };
  }
  // buy (native in → tokenIn=WETH, value=amountIn, router wraps) OR erc20→erc20.
  const tokenIn = p.nativeIn ? p.weth : p.tokenIn;
  const calldata = encodeFunctionData({ abi: V3_ABI, functionName: "exactInputSingle", args: [{ tokenIn, tokenOut: p.tokenOut, fee, recipient: p.recipient, amountIn: p.amountIn, amountOutMinimum: p.minOut, sqrtPriceLimitX96: 0n }] });
  return { to: p.router, calldata, value: p.nativeIn ? p.amountIn : 0n };
}

function buildSolidlyOrV2(p: ExecParams): ExecCall {
  const solidly = p.venue === "aerodrome";
  const abi = solidly ? SOLIDLY_ABI : V2_ABI;
  const from = p.nativeIn ? p.weth : p.tokenIn;
  const to = p.nativeOut ? p.weth : p.tokenOut;
  // route/path arg differs per family: solidly carries (stable, factory); v2 is a plain address path.
  const hop = solidly
    ? [{ from, to, stable: p.stable ?? false, factory: (p.factory ?? ("0x0000000000000000000000000000000000000000" as Address)) }]
    : [from, to];
  if (p.nativeIn) {
    const calldata = encodeFunctionData({ abi, functionName: "swapExactETHForTokens", args: [p.minOut, hop as never, p.recipient, p.deadline] });
    return { to: p.router, calldata, value: p.amountIn };
  }
  if (p.nativeOut) {
    const calldata = encodeFunctionData({ abi, functionName: "swapExactTokensForETH", args: [p.amountIn, p.minOut, hop as never, p.recipient, p.deadline] });
    return { to: p.router, calldata, value: 0n };
  }
  const calldata = encodeFunctionData({ abi, functionName: "swapExactTokensForTokens", args: [p.amountIn, p.minOut, hop as never, p.recipient, p.deadline] });
  return { to: p.router, calldata, value: 0n };
}
