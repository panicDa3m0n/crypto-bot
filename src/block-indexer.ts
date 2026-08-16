import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";

/**
 * BlockIndexer — the STARTING POINT of the whole system.
 *
 * It processes every new Base block ONCE (one topic-filtered `eth_getLogs` per block on the public feed
 * base.org, with fallback to the other public RPCs), derives state LOCALLY, and writes the DB. From then
 * on everything else reads the DB, never the chain — chain-sourced data is ALWAYS the indexer's job.
 *
 * Per block it extracts, in one call:
 *   - Uniswap-V3 `Swap` (sqrtPriceX96 = the pool's exact post-swap price) and V2 `Sync` (reserves) →
 *     recompute the traded token's USD price via the Chainlink ETH/USD anchor → `token_prices`.
 *   - `PairCreated`/`PoolCreated` → new pools + tokens → `entities` (real-time discovery).
 *
 * Robust by construction: a persisted cursor (last block processed) + gap backfill (chunked ≤10 for the
 * public getLogs range) → no block silently skipped; the Chainlink anchor makes the USD base rock-solid.
 */

const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V2_SYNC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";
const PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9"; // V2 factory
const POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"; // V3 factory
// Morpho Blue — position lifecycle. The indexer discovers/closes borrowers LIVE from these logs (the
// Morpho API stays as periodic seed + cross-check). Topics verified via toEventSelector; Borrow &
// Liquidate match the constants already in position-registry.
// Discovery on Borrow (debt appears → liquidation-relevant), close on Liquidate, params from
// CreateMarket. SupplyCollateral is intentionally NOT tracked: collateral without debt isn't
// liquidatable, and exact amounts come from the per-block RPC confirm anyway.
const MORPHO_CREATE_MARKET = "0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac";
const MORPHO_BORROW = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
const MORPHO_LIQUIDATE = "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41";
const MORPHO_TOPICS = new Set([MORPHO_CREATE_MARKET, MORPHO_BORROW, MORPHO_LIQUIDATE]);
const MORPHO_MARKET_ABI = parseAbi(["function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)"]);
const POOL_META_ABI = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)"]);
const BOOTSTRAP_CAP = 20; // max unknown pools to bootstrap per block (self-limits any first-run burst)
const TOPIC0S = [V3_SWAP, V2_SYNC, PAIR_CREATED, POOL_CREATED, MORPHO_CREATE_MARKET, MORPHO_BORROW, MORPHO_LIQUIDATE];
const CHUNK = 10;            // public getLogs range cap
const ANCHOR_TTL_MS = 30_000; // refresh ETH/USD at most this often

type RawLog = { address: string; topics: string[]; data: string; blockNumber: string };
type RawRpc = { request: (a: { method: string; params: unknown }) => Promise<unknown> };

export class BlockIndexer {
  private running = false;
  private cursor = 0;
  private ethUsd = 0;
  private ethUsdAt = 0;
  private ticks = 0;
  private timer?: NodeJS.Timeout;
  private unwatch?: () => void;
  private readonly weth: string;
  private readonly usdc: string;
  private readonly morpho: string | null;
  private readonly marketCache = new Map<string, { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: bigint }>();

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly logger: Logger
  ) {
    this.weth = config.WBERA_ADDRESS.toLowerCase();
    this.usdc = config.USDC_E_ADDRESS.toLowerCase();
    this.morpho = config.MORPHO_CORE ? config.MORPHO_CORE.toLowerCase() : null;
  }

  async start(): Promise<void> {
    if (!this.config.INDEXER_ENABLED) { this.logger.info("block-indexer disabled"); return; }
    const head = await this.head().catch(() => 0);
    const stored = await this.db.getIndexerCursor(this.config.CHAIN_ID).catch(() => null);
    this.cursor = stored ?? Math.max(0, head - 1); // fresh start: from the current head, not genesis
    await this.refreshAnchor();
    // Trigger: WS heads (primary) + a poll heartbeat (fallback if the WS drops). Overlaps are no-ops.
    this.unwatch = this.chain.watchHeads(() => void this.tick().catch((e) => this.logger.error({ err: e }, "indexer tick failed")), (err) => this.logger.warn({ err: err.message }, "indexer heads WS error"));
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.error({ err: e }, "indexer tick failed")), this.config.INDEXER_POLL_MS);
    this.logger.info({ cursor: this.cursor, head, ethUsd: this.ethUsd, source: this.config.BLOCK_SOURCE }, "block-indexer started");
  }

  stop(): void { if (this.timer) clearInterval(this.timer); if (this.unwatch) this.unwatch(); }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (Date.now() - this.ethUsdAt > ANCHOR_TTL_MS) await this.refreshAnchor();
      const head = await this.head();
      if (head <= this.cursor) return;
      const target = Math.min(head, this.cursor + this.config.INDEXER_MAX_CATCHUP); // cap catch-up per tick
      const t0 = Date.now();
      let processed = 0, swaps = 0, discovered = 0, lending = 0;
      let from = this.cursor + 1;
      while (from <= target) {
        const to = Math.min(from + CHUNK - 1, target);
        const r = await this.processRange(from, to);
        processed += to - from + 1; swaps += r.swaps; discovered += r.discovered; lending += r.lending;
        from = to + 1;
      }
      if (this.config.DEBUG_KEEP_RAW_BLOCKS && ++this.ticks % 200 === 0) await this.db.pruneRawBlocks(this.config.CHAIN_ID, this.config.INDEXER_RAW_RETENTION_HOURS).catch(() => undefined);
      if (processed > 0) this.logger.info({ upTo: this.cursor, blocks: processed, swaps, discovered, lending, ethUsd: this.ethUsd, ms: Date.now() - t0, lag: head - this.cursor }, "indexed blocks");
    } finally {
      this.running = false;
    }
  }

  private async processRange(from: number, to: number): Promise<{ swaps: number; discovered: number; lending: number }> {
    const logs = await this.getLogs(from, to);
    const byBlock = new Map<number, RawLog[]>();
    for (const l of logs) { const b = Number(BigInt(l.blockNumber)); const arr = byBlock.get(b) ?? []; arr.push(l); byBlock.set(b, arr); }
    let swaps = 0, discovered = 0, lending = 0;
    for (let b = from; b <= to; b++) {
      const bl = byBlock.get(b) ?? [];
      const r = await this.processBlock(b, bl);
      swaps += r.swaps; discovered += r.discovered; lending += r.lending;
      this.cursor = b;
    }
    await this.db.setIndexerCursor(this.config.CHAIN_ID, this.cursor).catch(() => undefined);
    return { swaps, discovered, lending };
  }

  private async processBlock(block: number, logs: RawLog[]): Promise<{ swaps: number; discovered: number; lending: number }> {
    // 1) Discovery: new pools/tokens from factory events.
    let discovered = 0;
    for (const l of logs) {
      const t0 = (l.topics[0] ?? "").toLowerCase();
      if (t0 === PAIR_CREATED || t0 === POOL_CREATED) {
        const token0 = addrFromTopic(l.topics[1]); const token1 = addrFromTopic(l.topics[2]);
        const isV3 = t0 === POOL_CREATED;
        const pool = isV3 ? wordAddr(l.data, 1) : wordAddr(l.data, 0);
        // V3 PoolCreated(token0, token1, fee indexed, tickSpacing, pool): fee = topics[3]. Needed for
        // exact sized amountOut (price-oracle.feePpm) so non-0.3% tiers don't default to 3000ppm.
        const fee = isV3 && l.topics[3] ? Number(BigInt(l.topics[3])) : undefined;
        if (pool && token0 && token1) {
          await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: pool, kind: "pool", meta: { token0, token1, archetype: isV3 ? "v3" : "v2", fee, discoveredBy: "indexer" }, source: "indexer" }).catch(() => undefined);
          await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: token0, kind: "token", source: "indexer" }).catch(() => undefined);
          await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: token1, kind: "token", source: "indexer" }).catch(() => undefined);
          // The emitting factory is a DEX — parity with the scanner's opportunistic dex discovery.
          await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: l.address.toLowerCase(), kind: "dex", meta: { role: "factory", discoveredBy: "indexer" }, source: "indexer" }).catch(() => undefined);
          discovered += 1;
        }
      }
    }

    // 1b) Lending (Morpho): discover borrowers on Borrow, close on Liquidate, learn params on
    // CreateMarket — the inventory becomes chain-sourced (API drops to seed + cross-check). Same
    // getLogs call: Morpho topics ride the global topic0 filter; we keep only logs from the Morpho core.
    let lending = 0;
    if (this.morpho) {
      for (const l of logs) {
        if (l.address.toLowerCase() !== this.morpho) continue;
        const t0 = (l.topics[0] ?? "").toLowerCase();
        if (MORPHO_TOPICS.has(t0) && await this.handleMorpho(t0, l)) lending += 1;
      }
    }

    // 2) Prices: swaps (V3) + syncs (V2) → the pool's price → USD via anchor.
    const priced = logs.filter((l) => { const t = (l.topics[0] ?? "").toLowerCase(); return t === V3_SWAP || t === V2_SYNC; });
    if (!priced.length) return { swaps: 0, discovered, lending };
    const poolAddrs = [...new Set(priced.map((l) => l.address.toLowerCase()))];
    const pools = await this.db.poolInfoBatch(this.config.CHAIN_ID, poolAddrs);
    // Self-sufficient discovery: a pool that swapped but isn't in entities (its Create predates the
    // indexer and no scanner classified it) — bootstrap it ONCE (token0/token1/archetype) so the indexer
    // discovers + prices it with no dependence on any other scanner. Capped/block to bound a first-run burst.
    const unknown: Array<{ addr: string; archetype: string }> = [];
    for (const l of priced) {
      const a = l.address.toLowerCase();
      if (pools.has(a) || unknown.some((u) => u.addr === a)) continue;
      unknown.push({ addr: a, archetype: (l.topics[0] ?? "").toLowerCase() === V3_SWAP ? "v3" : "v2" });
    }
    for (const u of unknown.slice(0, BOOTSTRAP_CAP)) { const info = await this.bootstrapPool(u.addr, u.archetype); if (info) pools.set(u.addr, info); }
    const tokenSet = new Set<string>();
    for (const p of pools.values()) { if (p.token0) tokenSet.add(p.token0.toLowerCase()); if (p.token1) tokenSet.add(p.token1.toLowerCase()); }
    const meta = await this.db.tokenMeta(this.config.CHAIN_ID, [...tokenSet]).catch(() => new Map());
    const dec = (a: string): number | null => { if (a === this.weth) return 18; if (a === this.usdc) return 6; return (meta as Map<string, { decimals: number | null }>).get(a)?.decimals ?? null; };

    // 2a) Pool state — from the SAME logs, independent of token metadata. V2 Sync = (r0,r1);
    // V3 Swap = (sqrtPriceX96, liquidity). Last log in the block wins (= latest state). This is the
    // DB source that makes PriceOracle's reserves/amountOut DB-read instead of RPC.
    const state = new Map<string, { pool: string; archetype: string; r0?: bigint; r1?: bigint; sqrtPrice?: bigint; liquidity?: bigint; block: number }>();
    const rows = new Map<string, number>(); // token → latest USD price this block (last swap wins)
    let swaps = 0;
    for (const l of priced) {
      const pool = l.address.toLowerCase();
      const isSwap = (l.topics[0] ?? "").toLowerCase() === V3_SWAP;
      if (isSwap) { const sp = word(l.data, 2), liq = word(l.data, 3); if (sp && sp > 0n) state.set(pool, { pool, archetype: "v3", sqrtPrice: sp, liquidity: liq ?? undefined, block }); }
      else { const r0 = word(l.data, 0), r1 = word(l.data, 1); if (r0 != null && r1 != null) state.set(pool, { pool, archetype: "v2", r0, r1, block }); }

      const info = pools.get(pool);
      if (!info?.token0 || !info.token1) continue; // unknown pool — discovery adds it; priced next time
      const t0 = info.token0.toLowerCase(), t1 = info.token1.toLowerCase();
      const d0 = dec(t0), d1 = dec(t1);
      if (d0 == null || d1 == null) continue; // decimals unknown → defer (enricher fills them)
      const p0in1 = isSwap ? priceV3(l.data, d0, d1) : priceV2(l.data, d0, d1); // token0 price in token1 (human)
      if (p0in1 == null || !(p0in1 > 0) || !Number.isFinite(p0in1)) continue;
      swaps += 1;
      // Anchor to USD: one side must be WETH or USDC (the quote). Price only the NON-quote token.
      const q1 = this.quoteUsd(t1), q0 = this.quoteUsd(t0);
      if (q1 != null) rows.set(t0, p0in1 * q1);
      else if (q0 != null) rows.set(t1, (1 / p0in1) * q0);
      // else: token/token pool with no direct anchor — skip (v1).
    }

    if (this.config.DEBUG_KEEP_RAW_BLOCKS && logs.length) await this.db.saveRawBlock(this.config.CHAIN_ID, block, logs).catch(() => undefined);
    if (state.size) await this.db.upsertPoolState(this.config.CHAIN_ID, [...state.values()]).catch((e) => this.logger.debug({ err: e }, "indexer pool_state upsert failed"));
    if (rows.size) {
      await this.db.upsertTokenPrices(this.config.CHAIN_ID, [...rows.entries()].map(([token, priceUsd]) => ({ token, priceUsd, confidence: 0.95, source: "indexer" })), { tauFastSec: this.config.VOL_TAU_FAST_SEC, tauSlowSec: this.config.VOL_TAU_SLOW_SEC }).catch((e) => this.logger.debug({ err: e }, "indexer price upsert failed"));
    }
    return { swaps, discovered, lending };
  }

  /** Morpho position lifecycle → chain-sourced inventory. Returns true if the log was actioned. */
  private async handleMorpho(t0: string, l: RawLog): Promise<boolean> {
    const id = l.topics[1]?.toLowerCase(); if (!id) return false;
    if (t0 === MORPHO_CREATE_MARKET) {
      const loanToken = wordAddr(l.data, 0), collateralToken = wordAddr(l.data, 1), oracle = wordAddr(l.data, 2), irm = wordAddr(l.data, 3), lltv = word(l.data, 4);
      if (loanToken && collateralToken && oracle && irm && lltv != null) {
        const m = { loanToken, collateralToken, oracle, irm, lltv };
        this.marketCache.set(id, m);
        await this.db.upsertLendingMarket({ chainId: this.config.CHAIN_ID, protocol: "morpho", marketId: id, ...m }).catch(() => undefined);
      }
      return true;
    }
    if (t0 === MORPHO_LIQUIDATE) {
      const borrower = addrFromTopic(l.topics[3]); if (!borrower) return false;
      await this.db.closeLendingPosition(this.config.CHAIN_ID, "morpho", id, borrower, "Liquidate event (indexer)").catch(() => undefined);
      return true;
    }
    // Borrow: onBehalf = topics[2] is the borrower. Debt just appeared → track it (tier 'pending';
    // the registry classifies + the per-block monitor confirms exact HF on the near band).
    const borrower = addrFromTopic(l.topics[2]); if (!borrower) return false;
    const m = await this.marketParams(id); if (!m) return false;
    await this.db.upsertLendingPosition({
      chainId: this.config.CHAIN_ID, protocol: "morpho", marketId: id, borrower,
      collateralToken: m.collateralToken, loanToken: m.loanToken, lltv: Number(m.lltv) / 1e18,
      meta: { oracle: m.oracle, irm: m.irm, lltv: m.lltv.toString(), discoveredBy: "indexer" }
    }).catch(() => undefined);
    return true;
  }

  /** Morpho market params: memory cache → DB → one-shot idToMarketParams bootstrap (market created
   * before the indexer started), then persist + cache. Few markets, so bootstrap is not a storm. */
  private async marketParams(id: string): Promise<{ loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: bigint } | null> {
    const c = this.marketCache.get(id); if (c) return c;
    const db = await this.db.getLendingMarket(this.config.CHAIN_ID, "morpho", id).catch(() => null);
    if (db) { this.marketCache.set(id, db); return db; }
    if (!this.morpho) return null;
    try {
      const r = await this.chain.fallback.readContract({ address: this.morpho as Address, abi: MORPHO_MARKET_ABI, functionName: "idToMarketParams", args: [id as `0x${string}`] }) as readonly [string, string, string, string, bigint];
      const m = { loanToken: r[0].toLowerCase(), collateralToken: r[1].toLowerCase(), oracle: r[2].toLowerCase(), irm: r[3].toLowerCase(), lltv: r[4] };
      if (m.collateralToken === "0x0000000000000000000000000000000000000000") return null;
      this.marketCache.set(id, m);
      await this.db.upsertLendingMarket({ chainId: this.config.CHAIN_ID, protocol: "morpho", marketId: id, ...m }).catch(() => undefined);
      return m;
    } catch (e) { this.logger.debug({ err: e, id }, "idToMarketParams bootstrap failed"); return null; }
  }

  /** One-shot discovery of a pool seen swapping but absent from entities: read token0/token1(/fee),
   * upsert the pool + its tokens, and return its meta so THIS block can already price it. */
  private async bootstrapPool(addr: string, archetype: string): Promise<{ token0: string; token1: string; archetype: string } | null> {
    try {
      const [t0, t1] = await Promise.all([
        this.chain.fallback.readContract({ address: addr as Address, abi: POOL_META_ABI, functionName: "token0" }) as Promise<string>,
        this.chain.fallback.readContract({ address: addr as Address, abi: POOL_META_ABI, functionName: "token1" }) as Promise<string>
      ]);
      const token0 = t0.toLowerCase(), token1 = t1.toLowerCase();
      const fee = archetype === "v3" ? await this.chain.fallback.readContract({ address: addr as Address, abi: POOL_META_ABI, functionName: "fee" }).then(Number).catch(() => undefined) : undefined;
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: addr, kind: "pool", meta: { token0, token1, archetype, fee, discoveredBy: "indexer-swap" }, source: "indexer" }).catch(() => undefined);
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: token0, kind: "token", source: "indexer" }).catch(() => undefined);
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: token1, kind: "token", source: "indexer" }).catch(() => undefined);
      return { token0, token1, archetype };
    } catch (e) { this.logger.debug({ err: e, pool: addr }, "pool bootstrap failed"); return null; }
  }

  /** USD value of one unit of a QUOTE token (WETH via Chainlink, USDC = $1). null if not a quote. */
  private quoteUsd(token: string): number | null {
    if (token === this.weth) return this.ethUsd > 0 ? this.ethUsd : null;
    if (token === this.usdc) return 1;
    return null;
  }

  private async refreshAnchor(): Promise<void> {
    try {
      const res = await (this.chain.fallback as unknown as RawRpc).request({ method: "eth_call", params: [{ to: this.config.CHAINLINK_ETH_USD_FEED, data: "0xfeaf968c" }, "latest"] }) as string; // latestRoundData()
      if (res && res.length >= 194) { this.ethUsd = Number(BigInt("0x" + res.slice(2 + 64, 2 + 128))) / 1e8; this.ethUsdAt = Date.now(); }
    } catch (e) { this.logger.debug({ err: e }, "anchor refresh failed"); }
  }

  private async head(): Promise<number> {
    const r = await (this.chain.fallback as unknown as RawRpc).request({ method: "eth_blockNumber", params: [] }).catch(() => (this.chain.secondary as unknown as RawRpc).request({ method: "eth_blockNumber", params: [] })) as string;
    return Number(BigInt(r));
  }

  /** Topic-filtered getLogs for [from,to] on the public feed, with fallback across RPCs. */
  private async getLogs(from: number, to: number): Promise<RawLog[]> {
    const params = [{ fromBlock: hex(from), toBlock: hex(to), topics: [TOPIC0S] }];
    let lastErr: unknown;
    for (const client of [this.chain.fallback, this.chain.secondary, this.chain.primary]) {
      try { return await (client as unknown as RawRpc).request({ method: "eth_getLogs", params }) as RawLog[]; }
      catch (e) { lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error("getLogs failed on all RPCs");
  }
}

// --- decoding helpers -------------------------------------------------------

function hex(n: number): string { return "0x" + n.toString(16); }
/** The Nth 32-byte word of `data` as a BigInt (null if data too short). */
function word(data: string, i: number): bigint | null { const s = 2 + i * 64; return data.length >= s + 64 ? BigInt("0x" + data.slice(s, s + 64)) : null; }
function addrFromTopic(topic: string | undefined): string | null { return topic && topic.length >= 42 ? "0x" + topic.slice(-40).toLowerCase() : null; }
/** address stored in the Nth 32-byte word of `data` (right-aligned). */
function wordAddr(data: string, word: number): string | null { const s = 2 + word * 64; return data.length >= s + 64 ? "0x" + data.slice(s + 24, s + 64).toLowerCase() : null; }

/** V3 Swap: price of 1 token0 in token1 (human), from sqrtPriceX96 (3rd data word). */
function priceV3(data: string, dec0: number, dec1: number): number | null {
  if (data.length < 2 + 194) return null;
  const sqrtP = BigInt("0x" + data.slice(2 + 128, 2 + 192)); // word[2]
  if (sqrtP <= 0n) return null;
  const r = Number(sqrtP) / 2 ** 96;       // = sqrt(price_raw)
  const priceRaw = r * r;                  // token1/token0 in raw units
  return priceRaw * 10 ** (dec0 - dec1);   // token1(human) per token0(human)
}

/** V2 Sync: price of 1 token0 in token1 (human), from reserves. */
function priceV2(data: string, dec0: number, dec1: number): number | null {
  if (data.length < 2 + 128) return null;
  const r0 = Number(BigInt("0x" + data.slice(2, 66))) / 10 ** dec0;
  const r1 = Number(BigInt("0x" + data.slice(66, 130))) / 10 ** dec1;
  if (!(r0 > 0)) return null;
  return r1 / r0;
}
