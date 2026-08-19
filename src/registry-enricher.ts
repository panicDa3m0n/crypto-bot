import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { BerachainClients } from "./chain.js";
import type { Etherscan } from "./etherscan.js";
import type { Blockscout } from "./blockscout.js";

const POOL_META_ABI = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function factory() view returns (address)"]);
const ERC20_META_ABI = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)"]);
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
      did = pools.done + toks.done + facs.done;
      rateLimited = pools.rateLimited || toks.rateLimited || facs.rateLimited;
      // Etherscan verified/proxy signal — only when the fast queue is idle and not more than once per interval.
      if (!did && this.etherscan.available && Date.now() - this.lastVerifiedAt > this.config.ENRICH_INTERVAL_MS) { await this.enrichVerified(); this.lastVerifiedAt = Date.now(); }
    } finally {
      this.running = false;
      this.schedule(rateLimited ? BACKOFF_MS : did ? FAST_MS : this.config.ENRICH_INTERVAL_MS);
    }
  }

  /** Fill token0/token1/fee for bare pools discovered by their Swap/Sync (pre-existing pools). Writing
   * token0 flips `enrich_pending` false automatically (generated column) — no bookkeeping flag needed. */
  private async enrichPools(block: number | null): Promise<{ done: number; rateLimited: boolean }> {
    const batch = await this.db.entitiesNeedingPoolInfo(this.config.CHAIN_ID, this.config.ENRICH_BATCH).catch(() => []);
    if (!batch.length) return { done: 0, rateLimited: false };
    let done = 0;
    for (const p of batch) {
      try {
        const [t0, t1] = await Promise.all([
          this.chain.enrichment.readContract({ address: p.address as Address, abi: POOL_META_ABI, functionName: "token0" }) as Promise<string>,
          this.chain.enrichment.readContract({ address: p.address as Address, abi: POOL_META_ABI, functionName: "token1" }) as Promise<string>
        ]);
        const token0 = t0.toLowerCase(), token1 = t1.toLowerCase();
        const [fee, factory] = await Promise.all([
          p.archetype === "v3" ? this.chain.enrichment.readContract({ address: p.address as Address, abi: POOL_META_ABI, functionName: "fee" }).then(Number).catch(() => undefined) : Promise.resolve(undefined),
          this.chain.enrichment.readContract({ address: p.address as Address, abi: POOL_META_ABI, functionName: "factory" }).then((f) => (f as string).toLowerCase()).catch(() => undefined) // own-execution routes each pool to ITS dex router
        ]);
        await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: p.address, kind: "pool", meta: { token0, token1, fee, ...(factory ? { factory } : {}) }, source: "enricher", block: block ?? undefined }).catch(() => undefined);
        // Ensure the two tokens exist as entities so they enter the buffer for decimals enrichment next.
        await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: token0, kind: "token", source: "enricher", block: block ?? undefined }).catch(() => undefined);
        await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: token1, kind: "token", source: "enricher", block: block ?? undefined }).catch(() => undefined);
        done += 1;
      } catch (e) {
        if (isRateLimit(e)) { this.chain.laneError("enrichment", e); return { done, rateLimited: true }; }
        await this.db.bumpEnrichAttempt(this.config.CHAIN_ID, p.address, "pool", block, MAX_ATTEMPTS).catch(() => undefined);
      }
      await this.pace();
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
