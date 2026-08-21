/**
 * EVENT REGISTRY — the SINGLE, unified decoding layer for the block stream. One place maps every
 * on-chain event we understand (topic0 → Decoder) to a NORMALIZED `DecodedEvent`. The indexer decodes
 * each log ONCE here, then the block-level reducers (pricing, state, stats, discovery, liquidity)
 * consume the normalized events — never re-reading raw bytes or re-branching on topics. Adding a new
 * venue/event = add ONE decoder here; nothing else changes. Decoders are PURE (log → event | null).
 */

export type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash?: string; logIndex?: string };

// ERC-20 Transfer(from indexed, to indexed, value). HIGH-VOLUME (~8k/block) — NOT in EVENT_DECODERS (we
// never want to allocate an event per transfer); the indexer cheap-filters raw logs for the WALLET first,
// then decodes only those via this helper. Feeds wallet_transactions (history + which tokens to read).
export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export function decodeTransfer(log: RawLog): { token: string; from: string; to: string; value: bigint } | null {
  if ((log.topics.length ?? 0) !== 3) return null; // 3 topics = ERC-20 (from,to indexed, value in data); 4 = ERC-721 NFT → skip
  const from = addrFromTopic(log.topics[1]), to = addrFromTopic(log.topics[2]);
  if (!from || !to) return null;
  return { token: log.address.toLowerCase(), from, to, value: word(log.data, 0) ?? 0n };
}

// ── topic0 signatures (single source of truth) ────────────────────────────────
export const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const PANCAKE_V3_SWAP = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83"; // same layout + trailing protocolFees
export const V2_SYNC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";
export const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
export const PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
export const POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
export const AERO_SYNC = "0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a";
export const AERO_SWAP = "0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b";
export const AERO_POOL_CREATED = "0x2128d88d14c80cb081c1252a5acff7a264671bf199ce226b53788fb26065005e";
export const UNIV3_MINT = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
export const UNIV3_BURN = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";
// Uniswap V4 — a SINGLETON PoolManager: every pool lives in one contract, keyed by PoolId (bytes32) not an
// address. Swap/Initialize carry the poolId in topics[1]; currency 0x0 = native ETH (mapped to WETH by the
// indexer). We price V4 like V3 (sqrtPrice) — the poolId is the "pool address" (a 66-char hex key).
export const V4_INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
// Verified against the live PoolManager on Base: 45 of these in a 10-block window, decoded with the ABI
// decoder to confirm the field layout (ticks inside the domain, signed delta).
export const V4_MODIFY_LIQUIDITY = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
export const MORPHO_CREATE_MARKET = "0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac";
export const MORPHO_BORROW = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
export const MORPHO_LIQUIDATE = "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41";

export const MORPHO_TOPICS = new Set([MORPHO_CREATE_MARKET, MORPHO_BORROW, MORPHO_LIQUIDATE]);
/** Topics for the FILTERED sync path (bulk historical catch-up). Real-time uses full getBlockReceipts. */
export const TOPIC0S = [V3_SWAP, PANCAKE_V3_SWAP, V2_SYNC, V2_SWAP, AERO_SYNC, AERO_SWAP, PAIR_CREATED, POOL_CREATED, AERO_POOL_CREATED, UNIV3_MINT, UNIV3_BURN, V4_SWAP, V4_INITIALIZE, V4_MODIFY_LIQUIDITY, MORPHO_CREATE_MARKET, MORPHO_BORROW, MORPHO_LIQUIDATE];

// ── byte helpers (pure) ───────────────────────────────────────────────────────
/** The Nth 32-byte word of `data` as a BigInt (null if data too short). */
export function word(data: string, i: number): bigint | null { const s = 2 + i * 64; return data.length >= s + 64 ? BigInt("0x" + data.slice(s, s + 64)) : null; }
/** The Nth word as a SIGNED int256 (V3 Swap amount0/amount1 can be negative = out of the pool). */
export function sword(data: string, i: number): bigint | null { const u = word(data, i); return u == null ? null : (u >= (1n << 255n) ? u - (1n << 256n) : u); }
export function addrFromTopic(topic: string | undefined): string | null { return topic && topic.length >= 42 ? "0x" + topic.slice(-40).toLowerCase() : null; }
/** address stored in the Nth 32-byte word of `data` (right-aligned). */
export function wordAddr(data: string, i: number): string | null { const s = 2 + i * 64; return data.length >= s + 64 ? "0x" + data.slice(s + 24, s + 64).toLowerCase() : null; }
/** A topic interpreted as a signed int24 tick (sign-extended to 256 bits on-chain). */
export function int24FromTopic(topic: string | undefined): number | null { if (!topic) return null; const u = BigInt(topic); return Number(u >= (1n << 255n) ? u - (1n << 256n) : u); }

export type PoolArchetype = "v2" | "aerodrome";

// ── normalized decoded events ─────────────────────────────────────────────────
export type DecodedEvent =
  | { kind: "pool_created"; pool: string; token0: string; token1: string; fee?: number; archetype: string; factory: string; tickSpacing?: number; hooks?: string } // tickSpacing/hooks: V4 only (for future V4 execution)
  | { kind: "swap_v3"; pool: string; sqrtPrice: bigint; liquidity: bigint | null; amount0: bigint; amount1: bigint; recipient: string | null; v4?: boolean } // Uniswap V3 + Pancake V3 + forks + V4 (identical sqrtPrice math); v4 = pool is a V4 poolId, not an address
  | { kind: "sync"; pool: string; archetype: PoolArchetype; r0: bigint; r1: bigint }
  | { kind: "swap_v2"; pool: string; archetype: PoolArchetype; a0In: bigint; a1In: bigint; a0Out: bigint; a1Out: bigint; to: string | null } // to = the trading wallet (flow)
  | { kind: "liquidity_v3"; pool: string; liquidityDelta: bigint; tickLower: number; tickUpper: number } // Mint (+) / Burn (−) → per-tick liquidity map
  | { kind: "morpho"; topic0: string; log: RawLog };

export type Decoder = (log: RawLog) => DecodedEvent | null;

/**
 * The archetypes whose LIQUIDITY events we actually decode into `liquidity_v3` (per-tick deltas). Certifying a
 * pool's tick map as "complete from birth because we watch it live" is only true for these — for anything else
 * the claim is a silent lie, which is exactly what happened to V4 for 19k pools: certified on Initialize while
 * ModifyLiquidity was never decoded. Any code that certifies from live observation MUST gate on this set, so
 * adding an archetype without its liquidity decoder cannot quietly re-introduce the same falsehood.
 */
export const LIQUIDITY_INDEXED_ARCHETYPES: ReadonlySet<string> = new Set(["v3", "v4"]);

const decodeV3Swap: Decoder = (l) => {
  const sp = word(l.data, 2); if (sp == null || sp <= 0n) return null; // sqrtPriceX96
  // Swap(sender⊙, recipient⊙, amount0, amount1, sqrtPriceX96, liquidity, tick): recipient = topics[2] = the wallet.
  return { kind: "swap_v3", pool: l.address.toLowerCase(), sqrtPrice: sp, liquidity: word(l.data, 3), amount0: sword(l.data, 0) ?? 0n, amount1: sword(l.data, 1) ?? 0n, recipient: addrFromTopic(l.topics[2]) };
};
const decodeSync = (archetype: PoolArchetype): Decoder => (l) => {
  const r0 = word(l.data, 0), r1 = word(l.data, 1);
  return r0 != null && r1 != null ? { kind: "sync", pool: l.address.toLowerCase(), archetype, r0, r1 } : null;
};
const decodeSwapV2 = (archetype: PoolArchetype): Decoder => (l) => ({
  // Swap(sender⊙, amount0In, amount1In, amount0Out, amount1Out, to⊙): to = topics[2] = the wallet.
  kind: "swap_v2", pool: l.address.toLowerCase(), archetype,
  a0In: word(l.data, 0) ?? 0n, a1In: word(l.data, 1) ?? 0n, a0Out: word(l.data, 2) ?? 0n, a1Out: word(l.data, 3) ?? 0n, to: addrFromTopic(l.topics[2])
});
const decodePoolCreated = (kind: "v3" | "v2" | "aero"): Decoder => (l) => {
  const token0 = addrFromTopic(l.topics[1]), token1 = addrFromTopic(l.topics[2]);
  const isV3 = kind === "v3", isAero = kind === "aero";
  const pool = isV3 ? wordAddr(l.data, 1) : wordAddr(l.data, 0); // V3: pool=word1 (after tickSpacing); V2/Aero: pool=word0
  if (!pool || !token0 || !token1) return null;
  const fee = isV3 && l.topics[3] ? Number(BigInt(l.topics[3])) : undefined;
  const aeroStable = isAero && l.topics[3] ? BigInt(l.topics[3]) !== 0n : false;
  const archetype = isV3 ? "v3" : isAero ? (aeroStable ? "aerodrome-stable" : "aerodrome") : "v2";
  return { kind: "pool_created", pool, token0, token1, fee, archetype, factory: l.address.toLowerCase() };
};
// UniV3 Mint(sender, owner⊙, tickLower⊙, tickUpper⊙, amount, amount0, amount1): liquidity = data word1 (+).
const decodeMint: Decoder = (l) => {
  const amt = word(l.data, 1), tl = int24FromTopic(l.topics[2]), tu = int24FromTopic(l.topics[3]);
  return amt != null && tl != null && tu != null ? { kind: "liquidity_v3", pool: l.address.toLowerCase(), liquidityDelta: amt, tickLower: tl, tickUpper: tu } : null;
};
// UniV3 Burn(owner⊙, tickLower⊙, tickUpper⊙, amount, amount0, amount1): same indexed layout as Mint
// (owner=topic1, tickLower=topic2, tickUpper=topic3); liquidity = data word0 (−, removed).
const decodeBurn: Decoder = (l) => {
  const amt = word(l.data, 0), tl = int24FromTopic(l.topics[2]), tu = int24FromTopic(l.topics[3]);
  return amt != null && tl != null && tu != null ? { kind: "liquidity_v3", pool: l.address.toLowerCase(), liquidityDelta: -amt, tickLower: tl, tickUpper: tu } : null;
};
const decodeMorpho = (t0: string): Decoder => (l) => ({ kind: "morpho", topic0: t0, log: l });
// V4 Swap(id⊙, sender⊙, amount0(int128), amount1(int128), sqrtPriceX96, liquidity, tick, fee): the pool key
// is the poolId (topics[1], a full bytes32), NOT the emitter (the singleton PoolManager). Priced like V3.
const decodeV4Swap: Decoder = (l) => {
  const id = l.topics[1]; if (!id || id.length < 66) return null;
  const sp = word(l.data, 2); if (sp == null || sp <= 0n) return null; // sqrtPriceX96 (word2)
  return { kind: "swap_v3", pool: id.toLowerCase(), sqrtPrice: sp, liquidity: word(l.data, 3), amount0: sword(l.data, 0) ?? 0n, amount1: sword(l.data, 1) ?? 0n, recipient: addrFromTopic(l.topics[2]), v4: true };
};
// V4 ModifyLiquidity(id⊙, sender⊙, tickLower, tickUpper, liquidityDelta, salt): V4's Mint AND Burn in one
// signed event — this is the per-tick liquidity map for V4, exactly what Mint/Burn are for V3. It was never
// decoded, so `tick_liquidity` held ZERO V4 rows while 19k V4 pools were certified as having a complete tick
// map. Unlike V3 the ticks are in DATA, not topics (only id/sender are indexed), and a delta of 0 is a
// fee-collection call — a real no-op for the map, dropped so it cannot advance a pool's coverage for free.
const decodeV4ModifyLiquidity: Decoder = (l) => {
  const id = l.topics[1]; if (!id || id.length < 66) return null;
  const tl = sword(l.data, 0), tu = sword(l.data, 1), delta = sword(l.data, 2);
  if (tl == null || tu == null || delta == null || delta === 0n) return null;
  return { kind: "liquidity_v3", pool: id.toLowerCase(), liquidityDelta: delta, tickLower: Number(tl), tickUpper: Number(tu) };
};
// V4 Initialize(id⊙, currency0⊙, currency1⊙, fee, tickSpacing, hooks, sqrtPriceX96, tick): the "PoolCreated"
// of V4 — maps a poolId to its currencies/fee/tickSpacing/hooks. currency 0x0 = native ETH (indexer→WETH).
export const decodeV4Init: Decoder = (l) => {
  const id = l.topics[1], c0 = addrFromTopic(l.topics[2]), c1 = addrFromTopic(l.topics[3]);
  if (!id || id.length < 66 || !c0 || !c1) return null;
  const fee = word(l.data, 0), ts = sword(l.data, 1);
  return { kind: "pool_created", pool: id.toLowerCase(), token0: c0, token1: c1, fee: fee != null ? Number(fee) : undefined, archetype: "v4", factory: l.address.toLowerCase(), tickSpacing: ts != null ? Number(ts) : undefined, hooks: wordAddr(l.data, 2) ?? undefined };
};

export const EVENT_DECODERS: Map<string, Decoder> = new Map([
  [V3_SWAP, decodeV3Swap],
  [PANCAKE_V3_SWAP, decodeV3Swap], // Pancake V3: same sqrtPrice(word2)/liquidity(word3) layout → priced like UniV3
  [V2_SYNC, decodeSync("v2")],
  [AERO_SYNC, decodeSync("aerodrome")],
  [V2_SWAP, decodeSwapV2("v2")],
  [AERO_SWAP, decodeSwapV2("aerodrome")],
  [PAIR_CREATED, decodePoolCreated("v2")],
  [POOL_CREATED, decodePoolCreated("v3")],
  [AERO_POOL_CREATED, decodePoolCreated("aero")],
  [UNIV3_MINT, decodeMint],
  [UNIV3_BURN, decodeBurn],
  [V4_SWAP, decodeV4Swap],
  [V4_INITIALIZE, decodeV4Init],
  [V4_MODIFY_LIQUIDITY, decodeV4ModifyLiquidity],
  [MORPHO_CREATE_MARKET, decodeMorpho(MORPHO_CREATE_MARKET)],
  [MORPHO_BORROW, decodeMorpho(MORPHO_BORROW)],
  [MORPHO_LIQUIDATE, decodeMorpho(MORPHO_LIQUIDATE)]
]);

/** Decode one log via the registry. null = an event type we don't (yet) understand. */
export function decodeLog(log: RawLog): DecodedEvent | null {
  const d = EVENT_DECODERS.get((log.topics[0] ?? "").toLowerCase());
  return d ? d(log) : null;
}
