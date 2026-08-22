import type { Logger } from "pino";
import { parseAbi, createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { BerachainClients } from "./chain.js";
import type { Etherscan } from "./etherscan.js";
import type { Blockscout } from "./blockscout.js";
import { UNIV3_MINT, UNIV3_BURN, POOL_CREATED, V4_MODIFY_LIQUIDITY, EVENT_DECODERS, type RawLog } from "./indexer/events.js";
import { scanTickMap, validateSnapshotVsQuoter, tickStorageProfile, bitmapWordRange, MULTICALL3 } from "./router/tick-storage.js";

const UNIV3_QUOTER_BASE = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address; // Uniswap V3 QuoterV2 on Base
const FEE_TO_SPACING: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 }; // 2500=Pancake tier
const STORAGE_SCAN_INTERVAL_MS = 15_000; // heavy last-resort path (Pinax reliable lane) — bound its cadence
const GAS_POLL_INTERVAL_MS = 20_000;     // DB-first gas: write-side poller cadence (read-side reads gas_state)
const DEX_IDENTITY_INTERVAL_MS = 120_000; // factory identity barely changes; its queries are heavy (full pool aggregate)
const T0_IDLE_PROBE_MS = 10_000;        // T0 queues empty → probe rarely; while they have work the probe runs every cycle
const T0_BUSY_PROBE_MS = 1_000;         // while T0 has work, re-probe often — but never once per 400ms drain tick
const TICK_BOOTSTRAP_INTERVAL_MS = 5_000; // background tick reconstruction: its OWN beat, never the leftovers
const PROTO_FEE_INTERVAL_MS = 30_000;   // the protocol-fee pass owns an expensive DISTINCT-ON; bound its cadence

const POOL_META_ABI = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function factory() view returns (address)", "function tickSpacing() view returns (int24)"]);
const AERO_STABLE_ABI = parseAbi(["function stable() view returns (bool)"]);
const AERO_FACTORY_FEE_ABI = parseAbi(["function getFee(address pool, bool stable) view returns (uint256)"]);
const V2_FACTORY_ABI = parseAbi(["function getPair(address,address) view returns (address)"]);
const SOLIDLY_FACTORY_ABI = parseAbi(["function getPair(address,address,bool) view returns (address)","function isPair(address) view returns (bool)"]);
// ABI fingerprint used to classify an unknown pool: which of these it answers tells us its family.
const CLASSIFY_ABI = parseAbi(["function slot0() view returns (uint160,int24)","function globalState() view returns (uint160,int24,uint16,uint16,uint16,bool)","function stable() view returns (bool)","function getReserves() view returns (uint112,uint112,uint32)"]);
const ERC20_META_ABI = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)"]);
// POSITIVE CONTROL for lane liveness: Multicall3 is deployed at the same address on every chain and this
// call cannot revert, so a failure to answer it is proof about the TRANSPORT rather than about any pool.
const MULTICALL3_PROBE_ABI = parseAbi(["function getBlockNumber() view returns (uint256)"]);
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
  private lastDexIdentityAt = 0;
  private lastProbeAt = 0;
  private lastTickBootstrapAt = 0;
  private lastProtoFeeAt = 0;
  private t0Busy = true;   // assume work at boot so the first cycle probes before deciding
  private q = { poolFactory: true, factoryReverse: false, classify: false, aeroStable: false, protocolFee: true, dexIdentity: true };
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
      // ── BUFFER CASCADE, ORDERED BY LEVERAGE ────────────────────────────────────────────────────────────
      // The entities are not independent — they are the graph. Resolving one can unlock many others, and the
      // ratio is not marginal: measured on Base, ONE protocol-fee read on a single factory completes 6,793
      // pools, while the most connected pending token unlocks 2. So the buffer is consumed by how much an
      // entity UNLOCKS, not by how long it has waited nor by a fixed position in a sequence.
      //
      //   T0 multipliers — 1 read → N entities: factory attribution, protocol fee, archetype classification.
      //   T1 structural  — creates new entities: pool token0/token1 spawn the token entities T2 then resolves.
      //   T2 leaves      — decimals, symbol, aero stable flag (ordered internally by graph degree).
      //
      // A time-based throttle would be wrong here: it is right only while a queue is EMPTY and exactly wrong
      // when a backlog appears (60 high-leverage factories must not sit behind 4,000 pools). So the gate is the
      // QUEUE ITSELF — one cheap EXISTS probe — and a pass with work runs immediately at full speed.
      const idle = { done: 0, rateLimited: false };
      if (Date.now() - this.lastProbeAt > (this.t0Busy ? T0_BUSY_PROBE_MS : T0_IDLE_PROBE_MS)) {
        this.lastProbeAt = Date.now();
        this.q = await this.db.enrichmentQueueSignals(this.config.CHAIN_ID).catch(() => this.q);
      }
      const facs = this.q.poolFactory ? await this.enrichFactories(block) : idle;
      const rev = this.q.factoryReverse ? await this.enrichFactoryReverse(block) : idle;
      const cls = this.q.classify ? await this.enrichClassify(block) : idle;
      // protocol-fee: gated by the queue AND by a timer — its own query is a DISTINCT ON over every pool, so
      // "there is a fee-less factory" must not translate into that aggregate every 400ms.
      let pfee = idle;
      if (this.q.protocolFee && Date.now() - this.lastProtoFeeAt > PROTO_FEE_INTERVAL_MS) { this.lastProtoFeeAt = Date.now(); pfee = await this.enrichProtocolFees(block); }
      const dex = this.q.dexIdentity ? await this.enrichDexIdentity(block) : idle; // additionally self-throttled
      const t0Done = facs.done + rev.done + cls.done + pfee.done + dex.done;
      void t0Done; // recorded for the cycle log; it must NOT decide whether the other tiers run (see below)
      // dexIdentity is deliberately NOT part of `t0Busy`: a factory whose name is genuinely unobtainable keeps
      // that signal true forever, and a permanently-true "busy" would pin the probe at the hot cadence.
      this.t0Busy = this.q.poolFactory || this.q.factoryReverse || this.q.classify || this.q.protocolFee;
      // PRIORITY IS ORDER, NOT EXCLUSION. These used to be skipped entirely whenever T0 had done anything,
      // on the assumption that the T0 queues are "attempt-capped and small by construction". That assumption
      // is false while the indexer runs: it writes new bare pools continuously, so T0 always has a trickle and
      // T1/T2 only ran on alternate cycles. Tokens then drained at ~12 per 90s, leaving 2,188 in the resync
      // set — and the startup gate waits for that set to empty, so a scheduling heuristic was holding the whole
      // system down. Running T0 FIRST already gives high-leverage work its head start; every pass is bounded
      // by its own batch size, so there is no budget to protect by starving the others.
      const pools = await this.enrichPools(block);
      const toks = await this.enrichTokens(block);
      const syms = await this.enrichSymbols(block);
      const aero = this.q.aeroStable ? await this.enrichAeroStable(block) : idle;
      did = pools.done + toks.done + facs.done + aero.done + rev.done + pfee.done + syms.done + cls.done + dex.done;
      rateLimited = pools.rateLimited || toks.rateLimited || facs.rateLimited || aero.rateLimited || rev.rateLimited || pfee.rateLimited || syms.rateLimited || cls.rateLimited || dex.rateLimited;
      // ACTIVITY LOG: record only cycles that did work or hit a limit — an idle tick is not news, but a cycle
      // where the buffer is non-empty and NOTHING advanced is exactly what we need to be able to see.
      const passes: Record<string, number> = {};
      for (const [k, v] of [["pool", pools.done], ["token", toks.done], ["factory", facs.done], ["factoryReverse", rev.done], ["protocolFee", pfee.done], ["symbol", syms.done], ["classify", cls.done], ["aeroStable", aero.done], ["dexIdentity", dex.done]] as const) if (v) passes[k] = v;
      if (did || rateLimited) {
        await this.db.logEnrichmentCycle(this.config.CHAIN_ID, block, passes, rateLimited, rateLimited ? "RPC lane rate-limited — buffer waits and resumes" : undefined).catch(() => undefined);
      } else {
        // Nothing advanced: say WHY, so "stuck" is distinguishable from "finished".
        const left = await this.db.countEnrichPending(this.config.CHAIN_ID).catch(() => 0);
        if (left > 0) await this.db.logEnrichmentCycle(this.config.CHAIN_ID, block, {}, false, `${left} entità in coda ma nessun avanzamento — candidati non risolvibili o cap tentativi raggiunto`).catch(() => undefined);
      }
      // Tick-map bootstrap (Item 3.2): P0 (demand-driven, KG-requested) runs ALWAYS so it's never starved;
      // P1–P3 (background historical) only when the fast queues are idle.
      const tb0 = await this.enrichTickBootstrap(0); did += tb0.done; rateLimited = rateLimited || tb0.rateLimited;
      // BACKGROUND tick reconstruction (P1–P3). Gating it on "nothing else did work" starved it completely:
      // the foreground queues almost always advance something, so the pass that must rebuild the 20,625
      // re-opened V4 maps and the 884 failed V3 ones would simply never run. Background work needs its own
      // cadence, not the leftovers of a busy cycle — the same idiom the storage scan above already uses.
      if (Date.now() - this.lastTickBootstrapAt > TICK_BOOTSTRAP_INTERVAL_MS) {
        this.lastTickBootstrapAt = Date.now();
        const tb = await this.enrichTickBootstrap(3); did += tb.done; rateLimited = rateLimited || tb.rateLimited;
      }
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
      // Same reasoning: its own interval is the throttle, not the absence of other work.
      if (this.etherscan.available && Date.now() - this.lastVerifiedAt > this.config.ENRICH_INTERVAL_MS) { await this.enrichVerified(); this.lastVerifiedAt = Date.now(); }
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
      // Ask for `factory` only when it is MISSING. Re-reading a field we already hold wasted one sub-call per
      // pool per cycle AND — because the answer landed in `got` — counted the pool as `done` every cycle. That
      // faked progress: a pool blocked on fee/tickSpacing looked like it was advancing while nothing changed.
      if (!p.hasFactory) wants.push({ address: p.address, field: "factory" }); // own-execution routes per dex router
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
    const mcClient = this.bulkClient();
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
      // ZERO successes across a whole batch is AMBIGUOUS: a dead lane and a batch of contracts that genuinely
      // lack these functions produce the identical result. Assuming "lane" burned good pools into enrich_failed;
      // assuming "contracts" would loop for ever on a flaky RPC. So don't assume — ask a POSITIVE CONTROL: one
      // call that must succeed on a healthy lane. If it answers, the transport is proven and the batch's
      // failures are real reverts; if it doesn't, the lane is at fault and no pool is judged.
      if (still.length === before) {
        transportFailed = !(await mcClient.readContract({ address: MULTICALL3, abi: MULTICALL3_PROBE_ABI, functionName: "getBlockNumber" }).then(() => true).catch(() => false));
        break;
      }
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
    // Which requested fields came back REVERTED rather than unanswered. Inside a batch that produced other
    // successes the transport is proven working, so a still-failing sub-call is the chain saying "this contract
    // does not expose that function" — a fact about the entity, not about the lane.
    const reverted = new Map<string, string[]>();
    if (!transportFailed) {
      for (let i = 0; i < wants.length; i++) {
        if (results[i]?.status === "success") continue;
        const w = wants[i];
        const l = reverted.get(w.address) ?? []; l.push(w.field); reverted.set(w.address, l);
      }
    }
    // A pass that returns "nothing happened" must be able to say WHY. Silence here is what let the pool queue
    // sit at 62 for hours while every other pass reported progress: the cycle log only records what advanced.
    if (!got.size) {
      this.logger.warn({ batch: batch.length, wants: wants.length, answered: results.filter((r) => r?.status === "success").length, reverted: reverted.size, transportFailed, lane: "bulk" },
        "enrichment: pool batch produced no data — no field on any pool in the batch could be read");
    }
    let done = 0;
    for (const p of batch) {
      const meta = got.get(p.address);
      const blocked = reverted.get(p.address);
      // A pool that answers SOME fields and reverts on the rest is the case that used to loop forever: it was
      // counted as done (a field was written) and never accrued an attempt, so it came back every cycle for
      // ever. A definitive revert is evidence — record WHICH field the chain refuses, and count the attempt so
      // the cap eventually applies. The residue stays visible in `enrichBlockedBy` instead of silently cycling.
      if (blocked?.length) {
        await this.db.mergeEntityMeta(this.config.CHAIN_ID, p.address, "pool", { enrichBlockedBy: blocked }).catch(() => undefined);
        await this.db.bumpEnrichAttempt(this.config.CHAIN_ID, p.address, "pool", block, MAX_ATTEMPTS).catch(() => undefined);
      }
      // Count an attempt ONLY on a definitive answer (the call resolved and the data isn't there). After a
      // transport failure we leave the pool untouched so it is retried later instead of being burned.
      if (!meta || !Object.keys(meta).length) { if (!transportFailed && !blocked?.length) await this.db.bumpEnrichAttempt(this.config.CHAIN_ID, p.address, "pool", block, MAX_ATTEMPTS).catch(() => undefined); continue; }
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
    const isV4 = p.archetype === "v4"; // a poolId inside the singleton PoolManager, not a contract of its own
    if (isV4 && !p.factory) { await this.db.noteTickBootstrapError(cid, pool, "V4 pool without its PoolManager (factory) — cannot filter its logs").catch(() => undefined); return { done: 0, rateLimited: false }; }
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
        // V4 has no pool CONTRACT: every pool lives inside the singleton PoolManager and is addressed by its
        // poolId (bytes32). So the historical filter is by EMITTER + indexed poolId, not by pool address —
        // `address: <a 66-char poolId>` is not even a valid getLogs filter, which is why V4 could never have
        // been bootstrapped by this path.
        const filter = isV4
          ? { address: p.factory, topics: [V4_MODIFY_LIQUIDITY, pool], fromBlock: hex(from), toBlock: hex(to) }
          : { address: pool, topics: [[UNIV3_MINT, UNIV3_BURN]], fromBlock: hex(from), toBlock: hex(to) };
        try { logs = await req("eth_getLogs", [filter]) as RawLog[]; }
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
  /**
   * BULK-READ lane for background enrichment batches. Deliberately NOT the indexer's lane: the indexer is the
   * urgent, per-block component and must never contend with background work. Enrichment issues ~300 multicall
   * sub-calls every few seconds — putting that on the indexer's provider is what turns a healthy indexer into
   * a lagging one. base.org is multicall-capable and fast for this shape (measured 120 sub-calls in ~197ms).
   */
  private bulkClient(): PublicClient { return this.chain.primary; }

  /** RELIABLE/archive lane, reserved for the rare heavy storage scan (throttled) — not for per-cycle batches. */
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
    const cid = this.config.CHAIN_ID;
    const batch = await this.db.poolsMissingFactory(cid, POOL_BATCH).catch(() => []);
    if (!batch.length) return { done: 0, rateLimited: false };
    const mc = this.bulkClient();
    let res: Array<{ status: string; result?: unknown }>;
    try {
      res = await mc.multicall({ contracts: batch.map((p) => ({ address: p.address as Address, abi: POOL_META_ABI, functionName: "factory" as const })), multicallAddress: MULTICALL3, allowFailure: true }) as Array<{ status: string; result?: unknown }>; // db-first-allow: write-side enrichment
    } catch (e) {
      if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done: 0, rateLimited: true }; }
      return { done: 0, rateLimited: false }; // transport fault: no evidence about any pool → retry later untouched
    }
    let done = 0, unexposed = 0;
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i];
      if (res[i]?.status === "success") {
        await this.db.upsertEntity({ chainId: cid, address: p.address, kind: "pool", meta: { factory: String(res[i].result).toLowerCase() }, source: "enricher", block: block ?? undefined }).catch(() => undefined);
        done++;
      } else {
        // Count the attempt (bounded) instead of excluding forever. Once the cap is hit the pool moves to the
        // REVERSE-LOOKUP pass — the datum is recoverable another way, so it is never simply dropped.
        const prev = await this.db.getEntity(cid, p.address).catch(() => []);
        const n = Number(((prev[0]?.meta ?? {}) as { factoryAttempts?: unknown }).factoryAttempts ?? 0) + 1;
        await this.db.mergeEntityMeta(cid, p.address, "pool", { factoryAttempts: n }).catch(() => undefined);
        unexposed++;
      }
    }
    if (unexposed) this.logger.debug({ unexposed }, "factory() not exposed — queued for reverse lookup");
    return { done, rateLimited: false };
  }

  /**
   * FACTORY REVERSE LOOKUP — some pools genuinely do not expose factory() (verified on a real Solidly-family
   * pool). The datum is still recoverable: ask each CANDIDATE factory whether it created this pair. The one
   * whose getPair(token0, token1[, stable]) returns our address IS the factory. Finding the data by another
   * route beats recording a permanent hole.
   */
  private async enrichFactoryReverse(block: number | null): Promise<{ done: number; rateLimited: boolean }> {
    const cid = this.config.CHAIN_ID;
    const batch = await this.db.poolsForFactoryReverseLookup(cid, 12).catch(() => []);
    if (!batch.length) return { done: 0, rateLimited: false };
    const cands = await this.db.knownFactories(cid, ["v2", "aerodrome", "aerodrome-stable", "solidly"]).catch(() => []);
    if (!cands.length) return { done: 0, rateLimited: false };
    const mc = this.bulkClient();
    let done = 0;
    for (const p of batch) {
      if (!p.token0 || !p.token1) continue;
      const calls: Array<Record<string, unknown>> = [];
      const meta: Array<{ factory: string; stable?: boolean; membership?: boolean }> = [];
      for (const f of cands) {
        // isPair(pool) is a DIRECT membership test — independent of token ordering and of the fork's mapping
        // shape, so it succeeds where getPair(t0,t1,…) fails. Try it first, then the getPair variants.
        calls.push({ address: f as Address, abi: SOLIDLY_FACTORY_ABI, functionName: "isPair", args: [p.address] }); meta.push({ factory: f, membership: true });
        for (const st of [false, true]) { calls.push({ address: f as Address, abi: SOLIDLY_FACTORY_ABI, functionName: "getPair", args: [p.token0, p.token1, st] }); meta.push({ factory: f, stable: st }); }
        calls.push({ address: f as Address, abi: V2_FACTORY_ABI, functionName: "getPair", args: [p.token0, p.token1] }); meta.push({ factory: f });
      }
      let res: Array<{ status: string; result?: unknown }>;
      try { res = await mc.multicall({ contracts: calls as never, multicallAddress: MULTICALL3, allowFailure: true }) as Array<{ status: string; result?: unknown }>; } // db-first-allow: write-side enrichment
      catch (e) { if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done, rateLimited: true }; } return { done, rateLimited: false }; }
      const hit = res.findIndex((r, i) => r?.status === "success" && meta[i] && (meta[i].membership ? r.result === true : String(r.result).toLowerCase() === p.address.toLowerCase()));
      if (hit >= 0) {
        const m = meta[hit];
        const patch: Record<string, unknown> = { factory: m.factory.toLowerCase(), factoryResolvedBy: "reverse-getPair" };
        if (m.stable !== undefined) patch.stableFlag = m.stable; // the factory also tells us the curve variant
        await this.db.upsertEntity({ chainId: cid, address: p.address, kind: "pool", meta: patch, source: "enricher", block: block ?? undefined }).catch(() => undefined);
        done++;
      } else {
        await this.db.mergeEntityMeta(cid, p.address, "pool", { factoryResolvedBy: "none (no candidate factory claims it)" }).catch(() => undefined);
      }
    }
    return { done, rateLimited: false };
  }

  /**
   * PROTOCOL FEE — for constant-product families the fee is NOT a per-pool datum (a V2 pair has no fee()); it
   * belongs to the protocol. Resolve it ONCE per factory and record its SOURCE, so a protocol constant stays
   * distinguishable from a value we actually read. This is what removes the `fee || 3000` guesses downstream.
   */
  private async enrichProtocolFees(block: number | null): Promise<{ done: number; rateLimited: boolean }> {
    const cid = this.config.CHAIN_ID;
    const batch = await this.db.factoriesNeedingFee(cid, 8).catch(() => []);
    if (!batch.length) return { done: 0, rateLimited: false };
    let done = 0;
    for (const f of batch) {
      try {
        // 1) Ask the factory (Aerodrome/Solidly expose getFee) — a READ beats any assumption.
        const read = await this.chain.enrichment.readContract({ address: f.factory as Address, abi: AERO_FACTORY_FEE_ABI, functionName: "getFee", args: [f.samplePool as Address, f.stable] }).then(Number).catch(() => null); // db-first-allow: write-side enrichment
        if (read != null && read > 0) { await this.db.setFactoryFee(cid, f.factory, read * 100, "factory.getFee"); done++; await this.pace(); continue; } // bps → ppm
        // 2) Otherwise it is a protocol CONSTANT (UniV2-style pairs hardcode 0.30%). Recording it with its
        //    source is a fact about the protocol, not a silent default.
        if (f.archetype === "v2") { await this.db.setFactoryFee(cid, f.factory, 3000, "protocol-constant:univ2-0.30%"); done++; }
      } catch (e) { if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done, rateLimited: true }; } }
      await this.pace();
    }
    return { done, rateLimited: false };
  }


  /**
   * ROUTER derivation — from OBSERVATION, because a factory cannot be asked. Only 4 of 146 factories had a
   * router, and without one none of that factory's pools is own-executable, which is what caps routeEncodable
   * in the KG funnel. But every Swap names the contract that called it, and for a factory's own pools that
   * caller IS the router — the evidence was in the block stream all along, simply discarded at decode time.
   *
   * The one thing that must not be got wrong is mistaking an AGGREGATOR for a router: it appears as sender
   * too, and everywhere. Exclusivity separates them by construction — a Uniswap router physically cannot swap
   * an Aerodrome pool, so a genuine router's swaps sit almost entirely on its own factory, while an aggregator
   * spreads across many. The promotion records the numbers behind it, so the claim can be re-checked later
   * instead of being an unexplained address.
   */
  private async deriveRouters(cid: number, block: number | null): Promise<number> {
    let n = 0;
    for (const c of await this.db.routerCandidates(cid).catch(() => [])) {
      await this.db.upsertEntity({ chainId: cid, address: c.factory, kind: "dex", meta: { router: c.router, routerSource: `swap-sender: ${c.swaps} swaps on ${c.pools} pools, exclusivity ${(c.exclusivity * 100).toFixed(1)}%` }, source: "enricher", block: block ?? undefined }).catch(() => undefined);
      this.logger.info({ factory: c.factory, router: c.router, swaps: c.swaps, pools: c.pools, exclusivity: Number(c.exclusivity.toFixed(3)) }, "router derived from swap senders");
      n += 1;
    }
    return n;
  }

  /**
   * FACTORY IDENTITY — the `dex` kind was structurally excluded from enrichment (only token/pool could ever
   * be "pending"), leaving 134 of 140 factories anonymous. That matters far beyond tidiness: a factory without
   * an identity has no router, and without a router every pool it created is NOT own-executable — which is
   * exactly what caps `routeEncodable` in the KG funnel.
   *
   * `type` needs NO network call: a factory's family is the archetype of the pools it created, and we have
   * indexed thousands of them. `name` comes from the verified contract name we already fetch. The ROUTER is
   * deliberately not attempted here — it is not readable from the factory and needs its own derivation.
   */
  private async enrichDexIdentity(block: number | null): Promise<{ done: number; rateLimited: boolean }> {
    const cid = this.config.CHAIN_ID;
    // THROTTLE + CHEAP PRE-CHECK. Both queries below aggregate every pool row by factory (JSONB extraction,
    // no index) — fine occasionally, ruinous in a 400ms loop: running them every cycle starved Postgres and
    // BLOCKED THE INDEXER's writes on an LWLock. An index-backed count decides whether the heavy work is
    // needed at all, and the pass is bounded to a slow cadence because factory identity barely changes.
    if (Date.now() - this.lastDexIdentityAt < DEX_IDENTITY_INTERVAL_MS) return { done: 0, rateLimited: false };
    this.lastDexIdentityAt = Date.now();
    // The ROUTER derivation runs BEFORE the "is anything pending" pre-check, deliberately. `enrich_pending`
    // for a dex means ONE thing — the type is missing — so with all 146 factories typed the pre-check would
    // return zero and skip the whole pass, hiding the router work behind an unrelated field. That is the same
    // shape of bug as the enrichment buffer keyed on token0: a queue predicate that speaks for one field only
    // makes every other missing datum invisible for ever. Its own query is index-backed and throttled above.
    const routers = await this.deriveRouters(cid, block);
    const pendingDex = await this.db.countPendingByKind(cid, "dex").catch(() => 0);
    if (!pendingDex) return { done: routers, rateLimited: false };
    // 1) TYPE in bulk, from data we already hold — one SQL statement, no network, no pacing. Do this FIRST so
    //    a derivable field is never queued behind a field that needs a (possibly failing) external lookup.
    const typed = await this.db.deriveFactoryTypes(cid).catch(() => 0);
    // 2) NAME is the only part that needs the network; it is best-effort and bounded.
    const batch = await this.db.factoriesNeedingIdentity(cid, 15).catch(() => []);
    if (!batch.length) return { done: typed + routers, rateLimited: false };
    const TYPE_OF: Record<string, string> = { v3: "uni-v3", v4: "uni-v4", slipstream: "slipstream", algebra: "algebra", v2: "uni-v2", aerodrome: "aerodrome", "aerodrome-stable": "aerodrome", solidly: "solidly" };
    let done = typed + routers;
    for (const f of batch) {
      const patch: Record<string, unknown> = {};
      if (!f.hasType && f.poolArchetype && TYPE_OF[f.poolArchetype]) { patch.type = TYPE_OF[f.poolArchetype]; patch.typeSource = `pools:${f.poolArchetype}(${f.pools})`; }
      let name: string | undefined;
      if (!f.hasName) {
        name = f.contractName ?? undefined;                       // already fetched by the verified pass
        // BOUNDED best-effort: an unverified contract has no name to give, so asking again every cycle only
        // burns a rate-limited third-party API. Try a couple of times, then stop and keep the factory usable.
        if (!name && this.etherscan.available && f.nameAttempts < 2) {
          name = (await this.etherscan.contractMeta(f.address).catch(() => undefined))?.contractName ?? undefined;
          if (!name) patch.nameAttempts = f.nameAttempts + 1;
        }
      }
      if (!Object.keys(patch).length && !name) continue;
      await this.db.upsertEntity({ chainId: cid, address: f.address, kind: "dex", name, meta: patch, source: "enricher", block: block ?? undefined }).catch(() => undefined);
      done++;
      await this.pace();
    }
    return { done, rateLimited: false };
  }

  /** SYMBOL backfill — a plain ERC20 call we simply were not making (symbol was only ever taken from a
   * third-party API while filling decimals, so a token that already had decimals was never revisited). */
  private async enrichSymbols(block: number | null): Promise<{ done: number; rateLimited: boolean }> {
    const cid = this.config.CHAIN_ID;
    const batch = await this.db.tokensMissingSymbol(cid, 60).catch(() => [] as string[]);
    if (!batch.length) return { done: 0, rateLimited: false };
    const mc = this.bulkClient();
    let res: Array<{ status: string; result?: unknown }>;
    try { res = await mc.multicall({ contracts: batch.map((a) => ({ address: a as Address, abi: ERC20_META_ABI, functionName: "symbol" as const })), multicallAddress: MULTICALL3, allowFailure: true }) as Array<{ status: string; result?: unknown }>; } // db-first-allow: write-side enrichment
    catch (e) { if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done: 0, rateLimited: true }; } return { done: 0, rateLimited: false }; }
    let done = 0;
    for (let i = 0; i < batch.length; i++) {
      const v = res[i]?.status === "success" ? String(res[i].result).slice(0, 32) : null;
      if (v && v !== "?") { await this.db.upsertEntity({ chainId: cid, address: batch[i], kind: "token", symbol: v, source: "enricher", block: block ?? undefined }).catch(() => undefined); done++; }
      else await this.db.mergeEntityMeta(cid, batch[i], "token", { symbolAttempts: 1 }).catch(() => undefined);
    }
    return { done, rateLimited: false };
  }

  /** CLASSIFY unknown-archetype pools from their ABI fingerprint — they are ACTIVE pools we simply never
   * identified, and an unclassified pool is invisible to every archetype-aware query downstream. */
  private async enrichClassify(block: number | null): Promise<{ done: number; rateLimited: boolean }> {
    const cid = this.config.CHAIN_ID;
    const batch = await this.db.poolsNeedingClassification(cid, 20).catch(() => []);
    if (!batch.length) return { done: 0, rateLimited: false };
    const mc = this.bulkClient();
    const calls: Array<Record<string, unknown>> = [];
    for (const p of batch) {
      calls.push({ address: p.address as Address, abi: CLASSIFY_ABI, functionName: "slot0" });
      calls.push({ address: p.address as Address, abi: CLASSIFY_ABI, functionName: "globalState" });
      calls.push({ address: p.address as Address, abi: CLASSIFY_ABI, functionName: "stable" });
      calls.push({ address: p.address as Address, abi: CLASSIFY_ABI, functionName: "getReserves" });
    }
    let res: Array<{ status: string; result?: unknown }>;
    try { res = await mc.multicall({ contracts: calls as never, multicallAddress: MULTICALL3, allowFailure: true }) as Array<{ status: string; result?: unknown }>; } // db-first-allow: write-side enrichment
    catch (e) { if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done: 0, rateLimited: true }; } return { done: 0, rateLimited: false }; }
    let done = 0;
    for (let i = 0; i < batch.length; i++) {
      const [hasSlot0, hasGlobal, stableRes, hasReserves] = [res[i * 4], res[i * 4 + 1], res[i * 4 + 2], res[i * 4 + 3]];
      let archetype: string | null = null;
      if (hasSlot0?.status === "success") archetype = "v3";
      else if (hasGlobal?.status === "success") archetype = "v3";                       // Algebra-family (concentrated)
      else if (stableRes?.status === "success") archetype = stableRes.result === true ? "aerodrome-stable" : "aerodrome";
      else if (hasReserves?.status === "success") archetype = "v2";
      if (archetype) { await this.db.upsertEntity({ chainId: cid, address: batch[i].address, kind: "pool", meta: { archetype, archetypeSource: "abi-fingerprint" }, source: "enricher", block: block ?? undefined }).catch(() => undefined); done++; }
      else await this.db.mergeEntityMeta(cid, batch[i].address, "pool", { classifyAttempts: 1 }).catch(() => undefined);
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
