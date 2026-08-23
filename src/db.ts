import pg from "pg";
import type { Decision, NetworkObservation, PortfolioSnapshot } from "./domain.js";
import { jsonSafe } from "./json.js";
import { summarizeMiniMaxUsage, type MiniMaxUsageSummary } from "./usage.js";
import { CONCENTRATED } from "./archetypes.js";

/** node-postgres binds JavaScript arrays as PostgreSQL arrays, not JSON arrays. */
function jsonParam(value: unknown): string {
  return JSON.stringify(jsonSafe(value)) ?? "null";
}

export type PositionPlan = {
  id: number; chainId: number; token: string; symbol: string | null; baseToken: string;
  status: string; entryKind: string; entryPrice: number | null; entryAmountUsd: number;
  filledAmountToken: number | null; filledPrice: number | null; filledAt: string | null;
  stopLossPct: number | null; takeProfitPct: number | null;
  partials: Array<{ atPct: number; sellPct: number; done?: boolean }>;
  remainingPct: number; note: string | null; lastResult: string | null; exitNowPct: number | null; entryAttempts: number; strategy: string | null;
};
function rowToPlan(r: Record<string, unknown>): PositionPlan {
  const num = (v: unknown): number | null => v === null || v === undefined ? null : Number(v);
  return {
    id: Number(r.id), chainId: Number(r.chain_id), token: String(r.token), symbol: (r.symbol as string) ?? null, baseToken: String(r.base_token),
    status: String(r.status), entryKind: String(r.entry_kind), entryPrice: num(r.entry_price), entryAmountUsd: Number(r.entry_amount_usd),
    filledAmountToken: num(r.filled_amount_token), filledPrice: num(r.filled_price), filledAt: r.filled_at ? new Date(r.filled_at as string).toISOString() : null,
    stopLossPct: num(r.stop_loss_pct), takeProfitPct: num(r.take_profit_pct), partials: (r.partials as PositionPlan["partials"]) ?? [],
    remainingPct: Number(r.remaining_pct), note: (r.note as string) ?? null, lastResult: (r.last_result as string) ?? null, exitNowPct: num(r.exit_now_pct), entryAttempts: Number(r.entry_attempts ?? 0), strategy: (r.strategy as string) ?? null
  };
}

export type LendingPosition = {
  chainId: number; protocol: string; marketId: string; borrower: string;
  collateralToken: string | null; collateralSymbol: string | null; loanToken: string | null; loanSymbol: string | null;
  hf: number | null; debtUsd: number | null; collateralUsd: number | null; exitUsd: number | null; profitUsd: number | null; lltv: number | null;
  tier: string; reason: string | null; nextCheckAt: string; lastCheckedAt: string | null; meta: Record<string, unknown>;
};
function rowToLendingPosition(r: Record<string, unknown>): LendingPosition {
  const num = (v: unknown): number | null => v === null || v === undefined ? null : Number(v);
  return {
    chainId: Number(r.chain_id), protocol: String(r.protocol), marketId: String(r.market_id), borrower: String(r.borrower),
    collateralToken: (r.collateral_token as string) ?? null, collateralSymbol: (r.collateral_symbol as string) ?? null,
    loanToken: (r.loan_token as string) ?? null, loanSymbol: (r.loan_symbol as string) ?? null,
    hf: num(r.hf), debtUsd: num(r.debt_usd), collateralUsd: num(r.collateral_usd), exitUsd: num(r.exit_usd), profitUsd: num(r.profit_usd), lltv: num(r.lltv),
    tier: String(r.tier), reason: (r.reason as string) ?? null,
    nextCheckAt: r.next_check_at ? new Date(r.next_check_at as string).toISOString() : new Date().toISOString(),
    lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at as string).toISOString() : null,
    meta: (r.meta as Record<string, unknown>) ?? {}
  };
}

/** System-seeded signal blacklist. 'symbol' matches as a case-insensitive SUBSTRING, so
 * "TEST" catches testwstETH/testWETH/any *TEST* market. 'exclude' = never shown; 'secondary'
 * = demoted to the occasional-verification bucket. Scarlet extends this at runtime. */
const SEED_BLACKLIST: Array<{ scope: "token" | "symbol"; value: string; tier: "exclude" | "secondary"; reason: string }> = [
  { scope: "symbol", value: "TEST", tier: "exclude", reason: "test/synthetic market token — not real prey" }
];

export type ProtocolVerification = {
  protocol: "reward-vault" | "bend-vault" | "bex" | "other";
  address: string;
  verifiedAt: Date;
  blockNumber: bigint;
  codeHash: string;
  status: "verified" | "rejected";
  details: Record<string, unknown>;
};

/**
 * Make a chain-derived string SAFE to store.
 *
 * A token's name and symbol are attacker-controlled: anyone can deploy a contract whose name contains a NUL
 * byte, a lone surrogate or malformed UTF-8. Postgres rejects those outright ("invalid byte sequence for
 * encoding UTF8"), so the whole INSERT fails — and because these writes are deliberately non-fatal, the
 * token was simply never stored, silently, for ever. It surfaced only once swallowed write failures started
 * being counted: 20 of them within minutes.
 *
 * Strip rather than reject: the token exists and we want it in the registry: it is the name that is hostile,
 * not the entity. Truncation bounds the damage from a deliberately enormous one.
 */
function safeText(v: string | null | undefined, max = 96): string | null {
  if (v == null) return null;
  const cleaned = v
    .replace(/\u0000/g, "")                        // Postgres cannot store NUL in text or jsonb
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "") // lone high surrogate
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "") // lone low surrogate
    .trim();
  return cleaned.length ? cleaned.slice(0, max) : null;
}

export class Database {
  readonly pool: pg.Pool;
  /** Cache for the factory-coverage aggregate: it scans every pool row, so it must not run at dashboard
   * polling frequency — doing so contended with the indexer's writes on the same table. */
  private execCovCache?: { at: number; rows: Array<{ factory: string; name: string | null; type: string | null; hasRouter: boolean; pools: number }> };

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 8 });
  }

  /**
   * WAIT for the database instead of dying because it is a few seconds late.
   *
   * `depends_on: service_healthy` only governs `docker compose up`. After a HOST reboot the daemon restarts
   * everything at once under its restart policy, which does not honour that ordering — so the app raced
   * Postgres, failed DNS resolution, and was killed as a "fatal startup failure" 23 times in a row until the
   * database happened to win. A service whose dependency is briefly unavailable should wait for it, not
   * crash-loop; the retries are bounded so a genuinely absent database still fails loudly rather than hanging.
   */
  private async awaitDatabase(attempts = 30, gapMs = 2_000): Promise<void> {
    for (let i = 1; i <= attempts; i++) {
      try { await this.pool.query("SELECT 1"); return; }
      catch (e) {
        if (i === attempts) throw e;
        await new Promise((r) => setTimeout(r, gapMs));
      }
    }
  }

  async migrate(): Promise<void> {
    await this.awaitDatabase();
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS network_observations (
        id BIGSERIAL PRIMARY KEY,
        observed_at TIMESTAMPTZ NOT NULL,
        primary_block NUMERIC NOT NULL,
        secondary_block NUMERIC NOT NULL,
        block_gap NUMERIC NOT NULL,
        gas_price_wei NUMERIC NOT NULL,
        primary_healthy BOOLEAN NOT NULL,
        secondary_healthy BOOLEAN NOT NULL,
        primary_rpc TEXT,
        secondary_rpc TEXT,
        source TEXT NOT NULL
      );
      ALTER TABLE network_observations ADD COLUMN IF NOT EXISTS primary_rpc TEXT;
      ALTER TABLE network_observations ADD COLUMN IF NOT EXISTS secondary_rpc TEXT;
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id BIGSERIAL PRIMARY KEY,
        observed_at TIMESTAMPTZ NOT NULL,
        wallet_address TEXT,
        bera NUMERIC NOT NULL,
        wbera NUMERIC NOT NULL DEFAULT 0,
        usdc_e NUMERIC NOT NULL,
        honey NUMERIC NOT NULL DEFAULT 0,
        nav_usd NUMERIC NOT NULL,
        daily_loss_usd NUMERIC NOT NULL,
        locked_usd NUMERIC NOT NULL,
        data_healthy BOOLEAN NOT NULL
      );
      ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS wbera NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS honey NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS bera_usd NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS honey_usd NUMERIC NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS decisions (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decision JSONB NOT NULL,
        model_response JSONB,
        status TEXT NOT NULL,
        outcome JSONB
      );
      ALTER TABLE decisions ADD COLUMN IF NOT EXISTS model_response JSONB;
      ALTER TABLE decisions ADD COLUMN IF NOT EXISTS portfolio JSONB;
      ALTER TABLE decisions ADD COLUMN IF NOT EXISTS evidence JSONB;
      ALTER TABLE decisions ADD COLUMN IF NOT EXISTS execution_plan JSONB;
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id BIGSERIAL PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        category TEXT NOT NULL,
        amount_usd NUMERIC NOT NULL,
        tx_hash TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE IF NOT EXISTS market_snapshots (
        id BIGSERIAL PRIMARY KEY,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source TEXT NOT NULL,
        snapshot_key TEXT NOT NULL,
        payload JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS protocol_verifications (
        id BIGSERIAL PRIMARY KEY,
        protocol TEXT NOT NULL,
        address TEXT NOT NULL,
        verified_at TIMESTAMPTZ NOT NULL,
        block_number NUMERIC NOT NULL,
        code_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        details JSONB NOT NULL,
        UNIQUE(protocol, address, block_number)
      );
      CREATE TABLE IF NOT EXISTS executions (
        id BIGSERIAL PRIMARY KEY,
        decision_id UUID NOT NULL REFERENCES decisions(id),
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tx_hash TEXT UNIQUE NOT NULL,
        target TEXT NOT NULL,
        calldata TEXT NOT NULL,
        value_wei NUMERIC NOT NULL,
        gas_limit NUMERIC NOT NULL,
        gas_used NUMERIC,
        effective_gas_price_wei NUMERIC,
        status TEXT NOT NULL,
        receipt JSONB,
        position JSONB
      );
      ALTER TABLE executions ADD COLUMN IF NOT EXISTS protocol_id TEXT;
      ALTER TABLE executions ADD COLUMN IF NOT EXISTS bera_usd_at_submission NUMERIC;
      ALTER TABLE executions ADD COLUMN IF NOT EXISTS position JSONB;
      CREATE UNIQUE INDEX IF NOT EXISTS ledger_gas_tx_hash_unique ON ledger_entries(tx_hash) WHERE category='gas' AND tx_hash IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ledger_execution_capital_tx_hash_unique ON ledger_entries(tx_hash) WHERE category='execution_capital_delta' AND tx_hash IS NOT NULL;
      CREATE TABLE IF NOT EXISTS scan_cursors (
        scanner_key TEXT PRIMARY KEY,
        block_number NUMERIC NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bend_accounts (
        market_id TEXT NOT NULL,
        account TEXT NOT NULL,
        first_seen_block NUMERIC NOT NULL,
        last_seen_block NUMERIC NOT NULL,
        last_position_checked_at TIMESTAMPTZ,
        PRIMARY KEY(market_id, account)
      );
      ALTER TABLE bend_accounts ADD COLUMN IF NOT EXISTS last_position_checked_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS bend_positions (
        id BIGSERIAL PRIMARY KEY,
        observed_at TIMESTAMPTZ NOT NULL,
        block_number NUMERIC NOT NULL,
        market_id TEXT NOT NULL,
        account TEXT NOT NULL,
        loan_token TEXT NOT NULL,
        collateral_token TEXT NOT NULL,
        oracle TEXT NOT NULL,
        borrow_assets NUMERIC NOT NULL,
        collateral NUMERIC NOT NULL,
        lltv NUMERIC NOT NULL,
        oracle_price NUMERIC NOT NULL,
        health_factor_wad NUMERIC,
        liquidatable BOOLEAN NOT NULL
      );
      CREATE TABLE IF NOT EXISTS official_documents (
        id BIGSERIAL PRIMARY KEY,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content_length INTEGER NOT NULL,
        changed BOOLEAN NOT NULL,
        UNIQUE(url, content_hash)
      );
      CREATE TABLE IF NOT EXISTS positions (
        id BIGSERIAL PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        protocol_id TEXT NOT NULL,
        vault_address TEXT NOT NULL,
        asset_address TEXT NOT NULL,
        shares_raw NUMERIC NOT NULL,
        assets_raw NUMERIC NOT NULL,
        value_usd NUMERIC NOT NULL,
        status TEXT NOT NULL,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE(protocol_id, vault_address)
      );
      CREATE TABLE IF NOT EXISTS opportunity_candidates (
        id BIGSERIAL PRIMARY KEY,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        fingerprint TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        protocol TEXT NOT NULL,
        block_number NUMERIC,
        qualified BOOLEAN NOT NULL,
        expected_net_profit_usd NUMERIC,
        reason TEXT NOT NULL,
        evidence JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS strategy_hypotheses (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        hypothesis JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'research',
        evidence JSONB NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE TABLE IF NOT EXISTS research_traces (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL,
        context JSONB NOT NULL,
        model_response JSONB,
        parsed_hypotheses JSONB NOT NULL DEFAULT '[]'::jsonb,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS network_observations_observed_at_idx ON network_observations(observed_at DESC);
      CREATE INDEX IF NOT EXISTS portfolio_snapshots_observed_at_idx ON portfolio_snapshots(observed_at DESC);
      CREATE INDEX IF NOT EXISTS ledger_entries_occurred_at_idx ON ledger_entries(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS market_snapshots_lookup_idx ON market_snapshots(source, snapshot_key, observed_at DESC);
      CREATE INDEX IF NOT EXISTS protocol_verifications_lookup_idx ON protocol_verifications(protocol, address, verified_at DESC);
      CREATE INDEX IF NOT EXISTS bend_positions_lookup_idx ON bend_positions(market_id, account, observed_at DESC);
      CREATE INDEX IF NOT EXISTS bend_positions_liquidatable_idx ON bend_positions(liquidatable, observed_at DESC);
      CREATE INDEX IF NOT EXISTS official_documents_lookup_idx ON official_documents(url, observed_at DESC);
      CREATE INDEX IF NOT EXISTS positions_status_idx ON positions(status, last_reconciled_at DESC);
      CREATE INDEX IF NOT EXISTS opportunity_candidates_lookup_idx ON opportunity_candidates(qualified, observed_at DESC);
      CREATE INDEX IF NOT EXISTS research_traces_created_at_idx ON research_traces(created_at DESC);
      CREATE TABLE IF NOT EXISTS scarlet_journal (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cycle TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS scarlet_journal_at_idx ON scarlet_journal(at DESC);
      CREATE INDEX IF NOT EXISTS scarlet_journal_cycle_idx ON scarlet_journal(cycle);
      -- Chronology STREAM: separates independent agent histories (e.g. the rebuilt trading core starts
      -- fresh, detached from the legacy agent's diary) while sharing the same compaction machinery.
      ALTER TABLE scarlet_journal ADD COLUMN IF NOT EXISTS stream TEXT NOT NULL DEFAULT 'main';
      CREATE INDEX IF NOT EXISTS scarlet_journal_stream_idx ON scarlet_journal(stream, id);
      -- Compaction summaries: each row summarizes all journal entries up to
      -- up_to_journal_id, so cross-cycle continuity survives without unbounded context.
      CREATE TABLE IF NOT EXISTS agent_summaries (
        id BIGSERIAL PRIMARY KEY,
        up_to_journal_id BIGINT NOT NULL,
        from_cycle TEXT,
        to_cycle TEXT,
        summary TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE agent_summaries ADD COLUMN IF NOT EXISTS stream TEXT NOT NULL DEFAULT 'main';
      -- Auto-flash: armed liquidation triggers. A background watcher simulates each
      -- one; the instant the simulation passes (position crossed hf<1 and funds are
      -- ready), it fires the real liquidation and wakes Scarlet with the result.
      CREATE TABLE IF NOT EXISTS autoflash (
        id BIGSERIAL PRIMARY KEY,
        label TEXT,
        market_id TEXT,
        borrower TEXT,
        target TEXT NOT NULL,
        signature TEXT NOT NULL,
        args JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'armed',
        note TEXT,
        created_cycle TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checked_at TIMESTAMPTZ,
        fired_at TIMESTAMPTZ,
        tx_hash TEXT,
        result JSONB
      );
      CREATE INDEX IF NOT EXISTS autoflash_status_idx ON autoflash(status);
      -- Fresh launches: pools created after we started watching (factory PoolCreated
      -- events), the real-time surface for new-token sniping on a growth chain.
      CREATE TABLE IF NOT EXISTS discovered_pools (
        pool TEXT PRIMARY KEY,
        dex TEXT NOT NULL,
        token0 TEXT NOT NULL,
        token1 TEXT NOT NULL,
        new_token TEXT,
        new_symbol TEXT,
        fee INTEGER,
        liquidity_usd NUMERIC,
        discovered_block BIGINT,
        discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS discovered_pools_at_idx ON discovered_pools(discovered_at DESC);
      -- Deployed organs: atomic executor contracts Scarlet owns and reuses.
      CREATE TABLE IF NOT EXISTS organs (
        kind TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        tx_hash TEXT,
        deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS scarlet_memory (
        key TEXT PRIMARY KEY,
        category TEXT NOT NULL DEFAULT 'note',
        content TEXT NOT NULL,
        tags TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS scarlet_memory_category_idx ON scarlet_memory(category, updated_at DESC);
      -- Operative-state machine log: every transition Scarlet chooses (with her justification), kept for
      -- continuity + shown in the dashboard. The latest row is her current operative state.
      CREATE TABLE IF NOT EXISTS scarlet_state (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        state TEXT NOT NULL,
        justification TEXT,
        cycle TEXT,
        phase TEXT NOT NULL DEFAULT 'operative'
      );
      CREATE INDEX IF NOT EXISTS scarlet_state_at_idx ON scarlet_state(at DESC);
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_value_usd NUMERIC;
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'erc4626';
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS label TEXT;
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS thesis_note TEXT;
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_at TIMESTAMPTZ;
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS opened_cycle TEXT;
      CREATE TABLE IF NOT EXISTS venues (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        address TEXT NOT NULL,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        added_by TEXT NOT NULL DEFAULT 'seed',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS signal_blacklist (
        id BIGSERIAL PRIMARY KEY,
        scope TEXT NOT NULL,
        value TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'exclude',
        source TEXT NOT NULL DEFAULT 'system',
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(scope, value)
      );
      CREATE TABLE IF NOT EXISTS entities (
        chain_id INTEGER NOT NULL,
        address TEXT NOT NULL,
        kind TEXT NOT NULL,
        symbol TEXT,
        name TEXT,
        decimals INTEGER,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'scarlet',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, address, kind)
      );
      CREATE INDEX IF NOT EXISTS entities_chain_kind_idx ON entities(chain_id, kind, status);
      -- BLOCK-BASED entity tracking + the ENRICHMENT BUFFER (db-first convergence). Internal logic reasons
      -- in BLOCKS, not timestamps (created_at/updated_at stay, for humans only): created_block/updated_block
      -- make "how many blocks since this entity was updated" answerable at a glance. enrich_pending is
      -- GENERATED — an entity is "in the enrichment buffer" the INSTANT a DEFINED field for its kind is
      -- missing (token=decimals, pool=token0), and leaves it the instant enrichment fills it: zero drift,
      -- no writer bookkeeping. enrich_resync marks the boot/gap set the startup gate waits to drain;
      -- enrich_failed = enrichment gave up after bounded attempts (visible, does NOT block the gate);
      -- enrich_attempts/enrich_checked_block record WHY (block-based) an entity stayed un-updated.
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS created_block BIGINT;
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS updated_block BIGINT;
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS enrich_resync BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS enrich_failed BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS enrich_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS enrich_checked_block BIGINT;
      -- COMPLETENESS, not "has token0". The old predicate only asked for token0, so a pool with token0 but no
      -- fee/tickSpacing was INVISIBLE to the enrichment buffer forever (measured: 10,263 pools without fee and
      -- 7,674 concentrated pools without tickSpacing, while the buffer reported 18 items to do). Missing data
      -- that calculations depend on is ENRICHMENT WORK — never something to paper over with a default.
      -- Per-archetype, because "complete" differs: v3/slipstream need per-pool fee+tickSpacing; algebra's fee
      -- is dynamic (read per block, not stored); v2/aerodrome/solidly have NO per-pool fee at all (it is a
      -- protocol constant, resolved once per factory); v4 is a poolId, not callable as a pool contract.
      DO $mig$
      DECLARE cur text;
      BEGIN
        SELECT pg_get_expr(d.adbin, d.adrelid) INTO cur
          FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
         WHERE d.adrelid = 'entities'::regclass AND a.attname = 'enrich_pending';
        IF cur IS NULL OR cur NOT LIKE '%tickSpacing%' OR cur NOT LIKE '%dex%' OR cur LIKE '%name IS NULL%' THEN
          ALTER TABLE entities DROP COLUMN IF EXISTS enrich_pending;
          ALTER TABLE entities ADD COLUMN enrich_pending BOOLEAN GENERATED ALWAYS AS (
            (kind = 'token' AND decimals IS NULL)
            OR (kind = 'pool' AND (
                 (meta->>'token0') IS NULL
              OR (meta->>'token1') IS NULL
              OR ((meta->>'archetype') IN ('v3','slipstream') AND ((meta->>'fee') IS NULL OR (meta->>'tickSpacing') IS NULL))
              OR ((meta->>'archetype') = 'algebra' AND (meta->>'tickSpacing') IS NULL)
            ))
            -- A FACTORY is an entity too. It was structurally excluded (only token/pool could ever be
            -- "pending"), which left 134 of 140 factories anonymous — and a factory without its identity is
            -- what makes its pools non-executable downstream. ONLY the type is required: it is always derivable
            -- from the archetype of the pools the factory created. The name (a verified-contract nicety) and the
            -- router are NOT required — neither is guaranteed obtainable, and requiring an unobtainable field
            -- keeps the entity pending forever, which means retrying a rate-limited external API every cycle
            -- for a value that will never arrive. A queue predicate must only demand what CAN be filled.
            OR (kind = 'dex' AND (meta->>'type') IS NULL)
          ) STORED;
        END IF;
      END $mig$;
      -- The BUFFER query index: ONLY the incomplete-and-not-failed subset, keyed for resync-first,
      -- oldest-block-first drain. The enricher's drain touches this subset, never a full-table scan.
      CREATE INDEX IF NOT EXISTS entities_enrich_buffer_idx ON entities(chain_id, kind, enrich_resync DESC, updated_block)
        WHERE enrich_pending AND NOT enrich_failed;
      -- GRAPH DEGREE of a token = how many pools reference it. The enrichment buffer is consumed by LEVERAGE
      -- (a token held by 500 pools unlocks 500 pools' worth of valuation; a token held by 1 unlocks 1), so the
      -- degree lookup must be an index probe, not a scan of every pool per candidate.
      CREATE INDEX IF NOT EXISTS entities_pool_token0_idx ON entities(chain_id, (lower(meta->>'token0'))) WHERE kind='pool';
      CREATE INDEX IF NOT EXISTS entities_pool_token1_idx ON entities(chain_id, (lower(meta->>'token1'))) WHERE kind='pool';
      -- The T0 (multiplier) probes ask "is there any pool still missing its factory / archetype": without these
      -- an EXISTS with no match degrades to a full scan of every pool, every drain cycle.
      CREATE INDEX IF NOT EXISTS entities_pool_no_factory_idx ON entities(chain_id) WHERE kind='pool' AND NOT (meta ? 'factory');
      CREATE INDEX IF NOT EXISTS entities_pool_unknown_arch_idx ON entities(chain_id) WHERE kind='pool' AND COALESCE(meta->>'archetype','unknown')='unknown';
      CREATE INDEX IF NOT EXISTS entities_pool_aero_unchecked_idx ON entities(chain_id) WHERE kind='pool' AND NOT (meta ? 'stableChecked');
      -- ROUTER EVIDENCE. A factory's router is not readable from the factory — but every Swap names the
      -- contract that called it (topic1, the sender), and that is the router. One caveat decides the whole
      -- method: an AGGREGATOR also appears as sender, across many factories at once, while a factory's own
      -- router can only ever swap that factory's own pools. So we count (factory, sender) pairs and let
      -- EXCLUSIVITY separate them — evidence accumulated over blocks, never a single observation.
      CREATE TABLE IF NOT EXISTS router_evidence (
        chain_id INTEGER NOT NULL,
        factory TEXT NOT NULL,
        sender TEXT NOT NULL,
        swaps BIGINT NOT NULL DEFAULT 0,
        pools_seen INTEGER NOT NULL DEFAULT 0,
        last_block BIGINT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, factory, sender)
      );
      CREATE INDEX IF NOT EXISTS router_evidence_sender_idx ON router_evidence(chain_id, sender);
      -- Marker table for one-shot data repairs: a repair that must run exactly once, and must NOT re-run and
      -- undo work done after it (re-opening a certification legitimately earned later would be a new bug).
      CREATE TABLE IF NOT EXISTS schema_markers (marker TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      -- ONE-SHOT REPAIR: every V4 pool was certified with a COMPLETE tick map the moment we saw its Initialize,
      -- on the premise "we observe every liquidity event from birth". The premise was false — V4 emits
      -- ModifyLiquidity on the singleton PoolManager and that topic was never decoded, so tick_liquidity held
      -- zero V4 rows while 19k pools claimed full coverage (2.4k of them with live liquidity). The decoder now
      -- exists; these rows must go back to the queue so they are actually reconstructed. Guarded by a marker
      -- row so it runs exactly once and does not undo the certifications earned after the fix.
      DO $v4fix$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM schema_markers WHERE marker = 'v4_tick_recert_2026_08') THEN
          UPDATE pool_tick_status pts SET status='pending', complete=false, bootstrap_through=NULL, updated_at=NOW()
            FROM entities e
           WHERE e.chain_id=pts.chain_id AND e.address=pts.pool AND e.kind='pool'
             AND e.meta->>'archetype'='v4' AND pts.source='live_indexer' AND pts.complete=true;
          INSERT INTO schema_markers(marker) VALUES ('v4_tick_recert_2026_08');
        END IF;
      END $v4fix$;
      -- Clear keys left holding a JSON null by a merge patch that meant "remove". Harmless in themselves, but
      -- they satisfy a key-presence test while failing anything that reads the value as its real type.
      UPDATE entities SET meta = meta - 'enrichBlockedBy'
       WHERE kind='pool' AND jsonb_typeof(meta->'enrichBlockedBy') = 'null';
      -- ONE-SHOT REPAIR: re-open pools whose "the chain refuses this field" verdict was recorded by a reader
      -- that could not yet see the field. Solidly V3 keeps a mutable fee INSIDE slot0 and exposes no fee(),
      -- so our two-field V3 reader saw a revert and the pool accrued attempts until it was written off. The
      -- verdict was about US, not about the contract. Only fee-blocked entries are re-opened; a pool that
      -- refuses token0 is a different, still-valid verdict and stays where it is.
      DO $refee$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM schema_markers WHERE marker = 'slot0_fee_recovery_2026_08') THEN
          UPDATE entities SET enrich_failed=false, enrich_attempts=0, meta = meta - 'enrichBlockedBy'
           WHERE kind='pool' AND meta ? 'enrichBlockedBy'
             AND (meta->'enrichBlockedBy') @> '["fee"]'::jsonb;
          INSERT INTO schema_markers(marker) VALUES ('slot0_fee_recovery_2026_08');
        END IF;
      END $refee$;
      -- ONE-SHOT REPAIR: strip the V4 dynamic-fee FLAG that was stored as if it were a fee (0x800000 =
      -- 8,388,608 ppm = 838%). It is a marker meaning "the hook sets this fee per swap", so the pool keeps
      -- meta.dynamicFee and loses the fabricated number; the real value lives in pool_state.fee_ppm.
      DO $v4fee$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM schema_markers WHERE marker = 'v4_dynamic_fee_2026_08') THEN
          UPDATE entities SET meta = (meta - 'fee') || '{"dynamicFee": true}'::jsonb
           WHERE kind='pool' AND meta->>'archetype'='v4'
             AND ((meta->>'fee')::numeric)::bigint & 8388608 <> 0;
          INSERT INTO schema_markers(marker) VALUES ('v4_dynamic_fee_2026_08');
        END IF;
      END $v4fee$;
      -- Scarlet's token JUDGMENT history (append-only). Her verdicts on a token live here, address-keyed,
      -- so she reconstructs HER past decisions on it. The token FACTS (identity/provenance/security) live
      -- on the entity; this is only the layer of opinion, kept as a timeline (not a single latest value).
      CREATE TABLE IF NOT EXISTS token_annotations (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verdict TEXT NOT NULL,
        note TEXT,
        tags TEXT[],
        author TEXT NOT NULL DEFAULT 'scarlet'
      );
      CREATE INDEX IF NOT EXISTS token_annotations_idx ON token_annotations(chain_id, token, id DESC);
      -- BLOCK INDEXER: the last block fully processed (the cursor everything derives from) + optional raw
      -- block-logs history (24h, DEBUG only) for development. Chain-derived state (prices/pools) is rebuilt
      -- forward from this cursor; a gap is backfilled, never silently skipped.
      CREATE TABLE IF NOT EXISTS indexer_state (
        chain_id INTEGER PRIMARY KEY,
        last_block BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- DB-FIRST BOUNDARY: observable freshness telemetry of the mirror, written ONLY by the BlockIndexer,
      -- read by everyone (the read-side must NEVER call getBlockNumber to compute lag). This is DISTINCT
      -- from indexer_state.last_block, which is the recovery/continuity CURSOR — chain_status is pure
      -- telemetry and never drives cold-start/resync. synced mirrors the indexer's syncedFlag.
      CREATE TABLE IF NOT EXISTS chain_status (
        chain_id INTEGER PRIMARY KEY,
        indexed_block BIGINT NOT NULL,
        network_head_seen BIGINT NOT NULL,
        lag_blocks BIGINT NOT NULL,
        synced BOOLEAN NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- GAS STATE (Item 4): DB-first gas price so the READ-SIDE (KG observatory/gate) never calls getGasPrice().
      -- Written by a WRITE-SIDE poller (the enricher, on its own lane, throttled); read by everyone. gas_price_wei
      -- is the effective price used to value a plan's gasUnits in USD.
      CREATE TABLE IF NOT EXISTS gas_state (
        chain_id INTEGER PRIMARY KEY,
        gas_price_wei NUMERIC NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- KG CANDIDATE LIFECYCLE (Item 4.3): every economic opportunity the observatory sees, with its lifetime.
      -- Keyed by (detector + normalized route) so the SAME opportunity across blocks updates one row: we learn
      -- how OFTEN they appear, how LONG they last, how much they're WORTH, and whether they survive to preflight.
      CREATE TABLE IF NOT EXISTS kg_candidates (
        chain_id INTEGER NOT NULL,
        ckey TEXT NOT NULL,
        detector TEXT NOT NULL,
        numeraire TEXT NOT NULL,
        route TEXT NOT NULL,
        pools TEXT[] NOT NULL,
        amount_in NUMERIC NOT NULL,
        gross_usd DOUBLE PRECISION,
        gas_units NUMERIC,
        gas_usd DOUBLE PRECISION,
        net_usd DOUBLE PRECISION,
        simulation_exact BOOLEAN NOT NULL,
        executable BOOLEAN NOT NULL,
        rejection_reason TEXT,
        first_seen_block BIGINT NOT NULL,
        last_seen_block BIGINT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1,
        peak_net_usd DOUBLE PRECISION,
        preflight_status TEXT,          -- null=not tried, 'pass'/'fail'/reason (Item 4.4 shadow preflight)
        preflight_block BIGINT,
        preflight_fingerprint TEXT,     -- state signature the last preflight was run against (dedup, Item 4/5)
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, ckey)
      );
      CREATE INDEX IF NOT EXISTS kg_candidates_net ON kg_candidates(chain_id, executable, net_usd DESC);
      ALTER TABLE kg_candidates ADD COLUMN IF NOT EXISTS preflight_fingerprint TEXT;
      -- OBSERVER TIME SERIES (Item 5/6): a snapshot per observer cycle + the value of each candidate at each
      -- block it was seen. Time is a dimension we cannot reconstruct retroactively — record it now.
      CREATE TABLE IF NOT EXISTS kg_observer_runs (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        block BIGINT NOT NULL,
        duration_ms INTEGER NOT NULL,
        pools_priced INTEGER, multi_venue_pairs INTEGER, sized INTEGER,
        economic INTEGER, economically_positive INTEGER, route_encodable INTEGER, executable INTEGER,
        preflight_attempted INTEGER, preflight_pass INTEGER,
        detectors JSONB, stats JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS kg_observer_runs_blk ON kg_observer_runs(chain_id, block DESC);
      CREATE TABLE IF NOT EXISTS kg_candidate_observations (
        chain_id INTEGER NOT NULL,
        ckey TEXT NOT NULL,
        block BIGINT NOT NULL,
        detector TEXT NOT NULL,
        net_usd DOUBLE PRECISION,
        gross_usd DOUBLE PRECISION,
        executable BOOLEAN NOT NULL,
        simulation_exact BOOLEAN NOT NULL,
        rejection_reason TEXT,
        preflight_status TEXT,          -- filled when this observation was (re)preflighted this cycle
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, ckey, block)
      );
      CREATE INDEX IF NOT EXISTS kg_cand_obs_ckey ON kg_candidate_observations(chain_id, ckey, block DESC);
      -- SURFACE TIME SERIES (Item 7): the geometry of liquidity per block — two levels (identity + points),
      -- stamped with the surface_model_version so we never compare surfaces from different algorithms as one
      -- series. Pair Surface and Best Exit share this storage; kind-specific columns are nullable.
      CREATE TABLE IF NOT EXISTS kg_surface_runs (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        block BIGINT NOT NULL,
        kind TEXT NOT NULL,             -- 'pair' | 'best-exit'
        target TEXT NOT NULL,           -- 'a|b' (pair) or asset (best-exit)
        numeraire TEXT,
        model_version TEXT NOT NULL,
        venues INTEGER, crossovers INTEGER, optimal_size NUMERIC, max_pnl NUMERIC,   -- pair summary
        economic_best NUMERIC, executable_best NUMERIC, execution_gap NUMERIC,        -- best-exit summary (ref size)
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS kg_surface_runs_tgt ON kg_surface_runs(chain_id, kind, target, block DESC);
      CREATE TABLE IF NOT EXISTS kg_surface_points (
        run_id BIGINT NOT NULL REFERENCES kg_surface_runs(id) ON DELETE CASCADE,
        amount_in NUMERIC NOT NULL,
        economic_out NUMERIC, executable_out NUMERIC,
        economic_path TEXT[], executable_path TEXT[],
        exact BOOLEAN, encodable BOOLEAN, clean BOOLEAN,
        execution_gap NUMERIC,
        dominant_buy TEXT, dominant_sell TEXT, spread_bps INTEGER
      );
      CREATE INDEX IF NOT EXISTS kg_surface_points_run ON kg_surface_points(run_id);
      -- ENRICHMENT ACTIVITY LOG — what each drain cycle actually DID, per pass. The buffer snapshot answers
      -- "how much is left"; this answers "is it working, on what, and why is something not advancing". Only
      -- cycles that did work / hit a limit / failed are recorded, so idle ticks never flood it.
      CREATE TABLE IF NOT EXISTS enrichment_log (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        block BIGINT,
        passes JSONB NOT NULL,        -- {pass: completed} for the passes that did something
        rate_limited BOOLEAN NOT NULL DEFAULT false,
        note TEXT,                    -- why nothing progressed (transport fault, no candidates, cap reached…)
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS enrichment_log_recent ON enrichment_log(chain_id, created_at DESC);
      -- SINGLE-INSTANCE observer lease (Item 7): TTL heartbeat so exactly one observer processes blocks.
      CREATE TABLE IF NOT EXISTS kg_observer_lease (
        chain_id INTEGER PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      -- ECONOMIC-ANOMALY SIGNALS (Item 7 step 6) — NOT trade opportunities: intelligence (e.g. a persistent
      -- execution_gap = value the graph sees we cannot capture). Own lifecycle, distinct from kg_candidates.
      CREATE TABLE IF NOT EXISTS kg_signals (
        chain_id INTEGER NOT NULL,
        skey TEXT NOT NULL,
        kind TEXT NOT NULL,             -- 'execution_gap'
        asset TEXT, numeraire TEXT,
        economic_usd DOUBLE PRECISION, executable_usd DOUBLE PRECISION, execution_gap_usd DOUBLE PRECISION,
        ref_size NUMERIC,
        first_seen_block BIGINT NOT NULL, last_seen_block BIGINT NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1,
        peak_gap_usd DOUBLE PRECISION,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, skey)
      );
      -- INDEXER COVERAGE (Item 3): the CONTINUOUSLY-observed block range, distinct from the recovery cursor
      -- (indexer_state.last_block) and from current freshness (chain_status). coverage_start = the first
      -- block of the current UNBROKEN ingested sequence (NOT the configured cold-start); continuous_through
      -- advances as contiguous blocks are processed; generation bumps whenever a gap breaks continuity. A
      -- tick-map is certifiable "complete" only while its range sits inside an unbroken coverage segment.
      CREATE TABLE IF NOT EXISTS indexer_coverage (
        chain_id INTEGER PRIMARY KEY,
        coverage_start BIGINT NOT NULL,
        continuous_through BIGINT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- INDEXER GAPS: block ranges the indexer SKIPPED (a pathological cold-start jump) → never observed, so
      -- any tick-map spanning them is no longer certifiable until repaired. repaired_at set by the 3.3 repair.
      CREATE TABLE IF NOT EXISTS indexer_gaps (
        chain_id INTEGER NOT NULL,
        from_block BIGINT NOT NULL,
        to_block BIGINT NOT NULL,
        reason TEXT,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        repaired_at TIMESTAMPTZ,
        PRIMARY KEY (chain_id, from_block, to_block)
      );
      -- PER-POOL TICK-MAP COMPLETENESS (Item 3): certifiable state of a concentrated pool's tick map. status
      -- pending|bootstrapping|complete|failed|partial; source live_indexer|historical_logs|storage_scan|
      -- third_party_seed|mixed. through_block = how far the map is known complete; creation_block = required
      -- earliest block. complete=true ONLY when through_block back to creation is inside unbroken coverage.
      CREATE TABLE IF NOT EXISTS pool_tick_status (
        chain_id INTEGER NOT NULL,
        pool TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        source TEXT NOT NULL DEFAULT 'live_indexer',
        creation_block BIGINT,
        through_block BIGINT,
        complete BOOLEAN NOT NULL DEFAULT FALSE,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, pool)
      );
      -- Item 3.2 (historical-log bootstrap): bootstrap_through = last historical block whose Mint/Burn are
      -- fully applied (grows creation_block → coverageStart−1, advanced ATOMICALLY with its deltas);
      -- coverage_generation = the indexer generation the completeness was certified against; creation_source
      -- = provenance of creation_block; priority = bootstrap worklist priority (0=P0 demand-driven … 3=P3).
      ALTER TABLE pool_tick_status ADD COLUMN IF NOT EXISTS bootstrap_through BIGINT;
      ALTER TABLE pool_tick_status ADD COLUMN IF NOT EXISTS coverage_generation INTEGER;
      ALTER TABLE pool_tick_status ADD COLUMN IF NOT EXISTS creation_source TEXT;
      ALTER TABLE pool_tick_status ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 3;
      CREATE TABLE IF NOT EXISTS raw_blocks (
        chain_id INTEGER NOT NULL,
        block_number BIGINT NOT NULL,
        logs JSONB NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, block_number)
      );
      -- ROLLING per-swap FLOW (db-first convergence): the indexer records each priced swap's wallet + USD
      -- value here so the FlowSensor derives hotPools/activeWallets/bigSwaps from the DB instead of its own
      -- getLogs. Pruned to a short window (FLOW_RETAIN_BLOCKS); delete-then-insert per block = idempotent.
      CREATE TABLE IF NOT EXISTS recent_swaps (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        block_number BIGINT NOT NULL,
        pool TEXT NOT NULL,
        wallet TEXT,
        value_usd DOUBLE PRECISION NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS recent_swaps_block_idx ON recent_swaps(chain_id, block_number);
      CREATE INDEX IF NOT EXISTS raw_blocks_at_idx ON raw_blocks(at);
      -- Per-pool AMM state, ingested from the SAME Swap/Sync logs the indexer already parses (V2 Sync
      -- carries the reserves; V3 Swap carries sqrtPriceX96 + liquidity). One latest row per pool. This
      -- is what makes PriceOracle's sized-exit math (amountOut/sellValueUsd) DB-read instead of RPC:
      -- reserves stored as NUMERIC (raw wei, up to ~2^160 for V3 virtual reserves) — never floats.
      CREATE TABLE IF NOT EXISTS pool_state (
        chain_id INTEGER NOT NULL,
        pool TEXT NOT NULL,
        archetype TEXT NOT NULL,
        r0 NUMERIC,        -- V2: reserve0 (raw)
        r1 NUMERIC,        -- V2: reserve1 (raw)
        sqrt_price NUMERIC, -- V3: sqrtPriceX96
        liquidity NUMERIC,  -- V3: in-range liquidity L
        fee_ppm INTEGER,    -- V4: the fee ACTUALLY charged on the last observed swap (hooks can set it per swap)
        block_number BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, pool)
      );
      -- Existing databases: pool_state predates fee_ppm.
      ALTER TABLE pool_state ADD COLUMN IF NOT EXISTS fee_ppm INTEGER;
      -- V3 per-tick liquidity map (from Mint/Burn events). liquidity_net = net liquidity added when the
      -- price crosses this tick going UP (Uniswap convention: +ΔL at tickLower, −ΔL at tickUpper). This is
      -- the data a tick-crossing swap sim needs to price LARGE V3 trades EXACTLY (no more single-tick approx).
      CREATE TABLE IF NOT EXISTS tick_liquidity (
        chain_id INTEGER NOT NULL,
        pool TEXT NOT NULL,
        tick INTEGER NOT NULL,
        liquidity_net NUMERIC NOT NULL DEFAULT 0,
        block_number BIGINT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, pool, tick)
      );
      -- Per-token market stats in 5-min buckets, from V3 swap amounts (the indexer already reads them).
      -- Gives volume / txns / buy-sell / price-change over any window by summing recent buckets — the
      -- chain-sourced replacement for the DexScreener market feed. Pruned to a short retention.
      CREATE TABLE IF NOT EXISTS token_stats (
        chain_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        bucket BIGINT NOT NULL,      -- unix epoch floored to 300s
        vol_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        buys INTEGER NOT NULL DEFAULT 0,
        sells INTEGER NOT NULL DEFAULT 0,
        last_price DOUBLE PRECISION,
        net_flow_usd DOUBLE PRECISION NOT NULL DEFAULT 0, -- signed: buys(+) − sells(+), the real buy pressure
        liq_usd DOUBLE PRECISION,                          -- token liquidity snapshot at bucket time (trajectory → rug-drain signal)
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, token, bucket)
      );
      CREATE INDEX IF NOT EXISTS token_stats_lookup_idx ON token_stats(chain_id, token, bucket DESC);
      ALTER TABLE token_stats ADD COLUMN IF NOT EXISTS net_flow_usd DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE token_stats ADD COLUMN IF NOT EXISTS liq_usd DOUBLE PRECISION;
      -- DISPLAY prices only (Lane A): indicative, slow-refreshed, batch-sourced. NEVER used for
      -- arb/liquidation decisions — those compute fresh execution quotes (Lane B). Kept in its own
      -- table so the fast-changing price never churns the immutable entity metadata.
      CREATE TABLE IF NOT EXISTS token_prices (
        chain_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        price_usd DOUBLE PRECISION,
        confidence DOUBLE PRECISION,
        source TEXT NOT NULL DEFAULT 'defillama',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, token)
      );
      CREATE INDEX IF NOT EXISTS token_prices_stale_idx ON token_prices(chain_id, updated_at);
      -- MEASURED volatility: EWMA of the per-second variance of log-returns, at two half-lives (fast
      -- reacts to spikes, slow = baseline). σ(T)=sqrt(max(fast,slow)·T). Updated by the price-JOB on
      -- each sample — no hardwiring, no extra calls. Unknown tokens have no history → treated as high-vol.
      ALTER TABLE token_prices ADD COLUMN IF NOT EXISTS vol_fast DOUBLE PRECISION;   -- EWMA var-rate (per sec), fast half-life
      ALTER TABLE token_prices ADD COLUMN IF NOT EXISTS vol_slow DOUBLE PRECISION;   -- EWMA var-rate (per sec), slow half-life
      ALTER TABLE token_prices ADD COLUMN IF NOT EXISTS vol_sample_price DOUBLE PRECISION; -- last price used for the return
      ALTER TABLE token_prices ADD COLUMN IF NOT EXISTS vol_at TIMESTAMPTZ;          -- when vol was last updated
      -- FRESHNESS: the block at which this price was last written by a block-anchored source (indexer /
      -- indexer-backfill). NULL for off-chain sources (defillama/aggregator/exec) that carry no block.
      -- Lets every consumer see how far behind head a display price is, matching pool_state.block_number.
      ALTER TABLE token_prices ADD COLUMN IF NOT EXISTS block_number BIGINT;
      -- Wallet MOVEMENTS (ERC-20 Transfer events touching the wallet), persisted once + appended as
      -- new ones are detected. The wallet reads/derives from here — never re-requests saved history.
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        chain_id INTEGER NOT NULL,
        wallet TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        block_number BIGINT NOT NULL,
        token TEXT NOT NULL,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        value_raw NUMERIC NOT NULL,
        direction TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, wallet, tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS wallet_tx_lookup_idx ON wallet_transactions(chain_id, wallet, block_number DESC);
      -- Wallet token QUANTITIES: the maintained balance per token (updated on the tokens a new
      -- transaction touched — ground truth via balanceOf — not recomputed from full history each time).
      CREATE TABLE IF NOT EXISTS wallet_token_balances (
        chain_id INTEGER NOT NULL,
        wallet TEXT NOT NULL,
        token TEXT NOT NULL,
        balance_raw NUMERIC NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, wallet, token)
      );
      CREATE TABLE IF NOT EXISTS follows (
        chain_id INTEGER NOT NULL,
        wallet TEXT NOT NULL,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_seen_block BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, wallet)
      );
      CREATE TABLE IF NOT EXISTS follow_moves (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        wallet TEXT NOT NULL,
        block BIGINT NOT NULL,
        tx_hash TEXT NOT NULL,
        direction TEXT NOT NULL,
        token TEXT,
        symbol TEXT,
        amount NUMERIC,
        counterparty TEXT,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (chain_id, wallet, tx_hash, token, direction)
      );
      CREATE INDEX IF NOT EXISTS follow_moves_wallet_idx ON follow_moves(chain_id, wallet, block DESC);
      CREATE TABLE IF NOT EXISTS position_plans (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        symbol TEXT,
        base_token TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending-entry',
        entry_kind TEXT NOT NULL DEFAULT 'now',
        entry_price NUMERIC,
        entry_amount_usd NUMERIC NOT NULL,
        filled_amount_token NUMERIC,
        filled_price NUMERIC,
        filled_at TIMESTAMPTZ,
        stop_loss_pct NUMERIC,
        take_profit_pct NUMERIC,
        partials JSONB NOT NULL DEFAULT '[]'::jsonb,
        remaining_pct NUMERIC NOT NULL DEFAULT 100,
        note TEXT,
        last_result TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS position_plans_active_idx ON position_plans(chain_id, status);
      -- Manual/tool-requested immediate exit: the engine sells this % of the original fill on its next
      -- tick, then clears it (so close_position routes through the SAME deterministic execution path).
      ALTER TABLE position_plans ADD COLUMN IF NOT EXISTS exit_now_pct NUMERIC;
      -- Retry counter for entries. A strategy that fails hard (on-chain revert) or exhausts retries goes
      -- to status 'error' (blocked): the engine stops touching it; Scarlet sees it and must modify or close.
      ALTER TABLE position_plans ADD COLUMN IF NOT EXISTS entry_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE position_plans ADD COLUMN IF NOT EXISTS strategy TEXT; -- category budget: 'launchtoken' | 'bluechip' (drives per-strategy budget accounting)
      CREATE TABLE IF NOT EXISTS lending_positions (
        chain_id INTEGER NOT NULL,
        protocol TEXT NOT NULL,          -- family: morpho | aave-v3 | compound | ...
        market_id TEXT NOT NULL,         -- market/pool id ('' for pooled protocols)
        borrower TEXT NOT NULL,
        collateral_token TEXT,
        collateral_symbol TEXT,
        loan_token TEXT,
        loan_symbol TEXT,
        hf NUMERIC,                      -- health factor (liquidatable when < 1)
        debt_usd NUMERIC,
        collateral_usd NUMERIC,          -- protocol-oracle value (decides liquidatability)
        exit_usd NUMERIC,                -- OUR executable exit value of the collateral (decides profit)
        lltv NUMERIC,
        tier TEXT NOT NULL DEFAULT 'pending', -- pending(unclassified) | candidate | watch | profitable | low_collateral | blacklist | closed
        reason TEXT,
        next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_checked_at TIMESTAMPTZ,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb, -- marketParams (oracle/irm/lltv) for reads/arming
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, protocol, market_id, borrower)
      );
      CREATE INDEX IF NOT EXISTS lending_positions_due_idx ON lending_positions(chain_id, next_check_at) WHERE tier <> 'closed';
      CREATE INDEX IF NOT EXISTS lending_positions_tier_idx ON lending_positions(chain_id, tier);
      -- The DECIDED loan-native liquidation profit in USD (amountOut − debtRepaid), stored by the
      -- registry so the dashboard shows the real decision — never recomputes from the mirage collateral.
      ALTER TABLE lending_positions ADD COLUMN IF NOT EXISTS profit_usd NUMERIC;
      -- SAFETY: the insert default must NOT be a monitored/actionable tier. upsertLendingPosition inserts
      -- a row BEFORE classification runs; if classify then bails (e.g. transient exit-quote failure) the
      -- row must stay UNMONITORED, not sit in 'profitable' where the on-chain monitor would watch it
      -- unverified. Default is 'pending'; the classifier promotes it. (Was 'profitable' — a real bug.)
      ALTER TABLE lending_positions ALTER COLUMN tier SET DEFAULT 'pending';
      UPDATE lending_positions SET tier='pending', next_check_at=NOW()
        WHERE tier='profitable' AND hf IS NULL; -- heal rows stuck by the old default
      -- Enumerate-sighting clock: ONLY the enumerate (upsertLendingPosition) bumps this, never the tick.
      -- Lets us age out orphans — positions no longer returned by discovery (e.g. their market fell out
      -- of scope) that would otherwise stay frozen in an actionable tier and be monitored forever.
      ALTER TABLE lending_positions ADD COLUMN IF NOT EXISTS enumerated_at TIMESTAMPTZ;
      -- Execution-lane fields: the market ORACLE price at which HF=1 (the fire trigger), the last
      -- observed oracle price, and the EV score (profit × imminence) that ranks pre-arm priority.
      ALTER TABLE lending_positions ADD COLUMN IF NOT EXISTS liq_price NUMERIC;      -- oracle price (loan/coll, 1e36) at HF=1
      ALTER TABLE lending_positions ADD COLUMN IF NOT EXISTS oracle_price NUMERIC;  -- last observed market oracle price
      ALTER TABLE lending_positions ADD COLUMN IF NOT EXISTS ev_score DOUBLE PRECISION;
      -- hf_at = when the HF VALUE was actually refreshed (enumerate only) — NOT updated_at (which the
      -- 20s tick touches while reusing the stale HF). This is the TRUE HF-staleness clock for observability.
      ALTER TABLE lending_positions ADD COLUMN IF NOT EXISTS hf_at TIMESTAMPTZ;
      -- Morpho market params (loan/collateral/oracle/irm/lltv), learned by the block-indexer from
      -- CreateMarket events (or a one-shot idToMarketParams bootstrap). Chain-sourced: lets the indexer
      -- attach the right market context when it discovers a borrower live from a Borrow/Supply log.
      CREATE TABLE IF NOT EXISTS lending_markets (
        chain_id INTEGER NOT NULL,
        protocol TEXT NOT NULL,
        market_id TEXT NOT NULL,
        loan_token TEXT,
        collateral_token TEXT,
        oracle TEXT,
        irm TEXT,
        lltv NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, protocol, market_id)
      );
      -- OBSERVABILITY: every liquidation-relevant event — positions found, prey LOST to other
      -- liquidators (missed), our armed watchers that FAILED to fire, and our HITS. Historized for
      -- analysis + dashboard, so we can see what we missed and why.
      CREATE TABLE IF NOT EXISTS liquidation_events (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        kind TEXT NOT NULL,              -- found | missed | armed_fail | hit
        protocol TEXT,
        market_id TEXT,
        borrower TEXT,
        collateral_symbol TEXT,
        loan_symbol TEXT,
        debt_usd NUMERIC,
        profit_usd NUMERIC,
        tx_hash TEXT,
        liquidator TEXT,                 -- who liquidated (for 'missed'/'hit')
        note TEXT,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS liquidation_events_lookup_idx ON liquidation_events(chain_id, kind, observed_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS liquidation_events_dedup_idx ON liquidation_events(chain_id, kind, tx_hash, borrower) WHERE tx_hash IS NOT NULL;
    `);
    await this.seedBlacklist(SEED_BLACKLIST);
  }

  // --- smart-money follows (Scarlet chooses; the system tracks + notifies) ----
  async addFollow(chainId: number, wallet: string, note: string): Promise<void> {
    await this.pool.query(`INSERT INTO follows(chain_id, wallet, note) VALUES($1,$2,$3) ON CONFLICT (chain_id, wallet) DO UPDATE SET note=COALESCE(EXCLUDED.note, follows.note), status='active'`, [chainId, wallet.toLowerCase(), note || null]);
  }
  async removeFollow(chainId: number, wallet: string): Promise<boolean> {
    const r = await this.pool.query(`UPDATE follows SET status='removed' WHERE chain_id=$1 AND wallet=$2 AND status='active'`, [chainId, wallet.toLowerCase()]);
    return (r.rowCount ?? 0) > 0;
  }
  async noteFollow(chainId: number, wallet: string, note: string): Promise<boolean> {
    const r = await this.pool.query(`UPDATE follows SET note=$3 WHERE chain_id=$1 AND wallet=$2`, [chainId, wallet.toLowerCase(), note]);
    return (r.rowCount ?? 0) > 0;
  }
  async activeFollows(chainId: number): Promise<Array<{ wallet: string; note: string | null; lastSeenBlock: string | null }>> {
    const r = await this.pool.query<{ wallet: string; note: string | null; last_seen_block: string | null }>(`SELECT wallet, note, last_seen_block::text FROM follows WHERE chain_id=$1 AND status='active' ORDER BY created_at DESC`, [chainId]);
    return r.rows.map((x) => ({ wallet: x.wallet, note: x.note, lastSeenBlock: x.last_seen_block }));
  }
  async setFollowSeen(chainId: number, wallet: string, block: bigint): Promise<void> {
    await this.pool.query(`UPDATE follows SET last_seen_block=$3 WHERE chain_id=$1 AND wallet=$2`, [chainId, wallet.toLowerCase(), block.toString()]);
  }
  async recordFollowMove(m: { chainId: number; wallet: string; block: bigint; txHash: string; direction: string; token: string | null; symbol: string | null; amount: number | null; counterparty: string | null }): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO follow_moves(chain_id, wallet, block, tx_hash, direction, token, symbol, amount, counterparty) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (chain_id, wallet, tx_hash, token, direction) DO NOTHING`,
      [m.chainId, m.wallet.toLowerCase(), m.block.toString(), m.txHash, m.direction, m.token?.toLowerCase() ?? null, m.symbol, m.amount, m.counterparty?.toLowerCase() ?? null]
    );
    return (r.rowCount ?? 0) > 0;
  }
  async followMoves(chainId: number, wallet: string, limit = 20, beforeBlock?: bigint): Promise<Array<{ block: string; txHash: string; direction: string; symbol: string | null; amount: number | null; at: string }>> {
    const r = await this.pool.query<{ block: string; tx_hash: string; direction: string; symbol: string | null; amount: string | null; at: Date }>(
      `SELECT block::text, tx_hash, direction, symbol, amount::text, at FROM follow_moves WHERE chain_id=$1 AND wallet=$2 AND ($3::bigint IS NULL OR block < $3) ORDER BY block DESC LIMIT $4`,
      [chainId, wallet.toLowerCase(), beforeBlock?.toString() ?? null, limit]
    );
    return r.rows.map((x) => ({ block: x.block, txHash: x.tx_hash, direction: x.direction, symbol: x.symbol, amount: x.amount === null ? null : Number(x.amount), at: x.at.toISOString() }));
  }
  async recentFollowActivity(chainId: number, sinceMinutes = 30): Promise<Array<{ wallet: string; moves: number; lastAt: string }>> {
    const r = await this.pool.query<{ wallet: string; moves: string; last_at: Date }>(`SELECT wallet, count(*)::text moves, max(at) last_at FROM follow_moves WHERE chain_id=$1 AND at > NOW() - ($2 || ' minutes')::interval GROUP BY wallet ORDER BY last_at DESC`, [chainId, sinceMinutes]);
    return r.rows.map((x) => ({ wallet: x.wallet, moves: Number(x.moves), lastAt: x.last_at.toISOString() }));
  }

  // --- programmatic position plans (SL/TP/partial; the system executes) -------
  async createPositionPlan(p: { chainId: number; token: string; symbol: string | null; baseToken: string; entryKind: string; entryPrice: number | null; entryAmountUsd: number; stopLossPct: number | null; takeProfitPct: number | null; partials: unknown; note: string; strategy?: string | null }): Promise<number> {
    const status = p.entryKind === "now" ? "entering" : "pending-entry";
    const r = await this.pool.query<{ id: number }>(
      `INSERT INTO position_plans(chain_id, token, symbol, base_token, status, entry_kind, entry_price, entry_amount_usd, stop_loss_pct, take_profit_pct, partials, note, strategy)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [p.chainId, p.token.toLowerCase(), p.symbol, p.baseToken.toLowerCase(), status, p.entryKind, p.entryPrice, p.entryAmountUsd, p.stopLossPct, p.takeProfitPct, jsonParam(p.partials ?? []), p.note, p.strategy ?? null]
    );
    return r.rows[0].id;
  }

  /** Per-strategy deployed capital (sum of active plans' entry USD, grouped by strategy) — for category budgets. */
  async usedBudgetByStrategy(chainId: number): Promise<Record<string, number>> {
    const r = await this.pool.query<{ strategy: string | null; used: string }>(
      `SELECT COALESCE(strategy,'?') AS strategy, COALESCE(SUM(entry_amount_usd),0) AS used FROM position_plans
       WHERE chain_id=$1 AND status IN ('pending-entry','entering','open','exiting') GROUP BY 1`, [chainId]
    );
    const out: Record<string, number> = {};
    for (const row of r.rows) out[row.strategy ?? "?"] = Number(row.used);
    return out;
  }
  async activePositionPlans(chainId: number): Promise<Array<PositionPlan>> {
    const r = await this.pool.query(`SELECT * FROM position_plans WHERE chain_id=$1 AND status IN ('pending-entry','entering','open','exiting') ORDER BY created_at`, [chainId]);
    return r.rows.map(rowToPlan);
  }
  /** Blocked (errored) plans — the engine skips them; the briefing surfaces them so Scarlet acts. */
  async erroredPositionPlans(chainId: number): Promise<Array<PositionPlan>> {
    const r = await this.pool.query(`SELECT * FROM position_plans WHERE chain_id=$1 AND status='error' ORDER BY updated_at DESC LIMIT 20`, [chainId]);
    return r.rows.map(rowToPlan);
  }
  async countOpenPositionPlans(chainId: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>(`SELECT count(*)::text n FROM position_plans WHERE chain_id=$1 AND status IN ('pending-entry','entering','open','exiting')`, [chainId]);
    return Number(r.rows[0].n);
  }
  async getPositionPlan(id: number): Promise<PositionPlan | undefined> {
    const r = await this.pool.query(`SELECT * FROM position_plans WHERE id=$1`, [id]);
    return r.rows[0] ? rowToPlan(r.rows[0]) : undefined;
  }
  async listPositionPlans(chainId: number, limit = 30): Promise<Array<PositionPlan>> {
    const r = await this.pool.query(`SELECT * FROM position_plans WHERE chain_id=$1 ORDER BY created_at DESC LIMIT $2`, [chainId, limit]);
    return r.rows.map(rowToPlan);
  }
  async updatePositionPlan(id: number, fields: Partial<{ status: string; filledAmountToken: number; filledPrice: number; filledAt: string; remainingPct: number; lastResult: string; stopLossPct: number | null; takeProfitPct: number | null; exitNowPct: number | null; entryAttempts: number; partials: unknown }>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [id]; let i = 2;
    const map: Record<string, string> = { status: "status", filledAmountToken: "filled_amount_token", filledPrice: "filled_price", filledAt: "filled_at", remainingPct: "remaining_pct", lastResult: "last_result", stopLossPct: "stop_loss_pct", takeProfitPct: "take_profit_pct", exitNowPct: "exit_now_pct", entryAttempts: "entry_attempts" };
    for (const [k, col] of Object.entries(map)) { const v = (fields as Record<string, unknown>)[k]; if (v !== undefined) { sets.push(`${col}=$${i++}`); vals.push(v); } }
    if (fields.partials !== undefined) { sets.push(`partials=$${i++}`); vals.push(jsonParam(fields.partials)); }
    if (!sets.length) return;
    await this.pool.query(`UPDATE position_plans SET ${sets.join(", ")}, updated_at=NOW() WHERE id=$1`, vals);
  }

  /** Upserts an entity's DETERMINISTIC fields (symbol/name/decimals/meta) — set by the system's
   * resolver, never by Scarlet. Her note + status are preserved unless explicitly changed. */
  async upsertEntity(e: { chainId: number; address: string; kind: string; symbol?: string | null; name?: string | null; decimals?: number | null; meta?: Record<string, unknown>; source?: string; block?: number }): Promise<void> {
    // "?"/"" are NON-values — store them as NULL so they never overwrite a real symbol via COALESCE
    // (a "?" is truthy and would clobber a good name). meta is MERGED, never clobbered.
    // block: the chain block this write reflects → created_block on first insert, updated_block on every
    // write (staleness = head − updated_block). Callers without a block (non-indexer) pass null → untouched.
    const sym = safeText(e.symbol && e.symbol !== "?" ? e.symbol : null, 32);
    const nm = safeText(e.name && e.name !== "?" ? e.name : null, 96);
    await this.pool.query(
      `INSERT INTO entities(chain_id, address, kind, symbol, name, decimals, meta, source, created_block, updated_block)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (chain_id, address, kind) DO UPDATE SET
         symbol=COALESCE(EXCLUDED.symbol, entities.symbol),
         name=COALESCE(EXCLUDED.name, entities.name),
         decimals=COALESCE(EXCLUDED.decimals, entities.decimals),
         meta=entities.meta || EXCLUDED.meta, updated_at=NOW(),
         updated_block=COALESCE(EXCLUDED.updated_block, entities.updated_block)`,
      [e.chainId, e.address.toLowerCase(), e.kind, sym, nm, e.decimals ?? null, jsonParam(e.meta ?? {}), e.source ?? "scarlet", e.block ?? null]
    );
  }
  async getEntity(chainId: number, address: string): Promise<Array<{ address: string; kind: string; symbol: string | null; name: string | null; decimals: number | null; meta: unknown; note: string | null; status: string; source: string }>> {
    const r = await this.pool.query(`SELECT address, kind, symbol, name, decimals, meta, note, status, source FROM entities WHERE chain_id=$1 AND address=$2`, [chainId, address.toLowerCase()]);
    return r.rows as never;
  }
  /** Explorer feed: full entity rows, filterable by kind + free-text (address/symbol/name),
   * paginated, plus per-kind counts for the whole chain registry. */
  async entitiesExplorer(chainId: number, opts: { kind?: string; q?: string; limit?: number; offset?: number } = {}): Promise<{ rows: Array<{ address: string; kind: string; symbol: string | null; name: string | null; decimals: number | null; meta: unknown; note: string | null; status: string; source: string; updatedAt: string }>; total: number; counts: Record<string, number> }> {
    const like = opts.q ? `%${opts.q.toLowerCase()}%` : null;
    const where = `chain_id=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR lower(address) LIKE $3 OR lower(coalesce(symbol,'')) LIKE $3 OR lower(coalesce(name,'')) LIKE $3)`;
    const [rows, total, counts] = await Promise.all([
      this.pool.query(`SELECT address, kind, symbol, name, decimals, meta, note, status, source, updated_at FROM entities WHERE ${where} ORDER BY updated_at DESC LIMIT $4 OFFSET $5`, [chainId, opts.kind ?? null, like, Math.min(opts.limit ?? 100, 200), opts.offset ?? 0]),
      this.pool.query<{ n: number }>(`SELECT count(*)::int n FROM entities WHERE ${where}`, [chainId, opts.kind ?? null, like]),
      this.pool.query<{ kind: string; n: number }>(`SELECT kind, count(*)::int n FROM entities WHERE chain_id=$1 GROUP BY kind`, [chainId])
    ]);
    const c: Record<string, number> = {};
    for (const row of counts.rows) c[row.kind] = row.n;
    return { rows: rows.rows.map((r) => ({ address: r.address, kind: r.kind, symbol: r.symbol, name: r.name, decimals: r.decimals, meta: r.meta, note: r.note, status: r.status, source: r.source, updatedAt: new Date(r.updated_at).toISOString() })), total: total.rows[0]?.n ?? 0, counts: c };
  }

  /** VENUE COVERAGE worklist: every distinct pool factory (the DEX that emitted the pool), with how many
   * pools + how many are ACTIVE (fresh pool_state). Feeds the "unknown active DEX" report — a factory here
   * that isn't in our executable registry is a protocol whose pools we ingest + quote but can't yet own-
   * execute (curate its router + encoder to cover). Ranked most-active first. */
  async poolFactoryActivity(chainId: number, freshMinutes = 30, limit = 40): Promise<Array<{ factory: string; archetype: string | null; pools: number; withState: number; fresh: number }>> {
    const r = await this.pool.query<{ factory: string; archetype: string | null; pools: string; with_state: string; fresh: string }>(
      `SELECT COALESCE(e.meta->>'factory','(missing)') factory, e.meta->>'archetype' archetype,
              count(*)::text pools,
              count(ps.pool)::text with_state,
              count(*) FILTER (WHERE ps.updated_at > NOW() - ($2 || ' min')::interval)::text fresh
       FROM entities e LEFT JOIN pool_state ps ON ps.chain_id=e.chain_id AND ps.pool=e.address
       WHERE e.chain_id=$1 AND e.kind='pool'
       GROUP BY 1,2 ORDER BY fresh DESC, pools DESC LIMIT $3`,
      [chainId, String(freshMinutes), limit]
    );
    return r.rows.map((x) => ({ factory: x.factory, archetype: x.archetype, pools: Number(x.pools), withState: Number(x.with_state), fresh: Number(x.fresh) }));
  }

  /** Arb candidate tokens FROM THE REGISTRY: tokens that appear in >=2 discovered pools (i.e.
   * priced on multiple venues/fee-tiers → where spatial arb lives), most-pooled first. Chain-
   * native — no third-party top-list. Excludes the base token (the cycle anchor). */
  async arbCandidateTokens(chainId: number, base: string, limit = 16): Promise<Array<{ address: string; symbol: string | null; pools: number }>> {
    const r = await this.pool.query<{ address: string; symbol: string | null; pools: string }>(
      `WITH toks AS (
         SELECT lower(meta->>'token0') tok, address pool FROM entities WHERE chain_id=$1 AND kind='pool' AND meta ? 'token0'
         UNION ALL
         SELECT lower(meta->>'token1') tok, address pool FROM entities WHERE chain_id=$1 AND kind='pool' AND meta ? 'token1'
       )
       SELECT t.tok address, e.symbol, count(DISTINCT t.pool)::text pools
       FROM toks t LEFT JOIN entities e ON e.chain_id=$1 AND e.address=t.tok AND e.kind='token'
       WHERE t.tok <> $2 AND t.tok LIKE '0x%'
       GROUP BY t.tok, e.symbol HAVING count(DISTINCT t.pool) >= 2
       ORDER BY count(DISTINCT t.pool) DESC LIMIT $3`,
      [chainId, base.toLowerCase(), limit]
    );
    return r.rows.map((x) => ({ address: x.address, symbol: x.symbol, pools: Number(x.pools) }));
  }

  /** GENUINE fresh launches from the indexer's discovery: pools it saw CREATED (origin='created', i.e. a
   * real PoolCreated event, NOT an old pool first-seen-via-swap) at/after `sinceBlock`. Feeds the launch
   * sensor from the DB instead of a duplicate getLogs. Oldest-first so a cursor can advance monotonically. */
  async recentLaunches(chainId: number, sinceBlock: number, limit = 100): Promise<Array<{ address: string; token0: string; token1: string; fee: number | null; factory: string | null; archetype: string | null; createdBlock: number }>> {
    const r = await this.pool.query<{ address: string; t0: string; t1: string; fee: string | null; factory: string | null; archetype: string | null; created_block: string }>(
      `SELECT address, meta->>'token0' t0, meta->>'token1' t1, meta->>'fee' fee, meta->>'factory' factory, meta->>'archetype' archetype, created_block
       FROM entities WHERE chain_id=$1 AND kind='pool' AND meta->>'origin'='created' AND created_block >= $2 AND (meta->>'token0') IS NOT NULL
       ORDER BY created_block ASC LIMIT $3`,
      [chainId, sinceBlock, limit]
    );
    return r.rows.map((x) => ({ address: x.address, token0: x.t0, token1: x.t1, fee: x.fee != null ? Number(x.fee) : null, factory: x.factory, archetype: x.archetype, createdBlock: Number(x.created_block) }));
  }

  /** All discovered pools containing a token (either side) — for the price oracle / arb. */
  /** Pools of a given archetype (with meta) — e.g. aerodrome-stable for the local stable-math work. */
  async poolsByArchetype(chainId: number, archetype: string, limit = 200): Promise<Array<{ address: string; meta: unknown }>> {
    const r = await this.pool.query<{ address: string; meta: unknown }>(
      `SELECT address, meta FROM entities WHERE chain_id=$1 AND kind='pool' AND meta->>'archetype'=$2 ORDER BY updated_at DESC LIMIT $3`, [chainId, archetype, limit]
    );
    return r.rows;
  }
  async poolsForToken(chainId: number, token: string): Promise<Array<{ address: string; meta: unknown }>> {
    const r = await this.pool.query<{ address: string; meta: unknown }>(
      `SELECT address, meta FROM entities WHERE chain_id=$1 AND kind='pool' AND (lower(meta->>'token0')=$2 OR lower(meta->>'token1')=$2) LIMIT 40`,
      [chainId, token.toLowerCase()]
    );
    return r.rows;
  }

  /** Entities not yet enriched with contract-verification metadata (newest first). */
  async entitiesNeedingMeta(chainId: number, limit = 12): Promise<Array<{ address: string; kind: string }>> {
    const r = await this.pool.query<{ address: string; kind: string }>(
      `SELECT address, kind FROM entities WHERE chain_id=$1 AND kind IN ('token','dex','contract') AND NOT (meta ? 'verifiedCheckedAt') ORDER BY updated_at DESC LIMIT $2`,
      [chainId, limit]
    );
    return r.rows;
  }

  /** ENRICHMENT BUFFER (tokens): token entities missing the price-critical `decimals`, not yet given up on.
   * Index-backed (entities_enrich_buffer_idx) so this touches ONLY the incomplete subset — never a full
   * scan, even at millions of entities. Resync set first (the boot/gap entities the gate waits for), then
   * oldest-block-first (NULLS FIRST = never-updated ahead of stale). */
  async entitiesNeedingDecimals(chainId: number, limit = 20): Promise<Array<{ address: string }>> {
    // LEVERAGE ORDER, not age order. Entities are not independent: a token's decimals unlock the valuation of
    // EVERY pool holding it, so the token with the highest graph degree is worth resolving first. We rank a
    // bounded candidate window (index-backed buffer scan) by degree — ranking the whole buffer would cost more
    // than it saves. Age/resync still decides which candidates enter the window, so nothing can starve.
    const r = await this.pool.query<{ address: string }>(
      `WITH cand AS (
         SELECT address FROM entities WHERE chain_id=$1 AND kind='token' AND enrich_pending AND NOT enrich_failed
         ORDER BY enrich_resync DESC, updated_block ASC NULLS FIRST LIMIT $3
       )
       SELECT c.address FROM cand c
       LEFT JOIN LATERAL (
         SELECT count(*) AS d FROM entities p
          WHERE p.chain_id=$1 AND p.kind='pool'
            AND (lower(p.meta->>'token0')=c.address OR lower(p.meta->>'token1')=c.address)
       ) deg ON TRUE
       ORDER BY deg.d DESC NULLS LAST LIMIT $2`,
      [chainId, limit, Math.max(limit * 5, 100)]
    );
    return r.rows;
  }

  /**
   * QUEUE SIGNALS — one round-trip that answers "does this pass have anything to do?" for the passes whose OWN
   * query is expensive (pool-wide aggregates). Booleans, not counts: an EXISTS stops at the first matching row,
   * so an idle probe is an index touch instead of an aggregate over every pool.
   *
   * This is what lets the drain be ordered by LEVERAGE instead of by a fixed sequence or a timer: a pass with a
   * non-empty queue runs immediately at full speed (60 factories never wait behind 4,000 pools), and a pass with
   * an empty queue costs nothing at all.
   */
  async enrichmentQueueSignals(chainId: number): Promise<{ poolFactory: boolean; factoryReverse: boolean; classify: boolean; aeroStable: boolean; protocolFee: boolean; dexIdentity: boolean }> {
    const r = await this.pool.query<{ pool_factory: boolean; factory_reverse: boolean; classify: boolean; aero_stable: boolean; protocol_fee: boolean; dex_identity: boolean }>(
      `SELECT
         EXISTS(SELECT 1 FROM entities WHERE chain_id=$1 AND kind='pool' AND NOT (meta ? 'factory')
                  AND COALESCE((meta->>'factoryAttempts')::int,0) < 3) AS pool_factory,
         EXISTS(SELECT 1 FROM entities WHERE chain_id=$1 AND kind='pool' AND NOT (meta ? 'factory')
                  AND COALESCE((meta->>'factoryAttempts')::int,0) >= 3 AND NOT (meta ? 'factoryResolvedBy')
                  AND meta->>'token0' IS NOT NULL AND meta->>'token1' IS NOT NULL) AS factory_reverse,
         EXISTS(SELECT 1 FROM entities WHERE chain_id=$1 AND kind='pool' AND COALESCE(meta->>'archetype','unknown')='unknown'
                  AND COALESCE((meta->>'classifyAttempts')::int,0) < 3) AS classify,
         EXISTS(SELECT 1 FROM entities WHERE chain_id=$1 AND kind='pool' AND meta->>'archetype' IN ('aerodrome','aerodrome-stable')
                  AND NOT (meta ? 'stableChecked')) AS aero_stable,
         EXISTS(SELECT 1 FROM entities WHERE chain_id=$1 AND kind='dex' AND NOT (meta ? 'feePpm')) AS protocol_fee,
         EXISTS(SELECT 1 FROM entities WHERE chain_id=$1 AND kind='dex' AND (NOT (meta ? 'type') OR name IS NULL OR NOT (meta ? 'router'))) AS dex_identity`,
      [chainId]
    );
    const x = r.rows[0];
    return { poolFactory: !!x?.pool_factory, factoryReverse: !!x?.factory_reverse, classify: !!x?.classify, aeroStable: !!x?.aero_stable, protocolFee: !!x?.protocol_fee, dexIdentity: !!x?.dex_identity };
  }

  // --- DISPLAY prices (Lane A: indicative, cached, batch-refreshed — never a decision input) ---
  /** Batch-upsert display prices (from DefiLlama batch / Blockscout / bounded aggregator backfill). */
  async upsertTokenPrices(chainId: number, rows: Array<{ token: string; priceUsd: number | null; confidence?: number | null; source?: string; block?: number | null }>, vol?: { tauFastSec: number; tauSlowSec: number }): Promise<void> {
    if (!rows.length) return;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      const b = i * 6;
      values.push(chainId, r.token.toLowerCase(), r.priceUsd, r.confidence ?? null, r.source ?? "defillama", r.block ?? null);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},NOW())`;
    });
    const tf = vol?.tauFastSec ?? 1200, ts = vol?.tauSlowSec ?? 86400;
    values.push(tf, ts);
    const pTf = `$${values.length - 1}`, pTs = `$${values.length}`;
    // EWMA of the per-second variance of log-returns, updated atomically on each new sample. dt =
    // seconds since the last sample; instVar = r²/dt; vol = λ·prior + (1−λ)·instVar, λ=exp(−dt/τ).
    const dt = "GREATEST(EXTRACT(EPOCH FROM (NOW() - token_prices.vol_at)), 1)";
    const instVar = `(power(ln(EXCLUDED.price_usd / NULLIF(token_prices.vol_sample_price,0)), 2) / ${dt})`;
    const ewma = (tau: string, col: string) => `(exp(-${dt}/${tau}) * COALESCE(token_prices.${col}, ${instVar}) + (1 - exp(-${dt}/${tau})) * ${instVar})`;
    const canUpdate = "token_prices.vol_sample_price > 0 AND EXCLUDED.price_usd > 0 AND token_prices.vol_at IS NOT NULL";
    await this.pool.query(
      `INSERT INTO token_prices(chain_id, token, price_usd, confidence, source, block_number, updated_at) VALUES ${tuples.join(",")}
       ON CONFLICT (chain_id, token) DO UPDATE SET price_usd=EXCLUDED.price_usd, confidence=EXCLUDED.confidence, source=EXCLUDED.source, updated_at=NOW(),
         block_number = COALESCE(EXCLUDED.block_number, token_prices.block_number),
         vol_fast = CASE WHEN ${canUpdate} THEN ${ewma(pTf, "vol_fast")} ELSE token_prices.vol_fast END,
         vol_slow = CASE WHEN ${canUpdate} THEN ${ewma(pTs, "vol_slow")} ELSE token_prices.vol_slow END,
         vol_sample_price = CASE WHEN EXCLUDED.price_usd > 0 THEN EXCLUDED.price_usd ELSE token_prices.vol_sample_price END,
         vol_at = CASE WHEN EXCLUDED.price_usd > 0 THEN NOW() ELSE token_prices.vol_at END
       -- SOURCE-PRIORITY + FRESHNESS guard: the indexer (exact, on-swap) is authoritative and must not be
       -- clobbered by a lower-quality lane (DefiLlama/none) while it is fresh. Accept a write only if it is
       -- (a) not zeroing a real price, AND (b) an equal/higher-priority source OR the stored price is stale
       -- enough (>120s, e.g. the token stopped trading so a slower lane may refresh it).
       WHERE (EXCLUDED.price_usd > 0 OR token_prices.price_usd IS NULL OR token_prices.price_usd = 0)
         AND ((CASE EXCLUDED.source WHEN 'indexer' THEN 3 WHEN 'aggregator' THEN 2 WHEN 'defillama' THEN 1 ELSE 0 END)
              >= (CASE token_prices.source WHEN 'indexer' THEN 3 WHEN 'aggregator' THEN 2 WHEN 'defillama' THEN 1 ELSE 0 END)
              OR token_prices.updated_at < NOW() - interval '120 seconds')`,
      values
    );
  }

  /** MEASURED per-second variance-rate (max of fast/slow EWMA) for a set of tokens → the caller turns
   * it into σ(T)=sqrt(varRate·T). null = no history yet (caller applies the high-vol prior). */
  async tokenVolatility(chainId: number, tokens: string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (!tokens.length) return out;
    const r = await this.pool.query<{ token: string; v: number | null }>(
      `SELECT token, GREATEST(COALESCE(vol_fast,0), COALESCE(vol_slow,0)) AS v FROM token_prices WHERE chain_id=$1 AND token = ANY($2::text[])`,
      [chainId, tokens.map((t) => t.toLowerCase())]
    );
    for (const row of r.rows) out.set(row.token, row.v && row.v > 0 ? row.v : null);
    return out;
  }

  /** Record a liquidation-relevant event for observability/history (dedup by tx+borrower when a tx). */
  async recordLiquidationEvent(e: { chainId: number; kind: string; protocol?: string; marketId?: string; borrower?: string; collateralSymbol?: string; loanSymbol?: string; debtUsd?: number | null; profitUsd?: number | null; txHash?: string; liquidator?: string; note?: string; meta?: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `INSERT INTO liquidation_events(chain_id, kind, protocol, market_id, borrower, collateral_symbol, loan_symbol, debt_usd, profit_usd, tx_hash, liquidator, note, meta)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (chain_id, kind, tx_hash, borrower) WHERE tx_hash IS NOT NULL DO NOTHING`,
      [e.chainId, e.kind, e.protocol ?? null, e.marketId ?? null, e.borrower?.toLowerCase() ?? null, e.collateralSymbol ?? null, e.loanSymbol ?? null, e.debtUsd ?? null, e.profitUsd ?? null, e.txHash?.toLowerCase() ?? null, e.liquidator?.toLowerCase() ?? null, e.note ?? null, jsonParam(e.meta ?? {})]
    );
  }

  /** Recent liquidation events for the dashboard history (optionally filtered by kind). */
  async listLiquidationEvents(chainId: number, kind?: string, limit = 60): Promise<Array<{ kind: string; protocol: string | null; borrower: string | null; collateralSymbol: string | null; loanSymbol: string | null; debtUsd: number | null; profitUsd: number | null; txHash: string | null; liquidator: string | null; note: string | null; observedAt: string }>> {
    const r = await this.pool.query<{ kind: string; protocol: string | null; borrower: string | null; collateral_symbol: string | null; loan_symbol: string | null; debt_usd: number | null; profit_usd: number | null; tx_hash: string | null; liquidator: string | null; note: string | null; observed_at: Date }>(
      `SELECT kind, protocol, borrower, collateral_symbol, loan_symbol, debt_usd, profit_usd, tx_hash, liquidator, note, observed_at
       FROM liquidation_events WHERE chain_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY observed_at DESC LIMIT $3`,
      [chainId, kind ?? null, Math.min(limit, 200)]
    );
    return r.rows.map((x) => ({ kind: x.kind, protocol: x.protocol, borrower: x.borrower, collateralSymbol: x.collateral_symbol, loanSymbol: x.loan_symbol, debtUsd: x.debt_usd, profitUsd: x.profit_usd, txHash: x.tx_hash, liquidator: x.liquidator, note: x.note, observedAt: x.observed_at.toISOString() }));
  }

  /** Display prices for a set of tokens (render-time read; no external calls). */
  async getTokenPrices(chainId: number, tokens: string[]): Promise<Map<string, { priceUsd: number | null; confidence: number | null; source: string; updatedAt: string; block: number | null }>> {
    const out = new Map<string, { priceUsd: number | null; confidence: number | null; source: string; updatedAt: string; block: number | null }>();
    if (!tokens.length) return out;
    const lower = tokens.map((t) => t.toLowerCase());
    const r = await this.pool.query<{ token: string; price_usd: number | null; confidence: number | null; source: string; updated_at: Date; block_number: string | null }>(
      `SELECT token, price_usd, confidence, source, updated_at, block_number::text FROM token_prices WHERE chain_id=$1 AND token = ANY($2::text[])`, [chainId, lower]
    );
    for (const row of r.rows) out.set(row.token, { priceUsd: row.price_usd, confidence: row.confidence, source: row.source, updatedAt: row.updated_at.toISOString(), block: row.block_number == null ? null : Number(row.block_number) });
    return out;
  }

  /** Discovered, non-blacklisted token entities to (re)price. LIQUID tokens (a real DefiLlama/aggregator
   * price) are kept fresh at `staleMs`; UNPRICED/no-liquidity ones (source none/no_liquidity) are
   * re-checked only every `deadMs` — so the active refresh list stays the liquid tokens and we don't
   * churn thousands of dead tokens every tick. Never-priced tokens come first. */
  async tokensForDisplayPricing(chainId: number, limit: number, staleMs: number, deadMs: number): Promise<string[]> {
    const r = await this.pool.query<{ address: string }>(
      `SELECT e.address FROM entities e LEFT JOIN token_prices p ON p.chain_id=e.chain_id AND p.token=e.address
       WHERE e.chain_id=$1 AND e.kind='token' AND e.status <> 'blacklist' AND COALESCE(e.meta->>'blacklisted','') <> 'true'
         AND (p.updated_at IS NULL
              OR (p.source NOT IN ('none','no_liquidity') AND p.updated_at < NOW() - ($3::double precision || ' milliseconds')::interval)
              OR (p.source IN ('none','no_liquidity') AND p.updated_at < NOW() - ($4::double precision || ' milliseconds')::interval))
       ORDER BY p.updated_at ASC NULLS FIRST LIMIT $2`, [chainId, limit, staleMs, deadMs]
    );
    return r.rows.map((x) => x.address);
  }

  /** Token entities MISSING a real symbol ("?"/null) — the resolver queue (enricher fills them). */
  async entitiesNeedingSymbol(chainId: number, limit = 20): Promise<Array<{ address: string }>> {
    const r = await this.pool.query<{ address: string }>(
      `SELECT address FROM entities WHERE chain_id=$1 AND kind='token' AND (symbol IS NULL OR symbol IN ('?','')) AND NOT (meta ? 'symbolCheckedAt') ORDER BY updated_at DESC LIMIT $2`,
      [chainId, limit]
    );
    return r.rows;
  }

  /** Pool entities the indexer discovered by their Swap/Sync but whose token0/token1 aren't known yet
   * (bare pools written on the critical path). The enricher fills token0/1/fee on its dedicated lane. */
  /** ENRICHMENT BUFFER (pools): bare pools missing token0/1 (discovered by a Swap/Sync, no PoolCreated seen),
   * not yet given up on. Same index-backed, resync-first, oldest-first drain as the token buffer. */
  /** The enrichment BUFFER for pools. Returns WHICH fields are missing so the worker reads only those — a pool
   * that already has token0/token1 but lacks fee/tickSpacing must not re-read what it already knows. */
  async entitiesNeedingPoolInfo(chainId: number, limit = 20): Promise<Array<{ address: string; archetype: string | null; hasTokens: boolean; hasFactory: boolean; needsFee: boolean; needsSpacing: boolean }>> {
    const r = await this.pool.query<{ address: string; archetype: string | null; has_tokens: boolean; has_factory: boolean; needs_fee: boolean; needs_spacing: boolean }>(
      `SELECT address, meta->>'archetype' AS archetype,
              ((meta->>'token0') IS NOT NULL AND (meta->>'token1') IS NOT NULL) AS has_tokens,
              ((meta->>'factory') IS NOT NULL) AS has_factory,
              ((meta->>'fee') IS NULL) AS needs_fee,
              ((meta->>'tickSpacing') IS NULL) AS needs_spacing
       FROM entities WHERE chain_id=$1 AND kind='pool' AND enrich_pending AND NOT enrich_failed
       ORDER BY enrich_resync DESC, updated_block ASC NULLS FIRST LIMIT $2`,
      [chainId, limit]
    );
    return r.rows.map((x) => ({ address: x.address, archetype: x.archetype, hasTokens: x.has_tokens, hasFactory: x.has_factory, needsFee: x.needs_fee, needsSpacing: x.needs_spacing }));
  }

  /** ENRICHMENT BUFFER — record a FAILED read attempt on an entity (block-based, persisted; replaces the
   * old in-memory counter that reset on restart). Stamps the attempt block, and after `maxAttempts` marks
   * the entity terminally `enrich_failed` so a genuinely-unresolvable address stops being re-drained and
   * never hangs the resync gate — while staying visible (attempts + checked_block show WHY it's un-updated). */
  async bumpEnrichAttempt(chainId: number, address: string, kind: string, block: number | null, maxAttempts: number): Promise<void> {
    await this.pool.query(
      `UPDATE entities SET enrich_attempts = enrich_attempts + 1, enrich_checked_block = COALESCE($4, enrich_checked_block),
         enrich_failed = (enrich_attempts + 1 >= $5)
       WHERE chain_id=$1 AND address=$2 AND kind=$3`,
      [chainId, address.toLowerCase(), kind, block, maxAttempts]
    );
  }

  /** GATE (resync): snapshot the CURRENT incomplete set as the resync set to drain. Called once when the
   * indexer first reaches head — everything discovered up to head (boot scan + gap) is present now. Sets
   * enrich_resync = true for still-incomplete entities, false for the rest, atomically. Returns how many
   * remain outstanding (the number the startup gate then waits to reach 0). */
  async flagResyncSet(chainId: number): Promise<number> {
    await this.pool.query(`UPDATE entities SET enrich_resync = (enrich_pending AND NOT enrich_failed) WHERE chain_id=$1`, [chainId]);
    return this.countResyncOutstanding(chainId);
  }

  /** GATE (resync): how many resync-flagged entities are still incomplete (not yet enriched, not failed).
   * 0 = the resync set is fully resolved → the startup gate may release the acting services. */
  /** Record one enrichment cycle. Called only when something happened, and self-trimming so the table stays
   * a rolling window rather than unbounded history. */
  async logEnrichmentCycle(chainId: number, block: number | null, passes: Record<string, number>, rateLimited: boolean, note?: string): Promise<void> {
    await this.pool.query(`INSERT INTO enrichment_log(chain_id, block, passes, rate_limited, note) VALUES($1,$2,$3,$4,$5)`,
      [chainId, block, JSON.stringify(passes), rateLimited, note ?? null]).catch(() => undefined);
    if (Math.random() < 0.02) await this.pool.query(`DELETE FROM enrichment_log WHERE chain_id=$1 AND created_at < now() - interval '6 hours'`, [chainId]).catch(() => undefined);
  }

  /** Factories needing identity, WITH the answer already in the data: a factory's family is simply the
   * archetype its pools have. No RPC needed for `type` — we already indexed thousands of its pools. */
  async factoriesNeedingIdentity(chainId: number, limit = 20): Promise<Array<{ address: string; poolArchetype: string | null; pools: number; hasName: boolean; hasType: boolean; contractName: string | null; nameAttempts: number }>> {
    const r = await this.pool.query<Record<string, unknown>>(
      `WITH by_factory AS (
         SELECT lower(p.meta->>'factory') f, p.meta->>'archetype' arch, count(*)::int n,
                row_number() OVER (PARTITION BY lower(p.meta->>'factory') ORDER BY count(*) DESC) rn
         FROM entities p WHERE p.chain_id=$1 AND p.kind='pool' AND p.meta->>'factory' IS NOT NULL
         GROUP BY 1,2)
       SELECT d.address, b.arch pool_archetype, COALESCE(b.n,0)::int pools,
              (d.name IS NOT NULL) has_name, ((d.meta->>'type') IS NOT NULL) has_type,
              d.meta->>'contractName' contract_name, COALESCE((d.meta->>'nameAttempts')::int,0) name_attempts
       FROM entities d LEFT JOIN by_factory b ON b.f = d.address AND b.rn = 1
       WHERE d.chain_id=$1 AND d.kind='dex' AND ((d.meta->>'type') IS NULL OR (d.name IS NULL AND COALESCE((d.meta->>'nameAttempts')::int,0) < 2))
       ORDER BY COALESCE(b.n,0) DESC LIMIT $2`, [chainId, limit]);
    return r.rows.map((x) => ({ address: String(x.address), poolArchetype: (x.pool_archetype as string) ?? null, pools: Number(x.pools), hasName: !!x.has_name, hasType: !!x.has_type, contractName: (x.contract_name as string) ?? null, nameAttempts: Number(x.name_attempts ?? 0) }));
  }

  /**
   * Derive every factory's TYPE in ONE statement. A factory's family is the archetype of the pools it created
   * — data we already hold — so this is pure SQL: no RPC, no per-entity pacing, no batching. Deriving a
   * derivable field one-at-a-time through a network-paced loop was the reason it crawled at ~2/cycle while
   * factories that only lacked an (often unobtainable) name monopolised the batch.
   */
  async deriveFactoryTypes(chainId: number): Promise<number> {
    const r = await this.pool.query(
      `WITH dom AS (
         SELECT lower(p.meta->>'factory') f, p.meta->>'archetype' arch, count(*) n,
                row_number() OVER (PARTITION BY lower(p.meta->>'factory') ORDER BY count(*) DESC) rn
         FROM entities p WHERE p.chain_id=$1 AND p.kind='pool' AND p.meta->>'factory' IS NOT NULL
           AND p.meta->>'archetype' IS NOT NULL AND p.meta->>'archetype' <> 'unknown'
         GROUP BY 1,2)
       UPDATE entities d SET meta = d.meta || jsonb_build_object(
                'type', CASE dom.arch WHEN 'v3' THEN 'uni-v3' WHEN 'v4' THEN 'uni-v4' WHEN 'slipstream' THEN 'slipstream'
                                      WHEN 'algebra' THEN 'algebra' WHEN 'v2' THEN 'uni-v2'
                                      WHEN 'aerodrome' THEN 'aerodrome' WHEN 'aerodrome-stable' THEN 'aerodrome'
                                      WHEN 'solidly' THEN 'solidly' ELSE NULL END,
                'typeSource', 'pools:' || dom.arch || '(' || dom.n || ')'),
              updated_at = NOW()
       FROM dom
       WHERE d.chain_id=$1 AND d.kind='dex' AND d.address = dom.f AND dom.rn = 1
         AND (d.meta->>'type') IS NULL
         AND dom.arch IN ('v3','v4','slipstream','algebra','v2','aerodrome','aerodrome-stable','solidly')`, [chainId]);
    return r.rowCount ?? 0;
  }

  /** Own-execution coverage: how much of the indexed liquidity sits behind a factory we can actually route
   * through. This is the number that gates `routeEncodable` in the KG — and it was never measured. */
  async executionCoverage(chainId: number): Promise<Array<{ factory: string; name: string | null; type: string | null; hasRouter: boolean; pools: number }>> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT lower(p.meta->>'factory') factory, max(d.name) name, max(d.meta->>'type') type,
              bool_or((d.meta->>'router') IS NOT NULL) has_router, count(*)::int pools
       FROM entities p LEFT JOIN entities d ON d.chain_id=p.chain_id AND d.address=lower(p.meta->>'factory') AND d.kind='dex'
       WHERE p.chain_id=$1 AND p.kind='pool' AND p.meta->>'factory' IS NOT NULL
       GROUP BY 1 ORDER BY pools DESC LIMIT 25`, [chainId]);
    return r.rows.map((x) => ({ factory: String(x.factory), name: (x.name as string) ?? null, type: (x.type as string) ?? null, hasRouter: !!x.has_router, pools: Number(x.pools) }));
  }

  /** Cheap, index-backed "is there anything to do for this kind" check — used to gate expensive passes. */
  async countPendingByKind(chainId: number, kind: string): Promise<number> {
    const r = await this.pool.query<{ n: number }>(`SELECT count(*)::int n FROM entities WHERE chain_id=$1 AND kind=$2 AND enrich_pending AND NOT enrich_failed`, [chainId, kind]);
    return r.rows[0]?.n ?? 0;
  }

  async countEnrichPending(chainId: number): Promise<number> {
    const r = await this.pool.query<{ n: number }>(`SELECT count(*)::int n FROM entities WHERE chain_id=$1 AND enrich_pending AND NOT enrich_failed`, [chainId]);
    return r.rows[0]?.n ?? 0;
  }

  /** Recent enrichment activity + per-pass totals: "is it working, on what, and what is stuck". */
  async enrichmentActivity(chainId: number, limit = 25): Promise<{ recent: Array<Record<string, unknown>>; totals: Record<string, number>; windowMin: number; rateLimitedCycles: number }> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT block::text, passes, rate_limited, note, to_char(created_at,'HH24:MI:SS') at,
              (EXTRACT(EPOCH FROM (now()-created_at)))::int age_s
       FROM enrichment_log WHERE chain_id=$1 ORDER BY created_at DESC LIMIT $2`, [chainId, limit]);
    const agg = await this.pool.query<{ passes: Record<string, number>; rl: boolean }>(
      `SELECT passes, rate_limited rl FROM enrichment_log WHERE chain_id=$1 AND created_at > now() - interval '60 minutes'`, [chainId]);
    const totals: Record<string, number> = {};
    let rateLimitedCycles = 0;
    for (const row of agg.rows) { if (row.rl) rateLimitedCycles++; for (const [k, v] of Object.entries(row.passes ?? {})) totals[k] = (totals[k] ?? 0) + Number(v); }
    return { recent: r.rows, totals, windowMin: 60, rateLimitedCycles };
  }

  /** Return entities to the enrichment buffer after a WRITE-SIDE fault (a flaky RPC burned their attempts,
   * not bad data). Data completeness is the goal — a permanently-failed entity we never re-try is a silent
   * hole in every downstream calculation. Called on startup so a transient outage cannot cost us data. */
  async resetEnrichFailures(chainId: number, kind = "pool"): Promise<number> {
    // Requeue only failures we CANNOT explain. This runs at every enricher start, and resetting every failed
    // entity meant each restart erased the evidence that the chain definitively refuses a contract — with
    // fast deploys those entities never reached the attempt cap and were re-read for ever (measured:
    // enrich_attempts=0 on all 37 queued pools, 22 of which already carried a recorded verdict).
    //
    // `enrichBlockedBy` is not a guess: it is only written when a positive control proved the lane healthy
    // and the sub-call still failed — the chain was asked and answered "this function does not exist". That
    // is a FACT about the contract and survives a restart. A failure with no such evidence is exactly the
    // flaky-transport case this reset exists for, and still gets another chance.
    const r = await this.pool.query(
      `UPDATE entities SET enrich_failed=false, enrich_attempts=0
        WHERE chain_id=$1 AND kind=$2 AND enrich_failed AND enrich_pending AND NOT (meta ? 'enrichBlockedBy')`, [chainId, kind]
    );
    return r.rowCount ?? 0;
  }

  /** Entities whose incompleteness would make an ACTING component WRONG — the only thing worth holding the
   * startup gate for. Scoped deliberately: a token without decimals mis-prices everything, and a pool without
   * its tokens cannot be modelled at all. A pool merely missing fee/tickSpacing is NOT counted: every
   * size-dependent claim on it already fails closed downstream, so blocking the whole system on thousands of
   * pool-metadata rows delays liquidations without making anything safer. */
  async countResyncOutstanding(chainId: number): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM entities
       WHERE chain_id=$1 AND enrich_resync AND enrich_pending AND NOT enrich_failed
         AND ( (kind='token' AND decimals IS NULL)
            OR (kind='pool' AND ((meta->>'token0') IS NULL OR (meta->>'token1') IS NULL)) )`, [chainId]
    );
    return r.rows[0]?.n ?? 0;
  }

  /** RECONCILIATION: pool entities missing `meta.factory` — old/bare pools discovered before we stored the
   * factory (own-execution routes each pool to ITS dex's router by factory). The manual re-sync backfills it.
   * `factoryCheckedAt` guards pools whose factory() couldn't be read, so a re-run doesn't loop on them. */
  /** Aerodrome pools not yet stable/volatile-classified — discovered via Sync (which can't tell them apart)
   * so labelled generically "aerodrome". The enricher reads the immutable stable() flag once to fix them. */
  async poolsNeedingStableCheck(chainId: number, limit = 200): Promise<string[]> {
    const r = await this.pool.query<{ address: string }>(
      `SELECT address FROM entities WHERE chain_id=$1 AND kind='pool' AND meta->>'archetype' IN ('aerodrome','aerodrome-stable') AND NOT (meta ? 'stableChecked') ORDER BY updated_at DESC LIMIT $2`,
      [chainId, limit]
    );
    return r.rows.map((x) => x.address);
  }
  /** Pools still missing their factory. A single failed read must NOT exclude a pool forever (that silently
   * cost us 131 pools): we bound RETRIES instead, and `factoryUnavailable` is set only when we have positive
   * evidence the contract does not expose it — those go to the reverse-lookup pass instead of being dropped. */
  async poolsMissingFactory(chainId: number, limit = 200, maxAttempts = 3): Promise<Array<{ address: string; archetype: string | null; token0: string | null; token1: string | null }>> {
    const r = await this.pool.query<{ address: string; archetype: string | null; t0: string | null; t1: string | null }>(
      `SELECT address, meta->>'archetype' archetype, meta->>'token0' t0, meta->>'token1' t1
       FROM entities WHERE chain_id=$1 AND kind='pool' AND NOT (meta ? 'factory')
         AND COALESCE((meta->>'factoryAttempts')::int, 0) < $3
       ORDER BY updated_at DESC LIMIT $2`, [chainId, limit, maxAttempts]
    );
    return r.rows.map((x) => ({ address: x.address, archetype: x.archetype, token0: x.t0, token1: x.t1 }));
  }

  /** Pools whose factory() is genuinely not exposed → recover it by REVERSE LOOKUP on candidate factories. */
  async poolsForFactoryReverseLookup(chainId: number, limit = 40): Promise<Array<{ address: string; archetype: string | null; token0: string | null; token1: string | null }>> {
    const r = await this.pool.query<{ address: string; archetype: string | null; t0: string | null; t1: string | null }>(
      `SELECT address, meta->>'archetype' archetype, meta->>'token0' t0, meta->>'token1' t1
       FROM entities WHERE chain_id=$1 AND kind='pool' AND NOT (meta ? 'factory')
         AND COALESCE((meta->>'factoryAttempts')::int, 0) >= 3 AND NOT (meta ? 'factoryResolvedBy')
         AND meta->>'token0' IS NOT NULL AND meta->>'token1' IS NOT NULL
       ORDER BY updated_at DESC LIMIT $2`, [chainId, limit]
    );
    return r.rows.map((x) => ({ address: x.address, archetype: x.archetype, token0: x.t0, token1: x.t1 }));
  }

  /** Distinct factories we already know, per archetype — the candidate set for the reverse lookup. */
  async knownFactories(chainId: number, archetypes: string[]): Promise<string[]> {
    const r = await this.pool.query<{ f: string }>(
      `SELECT DISTINCT meta->>'factory' f FROM entities WHERE chain_id=$1 AND kind='pool'
         AND meta->>'factory' IS NOT NULL AND meta->>'archetype' = ANY($2::text[])`, [chainId, archetypes]);
    return r.rows.map((x) => x.f).filter(Boolean);
  }

  /** Tokens missing a SYMBOL (readability, not price). Kept OUT of enrich_pending so it never blocks the
   * startup gate, but no longer invisible: symbol() is a plain ERC20 call we simply were not making. */
  async tokensMissingSymbol(chainId: number, limit = 60, maxAttempts = 3): Promise<string[]> {
    const r = await this.pool.query<{ address: string }>(
      `SELECT address FROM entities WHERE chain_id=$1 AND kind='token' AND symbol IS NULL
         AND COALESCE((meta->>'symbolAttempts')::int, 0) < $3
       ORDER BY updated_block DESC NULLS LAST LIMIT $2`, [chainId, limit, maxAttempts]);
    return r.rows.map((x) => x.address);
  }

  /** Pools whose archetype is unknown but that are ACTIVE — classify them from their ABI fingerprint. */
  async poolsNeedingClassification(chainId: number, limit = 40): Promise<Array<{ address: string; token0: string | null; token1: string | null }>> {
    const r = await this.pool.query<{ address: string; t0: string | null; t1: string | null }>(
      `SELECT address, meta->>'token0' t0, meta->>'token1' t1 FROM entities
       WHERE chain_id=$1 AND kind='pool' AND COALESCE(meta->>'archetype','unknown')='unknown'
         AND COALESCE((meta->>'classifyAttempts')::int, 0) < 3
       ORDER BY updated_at DESC LIMIT $2`, [chainId, limit]);
    return r.rows.map((x) => ({ address: x.address, token0: x.t0, token1: x.t1 }));
  }

  /** Factories still without a resolved protocol fee (the CP families where fee is NOT per-pool). */
  async factoriesNeedingFee(chainId: number, limit = 20): Promise<Array<{ factory: string; archetype: string; samplePool: string; stable: boolean }>> {
    const r = await this.pool.query<{ factory: string; archetype: string; pool: string; stable: boolean }>(
      `SELECT DISTINCT ON (e.meta->>'factory', e.meta->>'archetype')
              e.meta->>'factory' factory, e.meta->>'archetype' archetype, e.address pool,
              (e.meta->>'archetype' = 'aerodrome-stable') stable
       FROM entities e LEFT JOIN entities f ON f.chain_id=e.chain_id AND f.address=e.meta->>'factory' AND f.kind='dex'
       WHERE e.chain_id=$1 AND e.kind='pool' AND e.meta->>'factory' IS NOT NULL
         AND e.meta->>'archetype' IN ('v2','aerodrome','aerodrome-stable','solidly')
         AND (f.meta->>'feePpm') IS NULL
       LIMIT $2`, [chainId, limit]);
    return r.rows.map((x) => ({ factory: x.factory, archetype: x.archetype, samplePool: x.pool, stable: x.stable }));
  }

  /** Protocol-level fee lives on the FACTORY entity, with its SOURCE recorded (read vs protocol constant) —
   * a constant is a FACT about the protocol, not a guessed default, and the difference must stay visible. */
  async setFactoryFee(chainId: number, factory: string, feePpm: number, source: string): Promise<void> {
    await this.upsertEntity({ chainId, address: factory, kind: "dex", meta: { feePpm, feeSource: source }, source: "enricher" });
  }
  /** factory → protocol fee (ppm), for the loader to resolve a CP pool's real fee. */
  async protocolFees(chainId: number): Promise<Map<string, number>> {
    const r = await this.pool.query<{ address: string; fee: string }>(
      `SELECT address, meta->>'feePpm' fee FROM entities WHERE chain_id=$1 AND kind='dex' AND meta->>'feePpm' IS NOT NULL`, [chainId]);
    const m = new Map<string, number>();
    for (const row of r.rows) { const n = Number(row.fee); if (Number.isFinite(n) && n > 0) m.set(row.address.toLowerCase(), n); }
    return m;
  }

  /** Token symbol+decimals for a set of addresses, FROM THE REGISTRY (the source of truth). Consumers
   * like the wallet read metadata here and only compute quantities — they never resolve it themselves. */
  async tokenMeta(chainId: number, addresses: string[]): Promise<Map<string, { symbol: string | null; decimals: number | null }>> {
    const out = new Map<string, { symbol: string | null; decimals: number | null }>();
    if (!addresses.length) return out;
    const lower = addresses.map((a) => a.toLowerCase());
    const r = await this.pool.query<{ address: string; symbol: string | null; decimals: number | null }>(
      `SELECT address, symbol, decimals FROM entities WHERE chain_id=$1 AND kind='token' AND address = ANY($2::text[])`, [chainId, lower]
    );
    for (const row of r.rows) out.set(row.address, { symbol: row.symbol, decimals: row.decimals });
    return out;
  }

  // --- wallet movements + balances (the wallet's own source of truth, RPC-derived, DB-persisted) ---
  /** Append newly-detected wallet transfers (dedup by tx+logIndex). Already-saved ones are ignored. */
  async insertWalletTransfers(chainId: number, wallet: string, rows: Array<{ txHash: string; logIndex: number; blockNumber: bigint; token: string; from: string; to: string; valueRaw: bigint; direction: string }>): Promise<number> {
    if (!rows.length) return 0;
    const w = wallet.toLowerCase();
    const flat: unknown[] = [];
    rows.forEach((r) => flat.push(chainId, w, r.txHash.toLowerCase(), r.logIndex, r.blockNumber.toString(), r.token.toLowerCase(), r.from.toLowerCase(), r.to.toLowerCase(), r.valueRaw.toString(), r.direction));
    const tup = rows.map((_, i) => { const b = i * 10; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`; });
    const res = await this.pool.query(
      `INSERT INTO wallet_transactions(chain_id, wallet, tx_hash, log_index, block_number, token, from_addr, to_addr, value_raw, direction)
       VALUES ${tup.join(",")} ON CONFLICT (chain_id, wallet, tx_hash, log_index) DO NOTHING`, flat
    );
    return res.rowCount ?? 0;
  }

  /** A WATCHED wallet's transfers AFTER a block (oldest-first), JOINed to token symbols/decimals — fed by
   * the indexer. Lets FollowService read followed smart-money's moves from the DB instead of its own getLogs. */
  async walletTransfersSince(chainId: number, wallet: string, sinceBlock: number): Promise<Array<{ txHash: string; block: string; token: string; symbol: string | null; decimals: number | null; from: string; to: string; valueRaw: string; direction: string }>> {
    const r = await this.pool.query<{ tx_hash: string; block_number: string; token: string; symbol: string | null; decimals: number | null; from_addr: string; to_addr: string; value_raw: string; direction: string }>(
      `SELECT t.tx_hash, t.block_number::text, t.token, e.symbol, e.decimals, t.from_addr, t.to_addr, t.value_raw::text, t.direction
       FROM wallet_transactions t LEFT JOIN entities e ON e.chain_id=t.chain_id AND e.address=t.token AND e.kind='token'
       WHERE t.chain_id=$1 AND t.wallet=$2 AND t.block_number > $3 ORDER BY t.block_number ASC, t.log_index ASC LIMIT 200`,
      [chainId, wallet.toLowerCase(), sinceBlock]
    );
    return r.rows.map((x) => ({ txHash: x.tx_hash, block: x.block_number, token: x.token, symbol: x.symbol, decimals: x.decimals, from: x.from_addr, to: x.to_addr, valueRaw: x.value_raw, direction: x.direction }));
  }

  /** The wallet's transaction history for the detail page — newest first, JOINed to token symbols. */
  async listWalletTransactions(chainId: number, wallet: string, limit = 100, offset = 0): Promise<Array<{ txHash: string; blockNumber: string; token: string; symbol: string | null; decimals: number | null; from: string; to: string; valueRaw: string; direction: string; observedAt: string }>> {
    const r = await this.pool.query<{ tx_hash: string; block_number: string; token: string; symbol: string | null; decimals: number | null; from_addr: string; to_addr: string; value_raw: string; direction: string; observed_at: Date }>(
      `SELECT t.tx_hash, t.block_number::text, t.token, e.symbol, e.decimals, t.from_addr, t.to_addr, t.value_raw::text, t.direction, t.observed_at
       FROM wallet_transactions t LEFT JOIN entities e ON e.chain_id=t.chain_id AND e.address=t.token AND e.kind='token'
       WHERE t.chain_id=$1 AND t.wallet=$2 ORDER BY t.block_number DESC, t.log_index DESC LIMIT $3 OFFSET $4`,
      [chainId, wallet.toLowerCase(), Math.min(limit, 500), offset]
    );
    return r.rows.map((x) => ({ txHash: x.tx_hash, blockNumber: x.block_number, token: x.token, symbol: x.symbol, decimals: x.decimals, from: x.from_addr, to: x.to_addr, valueRaw: x.value_raw, direction: x.direction, observedAt: x.observed_at.toISOString() }));
  }

  /** Set/clear a token's maintained balance for the wallet (ground truth from a fresh balanceOf). */
  async upsertWalletTokenBalance(chainId: number, wallet: string, token: string, balanceRaw: bigint): Promise<void> {
    await this.pool.query(
      `INSERT INTO wallet_token_balances(chain_id, wallet, token, balance_raw, updated_at) VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT (chain_id, wallet, token) DO UPDATE SET balance_raw=EXCLUDED.balance_raw, updated_at=NOW()`,
      [chainId, wallet.toLowerCase(), token.toLowerCase(), balanceRaw.toString()]
    );
  }

  /** The wallet's maintained non-zero token balances (raw). The dashboard triangulates these with the
   * token registry (symbol/decimals/tagging) and token_prices (value). */
  async walletTokenBalances(chainId: number, wallet: string): Promise<Array<{ token: string; balanceRaw: string; updatedAt: string }>> {
    const r = await this.pool.query<{ token: string; balance_raw: string; updated_at: Date }>(
      `SELECT token, balance_raw::text, updated_at FROM wallet_token_balances WHERE chain_id=$1 AND wallet=$2 AND balance_raw > 0`,
      [chainId, wallet.toLowerCase()]
    );
    return r.rows.map((x) => ({ token: x.token, balanceRaw: x.balance_raw, updatedAt: x.updated_at.toISOString() }));
  }

  /** Merge a JSON patch into an entity's meta (verification enrichment, etc.). */
  async mergeEntityMeta(chainId: number, address: string, kind: string, patch: Record<string, unknown>): Promise<void> {
    // A null in a merge patch means REMOVE THE KEY, not "store a null". `meta || {"k": null}` keeps the key
    // with a null value, which then satisfies `meta ? 'k'` while failing anything that expects the real type —
    // that is exactly how one cleared field took down the whole health view. jsonParam, not raw stringify:
    // it is the one place that strips what Postgres cannot store.
    const drop = Object.entries(patch).filter(([, v]) => v === null).map(([k]) => k);
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
    await this.pool.query(
      `UPDATE entities SET meta = (meta - $5::text[]) || $4::jsonb WHERE chain_id=$1 AND address=$2 AND kind=$3`,
      [chainId, address.toLowerCase(), kind, jsonParam(set), drop]);
  }

  // --- lending positions registry (all borrowers, tiered, adaptive polling) ---
  /** Upsert a position's raw state (from enumeration/scanner). Preserves the loop-managed tier
   * and schedule; a brand-new row starts due NOW so the loop classifies it immediately. */
  async upsertLendingPosition(p: { chainId: number; protocol: string; marketId: string; borrower: string; collateralToken?: string | null; collateralSymbol?: string | null; loanToken?: string | null; loanSymbol?: string | null; lltv?: number | null; meta?: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `INSERT INTO lending_positions(chain_id, protocol, market_id, borrower, collateral_token, collateral_symbol, loan_token, loan_symbol, lltv, meta, next_check_at, enumerated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
       ON CONFLICT (chain_id, protocol, market_id, borrower) DO UPDATE SET
         collateral_token=COALESCE(EXCLUDED.collateral_token, lending_positions.collateral_token),
         collateral_symbol=COALESCE(EXCLUDED.collateral_symbol, lending_positions.collateral_symbol),
         loan_token=COALESCE(EXCLUDED.loan_token, lending_positions.loan_token),
         loan_symbol=COALESCE(EXCLUDED.loan_symbol, lending_positions.loan_symbol),
         lltv=COALESCE(EXCLUDED.lltv, lending_positions.lltv),
         meta=lending_positions.meta || EXCLUDED.meta, updated_at=NOW(), enumerated_at=NOW()`,
      [p.chainId, p.protocol, p.marketId, p.borrower.toLowerCase(), p.collateralToken?.toLowerCase() ?? null, p.collateralSymbol ?? null, p.loanToken?.toLowerCase() ?? null, p.loanSymbol ?? null, p.lltv ?? null, jsonParam(p.meta ?? {})]
    );
  }

  /** Morpho market params, learned by the indexer (CreateMarket / idToMarketParams bootstrap). */
  async upsertLendingMarket(m: { chainId: number; protocol: string; marketId: string; loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: bigint }): Promise<void> {
    await this.pool.query(
      `INSERT INTO lending_markets(chain_id, protocol, market_id, loan_token, collateral_token, oracle, irm, lltv)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (chain_id, protocol, market_id) DO UPDATE SET
         loan_token=EXCLUDED.loan_token, collateral_token=EXCLUDED.collateral_token,
         oracle=EXCLUDED.oracle, irm=EXCLUDED.irm, lltv=EXCLUDED.lltv`,
      [m.chainId, m.protocol, m.marketId, m.loanToken.toLowerCase(), m.collateralToken.toLowerCase(), m.oracle.toLowerCase(), m.irm.toLowerCase(), m.lltv.toString()]
    );
  }
  async getLendingMarket(chainId: number, protocol: string, marketId: string): Promise<{ loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: bigint } | null> {
    const r = await this.pool.query<{ loan_token: string; collateral_token: string; oracle: string; irm: string; lltv: string }>(
      `SELECT loan_token, collateral_token, oracle, irm, lltv::text FROM lending_markets WHERE chain_id=$1 AND protocol=$2 AND market_id=$3`, [chainId, protocol, marketId]
    );
    const m = r.rows[0];
    return m ? { loanToken: m.loan_token, collateralToken: m.collateral_token, oracle: m.oracle, irm: m.irm, lltv: BigInt(m.lltv.split(".")[0]) } : null;
  }


  /** Accumulate router evidence. Called with per-flush AGGREGATES, never per swap: the indexer counts in
   * memory and flushes occasionally, so the per-block critical path pays nothing for this. */
  async addRouterEvidence(chainId: number, rows: Array<{ factory: string; sender: string; swaps: number; pools: number; block: number }>): Promise<void> {
    if (!rows.length) return;
    await this.pool.query(
      `INSERT INTO router_evidence(chain_id, factory, sender, swaps, pools_seen, last_block)
       SELECT $1, f, s, sw, po, bn FROM unnest($2::text[], $3::text[], $4::bigint[], $5::int[], $6::bigint[]) AS t(f, s, sw, po, bn)
       ON CONFLICT (chain_id, factory, sender) DO UPDATE SET
         swaps = router_evidence.swaps + EXCLUDED.swaps,
         pools_seen = GREATEST(router_evidence.pools_seen, EXCLUDED.pools_seen),
         last_block = GREATEST(COALESCE(router_evidence.last_block,0), EXCLUDED.last_block), updated_at=NOW()`,
      [chainId, rows.map((r) => r.factory.toLowerCase()), rows.map((r) => r.sender.toLowerCase()),
       rows.map((r) => r.swaps), rows.map((r) => r.pools), rows.map((r) => r.block)]
    );
  }

  /**
   * The router candidate for each factory that still lacks one. A candidate must be the factory's TOP sender
   * by swap count, and EXCLUSIVE to it: `exclusivity` is the share of that sender's swaps, chain-wide, that
   * happened on this factory's pools. A router physically cannot swap another family's pools, so a genuine one
   * scores ~1.0; an aggregator, which routes everywhere, scores low. We also require it on several distinct
   * pools, so a sender that simply only ever touched one pool cannot masquerade as exclusive.
   */
  async routerCandidates(chainId: number, minSwaps = 50, minPools = 3, minExclusivity = 0.9): Promise<Array<{ factory: string; router: string; swaps: number; pools: number; exclusivity: number }>> {
    const r = await this.pool.query<{ factory: string; sender: string; swaps: string; pools_seen: number; exclusivity: string }>(
      `WITH totals AS (SELECT sender, sum(swaps) tot FROM router_evidence WHERE chain_id=$1 GROUP BY 1),
            ranked AS (
              SELECT re.factory, re.sender, re.swaps, re.pools_seen, (re.swaps::numeric / NULLIF(t.tot,0)) exclusivity,
                     row_number() OVER (PARTITION BY re.factory ORDER BY re.swaps DESC) rn
              FROM router_evidence re JOIN totals t ON t.sender=re.sender
              WHERE re.chain_id=$1
            )
       SELECT r.factory, r.sender, r.swaps::text, r.pools_seen, r.exclusivity::text
       FROM ranked r JOIN entities e ON e.chain_id=$1 AND e.address=r.factory AND e.kind='dex'
       WHERE r.rn=1 AND r.swaps >= $2 AND r.pools_seen >= $3 AND r.exclusivity >= $4 AND NOT (e.meta ? 'router')`,
      [chainId, minSwaps, minPools, minExclusivity]);
    return r.rows.map((x) => ({ factory: x.factory, router: x.sender, swaps: Number(x.swaps), pools: x.pools_seen, exclusivity: Number(x.exclusivity) }));
  }

  /** Merge FACTS onto a lending position's meta (size read from chain). Merge, never replace: the row also
   * carries oracle/irm/lltv written at discovery, and losing those would break the monitor's HF math. */
  async mergeLendingMeta(chainId: number, protocol: string, marketId: string, borrower: string, patch: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE lending_positions SET meta = COALESCE(meta, '{}'::jsonb) || $5::jsonb, updated_at=NOW()
       WHERE chain_id=$1 AND protocol=$2 AND market_id=$3 AND borrower=$4`,
      [chainId, protocol, marketId, borrower.toLowerCase(), JSON.stringify(patch)]);
  }

  /**
   * RESCHEDULE ONLY — advance when a position is next looked at, without touching WHAT it is.
   *
   * `setLendingTier` demands a tier, so a caller that merely wanted to postpone a row had to hand back the
   * tier it had READ, from a snapshot taken before the pass ran. That is a write-back of stale state: the
   * resolver would promote 9,117 positions out of `pending`, and the very next loop of the same tick would
   * write `pending` over them from its own stale copy. They were re-resolved for ever and never advanced.
   *
   * Rescheduling and classifying are different operations, so they are different methods now — a caller that
   * has not decided a tier can no longer accidentally assert one.
   */
  async rescheduleLendingPosition(chainId: number, protocol: string, marketId: string, borrower: string, nextCheckSec: number): Promise<void> {
    await this.pool.query(
      `UPDATE lending_positions SET last_checked_at=NOW(), next_check_at=NOW() + ($5 || ' seconds')::interval, updated_at=NOW()
       WHERE chain_id=$1 AND protocol=$2 AND market_id=$3 AND borrower=$4`,
      [chainId, protocol, marketId, borrower.toLowerCase(), String(Math.round(nextCheckSec))]
    );
  }

  /** Positions due for a re-check (next_check_at reached), soonest first. */
  async dueLendingPositions(chainId: number, limit = 60): Promise<Array<LendingPosition>> {
    const r = await this.pool.query(`SELECT * FROM lending_positions WHERE chain_id=$1 AND tier<>'closed' AND next_check_at<=NOW() ORDER BY next_check_at ASC LIMIT $2`, [chainId, limit]);
    return r.rows.map(rowToLendingPosition);
  }

  /** Record a check's result: tier, health, values, and the next scheduled check. */
  async setLendingTier(chainId: number, protocol: string, marketId: string, borrower: string, v: { tier: string; reason?: string | null; hf?: number | null; debtUsd?: number | null; collateralUsd?: number | null; exitUsd?: number | null; profitUsd?: number | null; nextCheckSec: number; hfFresh?: boolean }): Promise<void> {
    // hf_at advances ONLY when the HF value is genuinely fresh (enumerate) — so it measures TRUE HF
    // staleness, unlike updated_at which the tick touches while reusing the stale HF.
    await this.pool.query(
      // COALESCE the value columns: a partial update (e.g. reschedule, which passes only tier +
      // next-check) must PRESERVE the existing hf/debt/collateral/exit/profit/reason, not clobber them
      // to NULL. Only tier and the schedule always change. (Fix: reschedule was nulling watch rows' HF.)
      `UPDATE lending_positions SET tier=$5, reason=COALESCE($6, reason), hf=COALESCE($7, hf), debt_usd=COALESCE($8, debt_usd), collateral_usd=COALESCE($9, collateral_usd), exit_usd=COALESCE($10, exit_usd), profit_usd=COALESCE($12, profit_usd),
         hf_at = CASE WHEN $13 THEN NOW() ELSE hf_at END,
         last_checked_at=NOW(), next_check_at=NOW() + ($11 || ' seconds')::interval, updated_at=NOW()
       WHERE chain_id=$1 AND protocol=$2 AND market_id=$3 AND borrower=$4`,
      [chainId, protocol, marketId, borrower.toLowerCase(), v.tier, v.reason ?? null, v.hf ?? null, v.debtUsd ?? null, v.collateralUsd ?? null, v.exitUsd ?? null, String(Math.round(v.nextCheckSec)), v.profitUsd ?? null, v.hfFresh ?? false]
    );
  }

  /** One position, WHATEVER its tier — `closed` included.
   *
   * Every other reader deliberately excludes `closed`, which is right for deciding what to watch and wrong
   * for deciding what we lost: a liquidation on a position we had archived looked, to the miss detector, like
   * a liquidation of someone we had never heard of. That is how the counter said 3 while the chain said 83. */
  async lendingPositionAnyTier(chainId: number, protocol: string, marketId: string, borrower: string): Promise<LendingPosition | undefined> {
    const r = await this.pool.query(
      `SELECT * FROM lending_positions WHERE chain_id=$1 AND protocol=$2 AND lower(market_id)=lower($3) AND lower(borrower)=lower($4) LIMIT 1`,
      [chainId, protocol, marketId, borrower]
    );
    return r.rows.length ? rowToLendingPosition(r.rows[0]) : undefined;
  }

  /** Retire a position from the actionable set — liquidated (by anyone) or emptied. It stops being
   * watched/monitored (listLendingPositions/dueLendingPositions exclude tier='closed'). */
  async closeLendingPosition(chainId: number, protocol: string, marketId: string, borrower: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE lending_positions SET tier='closed', reason=$5, next_check_at=NOW() + interval '1 hour', updated_at=NOW()
       WHERE chain_id=$1 AND protocol=$2 AND market_id=$3 AND borrower=$4 AND tier <> 'closed'`,
      [chainId, protocol, marketId, borrower.toLowerCase(), reason]
    );
  }

  /** Age out orphans: positions still in an actionable tier (watch/profitable/candidate) that the last
   * enumerate(s) no longer returned — their market fell out of scope (e.g. unlisted) or they left the
   * enumeration window. Retiring them stops the monitor from watching frozen, stale positions. Returns
   * how many were retired. Never touches freshly-seen rows (enumerated_at is bumped only by enumerate). */
  /**
   * Positions the last enumerate(s) did not name — CANDIDATES for retirement, not a verdict.
   *
   * This used to be a single UPDATE that set tier='closed' outright. It was wrong in the most expensive way
   * available: the Morpho API not returning a position is a fact about the API, and we were reading it as a
   * fact about the debt. 10,712 positions were archived that way, 320 of them profitable by our own last
   * computation, and eleven were liquidated by someone else inside 72 hours while we had them filed as gone.
   *
   * The chain is what knows whether a debt exists. So this only ASKS, and the caller confirms on-chain
   * before anything terminal happens.
   */
  async staleActionableCandidates(chainId: number, olderThanSec: number, limit = 200): Promise<Array<LendingPosition>> {
    const r = await this.pool.query(
      `SELECT * FROM lending_positions
        WHERE chain_id=$1 AND tier IN ('watch','profitable','candidate')
          AND (enumerated_at IS NULL OR enumerated_at < NOW() - ($2 || ' seconds')::interval)
        ORDER BY debt_usd DESC NULLS LAST LIMIT $3`,
      [chainId, String(Math.round(olderThanSec)), limit]
    );
    return r.rows.map(rowToLendingPosition);
  }

  /** The positions archived by the old blind ageing rule — the ones `liq-recover` re-examines. */
  async positionsArchivedOnApiSilence(chainId: number): Promise<Array<LendingPosition>> {
    const r = await this.pool.query(
      `SELECT * FROM lending_positions WHERE chain_id=$1 AND tier='closed' AND reason LIKE '%aged out%' ORDER BY debt_usd DESC NULLS LAST`,
      [chainId]
    );
    return r.rows.map(rowToLendingPosition);
  }

  /** Put an archived-but-living position back, as `pending` with its CHAIN-read size. Not into an actionable
   * tier: what we still hold for it is stale, and `pending` is exactly the state meaning "known, unjudged" —
   * resolvePending then reads its health and classifies it. */
  async reopenLendingPosition(chainId: number, protocol: string, marketId: string, borrower: string, collateralRaw: string, borrowSharesRaw: string): Promise<void> {
    await this.pool.query(
      `UPDATE lending_positions
          SET tier='pending', reason='restored — archived on API silence, still borrowing on-chain',
              meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('collateralRaw',$5::text,'borrowShares',$6::text),
              next_check_at = NOW(), updated_at = NOW()
        WHERE chain_id=$1 AND protocol=$2 AND lower(market_id)=lower($3) AND lower(borrower)=lower($4) AND tier='closed'`,
      [chainId, protocol, marketId, borrower, collateralRaw, borrowSharesRaw]
    );
  }

  /** Keep an un-enumerated position in the actionable set, recording that the API stopped naming it.
   * It stays watched — only the chain may retire it. */
  async markUnenumerated(chainId: number, protocol: string, marketId: string, borrower: string, nextCheckSec: number): Promise<void> {
    await this.pool.query(
      `UPDATE lending_positions
          SET reason = CASE WHEN reason LIKE '%[API silente]%' THEN reason ELSE COALESCE(reason,'') || ' [API silente — confermata viva on-chain]' END,
              next_check_at = NOW() + ($5 || ' seconds')::interval, updated_at = NOW()
        WHERE chain_id=$1 AND protocol=$2 AND lower(market_id)=lower($3) AND lower(borrower)=lower($4)`,
      [chainId, protocol, marketId, borrower, String(Math.round(nextCheckSec))]
    );
  }

  async lendingTierCounts(chainId: number): Promise<Record<string, number>> {
    const r = await this.pool.query<{ tier: string; n: string }>(`SELECT tier, count(*)::text n FROM lending_positions WHERE chain_id=$1 GROUP BY tier`, [chainId]);
    const c: Record<string, number> = {}; for (const row of r.rows) c[row.tier] = Number(row.n); return c;
  }

  async listLendingPositions(chainId: number, opts: { tier?: string; limit?: number } = {}): Promise<Array<LendingPosition>> {
    const r = await this.pool.query(
      `SELECT * FROM lending_positions WHERE chain_id=$1 AND ($2::text IS NULL OR tier=$2) AND tier<>'closed' ORDER BY (hf IS NULL), hf ASC LIMIT $3`,
      [chainId, opts.tier ?? null, Math.min(opts.limit ?? 100, 300)]
    );
    return r.rows.map(rowToLendingPosition);
  }

  async listEntities(chainId: number, opts: { kind?: string; status?: string; limit?: number } = {}): Promise<Array<{ address: string; kind: string; symbol: string | null; name: string | null; note: string | null; status: string }>> {
    const r = await this.pool.query(
      `SELECT address, kind, symbol, name, note, status FROM entities WHERE chain_id=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR status=$3) ORDER BY updated_at DESC LIMIT $4`,
      [chainId, opts.kind ?? null, opts.status ?? null, opts.limit ?? 200]
    );
    return r.rows as never;
  }
  async setEntityNote(chainId: number, address: string, kind: string, note: string): Promise<boolean> {
    const r = await this.pool.query(`UPDATE entities SET note=$4, updated_at=NOW() WHERE chain_id=$1 AND address=$2 AND kind=$3`, [chainId, address.toLowerCase(), kind, note]);
    return (r.rowCount ?? 0) > 0;
  }
  async setEntityStatus(chainId: number, address: string, kind: string, status: string): Promise<boolean> {
    const r = await this.pool.query(`UPDATE entities SET status=$4, updated_at=NOW() WHERE chain_id=$1 AND address=$2 AND kind=$3`, [chainId, address.toLowerCase(), kind, status]);
    return (r.rowCount ?? 0) > 0;
  }

  // --- token dossier: security (system-authoritative), judgment history, our interaction ---------

  /** Persist the SECURITY facts onto the token entity (meta.security). The whole `security` object is
   * replaced on each (re)check — freshness lives in its `checkedAt`, never a stale merged blob. System-
   * authoritative: written only by the honeypot/verify path, not by free-text agent edits. */
  async setTokenSecurity(chainId: number, token: string, security: Record<string, unknown>): Promise<void> {
    await this.upsertEntity({ chainId, address: token, kind: "token", meta: { security }, source: "security-check" });
  }

  /** Append one of Scarlet's judgments on a token (timeline, never overwritten). */
  async addTokenAnnotation(chainId: number, token: string, verdict: string, note: string | null, tags: string[] = [], author = "scarlet"): Promise<void> {
    await this.pool.query(
      `INSERT INTO token_annotations(chain_id, token, verdict, note, tags, author) VALUES($1,$2,$3,$4,$5,$6)`,
      [chainId, token.toLowerCase(), verdict, note, tags, author]
    );
  }

  /** Scarlet's judgment history on a token, newest first. */
  async listTokenAnnotations(chainId: number, token: string, limit = 20): Promise<Array<{ at: string; verdict: string; note: string | null; tags: string[]; author: string }>> {
    const r = await this.pool.query<{ at: Date; verdict: string; note: string | null; tags: string[] | null; author: string }>(
      `SELECT at, verdict, note, tags, author FROM token_annotations WHERE chain_id=$1 AND token=$2 ORDER BY id DESC LIMIT $3`,
      [chainId, token.toLowerCase(), limit]
    );
    return r.rows.map((x) => ({ at: x.at.toISOString(), verdict: x.verdict, note: x.note, tags: x.tags ?? [], author: x.author }));
  }

  /** Our wallet's on-chain interactions with a specific token (how the system already touched it). */
  async walletActivityForToken(chainId: number, wallet: string, token: string, limit = 20): Promise<Array<{ txHash: string; blockNumber: string; direction: string; valueRaw: string; from: string; to: string; at: string }>> {
    const r = await this.pool.query<{ tx_hash: string; block_number: string; direction: string; value_raw: string; from_addr: string; to_addr: string; observed_at: Date }>(
      `SELECT tx_hash, block_number::text, direction, value_raw::text, from_addr, to_addr, observed_at
       FROM wallet_transactions WHERE chain_id=$1 AND wallet=$2 AND token=$3 ORDER BY block_number DESC, log_index DESC LIMIT $4`,
      [chainId, wallet.toLowerCase(), token.toLowerCase(), limit]
    );
    return r.rows.map((x) => ({ txHash: x.tx_hash, blockNumber: x.block_number, direction: x.direction, valueRaw: x.value_raw, from: x.from_addr, to: x.to_addr, at: x.observed_at.toISOString() }));
  }

  /** Persist externally-synced chain data (Blockscout etc.) onto the entity (meta.chain), replaced
   * wholesale on each sync — its `syncedAt` is the freshness clock so we read the cache and only re-sync
   * on demand. Written by the sync path, coexists with scanner/security meta via the top-level merge. */
  async setTokenChainData(chainId: number, token: string, chain: Record<string, unknown>): Promise<void> {
    await this.upsertEntity({ chainId, address: token, kind: "token", meta: { chain }, source: "sync" });
  }

  /** DB-side token search over the shared registry. Modes: recent (last discovered), symbol (ILIKE —
   * finds similar/redeploys), verdict (tokens whose LATEST judgment = verdict), most_pools (in most pools). */
  async searchTokens(chainId: number, opts: { mode: "recent" | "symbol" | "verdict" | "most_pools"; query?: string; verdict?: string; limit?: number }): Promise<Array<{ address: string; symbol: string | null; name: string | null; verified: boolean | null; poolCount?: number; verdict?: string; at?: string }>> {
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 50);
    const map = (rows: Array<Record<string, unknown>>) => rows.map((r) => ({
      address: r.address as string, symbol: (r.symbol as string) ?? null, name: (r.name as string) ?? null,
      verified: r.verified == null ? null : r.verified === "true" || r.verified === true,
      ...(r.pool_count != null ? { poolCount: Number(r.pool_count) } : {}),
      ...(r.verdict != null ? { verdict: r.verdict as string } : {}),
      ...(r.at != null ? { at: (r.at as Date).toISOString?.() ?? String(r.at) } : {})
    }));
    if (opts.mode === "symbol") {
      const r = await this.pool.query(`SELECT address, symbol, name, meta->>'verified' AS verified, created_at AS at FROM entities WHERE chain_id=$1 AND kind='token' AND symbol ILIKE $2 ORDER BY created_at DESC LIMIT $3`, [chainId, `%${(opts.query ?? "").trim()}%`, limit]);
      return map(r.rows);
    }
    if (opts.mode === "verdict") {
      const r = await this.pool.query(`
        SELECT e.address, e.symbol, e.name, e.meta->>'verified' AS verified, lv.verdict, lv.at
        FROM (SELECT DISTINCT ON (token) token, verdict, at FROM token_annotations WHERE chain_id=$1 ORDER BY token, id DESC) lv
        JOIN entities e ON e.chain_id=$1 AND e.address=lv.token AND e.kind='token'
        WHERE lv.verdict=$2 ORDER BY lv.at DESC LIMIT $3`, [chainId, opts.verdict ?? "", limit]);
      return map(r.rows);
    }
    if (opts.mode === "most_pools") {
      const r = await this.pool.query(`
        SELECT e.address, e.symbol, e.name, e.meta->>'verified' AS verified, p.cnt AS pool_count
        FROM (SELECT tok, count(*) cnt FROM (
                SELECT meta->>'token0' AS tok FROM entities WHERE chain_id=$1 AND kind='pool' AND meta ? 'token0'
                UNION ALL SELECT meta->>'token1' FROM entities WHERE chain_id=$1 AND kind='pool' AND meta ? 'token1'
             ) u WHERE tok IS NOT NULL GROUP BY tok) p
        JOIN entities e ON e.chain_id=$1 AND e.address=p.tok AND e.kind='token'
        ORDER BY p.cnt DESC LIMIT $2`, [chainId, limit]);
      return map(r.rows);
    }
    const r = await this.pool.query(`SELECT address, symbol, name, meta->>'verified' AS verified, created_at AS at FROM entities WHERE chain_id=$1 AND kind='token' ORDER BY created_at DESC LIMIT $2`, [chainId, limit]);
    return map(r.rows);
  }

  // --- block indexer: cursor, raw-block retention, pool lookup -----------------

  async getIndexerCursor(chainId: number): Promise<number | null> {
    const r = await this.pool.query<{ last_block: string }>(`SELECT last_block::text FROM indexer_state WHERE chain_id=$1`, [chainId]);
    return r.rows[0] ? Number(r.rows[0].last_block) : null;
  }
  async setIndexerCursor(chainId: number, block: number): Promise<void> {
    await this.pool.query(`INSERT INTO indexer_state(chain_id, last_block) VALUES($1,$2) ON CONFLICT (chain_id) DO UPDATE SET last_block=$2, updated_at=NOW()`, [chainId, block]);
  }
  /** Age (ms) of the indexer cursor's last advance — the true "is our data source live" signal (the
   * indexer, on base.org, is the single source of truth; the legacy dual-RPC ping is not). null if unseeded. */
  async indexerCursorAgeMs(chainId: number): Promise<number | null> {
    const r = await this.pool.query<{ age: string }>(`SELECT (EXTRACT(EPOCH FROM (NOW()-updated_at))*1000)::bigint::text AS age FROM indexer_state WHERE chain_id=$1`, [chainId]);
    return r.rows[0] ? Number(r.rows[0].age) : null;
  }
  /** DB-first freshness telemetry. WRITER = BlockIndexer ONLY. The read-side reads this instead of ever
   * calling getBlockNumber() to compute lag. Separate from the cursor (indexer_state). */
  async upsertChainStatus(s: { chainId: number; indexedBlock: number; networkHead: number; synced: boolean }): Promise<void> {
    const lag = Math.max(0, s.networkHead - s.indexedBlock);
    await this.pool.query(
      `INSERT INTO chain_status(chain_id, indexed_block, network_head_seen, lag_blocks, synced) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (chain_id) DO UPDATE SET indexed_block=$2, network_head_seen=$3, lag_blocks=$4, synced=$5, updated_at=NOW()`,
      [s.chainId, s.indexedBlock, s.networkHead, lag, s.synced]
    );
  }
  /** Read-side freshness gate source: {indexedBlock, networkHead, lag, synced, ageMs}. null if unseeded. */
  async getChainStatus(chainId: number): Promise<{ indexedBlock: number; networkHead: number; lag: number; synced: boolean; ageMs: number } | null> {
    const r = await this.pool.query<{ indexed_block: string; network_head_seen: string; lag_blocks: string; synced: boolean; age: string }>(
      `SELECT indexed_block::text, network_head_seen::text, lag_blocks::text, synced, (EXTRACT(EPOCH FROM (NOW()-updated_at))*1000)::bigint::text AS age FROM chain_status WHERE chain_id=$1`, [chainId]
    );
    const row = r.rows[0];
    return row ? { indexedBlock: Number(row.indexed_block), networkHead: Number(row.network_head_seen), lag: Number(row.lag_blocks), synced: row.synced, ageMs: Number(row.age) } : null;
  }

  /** DB-first gas (Item 4). WRITER = a write-side poller (the enricher). The read-side reads this instead of
   * ever calling getGasPrice(). */
  async upsertGasState(chainId: number, gasPriceWei: bigint): Promise<void> {
    await this.pool.query(
      `INSERT INTO gas_state(chain_id, gas_price_wei) VALUES($1,$2)
       ON CONFLICT (chain_id) DO UPDATE SET gas_price_wei=$2, updated_at=NOW()`, [chainId, gasPriceWei.toString()]
    );
  }
  /** Read-side gas source: {gasPriceWei, ageMs}. null if never polled. */
  async getGasState(chainId: number): Promise<{ gasPriceWei: bigint; ageMs: number } | null> {
    const r = await this.pool.query<{ gas: string; age: string }>(
      `SELECT gas_price_wei::text AS gas, (EXTRACT(EPOCH FROM (NOW()-updated_at))*1000)::bigint::text AS age FROM gas_state WHERE chain_id=$1`, [chainId]
    );
    const row = r.rows[0];
    return row ? { gasPriceWei: BigInt(row.gas.split(".")[0]), ageMs: Number(row.age) } : null;
  }

  /** Persist/refresh a KG candidate (Item 4.3). Same (detector, route) → one row whose lifecycle grows:
   * first_seen_block is preserved, last_seen_block/seen_count/peak advance, current metrics overwrite. */
  async upsertCandidate(c: { chainId: number; ckey: string; detector: string; numeraire: string; route: string; pools: string[]; amountIn: bigint; grossUsd: number | null; gasUnits: bigint; gasUsd: number | null; netUsd: number | null; simulationExact: boolean; executable: boolean; rejectionReason?: string; block: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO kg_candidates(chain_id, ckey, detector, numeraire, route, pools, amount_in, gross_usd, gas_units, gas_usd, net_usd, simulation_exact, executable, rejection_reason, first_seen_block, last_seen_block, seen_count, peak_net_usd)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,1,$11)
       ON CONFLICT (chain_id, ckey) DO UPDATE SET
         amount_in=$7, gross_usd=$8, gas_units=$9, gas_usd=$10, net_usd=$11,
         simulation_exact=$12, executable=$13, rejection_reason=$14,
         last_seen_block=$15, seen_count=kg_candidates.seen_count+1,
         peak_net_usd=GREATEST(kg_candidates.peak_net_usd, COALESCE($11,-1e9)), updated_at=NOW()`,
      [c.chainId, c.ckey, c.detector, c.numeraire, c.route, c.pools, c.amountIn.toString(), c.grossUsd, c.gasUnits.toString(), c.gasUsd, c.netUsd, c.simulationExact, c.executable, c.rejectionReason ?? null, c.block]
    );
  }
  /** Top candidates for the shadow-preflight pass / reporting (Item 4.4), ranked by net USD. */
  async topCandidates(chainId: number, limit = 20, executableOnly = false): Promise<Array<{ ckey: string; detector: string; numeraire: string; route: string; pools: string[]; amountIn: bigint; netUsd: number | null; grossUsd: number | null; simulationExact: boolean; executable: boolean; seenCount: number; firstSeenBlock: number; lastSeenBlock: number; peakNetUsd: number | null }>> {
    const r = await this.pool.query<{ ckey: string; detector: string; numeraire: string; route: string; pools: string[]; amount_in: string; net_usd: number | null; gross_usd: number | null; simulation_exact: boolean; executable: boolean; seen_count: number; first_seen_block: string; last_seen_block: string; peak_net_usd: number | null }>(
      `SELECT ckey, detector, numeraire, route, pools, amount_in::text, net_usd, gross_usd, simulation_exact, executable, seen_count, first_seen_block::text, last_seen_block::text, peak_net_usd
       FROM kg_candidates WHERE chain_id=$1 ${executableOnly ? "AND executable=true" : ""} ORDER BY net_usd DESC NULLS LAST LIMIT $2`, [chainId, limit]
    );
    return r.rows.map((x) => ({ ckey: x.ckey, detector: x.detector, numeraire: x.numeraire, route: x.route, pools: x.pools, amountIn: BigInt(x.amount_in.split(".")[0]), netUsd: x.net_usd, grossUsd: x.gross_usd, simulationExact: x.simulation_exact, executable: x.executable, seenCount: x.seen_count, firstSeenBlock: Number(x.first_seen_block), lastSeenBlock: Number(x.last_seen_block), peakNetUsd: x.peak_net_usd }));
  }
  async setCandidatePreflight(chainId: number, ckey: string, status: string, block: number, fingerprint?: string): Promise<void> {
    await this.pool.query(`UPDATE kg_candidates SET preflight_status=$3, preflight_block=$4, preflight_fingerprint=COALESCE($5,preflight_fingerprint), updated_at=NOW() WHERE chain_id=$1 AND ckey=$2`, [chainId, ckey, status, block, fingerprint ?? null]);
  }
  /** Preflight dedup source: the state signature + result of a candidate's LAST preflight (Item 5). */
  async getCandidatePreflightMeta(chainId: number, ckey: string): Promise<{ fingerprint: string | null; status: string | null; block: number | null } | null> {
    const r = await this.pool.query<{ preflight_fingerprint: string | null; preflight_status: string | null; preflight_block: string | null }>(`SELECT preflight_fingerprint, preflight_status, preflight_block::text FROM kg_candidates WHERE chain_id=$1 AND ckey=$2`, [chainId, ckey]);
    const row = r.rows[0];
    return row ? { fingerprint: row.preflight_fingerprint, status: row.preflight_status, block: row.preflight_block ? Number(row.preflight_block) : null } : null;
  }
  /** Record the per-cycle snapshot (Item 6 Reality Score source). */
  async recordObserverRun(r: { chainId: number; block: number; durationMs: number; poolsPriced: number; multiVenuePairs: number; sized: number; economic: number; economicallyPositive: number; routeEncodable: number; executable: number; preflightAttempted: number; preflightPass: number; detectors: unknown; stats: unknown }): Promise<void> {
    await this.pool.query(
      `INSERT INTO kg_observer_runs(chain_id, block, duration_ms, pools_priced, multi_venue_pairs, sized, economic, economically_positive, route_encodable, executable, preflight_attempted, preflight_pass, detectors, stats)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [r.chainId, r.block, r.durationMs, r.poolsPriced, r.multiVenuePairs, r.sized, r.economic, r.economicallyPositive, r.routeEncodable, r.executable, r.preflightAttempted, r.preflightPass, JSON.stringify(r.detectors), JSON.stringify(r.stats)]
    );
  }
  /** Append the time-series observation of each candidate at this block (Item 5). One row per (ckey, block). */
  async recordObservations(chainId: number, block: number, rows: Array<{ ckey: string; detector: string; netUsd: number | null; grossUsd: number | null; executable: boolean; simulationExact: boolean; rejectionReason?: string; preflightStatus?: string }>): Promise<void> {
    if (!rows.length) return;
    const vals: unknown[] = []; const chunks: string[] = [];
    rows.forEach((o, i) => { const b = i * 9; chunks.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`); vals.push(chainId, o.ckey, block, o.detector, o.netUsd, o.grossUsd, o.executable, o.simulationExact, o.rejectionReason ?? null); });
    await this.pool.query(
      `INSERT INTO kg_candidate_observations(chain_id, ckey, block, detector, net_usd, gross_usd, executable, simulation_exact, rejection_reason) VALUES ${chunks.join(",")}
       ON CONFLICT (chain_id, ckey, block) DO NOTHING`, vals
    );
  }
  /** SINGLE-INSTANCE lease (Item 7): a DB lease with TTL. The observer calls this each loop (heartbeat); only
   * the owner whose lease is current processes blocks, so restart/overlap never double-counts, and a standby
   * instance takes over TTL seconds after the holder dies. Deterministic (no pooled-connection subtleties). */
  async acquireObserverLease(chainId: number, owner: string, ttlSec: number): Promise<boolean> {
    const r = await this.pool.query<{ owner: string }>(
      `INSERT INTO kg_observer_lease(chain_id, owner, expires_at) VALUES($1,$2, now() + make_interval(secs => $3))
       ON CONFLICT (chain_id) DO UPDATE SET owner=$2, expires_at=now() + make_interval(secs => $3)
         WHERE kg_observer_lease.expires_at < now() OR kg_observer_lease.owner=$2
       RETURNING owner`, [chainId, owner, ttlSec]
    );
    return r.rows.length > 0 && r.rows[0].owner === owner;
  }

  async setObservationPreflight(chainId: number, ckey: string, block: number, status: string): Promise<void> {
    await this.pool.query(`UPDATE kg_candidate_observations SET preflight_status=$4 WHERE chain_id=$1 AND ckey=$2 AND block=$3`, [chainId, ckey, block, status]);
  }
  /** Watch-tier positions WITH raw amounts (Item A/a1) — the size-specific liquidation-capture analysis needs
   * collateralRaw/debtRaw + decimals + lltv, not just the USD summaries. */
  async positionsForCapture(chainId: number, tier = "watch"): Promise<Array<{ marketId: string; borrower: string; collateral: string; collateralSymbol: string | null; loan: string; loanSymbol: string | null; hf: number | null; collateralUsd: number | null; debtUsd: number | null; lltv: bigint | null; collateralRaw: bigint | null; collateralDec: number | null; debtRaw: bigint | null; loanDec: number | null }>> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT market_id, borrower, collateral_token, collateral_symbol, loan_token, loan_symbol, hf::float8 hf,
              collateral_usd::float8 collateral_usd, debt_usd::float8 debt_usd,
              meta->>'lltv' lltv, meta->>'collateralRaw' craw, meta->>'collateralDecimals' cdec,
              meta->>'debtRaw' draw, meta->>'loanDecimals' ldec
       FROM lending_positions WHERE chain_id=$1 AND tier=$2 AND collateral_token IS NOT NULL AND loan_token IS NOT NULL`,
      [chainId, tier]
    );
    const big = (v: unknown) => (v == null ? null : BigInt(String(v).split(".")[0]));
    const num = (v: unknown) => (v == null ? null : Number(v));
    return r.rows.map((x) => ({
      marketId: String(x.market_id), borrower: String(x.borrower),
      collateral: String(x.collateral_token).toLowerCase(), collateralSymbol: x.collateral_symbol as string | null,
      loan: String(x.loan_token).toLowerCase(), loanSymbol: x.loan_symbol as string | null,
      hf: x.hf as number | null, collateralUsd: x.collateral_usd as number | null, debtUsd: x.debt_usd as number | null,
      lltv: big(x.lltv), collateralRaw: big(x.craw), collateralDec: num(x.cdec), debtRaw: big(x.draw), loanDec: num(x.ldec),
    }));
  }

  /**
   * HEALTH SNAPSHOT — everything a human needs to SEE the system's real state, in one DB-only bundle. Built
   * from the failures this project actually hit: a buffer that reported 18 items while 10k entities were
   * incomplete, pools burned into enrich_failed by a flaky lane, 2.5% tick certification, numbers shown
   * without their trustworthiness. Every section answers "what is missing / what is wrong / how do I find it".
   */
  /**
   * CACHED + SINGLE-FLIGHT. This snapshot is a dashboard view built from a dozen full aggregates over every
   * pool and token. Uncached it is a live hazard, not a slow page: four of these running concurrently
   * saturated the database and pushed the indexer's own writes into WALSync/WALWrite waits, cutting it from
   * 0.5 blocks/s to 0.05 — the indexer fell behind because a monitoring view was too expensive to look at.
   * Refresh cadence is what the observer needs, not what a browser asks for, and overlapping callers share
   * ONE in-flight computation instead of each starting their own.
   */
  private healthCache?: { at: number; data: Record<string, unknown> };
  private healthInFlight?: Promise<Record<string, unknown>>;
  async healthSnapshot(chainId: number): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.healthCache && now - this.healthCache.at < 30_000) return this.healthCache.data;
    if (this.healthInFlight) return this.healthInFlight;
    this.healthInFlight = this.computeHealthSnapshot(chainId)
      .then((d) => { this.healthCache = { at: Date.now(), data: d }; return d; })
      .finally(() => { this.healthInFlight = undefined; });
    return this.healthInFlight;
  }

  private async computeHealthSnapshot(chainId: number): Promise<Record<string, unknown>> {
    const q = async (sql: string, params: unknown[] = []) => (await this.pool.query(sql, params)).rows as Array<Record<string, unknown>>;
    const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0] ?? {};

    // 1) DATA COMPLETENESS — per archetype, exactly which mandatory field is missing.
    // `fee_applies` / `spacing_applies`: a constant-product pool has NO per-pool fee (it is a protocol
    // constant) and NO tickSpacing. Reporting those as "missing" invents thousands of phantom gaps and makes
    // the real ones invisible — the view must distinguish NOT-APPLICABLE from MISSING.
    // A DYNAMIC fee is not a missing one. V4 pools whose fee is hook-controlled deliberately carry no static
    // meta.fee — the real value is per-swap and lives in pool_state.fee_ppm — so counting them as gaps
    // reported 16,095 phantom holes and pushed V4 completeness to 43%. A completeness view that invents gaps
    // is as misleading as one that hides them: it sends you to fix data that is already correct.
    const completeness = await q(
      `SELECT COALESCE(meta->>'archetype','(none)') archetype, count(*)::int total,
              (COALESCE(meta->>'archetype','') IN ('v3','slipstream')) fee_applies,
              (COALESCE(meta->>'archetype','') IN ('v3','v4','slipstream','algebra')) spacing_applies,
              count(*) FILTER (WHERE meta->>'token0' IS NULL)::int missing_token0,
              count(*) FILTER (WHERE meta->>'fee' IS NULL AND (meta->>'dynamicFee') IS DISTINCT FROM 'true')::int missing_fee,
              count(*) FILTER (WHERE (meta->>'dynamicFee') = 'true')::int dynamic_fee,
              count(*) FILTER (WHERE meta->>'tickSpacing' IS NULL)::int missing_spacing,
              count(*) FILTER (WHERE meta->>'factory' IS NULL)::int missing_factory,
              count(*) FILTER (WHERE enrich_pending)::int pending,
              count(*) FILTER (WHERE enrich_failed)::int failed,
              -- COMPLETE = every field that APPLIES to this archetype is present. Showing progress, not only
              -- gaps: "8945/8951 complete" tells you the pipeline is winning; a gap count alone never does.
              count(*) FILTER (WHERE (meta->>'token0') IS NOT NULL AND (meta->>'token1') IS NOT NULL
                AND ((meta->>'fee') IS NOT NULL OR (meta->>'dynamicFee') = 'true'
                     OR COALESCE(meta->>'archetype','') NOT IN ('v3','slipstream'))
                AND (COALESCE(meta->>'archetype','') NOT IN ('v3','v4','slipstream','algebra')
                     OR (meta->>'tickSpacing') IS NOT NULL))::int complete
       FROM entities WHERE chain_id=$1 AND kind='pool' GROUP BY 1,3,4 ORDER BY total DESC`, [chainId]);
    // WHY an entity cannot be completed. A datum the chain genuinely refuses (the contract does not expose the
    // function) is a bounded, knowable gap — but only if it is NAMED. Left as a bare "failed" count it looks
    // like a pipeline defect; named, it is a fact about those contracts that a human can act on.
    const blocked = await q(
      `SELECT COALESCE(meta->>'archetype','(none)') archetype,
              (SELECT string_agg(v, ',' ORDER BY v) FROM jsonb_array_elements_text(meta->'enrichBlockedBy') v) fields,
              count(*)::int pools, bool_or(enrich_failed) any_failed
       -- jsonb_typeof, not just key-presence: a key holding anything other than an array (a null left by a
       -- clear, say) makes jsonb_array_elements_text raise, and because this runs inside ONE health snapshot
       -- a single malformed row blanked every panel on the page. A diagnostic view must degrade, never fail.
       FROM entities WHERE chain_id=$1 AND kind='pool' AND jsonb_typeof(meta->'enrichBlockedBy') = 'array'
       GROUP BY 1,2 ORDER BY pools DESC LIMIT 12`, [chainId]);
    // Protocol-level fee coverage: for CP pools the fee lives on the FACTORY, so completeness is measured there.
    const protocolFees = await q(
      `SELECT COALESCE(e.meta->>'factory','(none)') factory, COALESCE(e.meta->>'archetype','?') archetype, count(*)::int pools,
              (f.meta->>'feePpm') fee_ppm, (f.meta->>'feeSource') fee_source
       FROM entities e LEFT JOIN entities f ON f.chain_id=e.chain_id AND f.address=e.meta->>'factory' AND f.kind='dex'
       WHERE e.chain_id=$1 AND e.kind='pool' AND COALESCE(e.meta->>'archetype','') IN ('v2','aerodrome','aerodrome-stable','solidly')
       GROUP BY 1,2,4,5 ORDER BY pools DESC LIMIT 15`, [chainId]);
    const tokens = await one(
      `SELECT count(*)::int total, count(*) FILTER (WHERE decimals IS NULL)::int missing_decimals,
              count(*) FILTER (WHERE symbol IS NULL)::int missing_symbol,
              count(*) FILTER (WHERE decimals IS NOT NULL)::int have_decimals,
              count(*) FILTER (WHERE symbol IS NOT NULL)::int have_symbol,
              count(*) FILTER (WHERE enrich_pending)::int pending, count(*) FILTER (WHERE enrich_failed)::int failed
       FROM entities WHERE chain_id=$1 AND kind='token'`, [chainId]);

    // 2) ENRICHMENT BUFFER — depth, what's stuck, and whether it is actually moving.
    const buffer = await one(
      `SELECT count(*) FILTER (WHERE enrich_pending AND NOT enrich_failed)::int in_buffer,
              count(*) FILTER (WHERE enrich_failed)::int failed,
              count(*) FILTER (WHERE enrich_resync AND enrich_pending AND NOT enrich_failed)::int resync_outstanding,
              count(*) FILTER (WHERE enrich_pending AND enrich_attempts > 0)::int with_attempts,
              max(enrich_attempts)::int max_attempts,
              count(*) FILTER (WHERE updated_at > now() - interval '2 min')::int written_last_2min
       FROM entities WHERE chain_id=$1`, [chainId]);

    // 3) TICK CERTIFICATION — the gate on every size-dependent number, by protocol.
    const ticks = await q(
      `SELECT COALESCE(e.meta->>'factory','(none)') factory, count(*)::int pools,
              count(*) FILTER (WHERE pts.complete)::int certified,
              count(*) FILTER (WHERE pts.status='failed')::int failed
       FROM entities e LEFT JOIN pool_tick_status pts ON pts.chain_id=e.chain_id AND pts.pool=e.address
       WHERE e.chain_id=$1 AND e.kind='pool' AND e.meta->>'archetype' IN ('v3','v4','slipstream')
       GROUP BY 1 ORDER BY pools DESC LIMIT 12`, [chainId]);
    const tickErrors = await q(
      `SELECT COALESCE(last_error,'(none)') reason, count(*)::int n FROM pool_tick_status
       WHERE chain_id=$1 AND status='failed' GROUP BY 1 ORDER BY n DESC LIMIT 8`, [chainId]);

    // 4) PIPELINE — indexer freshness/coverage, gas freshness. A stale mirror invalidates every decision.
    const chain = await one(`SELECT indexed_block::text, network_head_seen::text, lag_blocks::int, synced, (EXTRACT(EPOCH FROM (now()-updated_at))*1000)::bigint::text age_ms FROM chain_status WHERE chain_id=$1`, [chainId]);
    const coverage = await one(`SELECT coverage_start::text, continuous_through::text, generation FROM indexer_coverage WHERE chain_id=$1`, [chainId]);
    const gaps = await q(`SELECT from_block::text, to_block::text, reason, repaired_at FROM indexer_gaps WHERE chain_id=$1 ORDER BY from_block DESC LIMIT 5`, [chainId]);
    const gas = await one(`SELECT gas_price_wei::text, (EXTRACT(EPOCH FROM (now()-updated_at))*1000)::bigint::text age_ms FROM gas_state WHERE chain_id=$1`, [chainId]);
    const poolState = await one(`SELECT count(*)::int total, count(*) FILTER (WHERE updated_at > now() - interval '5 min')::int fresh_5min FROM pool_state WHERE chain_id=$1`, [chainId]);

    // 5) KG ECONOMICS — with the quality flags, so a number is never read without its trustworthiness.
    const kg = await one(
      `SELECT (SELECT count(*)::int FROM kg_candidates WHERE chain_id=$1) candidates,
              (SELECT count(*)::int FROM kg_candidates WHERE chain_id=$1 AND executable) executable,
              (SELECT count(*)::int FROM kg_candidates WHERE chain_id=$1 AND simulation_exact) exact,
              (SELECT count(*)::int FROM kg_candidates WHERE chain_id=$1 AND preflight_status='pass') preflight_pass,
              (SELECT count(*)::int FROM kg_signals WHERE chain_id=$1) signals,
              (SELECT count(*)::int FROM kg_observer_runs WHERE chain_id=$1) observer_runs,
              (SELECT count(*)::int FROM kg_surface_runs WHERE chain_id=$1) surface_runs`, [chainId]).catch(() => ({}));
    const lastRun = await one(`SELECT block::text, duration_ms, sized, executable, preflight_pass, (EXTRACT(EPOCH FROM (now()-created_at))*1000)::bigint::text age_ms FROM kg_observer_runs WHERE chain_id=$1 ORDER BY created_at DESC LIMIT 1`, [chainId]).catch(() => ({}));
    // CACHED: this aggregates every pool row by factory (JSONB, no index). The dashboard polls every 15s, and
    // running it that often competed with the indexer's writes for the same table. Factory→router coverage
    // changes on the order of hours, so a 5-minute cache costs nothing and keeps the hot path free.
    const now = Date.now();
    if (!this.execCovCache || now - this.execCovCache.at > 300_000) {
      this.execCovCache = { at: now, rows: await this.executionCoverage(chainId).catch(() => []) };
    }
    const execCoverage = this.execCovCache.rows;
    const lending = await q(`SELECT tier, count(*)::int n, round(sum(debt_usd)::numeric,0)::text debt_usd FROM lending_positions WHERE chain_id=$1 GROUP BY 1 ORDER BY n DESC`, [chainId]).catch(() => []);

    return { completeness, blocked, protocolFees, execCoverage, tokens, buffer, ticks, tickErrors, chain, coverage, gaps, gas, poolState, kg, lastRun, lending, now: new Date().toISOString() };
  }

  /** Coverage census: the deepest live pool of each concentrated factory (V3-family AND V4), so a capability
   * probe can prove there is no protocol on the chain we cannot read. */
  async topPoolPerFactory(chainId: number, limit = 20): Promise<Array<{ factory: string; archetype: string; pool: string; pools: number; fee: number | null; tickSpacing: number | null }>> {
    const r = await this.pool.query<Record<string, unknown>>(
      `WITH c AS (
         SELECT e.meta->>'factory' factory, e.meta->>'archetype' arch, e.address, ps.liquidity,
                (e.meta->>'fee')::numeric fee, (e.meta->>'tickSpacing')::numeric ts,
                count(*) OVER (PARTITION BY e.meta->>'factory') n,
                row_number() OVER (PARTITION BY e.meta->>'factory' ORDER BY ps.liquidity DESC NULLS LAST) rn
         FROM entities e JOIN pool_state ps ON ps.chain_id=e.chain_id AND ps.pool=e.address
         WHERE e.chain_id=$1 AND e.kind='pool' AND e.meta->>'archetype' IN ('v3','v4','slipstream')
           AND e.meta->>'factory' IS NOT NULL AND ps.liquidity > 0)
       SELECT factory, arch, address, n, fee, ts FROM c WHERE rn=1 ORDER BY n DESC LIMIT $2`, [chainId, limit]
    );
    return r.rows.map((x) => ({ factory: String(x.factory), archetype: String(x.arch), pool: String(x.address), pools: Number(x.n), fee: x.fee == null ? null : Number(x.fee), tickSpacing: x.ts == null ? null : Number(x.ts) }));
  }

  /** REALITY SCORE (Item 6) — per-detector aggregate over the candidate lifecycle table. */
  async realityByDetector(chainId: number): Promise<Array<{ detector: string; candidates: number; executable: number; netPositive: number; exact: number; preflightPass: number; behaviorMismatch: number; profitMoved: number; encodeUnsupported: number; medianNet: number | null; p95Net: number | null; maxNet: number | null; medianLifetime: number | null; p95Lifetime: number | null; maxSeen: number }>> {
    const r = await this.pool.query(
      `SELECT detector,
        count(*)::int candidates,
        count(*) filter(where executable)::int executable,
        count(*) filter(where net_usd>0)::int net_positive,
        count(*) filter(where simulation_exact)::int exact,
        count(*) filter(where preflight_status='pass')::int preflight_pass,
        count(*) filter(where preflight_status like '%BEHAVIOR_MISMATCH%')::int behavior_mismatch,
        count(*) filter(where preflight_status='PROFIT_MOVED')::int profit_moved,
        count(*) filter(where preflight_status='ENCODE_UNSUPPORTED')::int encode_unsupported,
        percentile_cont(0.5) within group(order by net_usd) filter(where net_usd>0) median_net,
        percentile_cont(0.95) within group(order by net_usd) filter(where net_usd>0) p95_net,
        max(net_usd) max_net,
        percentile_cont(0.5) within group(order by (last_seen_block-first_seen_block)) median_lifetime,
        percentile_cont(0.95) within group(order by (last_seen_block-first_seen_block)) p95_lifetime,
        max(seen_count)::int max_seen
       FROM kg_candidates WHERE chain_id=$1 GROUP BY detector ORDER BY detector`, [chainId]
    );
    return r.rows.map((x: Record<string, unknown>) => ({ detector: x.detector as string, candidates: x.candidates as number, executable: x.executable as number, netPositive: x.net_positive as number, exact: x.exact as number, preflightPass: x.preflight_pass as number, behaviorMismatch: x.behavior_mismatch as number, profitMoved: x.profit_moved as number, encodeUnsupported: x.encode_unsupported as number, medianNet: x.median_net as number | null, p95Net: x.p95_net as number | null, maxNet: x.max_net as number | null, medianLifetime: x.median_lifetime as number | null, p95Lifetime: x.p95_lifetime as number | null, maxSeen: x.max_seen as number }));
  }
  /** Persist a surface run (Item 7). Returns the run id so points can reference it. */
  async recordSurfaceRun(r: { chainId: number; block: number; kind: string; target: string; numeraire?: string; modelVersion: string; venues?: number; crossovers?: number; optimalSize?: bigint | null; maxPnl?: bigint; economicBest?: bigint | null; executableBest?: bigint | null; executionGap?: bigint | null }): Promise<number> {
    const q = await this.pool.query<{ id: string }>(
      `INSERT INTO kg_surface_runs(chain_id, block, kind, target, numeraire, model_version, venues, crossovers, optimal_size, max_pnl, economic_best, executable_best, execution_gap)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [r.chainId, r.block, r.kind, r.target, r.numeraire ?? null, r.modelVersion, r.venues ?? null, r.crossovers ?? null, r.optimalSize?.toString() ?? null, r.maxPnl?.toString() ?? null, r.economicBest?.toString() ?? null, r.executableBest?.toString() ?? null, r.executionGap?.toString() ?? null]
    );
    return Number(q.rows[0].id);
  }
  async recordSurfacePoints(runId: number, pts: Array<{ amountIn: bigint; economicOut?: bigint | null; executableOut?: bigint | null; economicPath?: string[]; executablePath?: string[] | null; exact?: boolean; encodable?: boolean; clean?: boolean; executionGap?: bigint | null; dominantBuy?: string | null; dominantSell?: string | null; spreadBps?: number | null }>): Promise<void> {
    if (!pts.length) return;
    const vals: unknown[] = []; const chunks: string[] = [];
    pts.forEach((p, i) => { const b = i * 13; chunks.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13})`); vals.push(runId, p.amountIn.toString(), p.economicOut?.toString() ?? null, p.executableOut?.toString() ?? null, p.economicPath ?? null, p.executablePath ?? null, p.exact ?? null, p.encodable ?? null, p.clean ?? null, p.executionGap?.toString() ?? null, p.dominantBuy ?? null, p.dominantSell ?? null, p.spreadBps ?? null); });
    await this.pool.query(
      `INSERT INTO kg_surface_points(run_id, amount_in, economic_out, executable_out, economic_path, executable_path, exact, encodable, clean, execution_gap, dominant_buy, dominant_sell, spread_bps) VALUES ${chunks.join(",")}`, vals
    );
  }
  /** Economic-anomaly signal lifecycle (Item 7 step 6) — same-key updates grow first/last/peak. */
  async upsertSignal(s: { chainId: number; skey: string; kind: string; asset: string; numeraire: string; economicUsd: number | null; executableUsd: number | null; executionGapUsd: number; refSize: bigint; block: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO kg_signals(chain_id, skey, kind, asset, numeraire, economic_usd, executable_usd, execution_gap_usd, ref_size, first_seen_block, last_seen_block, seen_count, peak_gap_usd)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,1,$8)
       ON CONFLICT (chain_id, skey) DO UPDATE SET economic_usd=$6, executable_usd=$7, execution_gap_usd=$8, ref_size=$9, last_seen_block=$10, seen_count=kg_signals.seen_count+1, peak_gap_usd=GREATEST(kg_signals.peak_gap_usd, $8), updated_at=NOW()`,
      [s.chainId, s.skey, s.kind, s.asset, s.numeraire, s.economicUsd, s.executableUsd, s.executionGapUsd, s.refSize.toString(), s.block]
    );
  }
  async surfaceRealitySummary(chainId: number): Promise<{ pairRuns: number; exitRuns: number; targetsPair: number; targetsExit: number; signals: number; medianGap: number | null; p95Gap: number | null; maxGap: number | null; avgCrossovers: number | null }> {
    const r = await this.pool.query(
      `SELECT
        count(*) filter(where kind='pair')::int pair_runs,
        count(*) filter(where kind='best-exit')::int exit_runs,
        count(distinct target) filter(where kind='pair')::int targets_pair,
        count(distinct target) filter(where kind='best-exit')::int targets_exit,
        avg(crossovers) filter(where kind='pair') avg_crossovers
       FROM kg_surface_runs WHERE chain_id=$1`, [chainId]);
    const s = await this.pool.query(
      `SELECT count(*)::int signals,
        percentile_cont(0.5) within group(order by execution_gap_usd) median_gap,
        percentile_cont(0.95) within group(order by execution_gap_usd) p95_gap,
        max(execution_gap_usd) max_gap FROM kg_signals WHERE chain_id=$1`, [chainId]);
    const a = r.rows[0] as Record<string, unknown>, b = s.rows[0] as Record<string, unknown>;
    return { pairRuns: a.pair_runs as number, exitRuns: a.exit_runs as number, targetsPair: a.targets_pair as number, targetsExit: a.targets_exit as number, signals: b.signals as number, medianGap: b.median_gap as number | null, p95Gap: b.p95_gap as number | null, maxGap: b.max_gap as number | null, avgCrossovers: a.avg_crossovers as number | null };
  }
  async recentObserverRuns(chainId: number, limit = 12): Promise<Array<{ block: number; durationMs: number; sized: number; economic: number; economicallyPositive: number; routeEncodable: number; executable: number; preflightAttempted: number; preflightPass: number }>> {
    const r = await this.pool.query(`SELECT block::text, duration_ms, sized, economic, economically_positive, route_encodable, executable, preflight_attempted, preflight_pass FROM kg_observer_runs WHERE chain_id=$1 ORDER BY block DESC LIMIT $2`, [chainId, limit]);
    return r.rows.map((x: Record<string, unknown>) => ({ block: Number(x.block), durationMs: x.duration_ms as number, sized: x.sized as number, economic: x.economic as number, economicallyPositive: x.economically_positive as number, routeEncodable: x.route_encodable as number, executable: x.executable as number, preflightAttempted: x.preflight_attempted as number, preflightPass: x.preflight_pass as number }));
  }
  // --- Item 3: indexer coverage / gaps / per-pool tick-map completeness -------
  async getIndexerCoverage(chainId: number): Promise<{ coverageStart: number; continuousThrough: number; generation: number } | null> {
    const r = await this.pool.query<{ coverage_start: string; continuous_through: string; generation: number }>(`SELECT coverage_start::text, continuous_through::text, generation FROM indexer_coverage WHERE chain_id=$1`, [chainId]);
    const row = r.rows[0];
    return row ? { coverageStart: Number(row.coverage_start), continuousThrough: Number(row.continuous_through), generation: row.generation } : null;
  }
  async upsertIndexerCoverage(chainId: number, c: { coverageStart: number; continuousThrough: number; generation: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO indexer_coverage(chain_id, coverage_start, continuous_through, generation) VALUES($1,$2,$3,$4)
       ON CONFLICT (chain_id) DO UPDATE SET coverage_start=$2, continuous_through=$3, generation=$4, updated_at=NOW()`,
      [chainId, c.coverageStart, c.continuousThrough, c.generation]
    );
  }
  async recordIndexerGap(chainId: number, fromBlock: number, toBlock: number, reason: string): Promise<void> {
    await this.pool.query(`INSERT INTO indexer_gaps(chain_id, from_block, to_block, reason) VALUES($1,$2,$3,$4) ON CONFLICT (chain_id, from_block, to_block) DO NOTHING`, [chainId, fromBlock, toBlock, reason]);
  }

  async upsertPoolTickStatus(chainId: number, pool: string, s: { status?: string; source?: string; creationBlock?: number; throughBlock?: number; complete?: boolean }): Promise<void> {
    await this.pool.query(
      `INSERT INTO pool_tick_status(chain_id, pool, status, source, creation_block, through_block, complete)
       VALUES($1,$2,COALESCE($3,'pending'),COALESCE($4,'live_indexer'),$5,$6,COALESCE($7,false))
       ON CONFLICT (chain_id, pool) DO UPDATE SET
         status=COALESCE($3, pool_tick_status.status), source=COALESCE($4, pool_tick_status.source),
         creation_block=COALESCE($5, pool_tick_status.creation_block), through_block=COALESCE($6, pool_tick_status.through_block),
         complete=COALESCE($7, pool_tick_status.complete), updated_at=NOW()`,
      [chainId, pool.toLowerCase(), s.status ?? null, s.source ?? null, s.creationBlock ?? null, s.throughBlock ?? null, s.complete ?? null]
    );
  }
  /** Tick-map completeness for a set of pools → Map<pool, complete>. The read-side reads this to set
   * V3PoolSim.tickCoverage (never inferred from ticks.length). Absent ⇒ not certified (treated partial). */
  async poolTickCompleteBatch(chainId: number, pools: string[]): Promise<Map<string, boolean>> {
    if (!pools.length) return new Map();
    const r = await this.pool.query<{ pool: string; complete: boolean }>(`SELECT pool, complete FROM pool_tick_status WHERE chain_id=$1 AND pool = ANY($2::text[])`, [chainId, pools.map((p) => p.toLowerCase())]);
    const m = new Map<string, boolean>();
    for (const row of r.rows) m.set(row.pool.toLowerCase(), row.complete);
    return m;
  }
  /** On a continuity-breaking gap: CONSERVATIVELY drop certification for every currently-complete pool (we
   * can't know which had Mint/Burn in the unobserved range). 3.3 repair restores the ones truly untouched. */
  async invalidateTickCertification(chainId: number, reason: string): Promise<number> {
    const r = await this.pool.query(`UPDATE pool_tick_status SET complete=false, status='partial', last_error=$2, updated_at=NOW() WHERE chain_id=$1 AND complete=true`, [chainId, reason]);
    return r.rowCount ?? 0;
  }

  /** Full tick-status row for a pool (Item 3.2 bootstrap decisions). */
  async getPoolTickStatus(chainId: number, pool: string): Promise<{ status: string; source: string; creationBlock: number | null; bootstrapThrough: number | null; complete: boolean; coverageGeneration: number | null; priority: number } | null> {
    const r = await this.pool.query<{ status: string; source: string; creation_block: string | null; bootstrap_through: string | null; complete: boolean; coverage_generation: number | null; priority: number }>(
      `SELECT status, source, creation_block::text, bootstrap_through::text, complete, coverage_generation, priority FROM pool_tick_status WHERE chain_id=$1 AND pool=$2`, [chainId, pool.toLowerCase()]);
    const x = r.rows[0];
    return x ? { status: x.status, source: x.source, creationBlock: x.creation_block != null ? Number(x.creation_block) : null, bootstrapThrough: x.bootstrap_through != null ? Number(x.bootstrap_through) : null, complete: x.complete, coverageGeneration: x.coverage_generation, priority: x.priority } : null;
  }
  /** Concentrated pools NOT yet tick-complete — the bootstrap worklist, priority ASC (0=P0 demand-driven). */
  async poolsNeedingTickBootstrap(chainId: number, limit = 20, maxPriority = 3): Promise<Array<{ pool: string; archetype: string; createdBlock: number | null; origin: string | null; factory: string | null }>> {
    // `length(address)=42` used to sit here and silently excluded ALL of V4 — a V4 pool is keyed by a 66-char
    // poolId, not an address. Half our pool population could therefore never enter this queue, while being
    // certified complete elsewhere. The archetype list is the ONLY membership rule now; the caller adapts the
    // log filter per family (V4 filters the singleton PoolManager by indexed poolId). The factory comes along
    // because for V4 it IS the emitter to filter on.
    const r = await this.pool.query<{ address: string; arch: string; created_block: string | null; origin: string | null; factory: string | null }>(
      `SELECT e.address, e.meta->>'archetype' arch, e.created_block::text, e.meta->>'origin' origin, e.meta->>'factory' factory
       FROM entities e LEFT JOIN pool_tick_status pts ON pts.chain_id=e.chain_id AND pts.pool=e.address
       WHERE e.chain_id=$1 AND e.kind='pool' AND e.meta->>'archetype' IN ('v3','v4')
         AND (pts.complete IS NULL OR pts.complete=false) AND (pts.status IS NULL OR pts.status <> 'failed')
         AND COALESCE(pts.priority,3) <= $3
       ORDER BY COALESCE(pts.priority,3) ASC, pts.updated_at ASC NULLS FIRST LIMIT $2`, [chainId, limit, maxPriority]);
    return r.rows.map((x) => ({ pool: x.address, archetype: x.arch, createdBlock: x.created_block != null ? Number(x.created_block) : null, origin: x.origin, factory: x.factory }));
  }
  async setPoolTickPriority(chainId: number, pool: string, priority: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO pool_tick_status(chain_id, pool, priority) VALUES($1,$2,$3)
       ON CONFLICT (chain_id, pool) DO UPDATE SET priority=LEAST(pool_tick_status.priority,$3), updated_at=NOW()`, [chainId, pool.toLowerCase(), priority]);
  }
  async setPoolTickCreation(chainId: number, pool: string, creationBlock: number, source: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO pool_tick_status(chain_id, pool, creation_block, creation_source, status) VALUES($1,$2,$3,$4,'bootstrapping')
       ON CONFLICT (chain_id, pool) DO UPDATE SET creation_block=$3, creation_source=$4, updated_at=NOW()`, [chainId, pool.toLowerCase(), creationBlock, source]);
  }
  async failPoolTickStatus(chainId: number, pool: string, error: string): Promise<void> {
    await this.pool.query(`UPDATE pool_tick_status SET status='failed', last_error=$3, attempts=attempts+1, updated_at=NOW() WHERE chain_id=$1 AND pool=$2`, [chainId, pool.toLowerCase(), error.slice(0, 300)]);
  }
  /** SOFT bootstrap error (e.g. an archive-depth getLogs miss): bump attempts + record; only mark 'failed'
   * (giving up → needs 3.4 storage-scan/archive) once attempts reach `cap`. Returns whether it gave up. */
  async noteTickBootstrapError(chainId: number, pool: string, error: string, cap = 8): Promise<boolean> {
    const r = await this.pool.query<{ failed: boolean }>(
      `UPDATE pool_tick_status SET attempts=attempts+1, last_error=$3, status = CASE WHEN attempts+1 >= $4 THEN 'failed' ELSE status END, updated_at=NOW()
       WHERE chain_id=$1 AND pool=$2 RETURNING (attempts >= $4) AS failed`, [chainId, pool.toLowerCase(), error.slice(0, 300), cap]);
    return r.rows[0]?.failed ?? false;
  }
  /** Certify a bootstrapped pool complete — ONLY after the caller re-checked coverage/generation. Stamps the
   * generation it was certified against (a later gap's global invalidation still resets it). */
  async certifyPoolTickComplete(chainId: number, pool: string, generation: number, source: string): Promise<void> {
    await this.pool.query(`UPDATE pool_tick_status SET complete=true, status='complete', source=$3, coverage_generation=$4, updated_at=NOW() WHERE chain_id=$1 AND pool=$2`, [chainId, pool.toLowerCase(), source, generation]);
  }
  /** Storage-scan worklist (Item 3.4): concentrated pools not tick-complete — INCLUDING status='failed'
   * (historical bootstrap gave up → storage snapshot is the fallback). Priority ASC (P0 first). */
  async poolsForStorageScan(chainId: number, limit = 4): Promise<Array<{ pool: string; factory: string | null; tickSpacing: number | null; fee: number | null; token0: string | null; token1: string | null; archetype: string | null }>> {
    const r = await this.pool.query<{ address: string; factory: string | null; ts: string | null; fee: string | null; t0: string | null; t1: string | null; arch: string | null }>(
      // FALLBACK SET ONLY: pools the historical-log bootstrap gave up on (status='failed'). The storage scan
      // is the recovery path for these — never a competitor to an in-flight bootstrap on the same pool. Runs on
      // its own reliable lane, so it is decoupled from the bootstrap queue. Highest priority / oldest first.
      `SELECT e.address, e.meta->>'factory' factory, e.meta->>'tickSpacing' ts, e.meta->>'fee' fee, e.meta->>'token0' t0, e.meta->>'token1' t1, e.meta->>'archetype' arch
       FROM entities e JOIN pool_tick_status pts ON pts.chain_id=e.chain_id AND pts.pool=e.address
       -- archetype='v3' AND length=42 sat here and silently excluded V4 (a poolId is 66 chars), which is
       -- the SAME exclusion that was already found and fixed in poolsNeedingTickBootstrap. Fixing one
       -- instance of a bug and leaving its siblings is how V4 stayed dark through four separate filters, so
       -- the archetype list is the only membership rule here too; the reader adapts per family.
       WHERE e.chain_id=$1 AND e.kind='pool' AND e.meta->>'archetype' = ANY($3::text[])
         AND pts.status='failed' AND pts.complete IS NOT TRUE
       ORDER BY pts.priority ASC, pts.updated_at ASC NULLS FIRST LIMIT $2`, [chainId, limit, [...CONCENTRATED]]);
    return r.rows.map((x) => ({ pool: x.address, factory: x.factory, tickSpacing: x.ts != null ? Number(x.ts) : null, fee: x.fee != null ? Number(x.fee) : null, token0: x.t0, token1: x.t1, archetype: x.arch }));
  }

  /** ATOMIC SNAPSHOT REPLACE (Item 3.4) — storage bootstrap is a STATE SNAPSHOT, NOT additive: a complete
   * tick map read at block B summarises all prior history, so it REPLACES the pool's tick_liquidity (never
   * sums, or every already-incorporated Mint/Burn would double). Optional `replayDeltas` are the
   * indexer-observed Mint/Burn in [B+1, throughBlock] applied additively ON TOP (the disjoint-range replay),
   * all in ONE transaction. Sets status='snapshot' (NOT complete — the Quoter-validation gate certifies). */
  async replaceTickMapSnapshot(chainId: number, pool: string, snapshotBlock: number, snapshotTicks: Array<{ tick: number; liquidityNet: bigint }>, throughBlock: number, replayDeltas: Array<{ tickLower: number; tickUpper: number; liquidityDelta: bigint }> = []): Promise<{ ok: boolean; reason?: string }> {
    const p = pool.toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO pool_tick_status(chain_id, pool, status) VALUES($1,$2,'snapshot') ON CONFLICT (chain_id, pool) DO NOTHING`, [chainId, p]);
      await client.query(`SELECT 1 FROM pool_tick_status WHERE chain_id=$1 AND pool=$2 FOR UPDATE`, [chainId, p]);
      await client.query(`DELETE FROM tick_liquidity WHERE chain_id=$1 AND pool=$2`, [chainId, p]);
      // Net the snapshot with the replay deltas (both keyed by tick) → one authoritative set.
      const net = new Map<number, bigint>();
      for (const t of snapshotTicks) if (t.liquidityNet !== 0n) net.set(t.tick, (net.get(t.tick) ?? 0n) + t.liquidityNet);
      for (const d of replayDeltas) { net.set(d.tickLower, (net.get(d.tickLower) ?? 0n) + d.liquidityDelta); net.set(d.tickUpper, (net.get(d.tickUpper) ?? 0n) - d.liquidityDelta); }
      const rows = [...net.entries()].filter(([, v]) => v !== 0n);
      if (rows.length) {
        const values: unknown[] = [];
        const tuples = rows.map(([tick, v], i) => { const b = i * 5; values.push(chainId, p, tick, v.toString(), throughBlock); return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},NOW())`; });
        await client.query(`INSERT INTO tick_liquidity(chain_id,pool,tick,liquidity_net,block_number,updated_at) VALUES ${tuples.join(",")}`, values); // plain INSERT — rows were just deleted, no conflict
      }
      await client.query(`UPDATE pool_tick_status SET status='snapshot', source='storage_scan', through_block=$3, bootstrap_through=$3, creation_block=COALESCE(creation_block,$4), updated_at=NOW() WHERE chain_id=$1 AND pool=$2`, [chainId, p, throughBlock, snapshotBlock]);
      await client.query("COMMIT");
      return { ok: true };
    } catch (e) { await client.query("ROLLBACK").catch(() => undefined); return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
    finally { client.release(); }
  }

  /** RESTART-SAFE bootstrap step: in ONE transaction, assert the chunk is contiguous (from == through+1, or
   * == creation_block for the first), additively apply its Mint/Burn deltas, and advance bootstrap_through —
   * so a crash either applies both or neither (exactly-once, independent of chunk boundaries). */
  async applyTickBootstrapChunk(chainId: number, pool: string, fromBlock: number, toBlock: number, deltas: Array<{ tickLower: number; tickUpper: number; liquidityDelta: bigint }>): Promise<{ ok: boolean; reason?: string }> {
    const p = pool.toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const st = await client.query<{ creation_block: string | null; bootstrap_through: string | null }>(`SELECT creation_block::text, bootstrap_through::text FROM pool_tick_status WHERE chain_id=$1 AND pool=$2 FOR UPDATE`, [chainId, p]);
      const row = st.rows[0];
      if (!row) { await client.query("ROLLBACK"); return { ok: false, reason: "no status row" }; }
      const bt = row.bootstrap_through != null ? Number(row.bootstrap_through) : null;
      const creation = row.creation_block != null ? Number(row.creation_block) : null;
      const expectedFrom = bt != null ? bt + 1 : creation;
      if (expectedFrom == null || fromBlock !== expectedFrom) { await client.query("ROLLBACK"); return { ok: false, reason: `non-contiguous: expected from ${expectedFrom}, got ${fromBlock}` }; }
      const net = new Map<number, bigint>();
      for (const d of deltas) { net.set(d.tickLower, (net.get(d.tickLower) ?? 0n) + d.liquidityDelta); net.set(d.tickUpper, (net.get(d.tickUpper) ?? 0n) - d.liquidityDelta); }
      if (net.size) {
        const values: unknown[] = [];
        const tuples = [...net.entries()].map(([tick, v], i) => { const b = i * 5; values.push(chainId, p, tick, v.toString(), toBlock); return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},NOW())`; });
        await client.query(`INSERT INTO tick_liquidity(chain_id,pool,tick,liquidity_net,block_number,updated_at) VALUES ${tuples.join(",")} ON CONFLICT (chain_id,pool,tick) DO UPDATE SET liquidity_net = tick_liquidity.liquidity_net + EXCLUDED.liquidity_net, block_number = GREATEST(tick_liquidity.block_number, EXCLUDED.block_number), updated_at=NOW()`, values);
      }
      await client.query(`UPDATE pool_tick_status SET bootstrap_through=$3, status='bootstrapping', attempts=attempts+1, updated_at=NOW() WHERE chain_id=$1 AND pool=$2`, [chainId, p, toBlock]);
      await client.query("COMMIT");
      return { ok: true };
    } catch (e) { await client.query("ROLLBACK").catch(() => undefined); return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
    finally { client.release(); }
  }
  async saveRawBlock(chainId: number, block: number, logs: unknown): Promise<void> {
    await this.pool.query(`INSERT INTO raw_blocks(chain_id, block_number, logs) VALUES($1,$2,$3) ON CONFLICT (chain_id, block_number) DO UPDATE SET logs=$3, at=NOW()`, [chainId, block, jsonParam(logs)]);
  }
  async pruneRawBlocks(chainId: number, olderThanHours: number): Promise<number> {
    const r = await this.pool.query(`DELETE FROM raw_blocks WHERE chain_id=$1 AND at < NOW() - ($2 || ' hours')::interval`, [chainId, String(olderThanHours)]);
    return r.rowCount ?? 0;
  }
  /** Rolling buffer: keep only the last `keep` blocks (by block_number) of raw full logs. */
  async pruneRawBlocksKeepLast(chainId: number, keep: number): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM raw_blocks WHERE chain_id=$1 AND block_number < (SELECT COALESCE(MAX(block_number),0) - $2 FROM raw_blocks WHERE chain_id=$1)`,
      [chainId, keep]
    );
    return r.rowCount ?? 0;
  }
  /** ROLLING FLOW: replace this block's swap rows (idempotent on re-process) with the given per-swap
   * {pool, wallet, valueUsd}. The indexer calls this once per block; the FlowSensor reads it back. */
  async insertRecentSwaps(chainId: number, block: number, rows: Array<{ pool: string; wallet: string | null; valueUsd: number }>): Promise<void> {
    await this.pool.query(`DELETE FROM recent_swaps WHERE chain_id=$1 AND block_number=$2`, [chainId, block]);
    if (!rows.length) return;
    const vals: unknown[] = [];
    const tuples = rows.map((r, i) => { const b = i * 5; vals.push(chainId, block, r.pool.toLowerCase(), r.wallet?.toLowerCase() ?? null, r.valueUsd); return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`; });
    await this.pool.query(`INSERT INTO recent_swaps(chain_id, block_number, pool, wallet, value_usd) VALUES ${tuples.join(",")}`, vals);
  }
  /** Rolling window: drop flow rows older than `keep` blocks behind the newest. */
  async pruneRecentSwaps(chainId: number, keep: number): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM recent_swaps WHERE chain_id=$1 AND block_number < (SELECT COALESCE(MAX(block_number),0) - $2 FROM recent_swaps WHERE chain_id=$1)`,
      [chainId, keep]
    );
    return r.rowCount ?? 0;
  }
  /** FLOW read (for the FlowSensor): per-swap {block, pool, wallet, valueUsd} at/after `sinceBlock`. */
  async recentSwaps(chainId: number, sinceBlock: number): Promise<Array<{ block: number; pool: string; wallet: string | null; valueUsd: number }>> {
    const r = await this.pool.query<{ block_number: string; pool: string; wallet: string | null; value_usd: number }>(
      `SELECT block_number, pool, wallet, value_usd FROM recent_swaps WHERE chain_id=$1 AND block_number >= $2 ORDER BY block_number ASC`,
      [chainId, sinceBlock]
    );
    return r.rows.map((x) => ({ block: Number(x.block_number), pool: x.pool, wallet: x.wallet, valueUsd: x.value_usd }));
  }
  /** Pool metadata (token0/token1/archetype) for a batch of pool addresses — from the entities registry. */
  async poolInfoBatch(chainId: number, addresses: string[]): Promise<Map<string, { token0: string | null; token1: string | null; archetype: string | null; factory: string | null }>> {
    const out = new Map<string, { token0: string | null; token1: string | null; archetype: string | null; factory: string | null }>();
    if (!addresses.length) return out;
    const lower = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const r = await this.pool.query<{ address: string; token0: string | null; token1: string | null; archetype: string | null; factory: string | null }>(
      `SELECT address, meta->>'token0' AS token0, meta->>'token1' AS token1, meta->>'archetype' AS archetype, meta->>'factory' AS factory FROM entities WHERE chain_id=$1 AND kind='pool' AND address = ANY($2::text[])`, [chainId, lower]
    );
    for (const row of r.rows) out.set(row.address, { token0: row.token0, token1: row.token1, archetype: row.archetype, factory: row.factory });
    return out;
  }

  /** Persist latest AMM state for a batch of pools (from Swap/Sync logs). One query via UNNEST; a
   * newer block always wins so a gap-backfill can never overwrite fresher state. Values are raw wei
   * strings (BigInt→string) to keep NUMERIC exact — never floats. */
  async upsertPoolState(chainId: number, rows: Array<{ pool: string; archetype: string; r0?: bigint | null; r1?: bigint | null; sqrtPrice?: bigint | null; liquidity?: bigint | null; feePpm?: number | null; block: number }>): Promise<void> {
    if (!rows.length) return;
    const s = (v: bigint | null | undefined) => (v == null ? null : v.toString());
    // fee_ppm is STATE, not metadata: a V4 fee can be set per swap by the pool's hook, so the only truthful
    // source is the last observed swap. COALESCE keeps the previous value when this event carries none (a V3
    // swap does not report a fee), so a V4 pool never loses its known fee to a later non-V4 write.
    await this.pool.query(
      `INSERT INTO pool_state(chain_id, pool, archetype, r0, r1, sqrt_price, liquidity, fee_ppm, block_number)
       SELECT $1, p, a, r0, r1, sp, liq, fee, bn
       FROM unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::int[], $9::bigint[]) AS t(p, a, r0, r1, sp, liq, fee, bn)
       ON CONFLICT (chain_id, pool) DO UPDATE SET
         archetype=EXCLUDED.archetype, r0=EXCLUDED.r0, r1=EXCLUDED.r1, sqrt_price=EXCLUDED.sqrt_price,
         liquidity=EXCLUDED.liquidity, fee_ppm=COALESCE(EXCLUDED.fee_ppm, pool_state.fee_ppm),
         block_number=EXCLUDED.block_number, updated_at=NOW()
       WHERE pool_state.block_number <= EXCLUDED.block_number`,
      [chainId,
        rows.map((x) => x.pool.toLowerCase()),
        rows.map((x) => x.archetype),
        rows.map((x) => s(x.r0)), rows.map((x) => s(x.r1)),
        rows.map((x) => s(x.sqrtPrice)), rows.map((x) => s(x.liquidity)),
        rows.map((x) => x.feePpm ?? null),
        rows.map((x) => x.block)]
    );
  }

  /** Accumulate V3 per-tick liquidity from Mint/Burn deltas. Each delta contributes +Δ at tickLower and
   * −Δ at tickUpper (Uniswap's crossing convention); Burn passes a negative Δ. Idempotency isn't perfect
   * across reprocessing (deltas accumulate), but the rolling raw buffer + block stamp let us rebuild if needed. */
  async upsertTickLiquidity(chainId: number, block: number, deltas: Array<{ pool: string; tickLower: number; tickUpper: number; liquidityDelta: bigint }>): Promise<void> {
    if (!deltas.length) return;
    // Aggregate by (pool, tick) FIRST — several Mint/Burn on the same tick in one block would otherwise
    // produce duplicate conflict keys in a single INSERT (Postgres 21000: "cannot affect row twice").
    const net = new Map<string, bigint>(); // `${pool}:${tick}` → summed net-liquidity delta
    for (const d of deltas) {
      const kl = `${d.pool.toLowerCase()}:${d.tickLower}`, ku = `${d.pool.toLowerCase()}:${d.tickUpper}`;
      net.set(kl, (net.get(kl) ?? 0n) + d.liquidityDelta); // +Δ at tickLower
      net.set(ku, (net.get(ku) ?? 0n) - d.liquidityDelta); // −Δ at tickUpper
    }
    const rows: Array<[string, number, string]> = [...net.entries()].map(([k, v]) => { const i = k.lastIndexOf(":"); return [k.slice(0, i), Number(k.slice(i + 1)), v.toString()]; });
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => { const b = i * 5; values.push(chainId, r[0], r[1], r[2], block); return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},NOW())`; });
    await this.pool.query(
      `INSERT INTO tick_liquidity(chain_id, pool, tick, liquidity_net, block_number, updated_at) VALUES ${tuples.join(",")}
       ON CONFLICT (chain_id, pool, tick) DO UPDATE SET liquidity_net = tick_liquidity.liquidity_net + EXCLUDED.liquidity_net, block_number = GREATEST(tick_liquidity.block_number, EXCLUDED.block_number), updated_at = NOW()`,
      values
    );
  }

  /** DEV RESET: return the system to a CLEAN slate. Wipes everything NOT managed by the indexer/enrichment
   * (nor system infra) — agent history/cognition, positions, annotations, follows, NAV history, the wallet
   * transfer/balance history (so Scarlet doesn't see stale movements) and derived/observation history.
   * KEEPS: objective indexer/enrichment data (entities, pool_state, token_prices, token_stats,
   * tick_liquidity, indexer_state, scan_cursors, venues, discovered_pools, raw_blocks,
   * protocol_verifications, lending_markets/positions) + SYSTEM infra (signal_blacklist = honeypot memory,
   * organs = deployed contract addresses/seeds). Logs self-rotate. Idempotent (TRUNCATE), one statement. */
  async resetScarletState(): Promise<void> {
    await this.pool.query(
      `TRUNCATE scarlet_journal, scarlet_memory, scarlet_state, decisions, executions, ledger_entries,
        position_plans, positions, token_annotations, research_traces, strategy_hypotheses,
        opportunity_candidates, follows, follow_moves, portfolio_snapshots, agent_summaries,
        wallet_transactions, wallet_token_balances, market_snapshots, network_observations,
        liquidation_events, autoflash, bend_accounts, bend_positions
       RESTART IDENTITY CASCADE`
    );
  }

  /** Initialized ticks (non-zero net liquidity) for a V3 pool — the input to the exact tick-crossing sim. */
  async tickLiquidity(chainId: number, pool: string): Promise<Array<{ tick: number; liquidityNet: bigint }>> {
    const r = await this.pool.query<{ tick: number; liquidity_net: string }>(
      `SELECT tick, liquidity_net::text FROM tick_liquidity WHERE chain_id=$1 AND pool=$2 AND liquidity_net <> 0 ORDER BY tick`,
      [chainId, pool.toLowerCase()]
    );
    return r.rows.map((x) => ({ tick: x.tick, liquidityNet: BigInt(x.liquidity_net) }));
  }

  /** Increment per-token market stats for the current 5-min bucket (from V3 swap amounts). */
  async upsertTokenStats(chainId: number, bucket: number, rows: Array<{ token: string; volUsd: number; buys: number; sells: number; lastPrice: number; netFlowUsd: number; liqUsd: number | null }>): Promise<void> {
    if (!rows.length) return;
    await this.pool.query(
      `INSERT INTO token_stats(chain_id, token, bucket, vol_usd, buys, sells, last_price, net_flow_usd, liq_usd)
       SELECT $1, t, $2, v, b, s, lp, nf, lq FROM unnest($3::text[], $4::float8[], $5::int[], $6::int[], $7::float8[], $8::float8[], $9::float8[]) AS x(t, v, b, s, lp, nf, lq)
       ON CONFLICT (chain_id, token, bucket) DO UPDATE SET
         vol_usd = token_stats.vol_usd + EXCLUDED.vol_usd,
         buys = token_stats.buys + EXCLUDED.buys,
         sells = token_stats.sells + EXCLUDED.sells,
         last_price = COALESCE(EXCLUDED.last_price, token_stats.last_price),
         net_flow_usd = token_stats.net_flow_usd + EXCLUDED.net_flow_usd,
         liq_usd = COALESCE(EXCLUDED.liq_usd, token_stats.liq_usd),
         updated_at = NOW()`,
      [chainId, bucket, rows.map((r) => r.token.toLowerCase()), rows.map((r) => r.volUsd), rows.map((r) => r.buys), rows.map((r) => r.sells), rows.map((r) => r.lastPrice), rows.map((r) => r.netFlowUsd), rows.map((r) => r.liqUsd)]
    );
  }
  async pruneTokenStats(chainId: number, olderThanHours: number): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanHours * 3600;
    const r = await this.pool.query(`DELETE FROM token_stats WHERE chain_id=$1 AND bucket < $2`, [chainId, cutoff]);
    return r.rowCount ?? 0;
  }
  /** Windowed market stats for a token — the chain-sourced replacement for the DexScreener feed. */
  async tokenStats(chainId: number, token: string): Promise<{ vol5m: number; vol1h: number; vol24h: number; txns24h: number; buys24h: number; sells24h: number; change1h: number | null; change24h: number | null; lastPrice: number | null; netFlow1h: number; liqUsd: number | null; liqChange1h: number | null }> {
    const now = Math.floor(Date.now() / 1000);
    const r = await this.pool.query<{ vol5m: string; vol1h: string; vol24h: string; buys24h: string; sells24h: string; netflow1h: string; liqnow: string | null; liqold: string | null }>(
      `SELECT
         COALESCE(SUM(vol_usd) FILTER (WHERE bucket >= $3),0)::text AS vol5m,
         COALESCE(SUM(vol_usd) FILTER (WHERE bucket >= $4),0)::text AS vol1h,
         COALESCE(SUM(vol_usd),0)::text AS vol24h,
         COALESCE(SUM(buys),0)::text AS buys24h,
         COALESCE(SUM(sells),0)::text AS sells24h,
         COALESCE(SUM(net_flow_usd) FILTER (WHERE bucket >= $4),0)::text AS netflow1h,
         (SELECT liq_usd FROM token_stats WHERE chain_id=$1 AND token=$2 AND liq_usd IS NOT NULL ORDER BY bucket DESC LIMIT 1)::text AS liqnow,
         (SELECT liq_usd FROM token_stats WHERE chain_id=$1 AND token=$2 AND liq_usd IS NOT NULL AND bucket <= $4 ORDER BY bucket DESC LIMIT 1)::text AS liqold
       FROM token_stats WHERE chain_id=$1 AND token=$2 AND bucket >= $5`,
      [chainId, token.toLowerCase(), now - 300, now - 3600, now - 86400]
    );
    const row = r.rows[0];
    const liqNow = row.liqnow != null ? Number(row.liqnow) : null;
    const liqOld = row.liqold != null ? Number(row.liqold) : null;
    const liqChange1h = liqNow != null && liqOld != null && liqOld > 0 ? (liqNow / liqOld - 1) * 100 : null;
    // Price change: latest bucket price vs the price ~1h / ~24h ago (nearest bucket at/under the mark).
    const priceAt = async (secsAgo: number): Promise<number | null> => {
      const q = await this.pool.query<{ last_price: number | null }>(
        `SELECT last_price FROM token_stats WHERE chain_id=$1 AND token=$2 AND last_price IS NOT NULL AND bucket <= $3 ORDER BY bucket DESC LIMIT 1`,
        [chainId, token.toLowerCase(), now - secsAgo]
      );
      return q.rows[0]?.last_price ?? null;
    };
    const latestQ = await this.pool.query<{ last_price: number | null }>(
      `SELECT last_price FROM token_stats WHERE chain_id=$1 AND token=$2 AND last_price IS NOT NULL ORDER BY bucket DESC LIMIT 1`, [chainId, token.toLowerCase()]
    );
    const latest = latestQ.rows[0]?.last_price ?? null;
    const chg = (past: number | null): number | null => (latest != null && past != null && past > 0 ? (latest / past - 1) * 100 : null);
    const [p1h, p24h] = await Promise.all([priceAt(3600), priceAt(86400)]);
    return {
      vol5m: Number(row.vol5m), vol1h: Number(row.vol1h), vol24h: Number(row.vol24h),
      txns24h: Number(row.buys24h) + Number(row.sells24h), buys24h: Number(row.buys24h), sells24h: Number(row.sells24h),
      change1h: chg(p1h), change24h: chg(p24h), lastPrice: latest,
      netFlow1h: Number(row.netflow1h), liqUsd: liqNow, liqChange1h
    };
  }

  /** Same-symbol siblings + our verdict on each — a proactive serial-redeploy / brand-impersonation
   * signal (a symbol we've marked 'avoid' many times before is almost certainly another rug). */
  async symbolSiblings(chainId: number, symbol: string, excludeToken: string, limit = 12): Promise<{ total: number; avoid: number; samples: Array<{ address: string; verdict: string | null }> }> {
    if (!symbol || symbol === "?") return { total: 0, avoid: 0, samples: [] };
    const r = await this.pool.query<{ address: string; verdict: string | null }>(
      `SELECT e.address, (SELECT verdict FROM token_annotations a WHERE a.chain_id=$1 AND a.token=e.address ORDER BY at DESC LIMIT 1) AS verdict
       FROM entities e WHERE e.chain_id=$1 AND e.kind='token' AND lower(e.symbol)=lower($2) AND e.address <> $3 ORDER BY e.created_at DESC LIMIT $4`,
      [chainId, symbol, excludeToken.toLowerCase(), limit]
    );
    return { total: r.rows.length, avoid: r.rows.filter((x) => x.verdict === "avoid").length, samples: r.rows.slice(0, 5) };
  }

  /** Ranked OPPORTUNITY feed — the fresh, indexer-sourced replacement for the stale legacy discovery
   * lists. One deduplicated set of ACTIVE tokens (traded in the last `windowMin`), each with the signals
   * Scarlet's strategies need — momentum, buy/sell pressure, net USD flow, liquidity + its trajectory
   * (rug-drain), age — scored by a composite so she focuses on the best few instead of sifting raw lists. */
  async topOpportunities(chainId: number, opts: { windowMin?: number; limit?: number } = {}): Promise<Array<{ address: string; symbol: string | null; priceUsd: number | null; ageMin: number | null; vol1h: number; buys1h: number; sells1h: number; netFlow1h: number; change1h: number | null; liqUsd: number | null; liqChange1h: number | null; score: number; bucket: "fresh" | "mover" }>> {
    const now = Math.floor(Date.now() / 1000);
    const since1h = now - 3600, sinceWin = now - (opts.windowMin ?? 30) * 60;
    const r = await this.pool.query<{ token: string; symbol: string | null; decimals: number | null; price: number | null; created: Date | null; vol1h: string; buys1h: string; sells1h: string; netflow1h: string; liqnow: string | null; liqold: string | null; p_now: number | null; p_1h: number | null }>(
      `WITH agg AS (
         SELECT token,
           SUM(vol_usd) FILTER (WHERE bucket >= $2) AS vol1h,
           SUM(buys) FILTER (WHERE bucket >= $2) AS buys1h,
           SUM(sells) FILTER (WHERE bucket >= $2) AS sells1h,
           COALESCE(SUM(net_flow_usd) FILTER (WHERE bucket >= $2),0) AS netflow1h,
           SUM(vol_usd) FILTER (WHERE bucket >= $3) AS volwin
         FROM token_stats WHERE chain_id=$1 AND bucket >= $2 GROUP BY token
         HAVING SUM(vol_usd) FILTER (WHERE bucket >= $3) > 0
       )
       SELECT a.token, e.symbol, e.decimals, tp.price_usd AS price, e.created_at AS created,
         a.vol1h::text, a.buys1h::text, a.sells1h::text, a.netflow1h::text,
         (SELECT liq_usd FROM token_stats s WHERE s.chain_id=$1 AND s.token=a.token AND liq_usd IS NOT NULL ORDER BY bucket DESC LIMIT 1)::text AS liqnow,
         (SELECT liq_usd FROM token_stats s WHERE s.chain_id=$1 AND s.token=a.token AND liq_usd IS NOT NULL AND bucket <= $2 ORDER BY bucket DESC LIMIT 1)::text AS liqold,
         (SELECT last_price FROM token_stats s WHERE s.chain_id=$1 AND s.token=a.token AND last_price IS NOT NULL ORDER BY bucket DESC LIMIT 1) AS p_now,
         (SELECT last_price FROM token_stats s WHERE s.chain_id=$1 AND s.token=a.token AND last_price IS NOT NULL AND bucket <= $2 ORDER BY bucket DESC LIMIT 1) AS p_1h
       FROM agg a
       LEFT JOIN entities e ON e.chain_id=$1 AND e.address=a.token AND e.kind='token'
       LEFT JOIN token_prices tp ON tp.chain_id=$1 AND tp.token=a.token
       WHERE e.address NOT IN ('0x4200000000000000000000000000000000000006','0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')`,
      [chainId, since1h, sinceWin]
    );
    const out = r.rows.map((x) => {
      const vol1h = Number(x.vol1h) || 0, buys = Number(x.buys1h) || 0, sells = Number(x.sells1h) || 0, netFlow1h = Number(x.netflow1h) || 0;
      const liqUsd = x.liqnow != null ? Number(x.liqnow) : null, liqOld = x.liqold != null ? Number(x.liqold) : null;
      const liqChange1h = liqUsd != null && liqOld != null && liqOld > 0 ? (liqUsd / liqOld - 1) * 100 : null;
      const change1h = x.p_now != null && x.p_1h != null && x.p_1h > 0 ? (x.p_now / x.p_1h - 1) * 100 : null;
      const ageMin = x.created ? Math.round((Date.now() - x.created.getTime()) / 60000) : null;
      // Composite score: volume + buy-pressure + momentum, dampened by liquidity drain (rug) and by
      // sell-dominant flow. Deliberately simple + transparent — a first-pass ranking, not a black box.
      const pressure = buys + sells > 0 ? (buys - sells) / (buys + sells) : 0; // −1..+1
      let score = Math.log10(1 + vol1h) * 2 + pressure * 3 + (netFlow1h > 0 ? 2 : -1) + Math.max(-3, Math.min(3, (change1h ?? 0) / 20));
      if (liqChange1h != null && liqChange1h < -30) score -= 4; // liquidity draining hard → likely rug
      if (liqUsd != null && liqUsd < 3000) score -= 1;          // ultra-thin
      const bucket: "fresh" | "mover" = ageMin != null && ageMin <= 180 ? "fresh" : "mover";
      return { address: x.token, symbol: x.symbol, priceUsd: x.price, ageMin, vol1h: Math.round(vol1h), buys1h: buys, sells1h: sells, netFlow1h: Math.round(netFlow1h), change1h, liqUsd: liqUsd != null ? Math.round(liqUsd) : null, liqChange1h, score: Math.round(score * 100) / 100, bucket };
    });
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit ?? 20);
  }
  /** Trending tokens = top by 1h chain volume (from token_stats), with identity + price. Indexer-sourced
   * replacement for the GeckoTerminal "trending" discovery. */
  async trendingTokens(chainId: number, limit = 15): Promise<Array<{ address: string; symbol: string | null; priceUsd: number | null; vol1h: number; buys: number; sells: number }>> {
    const since = Math.floor(Date.now() / 1000) - 3600;
    const r = await this.pool.query<{ token: string; symbol: string | null; price_usd: number | null; vol1h: string; buys: string; sells: string }>(
      `SELECT ts.token, e.symbol, tp.price_usd,
              SUM(ts.vol_usd)::text AS vol1h, SUM(ts.buys)::text AS buys, SUM(ts.sells)::text AS sells
       FROM token_stats ts
       LEFT JOIN entities e ON e.chain_id=ts.chain_id AND e.address=ts.token AND e.kind='token'
       LEFT JOIN token_prices tp ON tp.chain_id=ts.chain_id AND tp.token=ts.token
       WHERE ts.chain_id=$1 AND ts.bucket >= $2
       GROUP BY ts.token, e.symbol, tp.price_usd ORDER BY SUM(ts.vol_usd) DESC LIMIT $3`, [chainId, since, limit]
    );
    return r.rows.map((x) => ({ address: x.token, symbol: x.symbol, priceUsd: x.price_usd, vol1h: Math.round(Number(x.vol1h)), buys: Number(x.buys), sells: Number(x.sells) }));
  }
  /** Freshly-discovered pools (newest first), with token identity. Indexer-sourced "new_pools". */
  async recentPools(chainId: number, limit = 15): Promise<Array<{ pool: string; token0: string | null; token1: string | null; symbol0: string | null; symbol1: string | null; archetype: string | null; createdAt: string }>> {
    const r = await this.pool.query<{ pool: string; t0: string | null; t1: string | null; s0: string | null; s1: string | null; arch: string | null; created_at: Date }>(
      `SELECT p.address AS pool, p.meta->>'token0' AS t0, p.meta->>'token1' AS t1, p.meta->>'archetype' AS arch, p.created_at,
              e0.symbol AS s0, e1.symbol AS s1
       FROM entities p
       LEFT JOIN entities e0 ON e0.chain_id=p.chain_id AND e0.address=lower(p.meta->>'token0') AND e0.kind='token'
       LEFT JOIN entities e1 ON e1.chain_id=p.chain_id AND e1.address=lower(p.meta->>'token1') AND e1.kind='token'
       WHERE p.chain_id=$1 AND p.kind='pool' ORDER BY p.created_at DESC LIMIT $2`, [chainId, limit]
    );
    return r.rows.map((x) => ({ pool: x.pool, token0: x.t0, token1: x.t1, symbol0: x.s0, symbol1: x.s1, archetype: x.arch, createdAt: x.created_at.toISOString() }));
  }

  /** Approximate USD liquidity of a token: summed across its pools, quote-side reserve × quote USD × 2.
   * V2 reserves are exact; V3 uses virtual reserves (a relative-depth signal, not exact locked TVL). */
  async tokenLiquidityUsd(chainId: number, token: string, quoteUsd: (t: string) => number | null): Promise<number | null> {
    const t = token.toLowerCase();
    const r = await this.pool.query<{ token0: string | null; token1: string | null; r0: string | null; r1: string | null; sqrt_price: string | null; liquidity: string | null }>(
      `SELECT e.meta->>'token0' token0, e.meta->>'token1' token1, ps.r0::text, ps.r1::text, ps.sqrt_price::text, ps.liquidity::text
       FROM entities e JOIN pool_state ps ON ps.pool=e.address
       WHERE e.chain_id=$1 AND e.kind='pool' AND (lower(e.meta->>'token0')=$2 OR lower(e.meta->>'token1')=$2)`, [chainId, t]
    );
    if (!r.rows.length) return null;
    const decMap = await this.tokenMeta(chainId, r.rows.flatMap((x) => [x.token0, x.token1].filter(Boolean) as string[]));
    let total = 0; let any = false;
    const Q96 = 2 ** 96;
    for (const row of r.rows) {
      const t0 = row.token0?.toLowerCase(), t1 = row.token1?.toLowerCase(); if (!t0 || !t1) continue;
      const quote = t0 === t ? t1 : t0; const qUsd = quoteUsd(quote); if (qUsd == null || qUsd <= 0) continue;
      const qDec = quote === t0 ? decMap.get(t0)?.decimals : decMap.get(t1)?.decimals; if (qDec == null) continue;
      let qReserve: number | null = null;
      if (row.r0 != null && row.r1 != null) qReserve = Number(quote === t0 ? row.r0 : row.r1) / 10 ** qDec; // V2 exact
      else if (row.sqrt_price != null && row.liquidity != null) { // V3 virtual reserve of the quote side
        const sp = Number(BigInt(row.sqrt_price.split(".")[0])) / Q96, L = Number(BigInt(row.liquidity.split(".")[0]));
        const virt = quote === t0 ? L / sp : L * sp; qReserve = virt / 10 ** qDec;
      }
      if (qReserve != null && qReserve > 0) { total += qReserve * qUsd * 2; any = true; }
    }
    return any ? total : null;
  }

  /** Latest AMM state for a batch of pools — the DB source PriceOracle reads instead of RPC. */
  async poolStateBatch(chainId: number, pools: string[]): Promise<Map<string, { archetype: string; r0: bigint | null; r1: bigint | null; sqrtPrice: bigint | null; liquidity: bigint | null; block: number; ageMs: number }>> {
    const out = new Map<string, { archetype: string; r0: bigint | null; r1: bigint | null; sqrtPrice: bigint | null; liquidity: bigint | null; block: number; ageMs: number }>();
    if (!pools.length) return out;
    const lower = [...new Set(pools.map((a) => a.toLowerCase()))];
    const r = await this.pool.query<{ pool: string; archetype: string; r0: string | null; r1: string | null; sqrt_price: string | null; liquidity: string | null; block_number: string; age_ms: string }>(
      `SELECT pool, archetype, r0::text, r1::text, sqrt_price::text, liquidity::text, block_number::text,
              (EXTRACT(EPOCH FROM (NOW()-updated_at))*1000)::bigint::text AS age_ms
       FROM pool_state WHERE chain_id=$1 AND pool = ANY($2::text[])`, [chainId, lower]
    );
    const b = (v: string | null) => (v == null ? null : BigInt(v.split(".")[0]));
    for (const row of r.rows) out.set(row.pool, { archetype: row.archetype, r0: b(row.r0), r1: b(row.r1), sqrtPrice: b(row.sqrt_price), liquidity: b(row.liquidity), block: Number(row.block_number), ageMs: Number(row.age_ms) });
    return out;
  }

  /**
   * Lending positions as GRAPH NODES: everything still alive, with the size and market parameters the
   * valuation needs. Closed and blacklisted rows are excluded because they cannot become opportunities;
   * everything else is a node whose profit the graph re-derives whenever its inputs move.
   */
  async liquidationGraphNodes(chainId: number): Promise<Array<{ protocol: string; marketId: string; borrower: string; collateralToken: string | null; loanToken: string | null; collateralRaw: string | null; debtRaw: string | null; lltv: number | null; oracle: string | null; hf: number | null; tier: string }>> {
    const r = await this.pool.query<{ protocol: string; market_id: string; borrower: string; collateral_token: string | null; loan_token: string | null; coll_raw: string | null; debt_raw: string | null; lltv: string | null; oracle: string | null; hf: string | null; tier: string }>(
      `SELECT protocol, market_id, borrower, collateral_token, loan_token,
              meta->>'collateralRaw' coll_raw, meta->>'debtRaw' debt_raw, lltv::text, meta->>'oracle' oracle,
              hf::text, tier
       FROM lending_positions
       WHERE chain_id=$1 AND tier NOT IN ('closed','blacklist')
         AND (meta->>'collateralRaw') IS NOT NULL AND (meta->>'debtRaw') IS NOT NULL`, [chainId]);
    return r.rows.map((x) => ({ protocol: x.protocol, marketId: x.market_id, borrower: x.borrower,
      collateralToken: x.collateral_token, loanToken: x.loan_token, collateralRaw: x.coll_raw, debtRaw: x.debt_raw,
      lltv: x.lltv != null ? Number(x.lltv) : null, oracle: x.oracle, hf: x.hf != null ? Number(x.hf) : null, tier: x.tier }));
  }

  /**
   * CHANGE FEED — what a block actually changed.
   *
   * The system's governing rule is that a block is the only event: whatever it touches is recomputed, whatever
   * it does not is still valid and is reused. The signal for that has been in the DB all along and nobody read
   * it, so the read-side reloaded everything every cycle: measured, 17 pools change per block out of 25,390
   * loaded — 1,500x more data than moved.
   *
   * `pool_state.block_number` is written by the indexer at the moment a pool's state changes, so "greater than
   * the block I last saw" is exactly the set of pools I must recompute. Same for token_prices.block_number.
   */
  async poolsChangedSince(chainId: number, sinceBlock: number, archetypes: string[]): Promise<Array<{ address: string; meta: unknown; r0: bigint | null; r1: bigint | null; sqrtPrice: bigint | null; liquidity: bigint | null; feePpm: number | null; block: number; ageMs: number | null }>> {
    const r = await this.pool.query<{ address: string; meta: unknown; r0: string | null; r1: string | null; sp: string | null; liq: string | null; fee_ppm: number | null; bn: string | null; age_ms: string | null }>(
      `SELECT e.address, e.meta, ps.r0::text r0, ps.r1::text r1, ps.sqrt_price::text sp, ps.liquidity::text liq, ps.fee_ppm, ps.block_number::text bn,
              (EXTRACT(EPOCH FROM (NOW()-ps.updated_at))*1000)::bigint::text AS age_ms
       FROM pool_state ps JOIN entities e ON e.chain_id=ps.chain_id AND e.address=ps.pool AND e.kind='pool'
       WHERE ps.chain_id=$1 AND ps.block_number > $2 AND e.meta->>'archetype' = ANY($3::text[])`,
      [chainId, sinceBlock, archetypes]);
    const b = (v: string | null) => (v == null ? null : BigInt(v.split(".")[0]));
    return r.rows.map((x) => ({ address: x.address, meta: x.meta, r0: b(x.r0), r1: b(x.r1), sqrtPrice: b(x.sp), liquidity: b(x.liq), feePpm: x.fee_ppm ?? null, block: x.bn ? Number(x.bn) : 0, ageMs: x.age_ms ? Number(x.age_ms) : null }));
  }

  /** Tokens whose SPOT price was recomputed after `sinceBlock` — the indexer reprices exactly the tokens whose
   * pools moved, so this is the price half of the same change feed. */
  async tokensRepricedSince(chainId: number, sinceBlock: number): Promise<Map<string, number>> {
    const r = await this.pool.query<{ token: string; price_usd: number }>(
      `SELECT token, price_usd FROM token_prices WHERE chain_id=$1 AND block_number > $2 AND price_usd > 0`, [chainId, sinceBlock]);
    const out = new Map<string, number>();
    for (const x of r.rows) out.set(x.token.toLowerCase(), x.price_usd);
    return out;
  }

  /** FULL-GRAPH LOADER source (Item 4.1): every pool of the given archetypes with its latest mirrored state,
   * in ONE query (entities ⨝ pool_state) — no per-token sampling, no archetype exclusion. length(address)=42
   * drops V4 bytes32 poolIds (separate path). State may be null (a bare pool not yet priced) — the caller
   * decides modelability; the loader never hides a pool for arbitrary reasons. */
  async graphPools(chainId: number, archetypes: string[]): Promise<Array<{ address: string; meta: unknown; r0: bigint | null; r1: bigint | null; sqrtPrice: bigint | null; liquidity: bigint | null; feePpm: number | null; block: number; ageMs: number | null }>> {
    const r = await this.pool.query<{ address: string; meta: unknown; r0: string | null; r1: string | null; sp: string | null; liq: string | null; fee_ppm: number | null; bn: string | null; age_ms: string | null }>(
      `SELECT e.address, e.meta, ps.r0::text r0, ps.r1::text r1, ps.sqrt_price::text sp, ps.liquidity::text liq, ps.fee_ppm, ps.block_number::text bn,
              (EXTRACT(EPOCH FROM (NOW()-ps.updated_at))*1000)::bigint::text AS age_ms
       FROM entities e LEFT JOIN pool_state ps ON ps.chain_id=e.chain_id AND ps.pool=e.address
       -- No length filter: the archetype allowlist IS the membership rule. length(address)=42 here was a
       -- third copy of the same silent V4 exclusion, and it would have kept V4 out even once the loader asks
       -- for it — a filter that survives the decision it was meant to implement.
       WHERE e.chain_id=$1 AND e.kind='pool' AND e.meta->>'archetype' = ANY($2::text[])`,
      [chainId, archetypes]
    );
    const b = (v: string | null) => (v == null ? null : BigInt(v.split(".")[0]));
    return r.rows.map((x) => ({ address: x.address, meta: x.meta, r0: b(x.r0), r1: b(x.r1), sqrtPrice: b(x.sp), liquidity: b(x.liq), feePpm: x.fee_ppm ?? null, block: x.bn ? Number(x.bn) : 0, ageMs: x.age_ms ? Number(x.age_ms) : null }));
  }

  /** Idempotently plants the system blacklist (test/synthetic tokens etc.). System rows
   * never overwrite a human/Scarlet edit — ON CONFLICT DO NOTHING. */
  async seedBlacklist(entries: Array<{ scope: "token" | "symbol"; value: string; tier: "exclude" | "secondary"; reason: string }>): Promise<void> {
    for (const e of entries) {
      await this.pool.query(
        `INSERT INTO signal_blacklist(scope, value, tier, source, reason) VALUES($1,$2,$3,'system',$4)
         ON CONFLICT(scope, value) DO NOTHING`,
        [e.scope, e.scope === "token" ? e.value.toLowerCase() : e.value.toUpperCase(), e.tier, e.reason]
      );
    }
  }
  async addBlacklist(v: { scope: "token" | "symbol"; value: string; tier?: "exclude" | "secondary"; source?: "system" | "scarlet"; reason?: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO signal_blacklist(scope, value, tier, source, reason) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(scope, value) DO UPDATE SET tier=EXCLUDED.tier, reason=EXCLUDED.reason, source=EXCLUDED.source`,
      [v.scope, v.scope === "token" ? v.value.toLowerCase() : v.value.toUpperCase(), v.tier ?? "exclude", v.source ?? "scarlet", v.reason ?? null]
    );
  }
  async removeBlacklist(scope: "token" | "symbol", value: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM signal_blacklist WHERE scope=$1 AND value=$2`, [scope, scope === "token" ? value.toLowerCase() : value.toUpperCase()]);
    return (r.rowCount ?? 0) > 0;
  }
  async listBlacklist(): Promise<Array<{ scope: string; value: string; tier: string; source: string; reason: string | null }>> {
    const r = await this.pool.query<{ scope: string; value: string; tier: string; source: string; reason: string | null }>(`SELECT scope, value, tier, source, reason FROM signal_blacklist ORDER BY created_at DESC`);
    return r.rows.map((row) => ({ scope: row.scope, value: row.value, tier: row.tier, source: row.source, reason: row.reason }));
  }

  /** The registry of profit surfaces (DEX factories, lending cores, vaults) keyed by standard type. */
  async upsertVenue(v: { id: string; name: string; type: string; address: string; meta?: Record<string, unknown>; addedBy?: "seed" | "scarlet" }): Promise<void> {
    await this.pool.query(
      `INSERT INTO venues(id, name, type, address, meta, added_by) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, type=EXCLUDED.type, address=EXCLUDED.address, meta=EXCLUDED.meta, enabled=TRUE`,
      [v.id.slice(0, 80), v.name.slice(0, 120), v.type.slice(0, 40), v.address.toLowerCase(), jsonParam(v.meta ?? {}), v.addedBy ?? "seed"]
    );
  }

  async listVenues(includeDisabled = false): Promise<Array<{ id: string; name: string; type: string; address: string; meta: Record<string, unknown>; enabled: boolean; addedBy: string }>> {
    const r = await this.pool.query<{ id: string; name: string; type: string; address: string; meta: Record<string, unknown>; enabled: boolean; added_by: string }>(
      `SELECT id, name, type, address, meta, enabled, added_by FROM venues ${includeDisabled ? "" : "WHERE enabled=TRUE"} ORDER BY type, id`
    );
    return r.rows.map((row) => ({ id: row.id, name: row.name, type: row.type, address: row.address, meta: row.meta, enabled: row.enabled, addedBy: row.added_by }));
  }

  async removeVenue(id: string): Promise<boolean> {
    const r = await this.pool.query(`UPDATE venues SET enabled=FALSE WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Scarlet's notebook: saves a memory under a key, overwriting if it already exists. */
  async saveMemory(key: string, category: string, content: string, tags: string[] = []): Promise<void> {
    await this.pool.query(
      `INSERT INTO scarlet_memory(key, category, content, tags) VALUES($1,$2,$3,$4)
       ON CONFLICT(key) DO UPDATE SET category=EXCLUDED.category, content=EXCLUDED.content, tags=EXCLUDED.tags, updated_at=NOW()`,
      [key.slice(0, 200), (category || "note").slice(0, 60), content.replace(/\u0000/g, "").slice(0, 8_000), tags.slice(0, 12).map((t) => t.slice(0, 40))]
    );
  }

  async getMemory(key: string): Promise<{ key: string; category: string; content: string; tags: string[]; updatedAt: string } | undefined> {
    const r = await this.pool.query<{ key: string; category: string; content: string; tags: string[]; updated_at: Date }>(`SELECT key, category, content, tags, updated_at FROM scarlet_memory WHERE key=$1`, [key]);
    const row = r.rows[0];
    return row ? { key: row.key, category: row.category, content: row.content, tags: row.tags, updatedAt: row.updated_at.toISOString() } : undefined;
  }

  async searchMemory(opts: { category?: string; search?: string; limit?: number }): Promise<Array<{ key: string; category: string; content: string; tags: string[]; updatedAt: string }>> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.category) { params.push(opts.category); conds.push(`category = $${params.length}`); }
    if (opts.search) { params.push(`%${opts.search}%`); const p = params.length; params.push(opts.search); conds.push(`(key ILIKE $${p} OR content ILIKE $${p} OR $${params.length} = ANY(tags))`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(Math.min(opts.limit ?? 20, 50));
    const r = await this.pool.query<{ key: string; category: string; content: string; tags: string[]; updated_at: Date }>(
      `SELECT key, category, content, tags, updated_at FROM scarlet_memory ${where} ORDER BY updated_at DESC LIMIT $${params.length}`, params
    );
    return r.rows.map((row) => ({ key: row.key, category: row.category, content: row.content, tags: row.tags, updatedAt: row.updated_at.toISOString() }));
  }

  /** Compact index (keys + categories, no content) so she always knows what she has saved. */
  async memoryIndex(limit = 80): Promise<Array<{ key: string; category: string; updatedAt: string }>> {
    const r = await this.pool.query<{ key: string; category: string; updated_at: Date }>(`SELECT key, category, updated_at FROM scarlet_memory ORDER BY updated_at DESC LIMIT $1`, [limit]);
    return r.rows.map((row) => ({ key: row.key, category: row.category, updatedAt: row.updated_at.toISOString() }));
  }

  async deleteMemory(key: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM scarlet_memory WHERE key=$1`, [key]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Records one human-readable entry in Scarlet's journal (a note, a thought, or an action). */
  async addJournal(kind: "note" | "thought" | "action" | "rest" | "memory" | "cycle" | "tool", content: string, meta: Record<string, unknown> = {}, cycle?: string, stream = "main"): Promise<void> {
    await this.pool.query(`INSERT INTO scarlet_journal(cycle, kind, content, meta, stream) VALUES($1,$2,$3,$4,$5)`, [cycle ?? null, kind, content.replace(/\u0000/g, "").slice(0, 4_000), jsonParam(meta), stream]);
  }

  // --- operative-state machine ---
  async logScarletState(state: string, justification: string, cycle?: string, phase = "operative"): Promise<void> {
    await this.pool.query(`INSERT INTO scarlet_state(state, justification, cycle, phase) VALUES($1,$2,$3,$4)`, [state, justification.slice(0, 500), cycle ?? null, phase]);
  }
  async latestScarletState(): Promise<{ state: string; justification: string | null; at: string } | undefined> {
    const r = await this.pool.query<{ state: string; justification: string | null; at: Date }>(`SELECT state, justification, at FROM scarlet_state WHERE phase='operative' ORDER BY at DESC LIMIT 1`);
    return r.rows[0] ? { state: r.rows[0].state, justification: r.rows[0].justification, at: r.rows[0].at.toISOString() } : undefined;
  }
  async recentScarletStates(limit = 25): Promise<Array<{ state: string; justification: string | null; at: string }>> {
    const r = await this.pool.query<{ state: string; justification: string | null; at: Date }>(`SELECT state, justification, at FROM scarlet_state ORDER BY at DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ state: x.state, justification: x.justification, at: x.at.toISOString() }));
  }

  async recentJournal(limit = 40, stream?: string): Promise<Array<{ at: string; cycle?: string; kind: string; content: string; meta: unknown }>> {
    const result = await this.pool.query<{ at: Date; cycle: string | null; kind: string; content: string; meta: unknown }>(
      `SELECT at, cycle, kind, content, meta FROM scarlet_journal ${stream ? "WHERE stream = $2" : ""} ORDER BY at DESC LIMIT $1`,
      stream ? [limit, stream] : [limit]
    );
    return result.rows.map((row) => ({ at: row.at.toISOString(), cycle: row.cycle ?? undefined, kind: row.kind, content: row.content, meta: row.meta }));
  }

  // --- cross-cycle history (chronicle + compaction) ---------------------------

  /** Journal entries after a boundary id (ASC), the raw material of the running history. */
  async journalAfter(afterId: number, limit = 6000, stream = "main"): Promise<Array<{ id: number; at: string; cycle: string | null; kind: string; content: string }>> {
    const result = await this.pool.query<{ id: string; at: Date; cycle: string | null; kind: string; content: string }>(
      `SELECT id, at, cycle, kind, content FROM scarlet_journal WHERE id > $1 AND stream = $3 ORDER BY id ASC LIMIT $2`, [afterId, limit, stream]
    );
    return result.rows.map((r) => ({ id: Number(r.id), at: r.at.toISOString(), cycle: r.cycle, kind: r.kind, content: r.content }));
  }

  /** Full uncompacted transcript of one past cycle (for recall_cycle). */
  async journalForCycle(cycle: string): Promise<Array<{ id: number; at: string; kind: string; content: string }>> {
    const result = await this.pool.query<{ id: string; at: Date; kind: string; content: string }>(
      `SELECT id, at, kind, content FROM scarlet_journal WHERE cycle=$1 ORDER BY id ASC`, [cycle]
    );
    return result.rows.map((r) => ({ id: Number(r.id), at: r.at.toISOString(), kind: r.kind, content: r.content }));
  }

  async latestSummary(stream = "main"): Promise<{ upToJournalId: number; summary: string; tokens: number } | undefined> {
    const result = await this.pool.query<{ up_to_journal_id: string; summary: string; tokens: number }>(
      `SELECT up_to_journal_id, summary, tokens FROM agent_summaries WHERE stream = $1 ORDER BY up_to_journal_id DESC LIMIT 1`, [stream]
    );
    const row = result.rows[0];
    return row ? { upToJournalId: Number(row.up_to_journal_id), summary: row.summary, tokens: row.tokens } : undefined;
  }

  async saveSummary(value: { upToJournalId: number; fromCycle: string | null; toCycle: string | null; summary: string; tokens: number }, stream = "main"): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_summaries(up_to_journal_id, from_cycle, to_cycle, summary, tokens, stream) VALUES($1,$2,$3,$4,$5,$6)`,
      [value.upToJournalId, value.fromCycle, value.toCycle, value.summary.replace(/\u0000/g, "").slice(0, 60_000), value.tokens, stream]
    );
  }

  // --- auto-flash watchers ----------------------------------------------------

  async armAutoflash(value: { label: string; marketId: string; borrower: string; target: string; signature: string; args: unknown[]; note: string; cycle: string }): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO autoflash(label, market_id, borrower, target, signature, args, note, created_cycle) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [value.label, value.marketId, value.borrower.toLowerCase(), value.target.toLowerCase(), value.signature, jsonParam(value.args), value.note, value.cycle]
    );
    return Number(result.rows[0]?.id ?? 0);
  }

  async listAutoflash(statuses: string[] = ["armed", "fired", "failed"]): Promise<Array<{ id: number; label: string | null; marketId: string | null; borrower: string | null; target: string; signature: string; args: unknown[]; status: string; note: string | null; txHash: string | null; result: unknown; createdAt: string; firedAt: string | null }>> {
    const result = await this.pool.query<{ id: string; label: string | null; market_id: string | null; borrower: string | null; target: string; signature: string; args: unknown[]; status: string; note: string | null; tx_hash: string | null; result: unknown; created_at: Date; fired_at: Date | null }>(
      `SELECT id, label, market_id, borrower, target, signature, args, status, note, tx_hash, result, created_at, fired_at FROM autoflash WHERE status = ANY($1) ORDER BY created_at DESC LIMIT 50`, [statuses]
    );
    return result.rows.map((r) => ({ id: Number(r.id), label: r.label, marketId: r.market_id, borrower: r.borrower, target: r.target, signature: r.signature, args: r.args, status: r.status, note: r.note, txHash: r.tx_hash, result: r.result, createdAt: r.created_at.toISOString(), firedAt: r.fired_at ? r.fired_at.toISOString() : null }));
  }

  async activeAutoflash(): Promise<Array<{ id: number; target: string; signature: string; args: unknown[]; label: string | null; borrower: string | null; marketId: string | null }>> {
    const result = await this.pool.query<{ id: string; target: string; signature: string; args: unknown[]; label: string | null; borrower: string | null; market_id: string | null }>(
      `SELECT id, target, signature, args, label, borrower, market_id FROM autoflash WHERE status='armed' ORDER BY created_at ASC`
    );
    return result.rows.map((r) => ({ id: Number(r.id), target: r.target, signature: r.signature, args: r.args, label: r.label, borrower: r.borrower, marketId: r.market_id }));
  }

  async killAutoflash(id: number): Promise<boolean> {
    const result = await this.pool.query(`UPDATE autoflash SET status='killed' WHERE id=$1 AND status='armed'`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async touchAutoflash(id: number): Promise<void> {
    await this.pool.query(`UPDATE autoflash SET checked_at=NOW() WHERE id=$1`, [id]);
  }

  /** Retire an armed watcher that dropped out of the top-EV set — frees a slot for a higher-EV prey. */
  async cancelAutoflash(id: number, note: string): Promise<void> {
    await this.pool.query(`UPDATE autoflash SET status='cancelled', result=$2 WHERE id=$1 AND status='armed'`, [id, jsonParam({ note })]);
  }

  async settleAutoflash(id: number, status: "fired" | "failed", value: { txHash?: string; result: unknown }): Promise<void> {
    await this.pool.query(
      `UPDATE autoflash SET status=$2, fired_at=NOW(), tx_hash=$3, result=$4 WHERE id=$1`,
      [id, status, value.txHash ?? null, jsonParam(value.result)]
    );
  }

  async saveOrgan(kind: string, address: string, txHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO organs(kind, address, tx_hash) VALUES($1,$2,$3) ON CONFLICT(kind) DO UPDATE SET address=EXCLUDED.address, tx_hash=EXCLUDED.tx_hash, deployed_at=NOW()`,
      [kind, address.toLowerCase(), txHash]
    );
  }

  async getOrgan(kind: string): Promise<{ address: string; txHash: string | null; deployedAt: string } | undefined> {
    const result = await this.pool.query<{ address: string; tx_hash: string | null; deployed_at: Date }>(`SELECT address, tx_hash, deployed_at FROM organs WHERE kind=$1`, [kind]);
    const row = result.rows[0];
    return row ? { address: row.address, txHash: row.tx_hash, deployedAt: row.deployed_at.toISOString() } : undefined;
  }

  // --- fresh-launch discovery -------------------------------------------------

  async saveDiscoveredPool(value: { pool: string; dex: string; token0: string; token1: string; newToken: string | null; newSymbol: string | null; fee: number | null; liquidityUsd: number | null; block: bigint }): Promise<void> {
    await this.pool.query(
      `INSERT INTO discovered_pools(pool, dex, token0, token1, new_token, new_symbol, fee, liquidity_usd, discovered_block)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(pool) DO UPDATE SET liquidity_usd=EXCLUDED.liquidity_usd, new_symbol=COALESCE(EXCLUDED.new_symbol, discovered_pools.new_symbol)`,
      [value.pool.toLowerCase(), value.dex, value.token0.toLowerCase(), value.token1.toLowerCase(), value.newToken?.toLowerCase() ?? null, value.newSymbol, value.fee, value.liquidityUsd, value.block.toString()]
    );
  }

  async recentDiscoveredPools(minutes = 180, limit = 15): Promise<Array<{ pool: string; dex: string; newToken: string | null; newSymbol: string | null; fee: number | null; liquidityUsd: number | null; discoveredAt: string }>> {
    const result = await this.pool.query<{ pool: string; dex: string; new_token: string | null; new_symbol: string | null; fee: number | null; liquidity_usd: string | null; discovered_at: Date }>(
      `SELECT pool, dex, new_token, new_symbol, fee, liquidity_usd::text, discovered_at FROM discovered_pools WHERE discovered_at > now() - ($1 || ' minutes')::interval ORDER BY discovered_at DESC LIMIT $2`,
      [String(minutes), limit]
    );
    return result.rows.map((r) => ({ pool: r.pool, dex: r.dex, newToken: r.new_token, newSymbol: r.new_symbol, fee: r.fee, liquidityUsd: r.liquidity_usd != null ? Number(r.liquidity_usd) : null, discoveredAt: r.discovered_at.toISOString() }));
  }

  async saveObservation(value: NetworkObservation): Promise<void> {
    await this.pool.query(
      `INSERT INTO network_observations(observed_at, primary_block, secondary_block, block_gap, gas_price_wei, primary_healthy, secondary_healthy, primary_rpc, secondary_rpc, source)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [value.observedAt, value.primaryBlock.toString(), value.secondaryBlock.toString(), value.blockGap.toString(), value.gasPriceWei.toString(), value.primaryHealthy, value.secondaryHealthy, value.primaryRpc, value.secondaryRpc, value.source]
    );
  }

  async latestNetworkObservation(): Promise<NetworkObservation | undefined> {
    const result = await this.pool.query<{ observed_at: Date; primary_block: string; secondary_block: string; block_gap: string; gas_price_wei: string; primary_healthy: boolean; secondary_healthy: boolean; primary_rpc: string; secondary_rpc: string; source: "poll" | "websocket" }>(
      `SELECT observed_at, primary_block::text, secondary_block::text, block_gap::text, gas_price_wei::text, primary_healthy, secondary_healthy, primary_rpc, secondary_rpc, source FROM network_observations ORDER BY observed_at DESC LIMIT 1`
    );
    const row = result.rows[0];
    if (!row || !row.primary_rpc || !row.secondary_rpc) return undefined;
    return { observedAt: row.observed_at, primaryBlock: BigInt(row.primary_block), secondaryBlock: BigInt(row.secondary_block), blockGap: BigInt(row.block_gap), gasPriceWei: BigInt(row.gas_price_wei), primaryHealthy: row.primary_healthy, secondaryHealthy: row.secondary_healthy, primaryRpc: row.primary_rpc, secondaryRpc: row.secondary_rpc, source: row.source };
  }

  async savePortfolio(value: PortfolioSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO portfolio_snapshots(observed_at, wallet_address, bera, wbera, usdc_e, honey, nav_usd, daily_loss_usd, locked_usd, data_healthy, bera_usd, honey_usd)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [value.observedAt, value.walletAddress ?? null, value.bera, value.wbera, value.usdcE, value.honey, value.estimatedNavUsd, value.dailyLossUsd, value.lockedUsd, value.dataHealthy, value.beraUsd, value.honeyUsd]
    );
  }

  async saveDecision(id: string, decision: Decision, status = "proposed", modelResponse?: unknown, portfolio?: PortfolioSnapshot, evidence?: unknown, executionPlan?: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO decisions(id, decision, status, model_response, portfolio, evidence, execution_plan) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, decision, status, modelResponse ?? null, portfolio ?? null, evidence ?? null, executionPlan ?? null]
    );
  }

  async updateDecision(id: string, status: string, outcome: unknown): Promise<void> {
    await this.pool.query(`UPDATE decisions SET status=$2, outcome=$3 WHERE id=$1`, [id, status, jsonParam(outcome)]);
  }

  async updateDecisionExecutionPlan(id: string, plan: unknown): Promise<void> {
    await this.pool.query(`UPDATE decisions SET execution_plan=$2 WHERE id=$1`, [id, jsonParam(plan)]);
  }

  async addLedger(category: string, amountUsd: number, metadata: Record<string, unknown> = {}, txHash?: string): Promise<void> {
    await this.pool.query(`INSERT INTO ledger_entries(category, amount_usd, metadata, tx_hash) VALUES($1,$2,$3,$4)`, [category, amountUsd, jsonParam(metadata), txHash ?? null]);
  }

  /** Records capital movement once per receipt; gas is stored separately by settleExecution. */
  async addExecutionCapitalDelta(txHash: string, amountUsd: number, metadata: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO ledger_entries(category, amount_usd, metadata, tx_hash)
       VALUES('execution_capital_delta',$1,$2,$3)
       ON CONFLICT (tx_hash) WHERE category='execution_capital_delta' AND tx_hash IS NOT NULL DO NOTHING`,
      [amountUsd, jsonParam(metadata), txHash]
    );
  }

  async saveMarketSnapshot(source: string, key: string, payload: unknown): Promise<void> {
    await this.pool.query(`INSERT INTO market_snapshots(source, snapshot_key, payload) VALUES($1,$2,$3)`, [source, key, jsonParam(payload)]);
  }

  async saveStrategyHypotheses(hypotheses: unknown[]): Promise<void> {
    for (const hypothesis of hypotheses) await this.pool.query(`INSERT INTO strategy_hypotheses(hypothesis, evidence) VALUES($1,$2)`, [jsonParam(hypothesis), jsonParam((hypothesis as { evidence?: unknown }).evidence ?? [])]);
  }

  async recentStrategyHypotheses(limit = 12): Promise<unknown[]> {
    const result = await this.pool.query<{ hypothesis: unknown }>(`SELECT hypothesis FROM strategy_hypotheses ORDER BY created_at DESC LIMIT $1`, [limit]);
    return result.rows.map((row) => row.hypothesis);
  }

  /**
   * Persist the complete, non-secret MiniMax research trace even when the model
   * concludes that there is no eligible hypothesis. This makes absence of a
   * strategy an auditable result rather than an unobservable log line.
   */
  async saveResearchTrace(value: { status: string; context: unknown; modelResponse?: unknown; hypotheses?: unknown[]; error?: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO research_traces(status, context, model_response, parsed_hypotheses, error) VALUES($1,$2,$3,$4,$5)`,
      [value.status, jsonParam(value.context), value.modelResponse === undefined ? null : jsonParam(value.modelResponse), jsonParam(value.hypotheses ?? []), value.error ?? null]
    );
  }

  async recentResearchTraces(limit = 4): Promise<Array<{ createdAt: string; status: string; hypotheses: unknown; modelResponse: unknown; error?: string }>> {
    const result = await this.pool.query<{ created_at: Date; status: string; parsed_hypotheses: unknown; model_response: unknown; error: string | null }>(
      `SELECT created_at, status, parsed_hypotheses, model_response, error FROM research_traces ORDER BY created_at DESC LIMIT $1`, [limit]
    );
    return result.rows.map((row) => ({ createdAt: row.created_at.toISOString(), status: row.status, hypotheses: row.parsed_hypotheses, modelResponse: row.model_response, error: row.error ?? undefined }));
  }

  async latestMarketSnapshot<T>(source: string, key: string): Promise<T | undefined> {
    const result = await this.pool.query<{ payload: T }>(`SELECT payload FROM market_snapshots WHERE source=$1 AND snapshot_key=$2 ORDER BY observed_at DESC LIMIT 1`, [source, key]);
    return result.rows[0]?.payload;
  }

  /** Latest snapshot with its observation time — for e.g. the baseline/reset timestamp. */
  async latestSnapshotAt<T>(source: string, key: string): Promise<{ payload: T; observedAt: string } | undefined> {
    const r = await this.pool.query<{ payload: T; observed_at: Date }>(`SELECT payload, observed_at FROM market_snapshots WHERE source=$1 AND snapshot_key=$2 ORDER BY observed_at DESC LIMIT 1`, [source, key]);
    return r.rows[0] ? { payload: r.rows[0].payload, observedAt: new Date(r.rows[0].observed_at).toISOString() } : undefined;
  }

  async saveProtocolVerification(value: ProtocolVerification): Promise<void> {
    await this.pool.query(
      `INSERT INTO protocol_verifications(protocol, address, verified_at, block_number, code_hash, status, details)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(protocol, address, block_number) DO UPDATE SET status=EXCLUDED.status, details=EXCLUDED.details, code_hash=EXCLUDED.code_hash`,
      [value.protocol, value.address.toLowerCase(), value.verifiedAt, value.blockNumber.toString(), value.codeHash, value.status, value.details]
    );
  }

  async upsertPosition(value: { strategyId: string; protocolId: string; vaultAddress: string; assetAddress: string; sharesRaw: bigint; assetsRaw: bigint; valueUsd: number; status: "active" | "closed"; metadata: Record<string, unknown>; kind?: string }): Promise<void> {
    // Reconciliation path: refreshes market values only, never the annotation columns
    // (kind/label/thesis_note/entry_at/opened_cycle), which belong to open/annotate.
    await this.pool.query(
      `INSERT INTO positions(strategy_id, protocol_id, vault_address, asset_address, shares_raw, assets_raw, value_usd, status, closed_at, metadata, entry_value_usd, kind, entry_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8='closed' THEN NOW() ELSE NULL END,$9,$7,$10,NOW())
       ON CONFLICT(protocol_id, vault_address) DO UPDATE SET
         strategy_id=EXCLUDED.strategy_id, asset_address=EXCLUDED.asset_address,
         shares_raw=EXCLUDED.shares_raw, assets_raw=EXCLUDED.assets_raw, value_usd=EXCLUDED.value_usd,
         status=EXCLUDED.status, last_reconciled_at=NOW(),
         closed_at=CASE WHEN EXCLUDED.status='closed' THEN NOW() ELSE NULL END,
         opened_at=CASE WHEN positions.status='closed' AND EXCLUDED.status='active' THEN NOW() ELSE positions.opened_at END,
         entry_value_usd=CASE WHEN positions.status='closed' AND EXCLUDED.status='active' THEN EXCLUDED.value_usd ELSE COALESCE(positions.entry_value_usd, EXCLUDED.value_usd) END,
         metadata=EXCLUDED.metadata`,
      [value.strategyId, value.protocolId, value.vaultAddress.toLowerCase(), value.assetAddress.toLowerCase(), value.sharesRaw.toString(), value.assetsRaw.toString(), value.valueUsd, value.status, jsonParam(value.metadata), value.kind ?? "erc4626"]
    );
  }

  /** Scarlet-opened position: she supplies only label/note/instrument; every USD
   * value comes from the on-chain read the caller passes (she cannot set a value). */
  async openPosition(value: { kind: string; protocolId: string; vaultAddress: string; assetAddress: string; sharesRaw: bigint; assetsRaw: bigint; valueUsd: number; label: string; thesisNote: string; cycle: string; metadata: Record<string, unknown> }): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO positions(strategy_id, protocol_id, vault_address, asset_address, shares_raw, assets_raw, value_usd, status, metadata, entry_value_usd, kind, label, thesis_note, entry_at, opened_cycle)
       VALUES('agent_open',$1,$2,$3,$4,$5,$6,'active',$7,$6,$8,$9,$10,NOW(),$11)
       ON CONFLICT(protocol_id, vault_address) DO UPDATE SET
         status='active', label=EXCLUDED.label, thesis_note=EXCLUDED.thesis_note, kind=EXCLUDED.kind,
         value_usd=EXCLUDED.value_usd, shares_raw=EXCLUDED.shares_raw, assets_raw=EXCLUDED.assets_raw,
         opened_cycle=EXCLUDED.opened_cycle, last_reconciled_at=NOW(),
         opened_at=CASE WHEN positions.status='closed' THEN NOW() ELSE positions.opened_at END,
         entry_at=CASE WHEN positions.status='closed' THEN NOW() ELSE positions.entry_at END,
         entry_value_usd=CASE WHEN positions.status='closed' THEN EXCLUDED.value_usd ELSE COALESCE(positions.entry_value_usd, EXCLUDED.value_usd) END
       RETURNING id`,
      [value.protocolId, value.vaultAddress.toLowerCase(), value.assetAddress.toLowerCase(), value.sharesRaw.toString(), value.assetsRaw.toString(), value.valueUsd, jsonParam(value.metadata), value.kind, value.label, value.thesisNote, value.cycle]
    );
    return Number(result.rows[0]?.id ?? 0);
  }

  /** Edits ONLY the thesis note (her reasoning). Values are never touched here. */
  async annotatePosition(idOrLabel: string, note: string): Promise<boolean> {
    const byId = /^\d+$/.test(idOrLabel);
    const result = await this.pool.query(
      `UPDATE positions SET thesis_note=$2 WHERE ${byId ? "id=$1::bigint" : "label=$1"} AND status='active'`,
      [idOrLabel, note]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async closePosition(idOrLabel: string): Promise<boolean> {
    const byId = /^\d+$/.test(idOrLabel);
    const result = await this.pool.query(
      `UPDATE positions SET status='closed', closed_at=NOW() WHERE ${byId ? "id=$1::bigint" : "label=$1"} AND status='active'`,
      [idOrLabel]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async activePositions(): Promise<Array<{ id: number; kind: string; label: string | null; thesisNote: string | null; openedCycle: string | null; strategyId: string; protocolId: string; vaultAddress: string; assetAddress: string; sharesRaw: bigint; assetsRaw: bigint; valueUsd: number; entryValueUsd: number; pnlUsd: number; pnlPct: number; openedAt: string; metadata: Record<string, unknown> }>> {
    const result = await this.pool.query<{ id: string; kind: string | null; label: string | null; thesis_note: string | null; opened_cycle: string | null; strategy_id: string; protocol_id: string; vault_address: string; asset_address: string; shares_raw: string; assets_raw: string; value_usd: string; entry_value_usd: string | null; opened_at: Date; metadata: Record<string, unknown> }>(
      `SELECT id, kind, label, thesis_note, opened_cycle, strategy_id, protocol_id, vault_address, asset_address, shares_raw::text, assets_raw::text, value_usd::text, entry_value_usd::text, opened_at, metadata FROM positions WHERE status='active' ORDER BY opened_at ASC`
    );
    return result.rows.map((row) => {
      const valueUsd = Number(row.value_usd);
      const entryValueUsd = row.entry_value_usd != null ? Number(row.entry_value_usd) : valueUsd;
      const pnlUsd = valueUsd - entryValueUsd;
      return { id: Number(row.id), kind: row.kind ?? "erc4626", label: row.label, thesisNote: row.thesis_note, openedCycle: row.opened_cycle, strategyId: row.strategy_id, protocolId: row.protocol_id, vaultAddress: row.vault_address, assetAddress: row.asset_address, sharesRaw: BigInt(row.shares_raw), assetsRaw: BigInt(row.assets_raw), valueUsd, entryValueUsd, pnlUsd, pnlPct: entryValueUsd > 0 ? pnlUsd / entryValueUsd * 100 : 0, openedAt: row.opened_at.toISOString(), metadata: row.metadata };
    });
  }

  async recentDecisions(limit = 8): Promise<Array<{ id: string; createdAt: string; decision: Decision; status: string; outcome: unknown }>> {
    const result = await this.pool.query<{ id: string; created_at: Date; decision: Decision; status: string; outcome: unknown }>(
      `SELECT id, created_at, decision, status, outcome FROM decisions ORDER BY created_at DESC LIMIT $1`, [limit]
    );
    return result.rows.map((row) => ({ id: row.id, createdAt: row.created_at.toISOString(), decision: row.decision, status: row.status, outcome: row.outcome }));
  }

  async recordExecution(value: { decisionId: string; protocolId: string; txHash: string; target: string; calldata: string; valueWei: bigint; gasLimit: bigint; beraUsdAtSubmission: number; status: string; position?: unknown }): Promise<void> {
    await this.pool.query(
      `INSERT INTO executions(decision_id, protocol_id, tx_hash, target, calldata, value_wei, gas_limit, bera_usd_at_submission, status, position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [value.decisionId, value.protocolId, value.txHash, value.target.toLowerCase(), value.calldata, value.valueWei.toString(), value.gasLimit.toString(), value.beraUsdAtSubmission, value.status, value.position ? jsonParam(value.position) : null]
    );
  }

  /** A write-path is never retried automatically after either a submission or a reverted receipt. */
  async hasProtocolAttempt(protocolId: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM executions WHERE protocol_id=$1 AND status IN ('submitted','success','reverted')) AS exists`, [protocolId]);
    return Boolean(result.rows[0]?.exists);
  }

  async hasSuccessfulProtocolExecution(protocolId: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM executions WHERE protocol_id=$1 AND status='success') AS exists`, [protocolId]);
    return Boolean(result.rows[0]?.exists);
  }

  async successfulProtocolExecutionAt(protocolId: string): Promise<Date | undefined> {
    const result = await this.pool.query<{ submitted_at: Date }>(`SELECT submitted_at FROM executions WHERE protocol_id=$1 AND status='success' ORDER BY submitted_at DESC LIMIT 1`, [protocolId]);
    return result.rows[0]?.submitted_at;
  }

  async finalizeExecution(txHash: string, value: { status: string; gasUsed?: bigint; effectiveGasPriceWei?: bigint; receipt: unknown }): Promise<void> {
    await this.pool.query(
      `UPDATE executions SET status=$2, gas_used=$3, effective_gas_price_wei=$4, receipt=$5 WHERE tx_hash=$1`,
      [txHash, value.status, value.gasUsed?.toString() ?? null, value.effectiveGasPriceWei?.toString() ?? null, jsonParam(value.receipt)]
    );
  }

  /** Atomically stores a chain receipt and its single gas ledger entry. */
  async settleExecution(txHash: string, value: { status: string; gasUsed: bigint; effectiveGasPriceWei: bigint; receipt: unknown; beraUsdAtSubmission: number; outcome: unknown }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE executions SET status=$2, gas_used=$3, effective_gas_price_wei=$4, receipt=$5 WHERE tx_hash=$1`,
        [txHash, value.status, value.gasUsed.toString(), value.effectiveGasPriceWei.toString(), jsonParam(value.receipt)]
      );
      const gasUsd = Number(value.gasUsed * value.effectiveGasPriceWei) / 1e18 * value.beraUsdAtSubmission;
      if (Number.isFinite(gasUsd) && gasUsd >= 0) {
        await client.query(
          `INSERT INTO ledger_entries(category, amount_usd, metadata, tx_hash)
           VALUES('gas',$1,$2,$3)
           ON CONFLICT (tx_hash) WHERE category='gas' AND tx_hash IS NOT NULL DO NOTHING`,
          [-gasUsd, jsonParam({ receiptStatus: value.status, gasUsed: value.gasUsed.toString(), effectiveGasPriceWei: value.effectiveGasPriceWei.toString(), beraUsdAtSubmission: value.beraUsdAtSubmission }), txHash]
        );
      }
      await client.query(
        `UPDATE decisions SET status=$2, outcome=$3
         WHERE id=(SELECT decision_id FROM executions WHERE tx_hash=$1)`,
        [txHash, value.status, jsonParam(value.outcome)]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async unsettledExecutions(): Promise<Array<{ txHash: string; beraUsdAtSubmission?: number; position?: unknown }>> {
    const result = await this.pool.query<{ tx_hash: string; bera_usd_at_submission: string | null; position: unknown }>(`
      SELECT e.tx_hash, e.bera_usd_at_submission::text, e.position FROM executions e
      WHERE e.status='submitted' OR (e.status IN ('success','reverted') AND NOT EXISTS (
        SELECT 1 FROM ledger_entries l WHERE l.category='gas' AND l.tx_hash=e.tx_hash
      )) ORDER BY e.submitted_at ASC
    `);
    return result.rows.map((row) => ({ txHash: row.tx_hash, beraUsdAtSubmission: row.bera_usd_at_submission === null ? undefined : Number(row.bera_usd_at_submission), position: row.position ?? undefined }));
  }

  async scanCursor(key: string): Promise<bigint | undefined> {
    const result = await this.pool.query<{ block_number: string }>(`SELECT block_number::text FROM scan_cursors WHERE scanner_key=$1`, [key]);
    return result.rows[0] ? BigInt(result.rows[0].block_number) : undefined;
  }

  async saveScanCursor(key: string, blockNumber: bigint): Promise<void> {
    await this.pool.query(
      `INSERT INTO scan_cursors(scanner_key, block_number) VALUES($1,$2)
       ON CONFLICT(scanner_key) DO UPDATE SET block_number=EXCLUDED.block_number, updated_at=NOW()`, [key, blockNumber.toString()]
    );
  }

  async upsertBendAccounts(marketId: string, accounts: string[], blockNumber: bigint): Promise<void> {
    if (!accounts.length) return;
    await this.pool.query(
      `INSERT INTO bend_accounts(market_id, account, first_seen_block, last_seen_block)
       SELECT $1, lower(value), $2, $2 FROM unnest($3::text[]) AS value
       ON CONFLICT(market_id, account) DO UPDATE SET last_seen_block=EXCLUDED.last_seen_block`,
      [marketId.toLowerCase(), blockNumber.toString(), accounts]
    );
  }

  async bendAccounts(marketId: string): Promise<string[]> {
    const result = await this.pool.query<{ account: string }>(`SELECT account FROM bend_accounts WHERE market_id=$1`, [marketId.toLowerCase()]);
    return result.rows.map((row) => row.account);
  }

  async nextBendAccountsForSnapshot(marketId: string, limit: number): Promise<string[]> {
    const result = await this.pool.query<{ account: string }>(
      `SELECT account FROM bend_accounts WHERE market_id=$1
       ORDER BY last_position_checked_at ASC NULLS FIRST, last_seen_block DESC, account ASC LIMIT $2`,
      [marketId.toLowerCase(), limit]
    );
    return result.rows.map((row) => row.account);
  }

  async markBendAccountsSnapshot(marketId: string, accounts: string[], observedAt: Date): Promise<void> {
    if (!accounts.length) return;
    await this.pool.query(`UPDATE bend_accounts SET last_position_checked_at=$3 WHERE market_id=$1 AND account = ANY($2::text[])`, [marketId.toLowerCase(), accounts.map((account) => account.toLowerCase()), observedAt]);
  }

  async bendAccountCount(marketId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM bend_accounts WHERE market_id=$1`, [marketId.toLowerCase()]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async saveBendPosition(value: { observedAt: Date; blockNumber: bigint; marketId: string; account: string; loanToken: string; collateralToken: string; oracle: string; borrowAssets: bigint; collateral: bigint; lltv: bigint; oraclePrice: bigint; healthFactorWad?: bigint }): Promise<void> {
    await this.pool.query(
      `INSERT INTO bend_positions(observed_at, block_number, market_id, account, loan_token, collateral_token, oracle, borrow_assets, collateral, lltv, oracle_price, health_factor_wad, liquidatable)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [value.observedAt, value.blockNumber.toString(), value.marketId.toLowerCase(), value.account.toLowerCase(), value.loanToken.toLowerCase(), value.collateralToken.toLowerCase(), value.oracle.toLowerCase(), value.borrowAssets.toString(), value.collateral.toString(), value.lltv.toString(), value.oraclePrice.toString(), value.healthFactorWad?.toString() ?? null, value.healthFactorWad !== undefined && value.healthFactorWad <= 10n ** 18n]
    );
  }

  async recordOfficialDocument(url: string, contentHash: string, contentLength: number): Promise<boolean> {
    const previous = await this.pool.query<{ content_hash: string }>(`SELECT content_hash FROM official_documents WHERE url=$1 ORDER BY observed_at DESC LIMIT 1`, [url]);
    const changed = previous.rows[0]?.content_hash !== contentHash;
    await this.pool.query(`INSERT INTO official_documents(url, content_hash, content_length, changed) VALUES($1,$2,$3,$4) ON CONFLICT(url, content_hash) DO NOTHING`, [url, contentHash, contentLength, changed]);
    return changed;
  }

  async recentOfficialDocuments(limit = 12): Promise<Array<{ url: string; hash: string; changed: boolean; observedAt: string }>> {
    const result = await this.pool.query<{ url: string; content_hash: string; changed: boolean; observed_at: Date }>(`SELECT DISTINCT ON (url) url, content_hash, changed, observed_at FROM official_documents ORDER BY url, observed_at DESC LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ url: row.url, hash: row.content_hash, changed: row.changed, observedAt: row.observed_at.toISOString() }));
  }

  async dailyLossUsd(): Promise<number> {
    const result = await this.pool.query<{ loss: string }>(`
      SELECT COALESCE(SUM(CASE WHEN amount_usd < 0 THEN -amount_usd ELSE 0 END), 0)::text AS loss
      FROM ledger_entries WHERE occurred_at >= NOW() - INTERVAL '24 hours'
    `);
    return Number(result.rows[0]?.loss ?? 0);
  }

  async ledgerSummary(hours?: number): Promise<{ netUsd: number; gasUsd: number }> {
    const interval = hours === undefined ? undefined : `${hours} hours`;
    const result = await this.pool.query<{ net: string; gas: string }>(`
      SELECT COALESCE(SUM(amount_usd),0)::text AS net,
        COALESCE(SUM(CASE WHEN category='gas' THEN amount_usd ELSE 0 END),0)::text AS gas
      FROM ledger_entries WHERE ($1::text IS NULL OR occurred_at >= NOW() - $1::text::interval)
    `, [interval ?? null]);
    return { netUsd: Number(result.rows[0]?.net ?? 0), gasUsd: Number(result.rows[0]?.gas ?? 0) };
  }

  async miniMaxUsageSummary(hours?: number): Promise<MiniMaxUsageSummary> {
    const interval = hours === undefined ? undefined : `${hours} hours`;
    const result = await this.pool.query<{ model_response: unknown }>(
      `SELECT model_response FROM decisions WHERE model_response IS NOT NULL AND ($1::text IS NULL OR created_at >= NOW() - $1::text::interval)`, [interval ?? null]
    );
    return summarizeMiniMaxUsage(result.rows.map((row) => row.model_response));
  }

  async latestDecision(): Promise<{ id: string; decision: Decision; status: string } | undefined> {
    const result = await this.pool.query<{ id: string; decision: Decision; status: string }>(`SELECT id, decision, status FROM decisions ORDER BY created_at DESC LIMIT 1`);
    return result.rows[0];
  }

  async decisionByIdPrefix(prefix: string): Promise<{ id: string; createdAt: string; decision: Decision; status: string; outcome: unknown } | undefined> {
    const result = await this.pool.query<{ id: string; created_at: Date; decision: Decision; status: string; outcome: unknown }>(
      `SELECT id, created_at, decision, status, outcome FROM decisions WHERE id::text ILIKE $1 ORDER BY created_at DESC LIMIT 1`, [`${prefix}%`]
    );
    const row = result.rows[0];
    return row ? { id: row.id, createdAt: row.created_at.toISOString(), decision: row.decision, status: row.status, outcome: row.outcome } : undefined;
  }

  async latestPortfolio(): Promise<PortfolioSnapshot | undefined> {
    const result = await this.pool.query<{ observed_at: Date; wallet_address: string | null; bera: string; wbera: string; usdc_e: string; honey: string; nav_usd: string; daily_loss_usd: string; locked_usd: string; data_healthy: boolean; bera_usd: string; honey_usd: string }>(
      `SELECT observed_at, wallet_address, bera::text, wbera::text, usdc_e::text, honey::text, nav_usd::text, daily_loss_usd::text, locked_usd::text, data_healthy, bera_usd::text, honey_usd::text FROM portfolio_snapshots ORDER BY observed_at DESC LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { observedAt: row.observed_at.toISOString(), walletAddress: row.wallet_address ?? undefined, bera: Number(row.bera), wbera: Number(row.wbera), usdcE: Number(row.usdc_e), honey: Number(row.honey), baseAsset: "BERA", baseAssetBalance: Number(row.bera) + Number(row.wbera), estimatedNavUsd: Number(row.nav_usd), beraUsd: Number(row.bera_usd), honeyUsd: Number(row.honey_usd), dailyLossUsd: Number(row.daily_loss_usd), lockedUsd: Number(row.locked_usd), dataHealthy: row.data_healthy };
  }

  async observationGate(primaryRpc: string, secondaryRpc: string, hours: number, allowedGapSeconds: number, minimumHealthyRatio = 1): Promise<{ startedAt?: string; elapsedSeconds: number; sampleCount: number; unhealthyCount: number; headSkewCount: number; healthyRatio: number; recentHealthyCount: number; maxGapSeconds: number; ready: boolean }> {
    const result = await this.pool.query<{ started_at: Date | null; elapsed_seconds: string; sample_count: string; unhealthy_count: string; head_skew_count: string; recent_healthy_count: string; max_gap_seconds: string }>(`
      WITH scoped AS (
        SELECT observed_at, primary_healthy, secondary_healthy, block_gap,
          EXTRACT(EPOCH FROM observed_at - lag(observed_at) OVER (ORDER BY observed_at)) AS gap_seconds
        FROM network_observations
        WHERE primary_rpc=$1 AND secondary_rpc=$2 AND observed_at >= NOW() - ($3::text || ' hours')::interval
      )
      SELECT min(observed_at) AS started_at,
        COALESCE(EXTRACT(EPOCH FROM NOW() - min(observed_at)), 0)::text AS elapsed_seconds,
        count(*)::text AS sample_count,
        count(*) FILTER (WHERE NOT primary_healthy OR NOT secondary_healthy)::text AS unhealthy_count,
        count(*) FILTER (WHERE block_gap > 1)::text AS head_skew_count,
        (SELECT count(*)::text FROM (
          SELECT primary_healthy, secondary_healthy, block_gap FROM scoped ORDER BY observed_at DESC LIMIT 5
        ) recent WHERE primary_healthy AND secondary_healthy AND block_gap <= 1) AS recent_healthy_count,
        -- The final gap matters just as much as a gap between two samples.  A
        -- healthy historical burst followed by a stalled collector must never
        -- satisfy an execution gate.
        GREATEST(
          COALESCE(max(gap_seconds), 0),
          COALESCE(EXTRACT(EPOCH FROM NOW() - max(observed_at)), 0)
        )::text AS max_gap_seconds
      FROM scoped`, [primaryRpc, secondaryRpc, hours]);
    const row = result.rows[0];
    const elapsedSeconds = Number(row?.elapsed_seconds ?? 0);
    const sampleCount = Number(row?.sample_count ?? 0);
    const unhealthyCount = Number(row?.unhealthy_count ?? 0);
    const headSkewCount = Number(row?.head_skew_count ?? 0);
    const healthyRatio = sampleCount === 0 ? 0 : (sampleCount - unhealthyCount) / sampleCount;
    const recentHealthyCount = Number(row?.recent_healthy_count ?? 0);
    const maxGapSeconds = Number(row?.max_gap_seconds ?? 0);
    // `scoped` is a rolling window, so its oldest sample is necessarily a few
    // milliseconds newer than the exact lower time boundary.  Requiring a full
    // mathematical window made readiness unreachable forever.  Permit only one
    // configured sampling gap at the lower boundary; all internal and trailing
    // gaps remain bounded above.
    const durationSeconds = hours * 3_600;
    const lowerBoundaryCovered = rollingWindowCovered(elapsedSeconds, durationSeconds, allowedGapSeconds);
    // A head can advance between two independent RPC requests. We preserve a
    // strict fresh five-sample tail and validate both RPCs again at execution,
    // while allowing a small bounded amount of such sampling noise historically.
    return { startedAt: row?.started_at?.toISOString(), elapsedSeconds, sampleCount, unhealthyCount, headSkewCount, healthyRatio, recentHealthyCount, maxGapSeconds, ready: lowerBoundaryCovered && sampleCount > hours * 900 && healthyRatio >= minimumHealthyRatio && recentHealthyCount === 5 && maxGapSeconds <= allowedGapSeconds };
  }

  /**
   * Fast, production-only bootstrap for the WBERA wrapper. It never authorizes
   * approvals, swaps, deposits, or any third-party protocol interaction.
   */
  async bootstrapObservationGate(primaryRpc: string, secondaryRpc: string, minutes: number, allowedGapSeconds: number, minimumHealthyRatio: number): Promise<{ startedAt?: string; elapsedSeconds: number; sampleCount: number; unhealthyCount: number; headSkewCount: number; healthyRatio: number; recentHealthyCount: number; maxGapSeconds: number; ready: boolean }> {
    const hours = minutes / 60;
    const result = await this.observationGate(primaryRpc, secondaryRpc, hours, allowedGapSeconds, minimumHealthyRatio);
    // The collector samples every two seconds; require enough coverage even if
    // WebSocket triggers coalesce with polls.
    return { ...result, ready: result.ready && result.sampleCount >= minutes * 20 };
  }

  /**
   * Protocol-specific evidence gate. Discovery APIs never satisfy it: each sample
   * is a persisted on-chain verification and the contract bytecode must remain stable.
   */
  async protocolObservationGate(protocol: ProtocolVerification["protocol"], address: string, hours: number): Promise<{ startedAt?: string; elapsedSeconds: number; sampleCount: number; rejectedCount: number; codeHashCount: number; maxGapSeconds: number; ready: boolean }> {
    const result = await this.pool.query<{ started_at: Date | null; elapsed_seconds: string; sample_count: string; rejected_count: string; code_hash_count: string; max_gap_seconds: string }>(`
      WITH scoped AS (
        SELECT verified_at, status, code_hash,
          EXTRACT(EPOCH FROM verified_at - lag(verified_at) OVER (ORDER BY verified_at)) AS gap_seconds
        FROM protocol_verifications
        WHERE protocol=$1 AND lower(address)=lower($2) AND verified_at >= NOW() - ($3::text || ' hours')::interval
      )
      SELECT min(verified_at) AS started_at,
        COALESCE(EXTRACT(EPOCH FROM NOW() - min(verified_at)), 0)::text AS elapsed_seconds,
        count(*)::text AS sample_count,
        count(*) FILTER (WHERE status <> 'verified')::text AS rejected_count,
        count(DISTINCT code_hash) FILTER (WHERE status='verified')::text AS code_hash_count,
        GREATEST(
          COALESCE(max(gap_seconds), 0),
          COALESCE(EXTRACT(EPOCH FROM NOW() - max(verified_at)), 0)
        )::text AS max_gap_seconds
      FROM scoped`, [protocol, address, hours]);
    const row = result.rows[0];
    const elapsedSeconds = Number(row?.elapsed_seconds ?? 0);
    const sampleCount = Number(row?.sample_count ?? 0);
    const rejectedCount = Number(row?.rejected_count ?? 0);
    const codeHashCount = Number(row?.code_hash_count ?? 0);
    const maxGapSeconds = Number(row?.max_gap_seconds ?? 0);
    // This is also a rolling query: accept its lower boundary only within the
    // allowed verifier cadence, while rejecting any internal or trailing gap.
    const lowerBoundaryCovered = rollingWindowCovered(elapsedSeconds, hours * 3_600, 600);
    // Research runs every five minutes; 8 samples/hour leaves room for benign scheduling jitter.
    return { startedAt: row?.started_at?.toISOString(), elapsedSeconds, sampleCount, rejectedCount, codeHashCount, maxGapSeconds, ready: lowerBoundaryCovered && sampleCount >= hours * 8 && rejectedCount === 0 && codeHashCount === 1 && maxGapSeconds <= 600 };
  }

  async latestVerifiedCodeHash(protocol: ProtocolVerification["protocol"], address: string): Promise<string | undefined> {
    const result = await this.pool.query<{ code_hash: string }>(`SELECT code_hash FROM protocol_verifications WHERE protocol=$1 AND lower(address)=lower($2) AND status='verified' ORDER BY verified_at DESC LIMIT 1`, [protocol, address]);
    return result.rows[0]?.code_hash;
  }

  async saveOpportunityCandidate(value: { fingerprint: string; kind: string; protocol: string; blockNumber?: bigint; qualified: boolean; expectedNetProfitUsd?: number; reason: string; evidence: unknown }): Promise<void> {
    await this.pool.query(
      `INSERT INTO opportunity_candidates(fingerprint, kind, protocol, block_number, qualified, expected_net_profit_usd, reason, evidence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(fingerprint) DO NOTHING`,
      [value.fingerprint, value.kind, value.protocol, value.blockNumber?.toString() ?? null, value.qualified, value.expectedNetProfitUsd ?? null, value.reason, jsonParam(value.evidence)]
    );
  }

  async opportunityGate(hours = 24 * 14, minimumQualified = 20): Promise<{ qualifiedCount: number; ready: boolean }> {
    const result = await this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM opportunity_candidates WHERE qualified=true AND observed_at >= NOW() - ($1::text || ' hours')::interval`, [hours]);
    const qualifiedCount = Number(result.rows[0]?.count ?? 0);
    return { qualifiedCount, ready: qualifiedCount >= minimumQualified };
  }

  async recentExecutions(limit = 10): Promise<Array<{ txHash: string; status: string; target: string; submittedAt: string; gasUsed?: string; protocolId?: string; valueWei?: string; effectiveGasPriceWei?: string; beraUsd?: number }>> {
    const result = await this.pool.query<{ tx_hash: string; status: string; target: string; submitted_at: Date; gas_used: string | null; protocol_id: string | null; value_wei: string | null; effective_gas_price_wei: string | null; bera_usd_at_submission: string | null }>(
      `SELECT tx_hash, status, target, submitted_at, gas_used::text, protocol_id, value_wei::text, effective_gas_price_wei::text, bera_usd_at_submission::text FROM executions ORDER BY submitted_at DESC LIMIT $1`, [limit]
    );
    return result.rows.map((row) => ({ txHash: row.tx_hash, status: row.status, target: row.target, submittedAt: row.submitted_at.toISOString(), gasUsed: row.gas_used ?? undefined, protocolId: row.protocol_id ?? undefined, valueWei: row.value_wei ?? undefined, effectiveGasPriceWei: row.effective_gas_price_wei ?? undefined, beraUsd: row.bera_usd_at_submission ? Number(row.bera_usd_at_submission) : undefined }));
  }

  async close(): Promise<void> { await this.pool.end(); }
}

/**
 * SQL rolling windows exclude rows infinitesimally older than their lower time
 * bound, so a continuously sampled window normally ends a little short of its
 * nominal duration.  Only the configured sampling cadence may cover that edge.
 */
export function rollingWindowCovered(elapsedSeconds: number, durationSeconds: number, toleratedBoundaryGapSeconds: number): boolean {
  return Number.isFinite(elapsedSeconds) && Number.isFinite(durationSeconds) && Number.isFinite(toleratedBoundaryGapSeconds)
    && elapsedSeconds >= Math.max(0, durationSeconds - toleratedBoundaryGapSeconds);
}
