import pg from "pg";
import type { Decision, NetworkObservation, PortfolioSnapshot } from "./domain.js";
import { jsonSafe } from "./json.js";
import { summarizeMiniMaxUsage, type MiniMaxUsageSummary } from "./usage.js";

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
  remainingPct: number; note: string | null; lastResult: string | null; exitNowPct: number | null;
};
function rowToPlan(r: Record<string, unknown>): PositionPlan {
  const num = (v: unknown): number | null => v === null || v === undefined ? null : Number(v);
  return {
    id: Number(r.id), chainId: Number(r.chain_id), token: String(r.token), symbol: (r.symbol as string) ?? null, baseToken: String(r.base_token),
    status: String(r.status), entryKind: String(r.entry_kind), entryPrice: num(r.entry_price), entryAmountUsd: Number(r.entry_amount_usd),
    filledAmountToken: num(r.filled_amount_token), filledPrice: num(r.filled_price), filledAt: r.filled_at ? new Date(r.filled_at as string).toISOString() : null,
    stopLossPct: num(r.stop_loss_pct), takeProfitPct: num(r.take_profit_pct), partials: (r.partials as PositionPlan["partials"]) ?? [],
    remainingPct: Number(r.remaining_pct), note: (r.note as string) ?? null, lastResult: (r.last_result as string) ?? null, exitNowPct: num(r.exit_now_pct)
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

export class Database {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 8 });
  }

  async migrate(): Promise<void> {
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
      CREATE TABLE IF NOT EXISTS raw_blocks (
        chain_id INTEGER NOT NULL,
        block_number BIGINT NOT NULL,
        logs JSONB NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, block_number)
      );
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
        block_number BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, pool)
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain_id, token, bucket)
      );
      CREATE INDEX IF NOT EXISTS token_stats_lookup_idx ON token_stats(chain_id, token, bucket DESC);
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
  async createPositionPlan(p: { chainId: number; token: string; symbol: string | null; baseToken: string; entryKind: string; entryPrice: number | null; entryAmountUsd: number; stopLossPct: number | null; takeProfitPct: number | null; partials: unknown; note: string }): Promise<number> {
    const status = p.entryKind === "now" ? "entering" : "pending-entry";
    const r = await this.pool.query<{ id: number }>(
      `INSERT INTO position_plans(chain_id, token, symbol, base_token, status, entry_kind, entry_price, entry_amount_usd, stop_loss_pct, take_profit_pct, partials, note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [p.chainId, p.token.toLowerCase(), p.symbol, p.baseToken.toLowerCase(), status, p.entryKind, p.entryPrice, p.entryAmountUsd, p.stopLossPct, p.takeProfitPct, jsonParam(p.partials ?? []), p.note]
    );
    return r.rows[0].id;
  }
  async activePositionPlans(chainId: number): Promise<Array<PositionPlan>> {
    const r = await this.pool.query(`SELECT * FROM position_plans WHERE chain_id=$1 AND status IN ('pending-entry','entering','open','exiting') ORDER BY created_at`, [chainId]);
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
  async updatePositionPlan(id: number, fields: Partial<{ status: string; filledAmountToken: number; filledPrice: number; filledAt: string; remainingPct: number; lastResult: string; stopLossPct: number | null; takeProfitPct: number | null; exitNowPct: number | null; partials: unknown }>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [id]; let i = 2;
    const map: Record<string, string> = { status: "status", filledAmountToken: "filled_amount_token", filledPrice: "filled_price", filledAt: "filled_at", remainingPct: "remaining_pct", lastResult: "last_result", stopLossPct: "stop_loss_pct", takeProfitPct: "take_profit_pct", exitNowPct: "exit_now_pct" };
    for (const [k, col] of Object.entries(map)) { const v = (fields as Record<string, unknown>)[k]; if (v !== undefined) { sets.push(`${col}=$${i++}`); vals.push(v); } }
    if (fields.partials !== undefined) { sets.push(`partials=$${i++}`); vals.push(jsonParam(fields.partials)); }
    if (!sets.length) return;
    await this.pool.query(`UPDATE position_plans SET ${sets.join(", ")}, updated_at=NOW() WHERE id=$1`, vals);
  }

  /** Upserts an entity's DETERMINISTIC fields (symbol/name/decimals/meta) — set by the system's
   * resolver, never by Scarlet. Her note + status are preserved unless explicitly changed. */
  async upsertEntity(e: { chainId: number; address: string; kind: string; symbol?: string | null; name?: string | null; decimals?: number | null; meta?: Record<string, unknown>; source?: string }): Promise<void> {
    // "?"/"" are NON-values — store them as NULL so they never overwrite a real symbol via COALESCE
    // (a "?" is truthy and would clobber a good name). meta is MERGED, never clobbered.
    const sym = e.symbol && e.symbol !== "?" ? e.symbol : null;
    const nm = e.name && e.name !== "?" ? e.name : null;
    await this.pool.query(
      `INSERT INTO entities(chain_id, address, kind, symbol, name, decimals, meta, source)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (chain_id, address, kind) DO UPDATE SET
         symbol=COALESCE(EXCLUDED.symbol, entities.symbol),
         name=COALESCE(EXCLUDED.name, entities.name),
         decimals=COALESCE(EXCLUDED.decimals, entities.decimals),
         meta=entities.meta || EXCLUDED.meta, updated_at=NOW()`,
      [e.chainId, e.address.toLowerCase(), e.kind, sym, nm, e.decimals ?? null, jsonParam(e.meta ?? {}), e.source ?? "scarlet"]
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

  /** All discovered pools containing a token (either side) — for the price oracle / arb. */
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

  /** Token entities the system knows about but is MISSING decimals for — the immutable fact the
   * oracle needs. Filled from Blockscout (keyless) so the oracle resolves from system data, not RPC. */
  async entitiesNeedingDecimals(chainId: number, limit = 20): Promise<Array<{ address: string }>> {
    const r = await this.pool.query<{ address: string }>(
      `SELECT address FROM entities WHERE chain_id=$1 AND kind='token' AND decimals IS NULL AND NOT (meta ? 'decimalsCheckedAt') ORDER BY updated_at DESC LIMIT $2`,
      [chainId, limit]
    );
    return r.rows;
  }

  // --- DISPLAY prices (Lane A: indicative, cached, batch-refreshed — never a decision input) ---
  /** Batch-upsert display prices (from DefiLlama batch / Blockscout / bounded aggregator backfill). */
  async upsertTokenPrices(chainId: number, rows: Array<{ token: string; priceUsd: number | null; confidence?: number | null; source?: string }>, vol?: { tauFastSec: number; tauSlowSec: number }): Promise<void> {
    if (!rows.length) return;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      const b = i * 5;
      values.push(chainId, r.token.toLowerCase(), r.priceUsd, r.confidence ?? null, r.source ?? "defillama");
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},NOW())`;
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
      `INSERT INTO token_prices(chain_id, token, price_usd, confidence, source, updated_at) VALUES ${tuples.join(",")}
       ON CONFLICT (chain_id, token) DO UPDATE SET price_usd=EXCLUDED.price_usd, confidence=EXCLUDED.confidence, source=EXCLUDED.source, updated_at=NOW(),
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
  async getTokenPrices(chainId: number, tokens: string[]): Promise<Map<string, { priceUsd: number | null; confidence: number | null; source: string; updatedAt: string }>> {
    const out = new Map<string, { priceUsd: number | null; confidence: number | null; source: string; updatedAt: string }>();
    if (!tokens.length) return out;
    const lower = tokens.map((t) => t.toLowerCase());
    const r = await this.pool.query<{ token: string; price_usd: number | null; confidence: number | null; source: string; updated_at: Date }>(
      `SELECT token, price_usd, confidence, source, updated_at FROM token_prices WHERE chain_id=$1 AND token = ANY($2::text[])`, [chainId, lower]
    );
    for (const row of r.rows) out.set(row.token, { priceUsd: row.price_usd, confidence: row.confidence, source: row.source, updatedAt: row.updated_at.toISOString() });
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
    await this.pool.query(`UPDATE entities SET meta = meta || $4::jsonb WHERE chain_id=$1 AND address=$2 AND kind=$3`, [chainId, address.toLowerCase(), kind, JSON.stringify(patch)]);
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
  async demoteStaleActionable(chainId: number, olderThanSec: number): Promise<number> {
    const r = await this.pool.query(
      `UPDATE lending_positions SET tier='closed', reason='aged out — not seen by enumerate (market out of scope)', next_check_at=NOW() + interval '1 hour', updated_at=NOW()
       WHERE chain_id=$1 AND tier IN ('watch','profitable','candidate')
         AND (enumerated_at IS NULL OR enumerated_at < NOW() - ($2 || ' seconds')::interval)`,
      [chainId, String(Math.round(olderThanSec))]
    );
    return r.rowCount ?? 0;
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
  async saveRawBlock(chainId: number, block: number, logs: unknown): Promise<void> {
    await this.pool.query(`INSERT INTO raw_blocks(chain_id, block_number, logs) VALUES($1,$2,$3) ON CONFLICT (chain_id, block_number) DO UPDATE SET logs=$3, at=NOW()`, [chainId, block, jsonParam(logs)]);
  }
  async pruneRawBlocks(chainId: number, olderThanHours: number): Promise<number> {
    const r = await this.pool.query(`DELETE FROM raw_blocks WHERE chain_id=$1 AND at < NOW() - ($2 || ' hours')::interval`, [chainId, String(olderThanHours)]);
    return r.rowCount ?? 0;
  }
  /** Pool metadata (token0/token1/archetype) for a batch of pool addresses — from the entities registry. */
  async poolInfoBatch(chainId: number, addresses: string[]): Promise<Map<string, { token0: string | null; token1: string | null; archetype: string | null }>> {
    const out = new Map<string, { token0: string | null; token1: string | null; archetype: string | null }>();
    if (!addresses.length) return out;
    const lower = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const r = await this.pool.query<{ address: string; token0: string | null; token1: string | null; archetype: string | null }>(
      `SELECT address, meta->>'token0' AS token0, meta->>'token1' AS token1, meta->>'archetype' AS archetype FROM entities WHERE chain_id=$1 AND kind='pool' AND address = ANY($2::text[])`, [chainId, lower]
    );
    for (const row of r.rows) out.set(row.address, { token0: row.token0, token1: row.token1, archetype: row.archetype });
    return out;
  }

  /** Persist latest AMM state for a batch of pools (from Swap/Sync logs). One query via UNNEST; a
   * newer block always wins so a gap-backfill can never overwrite fresher state. Values are raw wei
   * strings (BigInt→string) to keep NUMERIC exact — never floats. */
  async upsertPoolState(chainId: number, rows: Array<{ pool: string; archetype: string; r0?: bigint | null; r1?: bigint | null; sqrtPrice?: bigint | null; liquidity?: bigint | null; block: number }>): Promise<void> {
    if (!rows.length) return;
    const s = (v: bigint | null | undefined) => (v == null ? null : v.toString());
    await this.pool.query(
      `INSERT INTO pool_state(chain_id, pool, archetype, r0, r1, sqrt_price, liquidity, block_number)
       SELECT $1, p, a, r0, r1, sp, liq, bn
       FROM unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::bigint[]) AS t(p, a, r0, r1, sp, liq, bn)
       ON CONFLICT (chain_id, pool) DO UPDATE SET
         archetype=EXCLUDED.archetype, r0=EXCLUDED.r0, r1=EXCLUDED.r1, sqrt_price=EXCLUDED.sqrt_price,
         liquidity=EXCLUDED.liquidity, block_number=EXCLUDED.block_number, updated_at=NOW()
       WHERE pool_state.block_number <= EXCLUDED.block_number`,
      [chainId,
        rows.map((x) => x.pool.toLowerCase()),
        rows.map((x) => x.archetype),
        rows.map((x) => s(x.r0)), rows.map((x) => s(x.r1)),
        rows.map((x) => s(x.sqrtPrice)), rows.map((x) => s(x.liquidity)),
        rows.map((x) => x.block)]
    );
  }

  /** Increment per-token market stats for the current 5-min bucket (from V3 swap amounts). */
  async upsertTokenStats(chainId: number, bucket: number, rows: Array<{ token: string; volUsd: number; buys: number; sells: number; lastPrice: number }>): Promise<void> {
    if (!rows.length) return;
    await this.pool.query(
      `INSERT INTO token_stats(chain_id, token, bucket, vol_usd, buys, sells, last_price)
       SELECT $1, t, $2, v, b, s, lp FROM unnest($3::text[], $4::float8[], $5::int[], $6::int[], $7::float8[]) AS x(t, v, b, s, lp)
       ON CONFLICT (chain_id, token, bucket) DO UPDATE SET
         vol_usd = token_stats.vol_usd + EXCLUDED.vol_usd,
         buys = token_stats.buys + EXCLUDED.buys,
         sells = token_stats.sells + EXCLUDED.sells,
         last_price = COALESCE(EXCLUDED.last_price, token_stats.last_price),
         updated_at = NOW()`,
      [chainId, bucket, rows.map((r) => r.token.toLowerCase()), rows.map((r) => r.volUsd), rows.map((r) => r.buys), rows.map((r) => r.sells), rows.map((r) => r.lastPrice)]
    );
  }
  async pruneTokenStats(chainId: number, olderThanHours: number): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanHours * 3600;
    const r = await this.pool.query(`DELETE FROM token_stats WHERE chain_id=$1 AND bucket < $2`, [chainId, cutoff]);
    return r.rowCount ?? 0;
  }
  /** Windowed market stats for a token — the chain-sourced replacement for the DexScreener feed. */
  async tokenStats(chainId: number, token: string): Promise<{ vol5m: number; vol1h: number; vol24h: number; txns24h: number; buys24h: number; sells24h: number; change1h: number | null; change24h: number | null; lastPrice: number | null }> {
    const now = Math.floor(Date.now() / 1000);
    const r = await this.pool.query<{ vol5m: string; vol1h: string; vol24h: string; buys24h: string; sells24h: string }>(
      `SELECT
         COALESCE(SUM(vol_usd) FILTER (WHERE bucket >= $3),0)::text AS vol5m,
         COALESCE(SUM(vol_usd) FILTER (WHERE bucket >= $4),0)::text AS vol1h,
         COALESCE(SUM(vol_usd),0)::text AS vol24h,
         COALESCE(SUM(buys),0)::text AS buys24h,
         COALESCE(SUM(sells),0)::text AS sells24h
       FROM token_stats WHERE chain_id=$1 AND token=$2 AND bucket >= $5`,
      [chainId, token.toLowerCase(), now - 300, now - 3600, now - 86400]
    );
    const row = r.rows[0];
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
      change1h: chg(p1h), change24h: chg(p24h), lastPrice: latest
    };
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
