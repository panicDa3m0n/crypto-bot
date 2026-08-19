import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import {
  decodeLog, decodeTransfer, TOPIC0S, TRANSFER, MORPHO_CREATE_MARKET, MORPHO_LIQUIDATE,
  word, wordAddr, addrFromTopic, type RawLog, type DecodedEvent
} from "./indexer/events.js";

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

// Decoding (topic0 signatures, byte helpers, DecodedEvent, EVENT_DECODERS) now lives in ONE place —
// src/indexer/events.ts — the unified registry. This indexer decodes each log there, then reduces the
// normalized events into DB writes. Only block-indexer-specific constants remain here.
const MORPHO_MARKET_ABI = parseAbi(["function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)"]);
// Sanity bounds: a thin pool at an extreme tick can quote an absurd price; unfiltered it poisons the
// token's price AND (× that price) its volume, and propagates through multi-hop. No real Base token
// unit exceeds these, so we simply refuse to write out-of-range prices / implausible single-swap volume.
const MAX_PRICE_USD = 10_000_000;    // ~158× cbBTC — well above any legitimate per-unit price
const MAX_SWAP_USD = 1_000_000_000;  // reject a single swap valued over $1B as a decode/decimals artifact
const sanePrice = (p: number | null | undefined): p is number => p != null && Number.isFinite(p) && p > 0 && p < MAX_PRICE_USD;
const CHUNK = 10;            // public getLogs range cap
const ZERO_ADDR = "0x0000000000000000000000000000000000000000"; // V4 native-ETH currency sentinel → WETH
const ANCHOR_TTL_MS = 30_000; // refresh ETH/USD at most this often
const Q96 = 2n ** 96n;

type RawRpc = { request: (a: { method: string; params: unknown }) => Promise<unknown> };

export class BlockIndexer {
  private running = false;
  private cursor = 0;
  private ethUsd = 0;
  private ethUsdAt = 0;
  private ticks = 0;
  private timer?: NodeJS.Timeout;
  private unwatch?: () => void;
  private headBlock = 0;       // latest network head seen (for the token_stats freshness guard)
  private syncedFlag = false;  // false while catching up (cold-start / resync) → Scarlet is gated
  private syncAnnounced = false; // the ONE-TIME first-head event (flag resync set + open the startup gate)
  private readyResolve!: () => void;
  /** Resolves the FIRST time the indexer reaches head — the startup gate Scarlet awaits before operating. */
  readonly ready: Promise<void> = new Promise((r) => { this.readyResolve = r; });
  private readonly weth: string;
  private readonly usdc: string;
  private readonly morpho: string | null;
  private readonly walletLower: string | null;
  private watchedWallets = new Set<string>(); // OUR wallet ∪ followed smart-money — all fed to wallet_transactions
  /** Event-driven hook (Canale wallet): fired with the tokens a wallet Transfer touched THIS block, so
   * WalletHoldings re-reads just those balances FROM CHAIN. Injected by index.ts; unset = no wallet wired. */
  onWalletTransfer?: (tokens: string[]) => void;
  /** PUSH to the enricher: fired when a block wrote a new/incomplete entity (bare pool/token) → the enricher
   * drains the buffer NOW instead of waiting for its idle poll. Injected by index.ts (= enricher.nudge). */
  onDiscovery?: () => void;
  private readonly marketCache = new Map<string, { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: bigint }>();

  /** TRUE when the indexer is at the chain head (data is fresh). While FALSE it's realigning (cold-start or
   * resync after a lost block) and Scarlet must WAIT — deciding on stale data is worse than not acting. */
  get synced(): boolean { return this.syncedFlag; }

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly logger: Logger
  ) {
    this.weth = config.WBERA_ADDRESS.toLowerCase();
    this.usdc = config.USDC_E_ADDRESS.toLowerCase();
    this.morpho = config.MORPHO_CORE ? config.MORPHO_CORE.toLowerCase() : null;
    this.walletLower = config.WALLET_ADDRESS ? config.WALLET_ADDRESS.toLowerCase() : null;
    if (this.walletLower) this.watchedWallets.add(this.walletLower);
  }

  /** Rebuild the watched-wallet set = our wallet ∪ active follows (so the indexer feeds FollowService's
   * followed-wallet transfers from the same stream). Cheap; refreshed periodically, not per block. */
  private async refreshWatched(): Promise<void> {
    const s = new Set<string>();
    if (this.walletLower) s.add(this.walletLower);
    for (const f of await this.db.activeFollows(this.config.CHAIN_ID).catch(() => [] as Array<{ wallet: string }>)) s.add(f.wallet.toLowerCase());
    this.watchedWallets = s;
  }

  async start(): Promise<void> {
    if (!this.config.INDEXER_ENABLED) { this.logger.info("block-indexer disabled"); return; }
    const head = await this.head().catch(() => 0);
    this.headBlock = head;
    const stored = await this.db.getIndexerCursor(this.config.CHAIN_ID).catch(() => null);
    const coldStart = Math.max(0, head - this.config.INDEXER_COLD_START_BLOCKS);
    // COLD START = RESYNC, no history replay. Fresh DB (no cursor) → start at head (COLD_START_BLOCKS=0 by
    // default); state comes from seeds + live discovery + enrichment, not from replaying old blocks. Resume
    // (cursor exists) → cover the gap FORWARD, UNLESS it's pathologically large (off for days) → jump near
    // head instead of replaying it (state re-derives forward + the resync buffer refills current data).
    this.cursor = stored == null ? coldStart : (head - stored > this.config.INDEXER_MAX_RESYNC_GAP ? coldStart : stored);
    this.syncedFlag = head - this.cursor <= this.config.INDEXER_RESYNC_LAG; // already fresh? (rare)
    if (this.syncedFlag) await this.markSynced();
    await this.refreshAnchor();
    await this.refreshWatched();
    // Trigger: WS heads (primary) + a poll heartbeat (fallback if the WS drops). Overlaps are no-ops.
    this.unwatch = this.chain.watchHeads(() => void this.tick().catch((e) => this.logger.error({ err: e }, "indexer tick failed")), (err) => this.logger.warn({ err: err.message }, "indexer heads WS error"));
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.error({ err: e }, "indexer tick failed")), this.config.INDEXER_POLL_MS);
    this.logger.info({ cursor: this.cursor, head, ethUsd: this.ethUsd, source: this.config.BLOCK_SOURCE }, "block-indexer started");
    await this.writeChainStatus(); // seed freshness telemetry at boot
  }

  stop(): void { if (this.timer) clearInterval(this.timer); if (this.unwatch) this.unwatch(); }

  /** BACKFILL: recompute USD price for tokens that JUST got their decimals (from enrichment), using the
   * already-stored pool_state — so a fresh token is priced the instant it's enriched, not only on its next
   * swap. Pure DB work (no RPC): reuses the same pricers + anchor as the per-block path. The enricher calls
   * this after filling a batch of decimals. */
  async repriceFromState(tokens: string[]): Promise<number> {
    const cid = this.config.CHAIN_ID;
    const wanted = [...new Set(tokens.map((t) => t.toLowerCase()))].filter((t) => t !== this.weth && t !== this.usdc);
    if (!wanted.length) return 0;
    const priced: Array<{ token: string; priceUsd: number; confidence: number; source: string; block: number | null }> = [];
    for (const T of wanted) {
      const pools = await this.db.poolsForToken(cid, T).catch(() => [] as Array<{ address: string; meta: unknown }>);
      if (!pools.length) continue;
      const addrs = pools.map((p) => p.address.toLowerCase());
      const [states, infos] = await Promise.all([this.db.poolStateBatch(cid, addrs).catch(() => new Map()), this.db.poolInfoBatch(cid, addrs).catch(() => new Map())]);
      const involved = new Set<string>();
      for (const info of infos.values()) { if (info.token0) involved.add(info.token0.toLowerCase()); if (info.token1) involved.add(info.token1.toLowerCase()); }
      const meta = await this.db.tokenMeta(cid, [...involved]).catch(() => new Map()) as Map<string, { decimals: number | null }>;
      const dec = (a: string): number | null => a === this.weth ? 18 : a === this.usdc ? 6 : (meta.get(a)?.decimals ?? null);
      let best: { price: number; conf: number; block: number | null } | null = null;
      for (const p of addrs) {
        const info = infos.get(p); const st = states.get(p);
        if (!info?.token0 || !info.token1 || !st) continue;
        const t0 = info.token0.toLowerCase(), t1 = info.token1.toLowerCase();
        const d0 = dec(t0), d1 = dec(t1); if (d0 == null || d1 == null) continue;
        const p0in1 = st.archetype === "v3" && st.sqrtPrice != null ? priceV3FromSqrt(st.sqrtPrice, d0, d1)
          : st.r0 != null && st.r1 != null ? priceV2FromReserves(st.r0, st.r1, d0, d1) : null;
        if (p0in1 == null || !(p0in1 > 0)) continue;
        const q0 = this.quoteUsd(t0), q1 = this.quoteUsd(t1);
        let priceT: number | null = null, conf = 0;
        if (T === t0 && q1 != null) { priceT = p0in1 * q1; conf = 0.95; }
        else if (T === t1 && q0 != null) { priceT = (1 / p0in1) * q0; conf = 0.95; }
        else { const other = T === t0 ? t1 : t0; const op = (await this.db.getTokenPrices(cid, [other]).catch(() => new Map())).get(other)?.priceUsd;
          if (op != null && op > 0) { priceT = T === t0 ? p0in1 * op : (1 / p0in1) * op; conf = 0.8; } }
        if (priceT != null && sanePrice(priceT) && (!best || conf > best.conf)) best = { price: priceT, conf, block: st.block ?? null };
      }
      if (best) priced.push({ token: T, priceUsd: best.price, confidence: best.conf, source: "indexer-backfill", block: best.block });
    }
    if (priced.length) await this.db.upsertTokenPrices(cid, priced, { tauFastSec: this.config.VOL_TAU_FAST_SEC, tauSlowSec: this.config.VOL_TAU_SLOW_SEC }).catch(() => undefined);
    return priced.length;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (Date.now() - this.ethUsdAt > ANCHOR_TTL_MS) await this.refreshAnchor();
      const head = await this.head();
      this.headBlock = head;
      if (head <= this.cursor) { await this.markSynced(); return; }
      // SYNC MODE when we're materially behind (cold-start / resync after a lost block): parallel cascade
      // catch-up + Scarlet gated. REAL-TIME (small lag): one chunk on the dedicated lane, Scarlet operates.
      const behind = head - this.cursor > this.config.INDEXER_RESYNC_LAG;
      if (behind && this.syncedFlag) { this.syncedFlag = false; this.logger.warn({ lag: head - this.cursor }, "indexer de-synced → catching up (Scarlet gated)"); }
      const cap = behind ? this.config.INDEXER_SYNC_MAX_CATCHUP : this.config.INDEXER_MAX_CATCHUP;
      const target = Math.min(head, this.cursor + cap);
      const t0 = Date.now();
      const r = behind ? await this.catchUpParallel(this.cursor + 1, target) : await this.seqRange(this.cursor + 1, target);
      if (++this.ticks % 200 === 0) {
        await this.db.pruneTokenStats(this.config.CHAIN_ID, 48).catch(() => undefined); // 48h retention for market-stat windows
        if (this.config.DEBUG_KEEP_RAW_BLOCKS) await this.db.pruneRawBlocks(this.config.CHAIN_ID, this.config.INDEXER_RAW_RETENTION_HOURS).catch(() => undefined);
      }
      // Rolling raw-block buffer: trim to the last N blocks (~every 40 ticks so it stays near N, not unbounded).
      if (this.config.INDEXER_RAW_BUFFER_BLOCKS > 0 && this.ticks % 40 === 0) await this.db.pruneRawBlocksKeepLast(this.config.CHAIN_ID, this.config.INDEXER_RAW_BUFFER_BLOCKS).catch(() => undefined);
      // Rolling per-swap flow window: trim to the retain horizon (~every 20 ticks).
      if (this.config.INDEXER_FLOW_ENABLED && this.ticks % 20 === 0) await this.db.pruneRecentSwaps(this.config.CHAIN_ID, this.config.INDEXER_FLOW_RETAIN_BLOCKS).catch(() => undefined);
      // Refresh the followed-wallet set (~every 20 ticks) so newly-followed smart-money starts being captured.
      if (this.ticks % 20 === 0) await this.refreshWatched();
      if (r.processed > 0) this.logger.info({ upTo: this.cursor, blocks: r.processed, swaps: r.swaps, discovered: r.discovered, lending: r.lending, ethUsd: this.ethUsd, ms: Date.now() - t0, lag: head - this.cursor, mode: behind ? "sync" : "live" }, "indexed blocks");
      if (this.headBlock - this.cursor <= this.config.INDEXER_RESYNC_LAG) await this.markSynced();
    } finally {
      this.running = false;
      await this.writeChainStatus(); // DB-first freshness telemetry (read-side reads this, never getBlockNumber)
    }
  }

  /** Persist the mirror's observable freshness for the read-side. WRITER = this indexer only. Does NOT
   * touch the cursor (indexer_state) — pure telemetry, never drives cold-start/resync. */
  private async writeChainStatus(): Promise<void> {
    await this.db.upsertChainStatus({ chainId: this.config.CHAIN_ID, indexedBlock: this.cursor, networkHead: this.headBlock, synced: this.syncedFlag }).catch(() => undefined);
  }

  /** At head. Sets the live `synced` flag every time (Scarlet's per-cycle freshness gate). The FIRST time,
   * it also fires the ONE-TIME startup event: snapshot the current incomplete-entity set as the RESYNC set
   * (everything discovered up to head — boot + gap) and resolve `ready`, so index.ts can then wait for the
   * enrichment resync to drain before releasing the acting services. Later re-syncs only re-set the flag. */
  private async markSynced(): Promise<void> {
    this.syncedFlag = true;
    if (this.syncAnnounced) return;
    this.syncAnnounced = true;
    await this.db.flagResyncSet(this.config.CHAIN_ID)
      .then((n) => this.logger.info({ resyncEntities: n, cursor: this.cursor, head: this.headBlock }, "indexer at head — resync set flagged; gate opens once enrichment drains it"))
      .catch((e) => this.logger.warn({ err: e }, "flagResyncSet failed (gate will not wait on resync)"));
    this.readyResolve();
  }

  /** Real-time. FULL ingestion (default): whole-block logs via getBlockReceipts, per block — we see every
   * event, store the last N blocks raw (rolling buffer). LEGACY: topic-filtered chunks on the indexer lane.
   * processBlock filters internally by topic0, so feeding it ALL logs is behaviour-identical for known venues. */
  private async seqRange(from: number, target: number): Promise<{ processed: number; swaps: number; discovered: number; lending: number }> {
    let processed = 0, swaps = 0, discovered = 0, lending = 0;
    if (this.config.INDEXER_FULL_INGESTION) {
      for (let b = from; b <= target; b++) {
        let logs = await this.blockReceiptsLogs(b);
        if (logs == null) logs = await this.getLogs(b, b, this.chain.indexer); // receipts RPC down → filtered (no stall)
        if (this.config.INDEXER_RAW_BUFFER_BLOCKS > 0) await this.db.saveRawBlock(this.config.CHAIN_ID, b, logs).catch(() => undefined);
        const r = await this.applyRange(b, b, logs);
        processed += 1; swaps += r.swaps; discovered += r.discovered; lending += r.lending;
      }
      return { processed, swaps, discovered, lending };
    }
    let f = from;
    while (f <= target) {
      const to = Math.min(f + CHUNK - 1, target);
      const logs = await this.getLogs(f, to, this.chain.indexer);
      const r = await this.applyRange(f, to, logs);
      processed += to - f + 1; swaps += r.swaps; discovered += r.discovered; lending += r.lending;
      f = to + 1;
    }
    return { processed, swaps, discovered, lending };
  }

  /** SYNC (behind) — the SAME full ingestion as real-time, just parallel for throughput: fetch whole-block
   * logs (getBlockReceipts) for many blocks CONCURRENTLY across the RECEIPTS-CAPABLE lanes (indexer/exec/
   * precision — base.org can't serve receipts, and precision is free while acting services are gated), then
   * apply IN ORDER. ONE pipeline: catch-up captures wallet transfers / token_stats identically to live — no
   * filtered-getLogs asymmetry. No block skipped: apply only the contiguous successful prefix, re-fetch the
   * rest next round (cursor stays contiguous). Per-block getLogs fallback if a lane can't serve receipts. */
  private async catchUpParallel(from: number, target: number): Promise<{ processed: number; swaps: number; discovered: number; lending: number }> {
    // Receipts-capable + NON-contending: drpc(indexer) + publicnode(exec). NOT precision (= enrichment's
    // nodies lane, busy draining the buffer during the same resync) nor base.org (can't serve receipts).
    const lanes = [this.chain.indexer, this.chain.exec];
    const conc = this.config.INDEXER_SYNC_CONCURRENCY;
    let processed = 0, swaps = 0, discovered = 0, lending = 0;
    let cur = from;
    while (cur <= target) {
      const blocks: number[] = [];
      for (let b = cur; b <= target && blocks.length < conc; b++) blocks.push(b);
      const fetched = await Promise.all(blocks.map((b, i) => this.blockLogs(b, lanes[i % lanes.length]).then((logs) => ({ b, logs })).catch(() => null)));
      let advanced = false;
      for (const item of fetched) {
        if (!item || item.logs == null) break; // gap → stop; re-fetch from here next round (cursor stays contiguous)
        const r = await this.applyRange(item.b, item.b, item.logs);
        processed += 1; swaps += r.swaps; discovered += r.discovered; lending += r.lending;
        cur = item.b + 1; advanced = true;
      }
      if (!advanced) await new Promise<void>((resolve) => setTimeout(resolve, 500)); // whole batch failed → brief backoff
    }
    return { processed, swaps, discovered, lending };
  }

  /** One block's logs by FULL ingestion on a specific lane (getBlockReceipts), with a filtered-getLogs
   * fallback if that lane can't serve receipts — degraded for that block (no transfers/stats) but no stall. */
  private async blockLogs(block: number, lane: typeof this.chain.indexer): Promise<RawLog[] | null> {
    const r = await this.receiptsOn(block, lane);
    if (r != null) return r;
    return await this.getLogs(block, block, lane).catch(() => null);
  }

  private async applyRange(from: number, to: number, logs: RawLog[]): Promise<{ swaps: number; discovered: number; lending: number }> {
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
    // Decode EVERY log ONCE via the unified registry → normalized events. Every reducer below consumes
    // these; none re-reads raw bytes or re-branches on topic0 (src/indexer/events.ts is the single path).
    const events: DecodedEvent[] = [];
    for (const l of logs) { const e = decodeLog(l); if (e) events.push(e); }

    // 0) WALLET activity (DB-first source of truth for our own wallet): the full-ingestion stream carries
    // EVERY Transfer, so we cheap-filter for the wallet (topic from/to) and persist to wallet_transactions
    // — the history/Movimenti + which tokens we hold. Then we signal WalletHoldings to re-read JUST those
    // balances FROM CHAIN (event-driven, ground truth). No-op on the filtered sync path (no Transfer logs),
    // so cold-start is untouched; this fires only in real-time full ingestion. Idempotent insert (tx:log).
    // WATCHED wallets = OUR wallet ∪ the smart-money wallets we FOLLOW. The indexer feeds all of them from
    // ONE stream → wallet_transactions (keyed by wallet), so WalletHoldings + FollowService read the DB
    // instead of each running its own getLogs. onWalletTransfer fires only for OUR wallet (balance re-read).
    if (this.watchedWallets.size) {
      const byWallet = new Map<string, Array<{ txHash: string; logIndex: number; blockNumber: bigint; token: string; from: string; to: string; valueRaw: bigint; direction: string }>>();
      const ownTouched = new Set<string>();
      for (const l of logs) {
        if ((l.topics[0] ?? "").toLowerCase() !== TRANSFER || l.transactionHash == null || l.logIndex == null) continue;
        const from = addrFromTopic(l.topics[1]), to = addrFromTopic(l.topics[2]);
        if (!from || !to || (!this.watchedWallets.has(from) && !this.watchedWallets.has(to))) continue;
        const t = decodeTransfer(l); if (!t) continue;
        for (const w of from === to ? [from] : [from, to]) {
          if (!this.watchedWallets.has(w)) continue;
          (byWallet.get(w) ?? byWallet.set(w, []).get(w)!).push({ txHash: l.transactionHash, logIndex: Number(BigInt(l.logIndex)), blockNumber: BigInt(block), token: t.token, from: t.from, to: t.to, valueRaw: t.value, direction: t.to === w ? (t.from === w ? "self" : "in") : "out" });
          if (w === this.walletLower) ownTouched.add(t.token);
        }
      }
      for (const [w, rows] of byWallet) await this.db.insertWalletTransfers(this.config.CHAIN_ID, w, rows).catch(() => 0);
      if (ownTouched.size) this.onWalletTransfer?.([...ownTouched]); // fire-and-forget: WalletHoldings reads fresh balances
    }

    // 1) Discovery: new pools/tokens/factory from PoolCreated/PairCreated events. The emitting FACTORY is
    // stored on the pool — one archetype ("v3") is shared by many forks, so own-execution routes each pool
    // to ITS dex's router. The bare `kind:token` entities are the enrichment QUEUE (async enricher fills them).
    let discovered = 0;
    for (const e of events) {
      if (e.kind !== "pool_created") continue;
      // V4: currency 0x0 = native ETH → price it as WETH. tickSpacing/hooks kept for future V4 execution.
      const t0 = e.token0 === ZERO_ADDR ? this.weth : e.token0, t1 = e.token1 === ZERO_ADDR ? this.weth : e.token1;
      const meta: Record<string, unknown> = { token0: t0, token1: t1, archetype: e.archetype, fee: e.fee, factory: e.factory, discoveredBy: "indexer", origin: "created" };
      if (e.tickSpacing != null) meta.tickSpacing = e.tickSpacing;
      if (e.hooks) meta.hooks = e.hooks;
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: e.pool, kind: "pool", meta, source: "indexer", block }).catch(() => undefined);
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: t0, kind: "token", source: "indexer", block }).catch(() => undefined);
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: t1, kind: "token", source: "indexer", block }).catch(() => undefined);
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: e.factory, kind: "dex", meta: { role: "factory", discoveredBy: "indexer" }, source: "indexer", block }).catch(() => undefined);
      discovered += 1;
    }
    if (discovered) this.onDiscovery?.(); // push: new bare token/pool entities → enricher drains now

    // 1b) Lending (Morpho): decoded morpho events from the Morpho core → borrower lifecycle (discover on
    // Borrow, close on Liquidate, params on CreateMarket). API stays as periodic seed + cross-check.
    let lending = 0;
    if (this.morpho) {
      for (const e of events) {
        if (e.kind !== "morpho" || e.log.address.toLowerCase() !== this.morpho) continue;
        if (await this.handleMorpho(e.topic0, e.log)) lending += 1;
      }
    }

    // 1c) V3 liquidity (Mint/Burn) → per-tick liquidity map: the foundation for EXACT V3-at-size quoting
    // (Mint adds +L at tickLower/−L at tickUpper; Burn the reverse). Consumed later by the V3 tick sim.
    const liq = events.filter((e): e is Extract<DecodedEvent, { kind: "liquidity_v3" }> => e.kind === "liquidity_v3");
    if (liq.length) await this.db.upsertTickLiquidity(this.config.CHAIN_ID, block, liq.map((e) => ({ pool: e.pool, tickLower: e.tickLower, tickUpper: e.tickUpper, liquidityDelta: e.liquidityDelta }))).catch((err) => this.logger.debug({ err }, "indexer tick_liquidity upsert failed"));

    // 2) Prices: swap_v3 (sqrtPrice) + sync (V2/Aerodrome reserves) events → the pool's price → USD anchor.
    const priced = events.filter((e): e is Extract<DecodedEvent, { kind: "swap_v3" } | { kind: "sync" }> => e.kind === "swap_v3" || e.kind === "sync");
    if (!priced.length) return { swaps: 0, discovered, lending };
    const poolAddrs = [...new Set(priced.map((e) => e.pool))];
    const pools = await this.db.poolInfoBatch(this.config.CHAIN_ID, poolAddrs);
    // Self-sufficient discovery WITHOUT inline RPC: a pool that swapped but isn't in entities (its Create
    // predates the indexer, or it's on a factory we don't watch) is written as a BARE `kind:pool` entity
    // (archetype only) → the enricher fills token0/1/fee on its dedicated lane, then the price backfills.
    // No cap needed: this is a fast DB upsert, not an RPC burst.
    let bareDiscovered = 0;
    for (const e of priced) {
      if (pools.has(e.pool)) continue;
      if (e.kind === "swap_v3" && e.v4) continue; // a V4 poolId can't be enriched on-chain (no reverse lookup) → only discover V4 pools via Initialize
      const archetype = e.kind === "swap_v3" ? "v3" : e.archetype;
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: e.pool, kind: "pool", meta: { archetype, discoveredBy: "indexer", origin: "swap" }, source: "indexer", block }).catch(() => undefined);
      bareDiscovered += 1;
    }
    if (bareDiscovered) this.onDiscovery?.(); // push: bare pools discovered via swap → enricher drains now
    const tokenSet = new Set<string>();
    for (const p of pools.values()) { if (p.token0) tokenSet.add(p.token0.toLowerCase()); if (p.token1) tokenSet.add(p.token1.toLowerCase()); }
    // Decimals come from the DB (enricher-filled). A token not yet enriched is simply NOT priced this block —
    // its raw pool_state is still written below, and the enricher backfills its price the moment decimals land.
    const meta = await this.db.tokenMeta(this.config.CHAIN_ID, [...tokenSet]).catch(() => new Map()) as Map<string, { symbol: string | null; decimals: number | null }>;
    const dec = (a: string): number | null => { if (a === this.weth) return 18; if (a === this.usdc) return 6; return meta.get(a)?.decimals ?? null; };

    // 2a) Pool state — from the SAME logs, independent of token metadata. V2 Sync = (r0,r1);
    // V3 Swap = (sqrtPriceX96, liquidity). Last log in the block wins (= latest state). This is the
    // DB source that makes PriceOracle's reserves/amountOut DB-read instead of RPC.
    // Multi-hop anchor: USD prices for the pool tokens, so a token/token swap (neither side WETH/USDC)
    // can still be priced via whichever side already has a USD price.
    const px = await this.db.getTokenPrices(this.config.CHAIN_ID, [...tokenSet]).catch(() => new Map()) as Map<string, { priceUsd: number | null; source: string }>;
    const state = new Map<string, { pool: string; archetype: string; r0?: bigint; r1?: bigint; sqrtPrice?: bigint; liquidity?: bigint; block: number }>();
    const rows = new Map<string, { price: number; conf: number }>(); // token → USD price this block (last swap wins)
    const stats = new Map<string, { volUsd: number; buys: number; sells: number; lastPrice: number; netFlowUsd: number; liqUsd: number | null }>(); // per-token market stats this block
    const flowRows: Array<{ pool: string; wallet: string | null; valueUsd: number }> = []; // per-swap wallet+USD for the FlowSensor (recent_swaps)
    // A token's current USD: a QUOTE (WETH/USDC), a DIRECT price computed this block (conf≥0.95), or the
    // stored DB price. Only direct/quote anchors are used for multi-hop, so hop prices never chain.
    const usdOf = (t: string): number | null => {
      const q = this.quoteUsd(t); if (q != null) return q;
      const fresh = rows.get(t); if (fresh && fresh.conf >= 0.95 && sanePrice(fresh.price)) return fresh.price;
      const dbp = px.get(t)?.priceUsd; return sanePrice(dbp) ? dbp : null;
    };
    let swaps = 0;
    for (const e of priced) {
      const pool = e.pool;
      const info = pools.get(pool);
      if (info?.archetype === "aerodrome-stable") continue; // stablecoin-pair curve — x·y=k pricing is invalid; skip
      const isSwap = e.kind === "swap_v3";
      if (isSwap) { if (e.sqrtPrice > 0n) state.set(pool, { pool, archetype: "v3", sqrtPrice: e.sqrtPrice, liquidity: e.liquidity ?? undefined, block }); }
      else { state.set(pool, { pool, archetype: e.archetype, r0: e.r0, r1: e.r1, block }); }

      if (!info?.token0 || !info.token1) continue; // unknown pool — discovery adds it; priced next time
      const t0 = info.token0.toLowerCase(), t1 = info.token1.toLowerCase();
      const d0 = dec(t0), d1 = dec(t1);
      if (d0 == null || d1 == null) continue; // decimals unknown → defer (enricher fills them)
      const p0in1 = isSwap ? priceV3FromSqrt(e.sqrtPrice, d0, d1) : priceV2FromReserves(e.r0, e.r1, d0, d1); // token0 price in token1 (human)
      if (p0in1 == null || !(p0in1 > 0) || !Number.isFinite(p0in1)) continue;
      swaps += 1;
      // Price the NON-quote token T via anchor side A. Direct if A is WETH/USDC (conf 0.95); else
      // multi-hop via a side that already has a USD price (conf 0.8 — one hop, never anchors another).
      const q1 = this.quoteUsd(t1), q0 = this.quoteUsd(t0);
      let T: string | null = null, A: string | null = null, U = 0, priceT = 0, conf = 0;
      if (q1 != null) { T = t0; A = t1; U = q1; priceT = p0in1 * q1; conf = 0.95; }
      else if (q0 != null) { T = t1; A = t0; U = q0; priceT = (1 / p0in1) * q0; conf = 0.95; }
      else { const u1 = usdOf(t1), u0 = usdOf(t0);
        if (u1 != null) { T = t0; A = t1; U = u1; priceT = p0in1 * u1; conf = 0.8; }
        else if (u0 != null) { T = t1; A = t0; U = u0; priceT = (1 / p0in1) * u0; conf = 0.8; } }
      if (!T || !A || !sanePrice(priceT)) continue; // reject thin-pool / extreme-tick garbage
      rows.set(T, { price: priceT, conf });

      // V3 volume/txns/flow: buy = T flows OUT (negative in V3's signed convention). netFlow = +S buy /
      // −S sell (buy pressure). liq = anchor(quote)-side VIRTUAL reserve × USD × 2 (rug-drain trajectory).
      if (isSwap) {
        const aAmt = A === t0 ? e.amount0 : e.amount1;
        const tAmt = A === t0 ? e.amount1 : e.amount0;
        const decA = A === t0 ? d0 : d1;
        const S = Math.abs(Number(aAmt) / 10 ** decA) * U;
        if (S > 0 && S < MAX_SWAP_USD && Number.isFinite(S)) {
          const s = stats.get(T) ?? { volUsd: 0, buys: 0, sells: 0, lastPrice: priceT, netFlowUsd: 0, liqUsd: null };
          const buy = tAmt < 0n;
          s.volUsd += S; if (buy) s.buys += 1; else s.sells += 1; s.netFlowUsd += buy ? S : -S; s.lastPrice = priceT;
          if (e.sqrtPrice > 0n && e.liquidity && e.liquidity > 0n) { const qRes = A === t0 ? (e.liquidity * Q96) / e.sqrtPrice : (e.liquidity * e.sqrtPrice) / Q96; s.liqUsd = (Number(qRes) / 10 ** decA) * U * 2; }
          stats.set(T, s);
          if (this.config.INDEXER_FLOW_ENABLED && S >= this.config.INDEXER_FLOW_MIN_USD) flowRows.push({ pool, wallet: e.recipient, valueUsd: S }); // per-swap flow (wallet = recipient)
        }
      }
    }

    // 2b) V2 + Aerodrome volume/txns — the swap_v2 event carries the amounts the Sync doesn't. Price from Sync.
    const swapV2 = events.filter((e): e is Extract<DecodedEvent, { kind: "swap_v2" }> => e.kind === "swap_v2");
    for (const e of swapV2) {
      const info = pools.get(e.pool);
      if (!info?.token0 || !info.token1 || info.archetype === "aerodrome-stable") continue;
      const t0 = info.token0.toLowerCase(), t1 = info.token1.toLowerCase();
      const d0 = dec(t0), d1 = dec(t1); if (d0 == null || d1 == null) continue;
      const u1 = usdOf(t1), u0 = usdOf(t0);
      let T: string, A: string, U: number, decA: number;
      if (u1 != null) { T = t0; A = t1; U = u1; decA = d1; } else if (u0 != null) { T = t1; A = t0; U = u0; decA = d0; } else continue;
      // Swap(amount0In, amount1In, amount0Out, amount1Out): net = In − Out (into pool positive).
      const net0 = e.a0In - e.a0Out;
      const net1 = e.a1In - e.a1Out;
      const netA = A === t0 ? net0 : net1, netT = T === t0 ? net0 : net1;
      const S = Math.abs(Number(netA) / 10 ** decA) * U;
      if (!(S > 0) || S >= MAX_SWAP_USD || !Number.isFinite(S)) continue;
      const priceT = rows.get(T)?.price ?? px.get(T)?.priceUsd ?? 0;
      const s = stats.get(T) ?? { volUsd: 0, buys: 0, sells: 0, lastPrice: priceT, netFlowUsd: 0, liqUsd: null };
      const buy = netT < 0n; // T flows OUT of the pool → bought
      s.volUsd += S; if (buy) s.buys += 1; else s.sells += 1; s.netFlowUsd += buy ? S : -S; if (priceT > 0) s.lastPrice = priceT;
      const st = state.get(e.pool); // reserves from this pool's Sync (same block)
      if (st?.r0 != null && st.r1 != null) { const qRes = A === t0 ? st.r0 : st.r1; s.liqUsd = (Number(qRes) / 10 ** decA) * U * 2; }
      stats.set(T, s);
      if (this.config.INDEXER_FLOW_ENABLED && S >= this.config.INDEXER_FLOW_MIN_USD) flowRows.push({ pool: e.pool, wallet: e.to, valueUsd: S }); // per-swap flow (wallet = to)
    }

    if (this.config.DEBUG_KEEP_RAW_BLOCKS && logs.length) await this.db.saveRawBlock(this.config.CHAIN_ID, block, logs).catch(() => undefined);
    if (state.size) await this.db.upsertPoolState(this.config.CHAIN_ID, [...state.values()]).catch((e) => this.logger.debug({ err: e }, "indexer pool_state upsert failed"));
    if (rows.size) {
      await this.db.upsertTokenPrices(this.config.CHAIN_ID, [...rows.entries()].map(([token, v]) => ({ token, priceUsd: v.price, confidence: v.conf, source: "indexer", block })), { tauFastSec: this.config.VOL_TAU_FAST_SEC, tauSlowSec: this.config.VOL_TAU_SLOW_SEC }).catch((e) => this.logger.debug({ err: e }, "indexer price upsert failed"));
    }
    // FRESHNESS stamp: every data update carries the block it was written at (also visible in the log),
    // so "how far behind is this pool/price" is answerable from the DB and the log alone.
    if (state.size || rows.size) this.logger.debug({ block, blocksBehind: this.headBlock > 0 ? Math.max(0, this.headBlock - block) : null, pools: state.size, priced: rows.size, stats: stats.size }, "indexer data written @ block");
    // token_stats buckets are WALL-CLOCK (5-min): during a big catch-up, blocks older than 48h would dump
    // historical volume into the CURRENT bucket. Only write stats for near-head (recent) blocks.
    if (stats.size && (this.headBlock === 0 || this.headBlock - block <= this.config.INDEXER_STATS_MAX_LAG_BLOCKS)) {
      const bucket = Math.floor(Date.now() / 1000 / 300) * 300;
      await this.db.upsertTokenStats(this.config.CHAIN_ID, bucket, [...stats.entries()].map(([token, s]) => ({ token, ...s }))).catch((e) => this.logger.debug({ err: e }, "indexer token_stats upsert failed"));
    }
    // Per-swap FLOW (recent_swaps) — only for blocks within the rolling window (near head); older catch-up
    // blocks would be pruned immediately, so don't write them. FlowSensor reads this back.
    if (flowRows.length && (this.headBlock === 0 || this.headBlock - block <= this.config.INDEXER_FLOW_RETAIN_BLOCKS)) {
      await this.db.insertRecentSwaps(this.config.CHAIN_ID, block, flowRows).catch((e) => this.logger.debug({ err: e }, "indexer recent_swaps insert failed"));
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
      const r = await this.chain.indexer.readContract({ address: this.morpho as Address, abi: MORPHO_MARKET_ABI, functionName: "idToMarketParams", args: [id as `0x${string}`] }) as readonly [string, string, string, string, bigint];
      const m = { loanToken: r[0].toLowerCase(), collateralToken: r[1].toLowerCase(), oracle: r[2].toLowerCase(), irm: r[3].toLowerCase(), lltv: r[4] };
      if (m.collateralToken === "0x0000000000000000000000000000000000000000") return null;
      this.marketCache.set(id, m);
      await this.db.upsertLendingMarket({ chainId: this.config.CHAIN_ID, protocol: "morpho", marketId: id, ...m }).catch(() => undefined);
      return m;
    } catch (e) { this.logger.debug({ err: e, id }, "idToMarketParams bootstrap failed"); return null; }
  }


  /** USD value of one unit of a QUOTE token (WETH via Chainlink, USDC = $1). null if not a quote. */
  private quoteUsd(token: string): number | null {
    if (token === this.weth) return this.ethUsd > 0 ? this.ethUsd : null;
    if (token === this.usdc) return 1;
    return null;
  }

  private async refreshAnchor(): Promise<void> {
    try {
      const res = await (this.chain.indexer as unknown as RawRpc).request({ method: "eth_call", params: [{ to: this.config.CHAINLINK_ETH_USD_FEED, data: "0xfeaf968c" }, "latest"] }) as string; // latestRoundData()
      if (res && res.length >= 194) { this.ethUsd = Number(BigInt("0x" + res.slice(2 + 64, 2 + 128))) / 1e8; this.ethUsdAt = Date.now(); }
    } catch (e) { this.logger.debug({ err: e }, "anchor refresh failed"); }
  }

  private async head(): Promise<number> {
    const r = await (this.chain.indexer as unknown as RawRpc).request({ method: "eth_blockNumber", params: [] }) as string;
    return Number(BigInt(r));
  }

  /** EVERY log of a block via eth_getBlockReceipts on ONE lane (null = that lane can't serve it / errored). */
  private async receiptsOn(block: number, client: typeof this.chain.indexer): Promise<RawLog[] | null> {
    try {
      const receipts = await (client as unknown as RawRpc).request({ method: "eth_getBlockReceipts", params: [hex(block)] }) as Array<{ logs?: RawLog[] }> | null;
      if (receipts == null) return null;
      const out: RawLog[] = [];
      for (const rc of receipts) if (rc.logs) for (const lg of rc.logs) out.push(lg);
      return out;
    } catch { return null; }
  }

  /** FULL block ingestion (live, single block): try the indexer's OWN receipts-capable lanes drpc → publicnode
   * (base.org can't serve receipts). null = neither served it → caller falls back to filtered getLogs (no stall). */
  private async blockReceiptsLogs(block: number): Promise<RawLog[] | null> {
    for (const client of [this.chain.indexer, this.chain.exec]) { const r = await this.receiptsOn(block, client); if (r != null) return r; }
    return null;
  }

  /** Topic-filtered getLogs for [from,to] on `client` (default the dedicated indexer lane; during sync the
   * caller passes different cascade lanes for concurrency). We retry IN-LANE so a transient blip doesn't skip
   * a block; if all retries fail we throw → the caller keeps the cursor put → re-processed later (no skip). */
  private async getLogs(from: number, to: number, client: typeof this.chain.indexer = this.chain.indexer): Promise<RawLog[]> {
    const params = [{ fromBlock: hex(from), toBlock: hex(to), topics: [TOPIC0S] }];
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await (client as unknown as RawRpc).request({ method: "eth_getLogs", params }) as RawLog[]; }
      catch (e) { lastErr = e; if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 300 * (attempt + 1))); }
    }
    throw lastErr instanceof Error ? lastErr : new Error("getLogs failed");
  }
}

// --- decoding helpers -------------------------------------------------------

function hex(n: number): string { return "0x" + n.toString(16); }

/** CORE: price of 1 token0 in token1 (human) from a raw sqrtPriceX96. Reused by the per-block pricer AND
 * the enrichment backfill (which recomputes from the stored pool_state once decimals arrive). */
export function priceV3FromSqrt(sqrtP: bigint, dec0: number, dec1: number): number | null {
  if (sqrtP <= 0n) return null;
  const r = Number(sqrtP) / 2 ** 96;       // = sqrt(price_raw)
  const priceRaw = r * r;                  // token1/token0 in raw units
  return priceRaw * 10 ** (dec0 - dec1);   // token1(human) per token0(human)
}
/** CORE: price of 1 token0 in token1 (human) from raw reserves. Reused by the per-block pricer + backfill. */
export function priceV2FromReserves(r0raw: bigint, r1raw: bigint, dec0: number, dec1: number): number | null {
  const r0 = Number(r0raw) / 10 ** dec0;
  const r1 = Number(r1raw) / 10 ** dec1;
  if (!(r0 > 0)) return null;
  return r1 / r0;
}
