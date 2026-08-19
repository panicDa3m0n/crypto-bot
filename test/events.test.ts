import { describe, expect, it } from "vitest";
import { decodeLog, decodeTransfer, TRANSFER, V3_SWAP, PANCAKE_V3_SWAP, V2_SYNC, AERO_SYNC, V2_SWAP, POOL_CREATED, UNIV3_MINT, UNIV3_BURN, V4_SWAP, V4_INITIALIZE } from "../src/indexer/events.js";

const POOL = "0x00000000000000000000000000000000000000pp".replace("pp", "01");
const FACTORY = "0x00000000000000000000000000000000000000ff";
const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";

const w = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
const data = (...ws: bigint[]) => "0x" + ws.map(w).join("");
const topicNum = (v: bigint) => "0x" + w(v);
const topicAddr = (a: string) => "0x" + "0".repeat(24) + a.slice(2);
const log = (topic0: string, topics: string[], d: string, address = POOL) => ({ address, topics: [topic0, ...topics], data: d, blockNumber: "0x1" });

describe("event decoders (unified registry)", () => {
  it("V3 Swap → swap_v3 (sqrtPrice=word2, liquidity=word3, signed amounts)", () => {
    const e = decodeLog(log(V3_SWAP, [], data(-5n, 7n, 123n, 456n, 10n))) as any; // amount0<0 (out), amount1>0
    expect(e.kind).toBe("swap_v3");
    expect(e.pool).toBe(POOL.toLowerCase());
    expect(e.amount0).toBe(-5n);
    expect(e.amount1).toBe(7n);
    expect(e.sqrtPrice).toBe(123n);
    expect(e.liquidity).toBe(456n);
  });

  it("Pancake V3 Swap → swap_v3 with the SAME layout (trailing protocolFees ignored)", () => {
    const e = decodeLog(log(PANCAKE_V3_SWAP, [], data(-5n, 7n, 123n, 456n, 10n, 1n, 2n))) as any;
    expect(e.kind).toBe("swap_v3");
    expect(e.sqrtPrice).toBe(123n);
    expect(e.liquidity).toBe(456n);
    expect(e.amount0).toBe(-5n);
  });

  it("V2 / Aerodrome Sync → sync with reserves + archetype", () => {
    const v2 = decodeLog(log(V2_SYNC, [], data(1000n, 2000n))) as any;
    expect(v2).toMatchObject({ kind: "sync", archetype: "v2", r0: 1000n, r1: 2000n });
    const aero = decodeLog(log(AERO_SYNC, [], data(1000n, 2000n))) as any;
    expect(aero.archetype).toBe("aerodrome");
  });

  it("V2 Swap → swap_v2 (amount0In,amount1In,amount0Out,amount1Out)", () => {
    const e = decodeLog(log(V2_SWAP, [], data(10n, 0n, 0n, 20n))) as any;
    expect(e).toMatchObject({ kind: "swap_v2", archetype: "v2", a0In: 10n, a1In: 0n, a0Out: 0n, a1Out: 20n });
  });

  it("V3 PoolCreated → pool_created (pool=word1, fee=topic3, factory=emitter)", () => {
    const e = decodeLog(log(POOL_CREATED, [topicAddr(A), topicAddr(B), topicNum(3000n)], data(60n, BigInt(POOL)), FACTORY)) as any;
    expect(e.kind).toBe("pool_created");
    expect(e.token0).toBe(A); expect(e.token1).toBe(B);
    expect(e.pool).toBe(POOL.toLowerCase());
    expect(e.fee).toBe(3000);
    expect(e.archetype).toBe("v3");
    expect(e.factory).toBe(FACTORY);
  });

  it("V3 Mint → liquidity_v3 with +delta (liquidity=data word1) and ticks from topics", () => {
    const e = decodeLog(log(UNIV3_MINT, [topicAddr(A), topicNum(-100n), topicNum(200n)], data(BigInt(A), 999n, 1n, 2n))) as any;
    expect(e.kind).toBe("liquidity_v3");
    expect(e.liquidityDelta).toBe(999n);     // added
    expect(e.tickLower).toBe(-100);           // signed int24 from topic
    expect(e.tickUpper).toBe(200);
  });

  it("V3 Burn → liquidity_v3 with −delta (liquidity=data word0)", () => {
    const e = decodeLog(log(UNIV3_BURN, [topicAddr(A), topicNum(-100n), topicNum(200n)], data(999n, 1n, 2n))) as any;
    expect(e.kind).toBe("liquidity_v3");
    expect(e.liquidityDelta).toBe(-999n);    // removed
    expect(e.tickLower).toBe(-100);
  });

  it("unknown topic0 → null (ignored, but present in the raw buffer)", () => {
    expect(decodeLog(log("0xdeadbeef00000000000000000000000000000000000000000000000000000000", [], "0x"))).toBeNull();
  });

  it("ERC-20 Transfer → {token, from, to, value} (from/to from topics, value from data)", () => {
    const TOKEN = "0x00000000000000000000000000000000000000cc";
    const e = decodeTransfer({ address: TOKEN, topics: [TRANSFER, topicAddr(A), topicAddr(B)], data: data(1234n), blockNumber: "0x1" });
    expect(e).toEqual({ token: TOKEN.toLowerCase(), from: A.toLowerCase(), to: B.toLowerCase(), value: 1234n });
  });

  it("V4 Swap → swap_v3 with v4 flag, poolId as pool (not the PoolManager address)", () => {
    const PM = "0x00000000000000000000000000000000000000mm".replace("mm", "44");
    const poolId = "0x" + "ab".repeat(32);
    const e = decodeLog({ address: PM, topics: [V4_SWAP, poolId, topicAddr(A)], data: data(-5n, 7n, 123n, 456n, 10n, 500n), blockNumber: "0x1" }) as any;
    expect(e.kind).toBe("swap_v3");
    expect(e.v4).toBe(true);
    expect(e.pool).toBe(poolId.toLowerCase());
    expect(e.sqrtPrice).toBe(123n);
    expect(e.liquidity).toBe(456n);
    expect(e.recipient).toBe(A.toLowerCase());
  });

  it("V4 Initialize → pool_created archetype v4 (poolId, currencies, tickSpacing)", () => {
    const PM = "0x00000000000000000000000000000000000000mm".replace("mm", "44");
    const poolId = "0x" + "cd".repeat(32);
    const HOOKS = "0x00000000000000000000000000000000000000hh".replace("hh", "55");
    const e = decodeLog({ address: PM, topics: [V4_INITIALIZE, poolId, topicAddr(A), topicAddr(B)], data: data(100n, 1n, BigInt(HOOKS), 123n, 0n), blockNumber: "0x1" }) as any;
    expect(e.kind).toBe("pool_created");
    expect(e.archetype).toBe("v4");
    expect(e.pool).toBe(poolId.toLowerCase());
    expect(e.token0).toBe(A.toLowerCase());
    expect(e.token1).toBe(B.toLowerCase());
    expect(e.fee).toBe(100);
    expect(e.tickSpacing).toBe(1);
    expect(e.hooks).toBe(HOOKS.toLowerCase());
  });

  it("ERC-721 Transfer (4 topics, tokenId indexed) → null (not a fungible balance)", () => {
    const e = decodeTransfer({ address: POOL, topics: [TRANSFER, topicAddr(A), topicAddr(B), topicNum(7n)], data: "0x", blockNumber: "0x1" });
    expect(e).toBeNull();
  });
});
