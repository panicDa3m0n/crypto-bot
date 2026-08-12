import pg from "pg";
import type { Decision, NetworkObservation, PortfolioSnapshot } from "./domain.js";
import { jsonSafe } from "./json.js";
import { summarizeMiniMaxUsage, type MiniMaxUsageSummary } from "./usage.js";

/** node-postgres binds JavaScript arrays as PostgreSQL arrays, not JSON arrays. */
function jsonParam(value: unknown): string {
  return JSON.stringify(jsonSafe(value)) ?? "null";
}

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
    `);
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
      `INSERT INTO portfolio_snapshots(observed_at, wallet_address, bera, wbera, usdc_e, honey, nav_usd, daily_loss_usd, locked_usd, data_healthy)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [value.observedAt, value.walletAddress ?? null, value.bera, value.wbera, value.usdcE, value.honey, value.estimatedNavUsd, value.dailyLossUsd, value.lockedUsd, value.dataHealthy]
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

  async saveProtocolVerification(value: ProtocolVerification): Promise<void> {
    await this.pool.query(
      `INSERT INTO protocol_verifications(protocol, address, verified_at, block_number, code_hash, status, details)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(protocol, address, block_number) DO UPDATE SET status=EXCLUDED.status, details=EXCLUDED.details, code_hash=EXCLUDED.code_hash`,
      [value.protocol, value.address.toLowerCase(), value.verifiedAt, value.blockNumber.toString(), value.codeHash, value.status, value.details]
    );
  }

  async upsertPosition(value: { strategyId: string; protocolId: string; vaultAddress: string; assetAddress: string; sharesRaw: bigint; assetsRaw: bigint; valueUsd: number; status: "active" | "closed"; metadata: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `INSERT INTO positions(strategy_id, protocol_id, vault_address, asset_address, shares_raw, assets_raw, value_usd, status, closed_at, metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8='closed' THEN NOW() ELSE NULL END,$9)
       ON CONFLICT(protocol_id, vault_address) DO UPDATE SET
         strategy_id=EXCLUDED.strategy_id, asset_address=EXCLUDED.asset_address,
         shares_raw=EXCLUDED.shares_raw, assets_raw=EXCLUDED.assets_raw, value_usd=EXCLUDED.value_usd,
         status=EXCLUDED.status, last_reconciled_at=NOW(),
         closed_at=CASE WHEN EXCLUDED.status='closed' THEN NOW() ELSE NULL END,
         opened_at=CASE WHEN positions.status='closed' AND EXCLUDED.status='active' THEN NOW() ELSE positions.opened_at END,
         metadata=EXCLUDED.metadata`,
      [value.strategyId, value.protocolId, value.vaultAddress.toLowerCase(), value.assetAddress.toLowerCase(), value.sharesRaw.toString(), value.assetsRaw.toString(), value.valueUsd, value.status, jsonParam(value.metadata)]
    );
  }

  async activePositions(): Promise<Array<{ strategyId: string; protocolId: string; vaultAddress: string; assetAddress: string; sharesRaw: bigint; assetsRaw: bigint; valueUsd: number; openedAt: string; metadata: Record<string, unknown> }>> {
    const result = await this.pool.query<{ strategy_id: string; protocol_id: string; vault_address: string; asset_address: string; shares_raw: string; assets_raw: string; value_usd: string; opened_at: Date; metadata: Record<string, unknown> }>(
      `SELECT strategy_id, protocol_id, vault_address, asset_address, shares_raw::text, assets_raw::text, value_usd::text, opened_at, metadata FROM positions WHERE status='active' ORDER BY opened_at ASC`
    );
    return result.rows.map((row) => ({ strategyId: row.strategy_id, protocolId: row.protocol_id, vaultAddress: row.vault_address, assetAddress: row.asset_address, sharesRaw: BigInt(row.shares_raw), assetsRaw: BigInt(row.assets_raw), valueUsd: Number(row.value_usd), openedAt: row.opened_at.toISOString(), metadata: row.metadata }));
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
    const result = await this.pool.query<{ observed_at: Date; wallet_address: string | null; bera: string; wbera: string; usdc_e: string; honey: string; nav_usd: string; daily_loss_usd: string; locked_usd: string; data_healthy: boolean }>(
      `SELECT observed_at, wallet_address, bera::text, wbera::text, usdc_e::text, honey::text, nav_usd::text, daily_loss_usd::text, locked_usd::text, data_healthy FROM portfolio_snapshots ORDER BY observed_at DESC LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { observedAt: row.observed_at.toISOString(), walletAddress: row.wallet_address ?? undefined, bera: Number(row.bera), wbera: Number(row.wbera), usdcE: Number(row.usdc_e), honey: Number(row.honey), baseAsset: "BERA", baseAssetBalance: Number(row.bera) + Number(row.wbera), estimatedNavUsd: Number(row.nav_usd), beraUsd: 0, honeyUsd: 0, dailyLossUsd: Number(row.daily_loss_usd), lockedUsd: Number(row.locked_usd), dataHealthy: row.data_healthy };
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

  async recentExecutions(limit = 10): Promise<Array<{ txHash: string; status: string; target: string; submittedAt: string; gasUsed?: string }>> {
    const result = await this.pool.query<{ tx_hash: string; status: string; target: string; submitted_at: Date; gas_used: string | null }>(
      `SELECT tx_hash, status, target, submitted_at, gas_used::text FROM executions ORDER BY submitted_at DESC LIMIT $1`, [limit]
    );
    return result.rows.map((row) => ({ txHash: row.tx_hash, status: row.status, target: row.target, submittedAt: row.submitted_at.toISOString(), gasUsed: row.gas_used ?? undefined }));
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
