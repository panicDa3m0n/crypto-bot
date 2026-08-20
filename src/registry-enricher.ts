import type { Logger } from "pino";
import { parseAbi, createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { BerachainClients } from "./chain.js";
import type { Etherscan } from "./etherscan.js";
import type { Blockscout } from "./blockscout.js";
import { UNIV3_MINT, UNIV3_BURN, POOL_CREATED, EVENT_DECODERS, type RawLog } from "./indexer/events.js";
import { scanTickMap, validateSnapshotVsQuoter, tickStorageProfile, bitmapWordRange, MULTICALL3 } from "./router/tick-storage.js";

const UNIV3_QUOTER_BASE = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address; // Uniswap V3 QuoterV2 on Base
const FEE_TO_SPACING: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 }; // 2500=Pancake tier
const STORAGE_SCAN_INTERVAL_MS = 15_000; // heavy last-resort path (Pinax reliable lane) — bound its cadence
const GAS_POLL_INTERVAL_MS = 20_000;     // DB-first gas: write-side poller cadence (read-side reads gas_state)

const POOL_META_ABI = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function factory() view returns (address)", "function tickSpacing() view returns (int24)"]);
const AERO_STABLE_ABI = parseAbi(["function stable() view returns (bool)"]);
const AERO_FACTORY_FEE_ABI = parseAbi(["function getFee(address pool, bool stable) view returns (uint256)"]);
const ERC20_META_ABI = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)"]);
const POOL_BATCH = 40;   // one Multicall3 covers the whole batch, so batch size is nearly free now
const FAST_MS = 400;      // there's a backlog → drain quickly
const BACKOFF_MS = 6_000; // the enrichment RPC threw a rate-limit → let the buffer WAIT, then resume
const MAX_ATTEMPTS = 4;   // per-entity in-memory read attempts before giving up (marks checked so we don't loop forever)
const isRateLimit = (e: unknown): boolean => /rate limit|429|too many|quota|exceeded/i.test(e instanceof Error ? e.message : String(e));

/**
 * EnrichmentWorker (kept as RegistryEnricher for continuity) — the SEPARATE, async metadata pipeline.
 *
 * The indexer's critical path only writes BARE entities (a token address, a bare pool with its archetype).
 * Those bare entities ARE the queue: this worker drains them on a DEDICATED RPC lane (`chain.enrichment`),
 * fills the two things not present in block logs — token decimals/symbol/name and a pre-existing pool's
 * token0/1/fee — and then BACKFILLS the token's USD price from the already-stored pool_state (via `reprice`).
 *
 * Self-pacing to the RPC: it drains fast while there's a backlog, idles when empty, and BACKS OFF when the
 * RPC rate-limits (the buffer simply waits). Dedup + persistence are free (the DB "needs X" queries). A read
 * failure NEVER marks an entity done permanently until MAX_ATTEMPTS — fixing the old "checked-before-read"
 * data loss. Etherscan verified/proxy meta rides along on idle ticks (rate-friendly).
 */
export class RegistryEnricher {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastVerifiedAt = 0;
  private lastStorageScanAt = 0;
  private lastGasAt = 0;
  private scanClient?: PublicClient | null; // lazy reliable lane (Pinax) for storage-scan certification; null = unconfigured
  private nudged = false; // a nudge has a drain scheduled imminently (coalesces a burst of nudges into one)

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly etherscan: Etherscan,
    private readonly blockscout: Blockscout,
    private readonly logger: Logger,
    private readonly reprice?: (tokens: string[]) => Promise<void> // backfill hook (indexer.repriceFromState)
  ) {}

  start(): void {
    this.logger.info({ lane: this.chain.enrichmentRpc }, "enrichment worker started (dedicated RPC)");
    // Give previously-burned entities another chance: an entity marked failed by a WRITE-SIDE fault (flaky
    // RPC) is a silent data hole downstream. Completeness is the goal, so failures are not permanent.
    void this.db.resetEnrichFailures(this.config.CHAIN_ID, "pool")
      .then((n) => { if (n) this.logger.info({ requeued: n }, "enrichment: returned previously-failed pools to the buffer"); })
      .catch(() => undefined);
    this.schedule(FAST_MS);
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); }

  /** PUSH: the indexer just wrote a new entity that may be incomplete → drain NOW instead of waiting for the
   * idle poll. Coalesced: a burst of nudges schedules a single imminent drain (which then reschedules by
   * backlog). This is what makes "the instant an entity with missing data arrives, it enters the buffer and
   * is processed" true in LIVE — no per-block full-DB scan; the buffer is the index-backed pending subset. */
  nudge(): void {
    if (this.running || this.nudged) return; // a drain is running / already imminent → it will pick this up
    this.nudged = true;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  private schedule(ms: number): void { this.timer = setTimeout(() => void this.drain().catch((e) => this.logger.error({ err: e }, "enrichment drain failed")), ms); }

  /** One drain pass: pools → tokens (+price backfill) → (idle) verified. Self-reschedules by backlog state. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.nudged = false; // this pass consumes any pending nudge; new nudges during it re-arm afterwards
    let did = 0, rateLimited = false;
    // Block-based tracking: stamp writes/attempts with the indexer's current block (DB-read, no RPC).
    const block = await this.db.getIndexerCursor(this.config.CHAIN_ID).catch(() => null);
    try {
      const pools = await this.enrichPools(block);
      const toks = await this.enrichTokens(block);
      const facs = await this.enrichFactories(block);
      const aero = await this.enrichAeroStable(block);
      did = pools.done + toks.done + facs.done + aero.done;
      rateLimited = pools.rateLimited || toks.rateLimited || facs.rateLimited || aero.rateLimited;
      // Tick-map bootstrap (Item 3.2): P0 (demand-driven, KG-requested) runs ALWAYS so it's never starved;
      // P1–P3 (background historical) only when the fast queues are idle.
      const tb0 = await this.enrichTickBootstrap(0); did += tb0.done; rateLimited = rateLimited || tb0.rateLimited;
      if (!did) { const tb = await this.enrichTickBootstrap(3); did += tb.done; rateLimited = rateLimited || tb.rateLimited; }
      // Storage-scan certification (Item 3.4b/c/d) — recovery for the FINITE set of pools the historical-log
      // bootstrap gave up on (status=failed). Runs on its OWN reliable lane (Pinax), disjoint from the bootstrap
      // lane, so it is decoupled from the bootstrap queue (no starvation behind P0/P3) and bounded solely by the
      // 15s throttle. Cheap no-op when the failed set is empty. No reliable lane ⇒ dormant.
      if (Date.now() - this.lastStorageScanAt > STORAGE_SCAN_INTERVAL_MS) {
        const ss = await this.enrichTickStorageScan(); did += ss.done; rateLimited = rateLimited || ss.rateLimited;
        this.lastStorageScanAt = Date.now();
      }
      // DB-first gas (Item 4): write-side poller so the read-side (KG observatory/gate) never calls getGasPrice.
      if (Date.now() - this.lastGasAt > GAS_POLL_INTERVAL_MS) {
        this.lastGasAt = Date.now();
        const gp = await this.chain.primary.getGasPrice().catch(() => 0n);
        if (gp > 0n) await this.db.upsertGasState(this.config.CHAIN_ID, gp).catch(() => undefined);
      }
      // Etherscan verified/proxy signal — only when the fast queue is idle and not more than once per interval.
      if (!did && this.etherscan.available && Date.now() - this.lastVerifiedAt > this.config.ENRICH_INTERVAL_MS) { await this.enrichVerified(); this.lastVerifiedAt = Date.now(); }
    } finally {
      this.running = false;
      this.schedule(rateLimited ? BACKOFF_MS : did ? FAST_MS : this.config.ENRICH_INTERVAL_MS);
    }
  }

  /** Complete a pool's MANDATORY data (token0/token1 + per-pool fee/tickSpacing where the archetype has them).
   * Reads ONLY the fields that are missing — a pool already carrying its tokens must not re-read them. Data a
   * calculation depends on is enrichment work: never left to a default downstream. Writing the last missing
   * field flips `enrich_pending` false automatically (generated column). */
  private async enrichPools(block: number | null): Promise<{ done: number; rateLimited: boolean }> {
    const batch = await this.db.entitiesNeedingPoolInfo(this.config.CHAIN_ID, POOL_BATCH).catch(() => []);
    if (!batch.length) return { done: 0, rateLimited: false };
    const CONC_FEE = new Set(["v3", "slipstream"]);            // per-pool fee() exists on these
    const CONC_SPACING = new Set(["v3", "slipstream", "algebra"]); // tickSpacing() is static on all of them
    // ONE Multicall3 for the WHOLE batch instead of 2-3 sequential eth_calls per pool. The buffer holds
    // thousands of incomplete pools; per-pool calls on a rate-limited public lane drain slower than discovery
    // adds, so the backlog never clears. Batching is what makes "the enricher finds the missing data" true.
    type Want = { address: string; field: "token0" | "token1" | "fee" | "factory" | "tickSpacing" };
    const wants: Want[] = [];
    for (const p of batch) {
      const arch = p.archetype ?? "";
      if (!p.hasTokens) { wants.push({ address: p.address, field: "token0" }, { address: p.address, field: "token1" }); }
      if (p.needsFee && CONC_FEE.has(arch)) wants.push({ address: p.address, field: "fee" });
      wants.push({ address: p.address, field: "factory" }); // own-execution routes each pool to ITS dex router
      if (p.needsSpacing && CONC_SPACING.has(arch)) wants.push({ address: p.address, field: "tickSpacing" });
    }
    if (!wants.length) return { done: 0, rateLimited: false };
    // Retry ONLY the still-unanswered sub-calls: a flaky/rate-limited lane returns PARTIAL multicall results,
    // and a transport failure must NEVER be mistaken for "this pool has no such data" — that would burn good
    // pools into enrich_failed permanently (the classic checked-before-read data loss).
    const contracts = wants.map((w) => ({ address: w.address as Address, abi: POOL_META_ABI, functionName: w.field }));
    const results = new Array<{ status: string; result?: unknown } | undefined>(wants.length);
    // The dedicated enrichment lane answers SINGLE reads but returns all-failures for BATCHED multicalls
    // (measured: nodies 1/1 ok, 0/40, 0/120 — silently, without throwing). Batch reads therefore go to a
    // multicall-capable lane; the data was always on-chain, only the transport was wrong.
    const mcClient = this.getScanClient() ?? this.chain.primary;
    let pending = wants.map((_, i) => i), transportFailed = false;
    for (let round = 0; round < 3 && pending.length; round++) {
      const sub = pending.map((i) => contracts[i]);
      let r: Array<{ status: string; result?: unknown }> | null = null;
      try {
        r = await mcClient.multicall({ contracts: sub, multicallAddress: MULTICALL3, allowFailure: true }) as Array<{ status: string; result?: unknown }>; // db-first-allow: write-side enrichment
      } catch (e) {
        if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done: 0, rateLimited: true }; }
        transportFailed = true; // whole-call failure: NOT evidence about any pool's data
      }
      if (!r) { await this.pace(); continue; }
      const before = pending.length;
      const still: number[] = [];
      for (let j = 0; j < pending.length; j++) { if (r[j]?.status === "success") results[pending[j]] = r[j]; else still.push(pending[j]); }
      // ZERO successes across a whole batch is evidence about the LANE, not about 40 pools simultaneously
      // lacking the same functions. Treating it as definitive is what burned good pools into enrich_failed.
      if (still.length === before) { transportFailed = true; break; }
      pending = still;
      if (pending.length) await this.pace();
    }
    const got = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < wants.length; i++) {
      if (results[i]?.status !== "success") continue;
      const w = wants[i], v = results[i]!.result;
      const m = got.get(w.address) ?? {}; got.set(w.address, m);
      if (w.field === "token0" || w.field === "token1" || w.field === "factory") m[w.field] = String(v).toLowerCase();
      else m[w.field] = Number(v);
    }
    let done = 0;
    for (const p of batch) {
      const meta = got.get(p.address);
      // Count an attempt ONLY on a definitive answer (the call resolved and the data isn't there). After a
      // transport failure we leave the pool untouched so it is retried later instead of being burned.
      if (!meta || !Object.keys(meta).length) { if (!transportFailed) await this.db.bumpEnrichAttempt(this.config.CHAIN_ID, p.address, "pool", block, MAX_ATTEMPTS).catch(() => undefined); continue; }
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: p.address, kind: "pool", meta, source: "enricher", block: block ?? undefined }).catch(() => undefined);
      // Ensure the two tokens exist as entities so they enter the buffer for decimals enrichment next.
      for (const f of ["token0", "token1"] as const) { const t = meta[f] as string | undefined; if (t) await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: t, kind: "token", source: "enricher", block: block ?? undefined }).catch(() => undefined); }
      done += 1;
    }
    return { done, rateLimited: false };
  }

  /** Fill DECIMALS (the only price-critical fact) via ONE RPC read/token on the dedicated lane — gentle
   * enough to stay under free-tier limits — then symbol/name best-effort from Blockscout (keyless API, not
   * the RPC), then BACKFILL price for the tokens that just got decimals. Spacing paces us under the limit. */
  private async enrichTokens(block: number | null): Promise<{ done: number; rateLimited: boolean }> {
    const need = await this.db.entitiesNeedingDecimals(this.config.CHAIN_ID, this.config.ENRICH_BATCH).catch(() => []);
    if (!need.length) return { done: 0, rateLimited: false };
    let done = 0; const gotDecimals: string[] = [];
    for (const e of need) {
      try {
        const dc = await this.chain.enrichment.readContract({ address: e.address as Address, abi: ERC20_META_ABI, functionName: "decimals" }) as number | bigint;
        const decimals = dc != null && Number.isFinite(Number(dc)) && Number(dc) >= 0 && Number(dc) <= 36 ? Number(dc) : undefined;
        if (decimals != null) {
          // symbol/name are NOT price-critical — take them from Blockscout (keyless), off the RPC lane.
          const info = this.blockscout.available ? await this.blockscout.tokenInfo(e.address).catch(() => null) : null;
          const symbol = info?.symbol && info.symbol !== "?" ? info.symbol.slice(0, 32) : undefined;
          // Writing decimals flips `enrich_pending` false automatically (generated) + advances updated_block.
          await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: e.address, kind: "token", symbol, name: info?.name?.slice(0, 96), decimals, source: "enricher", block: block ?? undefined }).catch(() => undefined);
          if (symbol) await this.db.mergeEntityMeta(this.config.CHAIN_ID, e.address, "token", { symbolCheckedAt: new Date().toISOString() }).catch(() => undefined);
          gotDecimals.push(e.address); done += 1;
        } else { await this.db.bumpEnrichAttempt(this.config.CHAIN_ID, e.address, "token", block, MAX_ATTEMPTS).catch(() => undefined); }
      } catch (err) {
        if (isRateLimit(err)) { this.chain.laneError("enrichment", err); return { done, rateLimited: true }; }
        await this.db.bumpEnrichAttempt(this.config.CHAIN_ID, e.address, "token", block, MAX_ATTEMPTS).catch(() => undefined);
      }
      await this.pace();
    }
    // Backfill USD price for the freshly-decimalled tokens from the stored pool_state (no RPC).
    if (gotDecimals.length && this.reprice) await this.reprice(gotDecimals).catch(() => undefined);
    if (done) this.logger.info({ filled: done, backfilled: gotDecimals.length }, "tokens enriched (dedicated RPC)");
    return { done, rateLimited: false };
  }

  /** Classify Aerodrome pools stable vs volatile — pools discovered via Sync are labelled generically
   * "aerodrome" (the Sync event can't tell them apart). Reads the IMMUTABLE stable() flag ONCE and, for
   * stable pools, the factory fee (getFee(pool,true), which the exact stable math needs), then corrects
   * entities.meta.archetype + meta.fee (ppm = bps×100). `stableChecked` marks it done. This lets the
   * read-side/KG include stable pools DB-first (no live stable()/getFee at reasoning time). NOTE: the
   * factory fee is DYNAMIC per pool → a REFRESHABLE-enrichment candidate (roadmap item 4); read once here. */
  private async enrichAeroStable(block: number | null): Promise<{ done: number; rateLimited: boolean }> {
    const batch = await this.db.poolsNeedingStableCheck(this.config.CHAIN_ID, this.config.ENRICH_BATCH).catch(() => [] as string[]);
    if (!batch.length) return { done: 0, rateLimited: false };
    let done = 0;
    for (const pool of batch) {
      try {
        const isStable = await this.chain.enrichment.readContract({ address: pool as Address, abi: AERO_STABLE_ABI, functionName: "stable" }) as boolean;
        if (isStable) {
          const factory = ((await this.chain.enrichment.readContract({ address: pool as Address, abi: POOL_META_ABI, functionName: "factory" })) as string).toLowerCase();
          const feeRaw = await this.chain.enrichment.readContract({ address: factory as Address, abi: AERO_FACTORY_FEE_ABI, functionName: "getFee", args: [pool as Address, true] }) as bigint;
          await this.db.mergeEntityMeta(this.config.CHAIN_ID, pool, "pool", { archetype: "aerodrome-stable", fee: Number(feeRaw) * 100, factory, stableChecked: block ?? 0 }).catch(() => undefined);
        } else {
          await this.db.mergeEntityMeta(this.config.CHAIN_ID, pool, "pool", { archetype: "aerodrome", stableChecked: block ?? 0 }).catch(() => undefined);
        }
        done += 1;
      } catch (e) {
        if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done, rateLimited: true }; }
        await this.db.mergeEntityMeta(this.config.CHAIN_ID, pool, "pool", { stableChecked: block ?? 0 }).catch(() => undefined); // mark so we don't retry forever
      }
      await this.pace();
    }
    return { done, rateLimited: false };
  }

  /** Locate a pool's CREATION block AUTHORITATIVELY via its factory's PoolCreated log, filtered by the
   * discriminant indexed topics (token0, token1, fee) — this uses only the LOG index (which public RPCs
   * serve for history), NOT historical STATE (getCode, which they prune). Cascades primary→fallback→
   * enrichment. Returns null if the factory/tokens/fee aren't known yet or no provider serves the range. */
  private async locateCreationBlock(pool: Address, meta: { token0?: string; token1?: string; fee?: unknown; factory?: string }, head: number): Promise<number | null> {
    const factory = meta.factory?.toLowerCase(), t0 = meta.token0?.toLowerCase(), t1 = meta.token1?.toLowerCase(), fee = Number(meta.fee);
    if (!factory || !t0 || !t1 || !Number.isFinite(fee) || fee <= 0) return null; // need the discriminant topics
    const pad = (h: string) => "0x" + h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    const topics = [POOL_CREATED, pad(t0), pad(t1), pad(fee.toString(16))];
    const lanes = [this.chain.primary, this.chain.fallback, this.chain.enrichment]; // base.org (archive logs) first
    for (const c of lanes) {
      try {
        const logs = await (c as unknown as { request: (a: { method: string; params: unknown }) => Promise<unknown> }).request({ method: "eth_getLogs", params: [{ address: factory, topics, fromBlock: "0x0", toBlock: "0x" + head.toString(16) }] }) as RawLog[];
        if (logs && logs.length) return Number(BigInt(logs[0].blockNumber));
      } catch { /* range/limit → try next lane */ }
      await this.pace();
    }
    return null;
  }

  /** ITEM 3.2 — historical tick-map bootstrap (one pending concentrated pool per drain, priority-ordered).
   * Reconstructs [creationBlock, coverageStart−1] Mint/Burn deltas via the SAME algebra the indexer uses
   * forward, applied through the RESTART-SAFE transactional cursor (applyTickBootstrapChunk). Certifies
   * complete ONLY after RE-CHECKING that coverage/generation still hold (a mid-bootstrap jump invalidates
   * the premise). Range [creation, coverageStart−1] is disjoint from live coverage → additive, no overlap. */
  private async enrichTickBootstrap(maxPriority = 3): Promise<{ done: number; rateLimited: boolean }> {
    const cid = this.config.CHAIN_ID;
    const cov = await this.db.getIndexerCoverage(cid).catch(() => null);
    if (!cov) return { done: 0, rateLimited: false };
    const target = cov.coverageStart - 1;
    const batch = await this.db.poolsNeedingTickBootstrap(cid, 1, maxPriority).catch(() => []);
    if (!batch.length) return { done: 0, rateLimited: false };
    const p = batch[0];
    const pool = p.pool.toLowerCase() as Address;
    const hex = (n: number) => "0x" + n.toString(16);
    // Historical logs need archive depth the enrichment lane often lacks → cascade to primary/fallback.
    const lanes = [this.chain.enrichment, this.chain.primary, this.chain.fallback];
    const req = async (m: string, prm: unknown): Promise<unknown> => {
      let lastErr: unknown;
      for (const c of lanes) { try { return await (c as unknown as { request: (a: { method: string; params: unknown }) => Promise<unknown> }).request({ method: m, params: prm }); } catch (e) { lastErr = e; } }
      throw lastErr;
    };
    try {
      let status = await this.db.getPoolTickStatus(cid, pool);
      let creation = status?.creationBlock ?? null;
      if (creation == null) {
        const ent = await this.db.getEntity(cid, pool).catch(() => []);
        const pm = (ent[0]?.meta ?? {}) as { token0?: string; token1?: string; fee?: unknown; factory?: string };
        const src = (p.origin === "created" && p.createdBlock != null) ? "pool_created" : "pool_created_log";
        creation = (p.origin === "created" && p.createdBlock != null) ? p.createdBlock : await this.locateCreationBlock(pool, pm, cov.continuousThrough);
        if (creation == null) { await this.db.noteTickBootstrapError(cid, pool, "creation block not located (factory PoolCreated)").catch(() => undefined); return { done: 0, rateLimited: false }; }
        await this.db.setPoolTickCreation(cid, pool, creation, src);
        status = await this.db.getPoolTickStatus(cid, pool);
      }
      if (creation > target) { await this.db.certifyPoolTickComplete(cid, pool, cov.generation, "live_indexer"); return { done: 1, rateLimited: false }; } // born inside live coverage
      let from = status?.bootstrapThrough != null ? status.bootstrapThrough + 1 : creation;
      let span = 2000, chunks = 0;
      while (from <= target && chunks < 25) {
        const to = Math.min(from + span - 1, target);
        let logs: RawLog[] | null = null;
        try { logs = await req("eth_getLogs", [{ address: pool, topics: [[UNIV3_MINT, UNIV3_BURN]], fromBlock: hex(from), toBlock: hex(to) }]) as RawLog[]; }
        catch (e) { if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done: chunks, rateLimited: true }; } if (span > 400) { span = Math.floor(span / 2); continue; } const gaveUp = await this.db.noteTickBootstrapError(cid, pool, `getLogs failed @${from} (archive depth?)`).catch(() => false); if (gaveUp) this.logger.debug({ pool, from }, "tick bootstrap: giving up (archive unavailable) → needs storage-scan/3.4"); return { done: chunks, rateLimited: false }; }
        const deltas: Array<{ tickLower: number; tickUpper: number; liquidityDelta: bigint }> = [];
        for (const l of logs ?? []) { const d = EVENT_DECODERS.get((l.topics[0] ?? "").toLowerCase())?.(l); if (d && d.kind === "liquidity_v3") deltas.push({ tickLower: d.tickLower, tickUpper: d.tickUpper, liquidityDelta: d.liquidityDelta }); }
        const r = await this.db.applyTickBootstrapChunk(cid, pool, from, to, deltas);
        if (!r.ok) { await this.db.failPoolTickStatus(cid, pool, r.reason ?? "apply failed"); return { done: chunks, rateLimited: false }; }
        from = to + 1; chunks += 1;
        if (span < 2000 && (logs?.length ?? 0) < 50) span = Math.min(2000, span * 2);
        await this.pace();
      }
      if (from > target) {
        // RE-CHECK: the premise (unbroken coverage from coverageStart, same generation) must still hold.
        const cov2 = await this.db.getIndexerCoverage(cid).catch(() => null);
        if (cov2 && cov2.generation === cov.generation && cov2.coverageStart === cov.coverageStart) {
          await this.db.certifyPoolTickComplete(cid, pool, cov2.generation, "historical_logs");
          this.logger.info({ pool, creation, through: target, generation: cov2.generation }, "tick-map bootstrap COMPLETE");
        }
      }
      return { done: chunks || 1, rateLimited: false };
    } catch (e) {
      if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done: 0, rateLimited: true }; }
      await this.db.failPoolTickStatus(cid, pool, e instanceof Error ? e.message : String(e)).catch(() => undefined);
      return { done: 0, rateLimited: false };
    }
  }

  /** The reliable read lane for storage scans (a multi-hundred-word tick sweep throttles public RPCs). Pinax
   * (or any archive-grade endpoint) via PINAX_RPC/SCAN_RPC. Lazily built; null (cached) when unconfigured so
   * the storage-scan path simply stays dormant — it never falls back to a flaky lane and mis-certifies. */
  private getScanClient(): PublicClient | null {
    if (this.scanClient !== undefined) return this.scanClient;
    const url = process.env.PINAX_RPC || process.env.SCAN_RPC || "";
    this.scanClient = url ? (createPublicClient({ chain: base, transport: http(url, { batch: false }) }) as unknown as PublicClient) : null;
    if (!this.scanClient) this.logger.debug("storage-scan lane not configured (PINAX_RPC/SCAN_RPC) → storage certification dormant");
    return this.scanClient;
  }

  /**
   * STORAGE-SCAN certification (Item 3.4b/c/d) — for pools the historical-log bootstrap could NOT complete
   * (archive depth exhausted, status=failed). Reads the pool's COMPLETE tick map from chain STATE at a settled
   * block B on the reliable lane, VALIDATES it reproduces QuoterV2 (amountOut+sqrtPriceAfter+ticksCrossed),
   * REPLACES the DB tick map with that authoritative snapshot + replays live Mint/Burn [B+1,cursor], then
   * certifies against the CURRENT coverage generation. Fail-closed at every seam: no reliable lane, no known
   * Quoter for the fork, or a validation miss ⇒ never certify. Snapshot REPLACE (not additive) — the scan is
   * an authoritative state read, not another delta reconstruction.
   */
  private async enrichTickStorageScan(): Promise<{ done: number; rateLimited: boolean }> {
    const client = this.getScanClient();
    if (!client) return { done: 0, rateLimited: false };
    const cid = this.config.CHAIN_ID;
    const cov = await this.db.getIndexerCoverage(cid).catch(() => null);
    if (!cov) return { done: 0, rateLimited: false };
    const batch = await this.db.poolsForStorageScan(cid, 1).catch(() => []);
    if (!batch.length) return { done: 0, rateLimited: false };
    const p = batch[0];
    const pool = p.pool.toLowerCase() as Address;
    if (pool.length !== 42) return { done: 0, rateLimited: false };   // V4 poolId — not storage-scannable here
    if (!p.token0 || !p.token1) { await this.db.noteTickBootstrapError(cid, pool, "storage scan: tokens unknown").catch(() => undefined); return { done: 0, rateLimited: false }; }
    const profile = tickStorageProfile(p.factory ?? undefined, { DEX_FACTORY: this.config.DEX_FACTORY, UNIV3_QUOTER: UNIV3_QUOTER_BASE });
    if (!profile?.quoter) { await this.db.failPoolTickStatus(cid, pool, "no known Quoter for fork → not storage-certifiable").catch(() => undefined); return { done: 1, rateLimited: false }; }
    const feePips = Number(p.fee) > 0 ? Number(p.fee) : 500;
    const tickSpacing = Number(p.tickSpacing) > 0 ? Number(p.tickSpacing) : (FEE_TO_SPACING[feePips] ?? 0);
    if (!tickSpacing) { await this.db.failPoolTickStatus(cid, pool, "storage scan: tickSpacing unknown").catch(() => undefined); return { done: 1, rateLimited: false }; }
    try {
      const head = Number(await client.getBlockNumber().catch(() => 0n));
      if (!head) return { done: 0, rateLimited: false };
      const B = Math.min(head - 3, cov.continuousThrough); // settled block the lane serves, ≤ our continuous head
      if (B <= 0) return { done: 0, rateLimited: false };
      const snap = await scanTickMap(client, pool, tickSpacing, B);
      // Report WHAT actually failed. The old message blamed the cost guard for every failure, including ABI
      // decode errors on 6-field forks — a misleading reason is worse than no reason: it sends you down the
      // wrong investigation. bitmapWordRange tells us whether the guard is genuinely the cause.
      if (!snap) {
        const { words } = bitmapWordRange(tickSpacing);
        const reason = words > 2000 ? `storage scan: word cost guard (${words} words @spacing ${tickSpacing})` : `storage scan: read/decode failed @spacing ${tickSpacing} (${words} words) — pool ABI or RPC`;
        await this.db.noteTickBootstrapError(cid, pool, reason).catch(() => undefined);
        return { done: 1, rateLimited: false };
      }
      const v = await validateSnapshotVsQuoter(client, profile.quoter, snap, p.token0 as Address, p.token1 as Address, feePips, tickSpacing);
      if (!v.validated) { await this.db.failPoolTickStatus(cid, pool, `storage snapshot did not reproduce Quoter (${v.detail})`).catch(() => undefined); return { done: 1, rateLimited: false }; }
      // Replay live Mint/Burn [B+1, cursor] so the authoritative snapshot is current with the indexer head.
      const cursor = (await this.db.getIndexerCursor(cid).catch(() => null)) ?? cov.continuousThrough;
      const replay: Array<{ tickLower: number; tickUpper: number; liquidityDelta: bigint }> = [];
      const hex = (n: number) => "0x" + n.toString(16);
      for (let from = B + 1; from <= cursor; from += 2000) {
        const to = Math.min(from + 1999, cursor);
        const logs = await (client as unknown as { request: (a: { method: string; params: unknown }) => Promise<unknown> }).request({ method: "eth_getLogs", params: [{ address: pool, topics: [[UNIV3_MINT, UNIV3_BURN]], fromBlock: hex(from), toBlock: hex(to) }] }) as RawLog[];
        for (const l of logs ?? []) { const d = EVENT_DECODERS.get((l.topics[0] ?? "").toLowerCase())?.(l); if (d && d.kind === "liquidity_v3") replay.push({ tickLower: d.tickLower, tickUpper: d.tickUpper, liquidityDelta: d.liquidityDelta }); }
      }
      const r = await this.db.replaceTickMapSnapshot(cid, pool, B, snap.ticks, cursor, replay);
      if (!r.ok) { await this.db.failPoolTickStatus(cid, pool, r.reason ?? "snapshot replace failed").catch(() => undefined); return { done: 1, rateLimited: false }; }
      // RE-CHECK: coverage generation/start must still hold (the indexer may have reset mid-scan) before certify.
      const cov2 = await this.db.getIndexerCoverage(cid).catch(() => null);
      if (cov2 && cov2.generation === cov.generation && cov2.coverageStart === cov.coverageStart) {
        await this.db.certifyPoolTickComplete(cid, pool, cov2.generation, "storage_scan");
        this.logger.info({ pool, B, through: cursor, ticks: snap.ticks.length, directions: v.directions, generation: cov2.generation }, "tick-map STORAGE SCAN certified complete");
      }
      return { done: 1, rateLimited: false };
    } catch (e) {
      if (isRateLimit(e)) return { done: 0, rateLimited: true };
      await this.db.failPoolTickStatus(cid, pool, e instanceof Error ? e.message : String(e)).catch(() => undefined);
      return { done: 0, rateLimited: false };
    }
  }

  /** Backfill `meta.factory` for pools that have it missing (old/bare pools discovered before the factory
   * was captured) — own-execution routes each pool to ITS dex's router. Now the enricher's job (was the
   * manual resync `factory` task). A pool whose factory() can't be read is block-marked so it isn't retried
   * forever. Runs on the enrichment lane, paced; NOT gate-blocking (factory isn't in the resync buffer). */
  private async enrichFactories(block: number | null): Promise<{ done: number; rateLimited: boolean }> {
    const batch = await this.db.poolsMissingFactory(this.config.CHAIN_ID, this.config.ENRICH_BATCH).catch(() => [] as string[]);
    if (!batch.length) return { done: 0, rateLimited: false };
    let done = 0;
    for (const pool of batch) {
      try {
        const f = (await this.chain.enrichment.readContract({ address: pool as Address, abi: POOL_META_ABI, functionName: "factory" }) as string).toLowerCase();
        await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: pool, kind: "pool", meta: { factory: f }, source: "enricher", block: block ?? undefined }).catch(() => undefined);
        done += 1;
      } catch (e) {
        if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done, rateLimited: true }; }
        await this.db.mergeEntityMeta(this.config.CHAIN_ID, pool, "pool", { factoryCheckedAt: block ?? 0 }).catch(() => undefined); // block-based marker (was timestamp)
      }
      await this.pace();
    }
    return { done, rateLimited: false };
  }

  /** Small inter-read spacing to keep the sustained rate under free-tier RPC limits (a burst gets 429'd). */
  private pace(): Promise<void> { return new Promise((r) => setTimeout(r, this.config.ENRICH_SPACING_MS)); }

  private async enrichVerified(): Promise<void> {
    const batch = await this.db.entitiesNeedingMeta(this.config.CHAIN_ID, this.config.ENRICH_BATCH).catch(() => []);
    if (!batch.length) return;
    let verified = 0, unverified = 0;
    for (const e of batch) {
      const m = await this.etherscan.contractMeta(e.address).catch(() => undefined);
      const patch: Record<string, unknown> = m
        ? { verified: m.verified, contractName: m.contractName ?? null, isProxy: m.isProxy, implementation: m.implementation ?? null, verifiedCheckedAt: new Date().toISOString() }
        : { verifiedCheckedAt: new Date().toISOString(), metaError: true };
      await this.db.mergeEntityMeta(this.config.CHAIN_ID, e.address, e.kind, patch).catch(() => undefined);
      if (m?.verified) verified += 1; else if (m) unverified += 1;
      await new Promise((r) => setTimeout(r, 250)); // < 5 req/s (Etherscan free tier)
    }
    this.logger.info({ enriched: batch.length, verified, unverified }, "registry entities enriched (verified/proxy)");
  }
}
