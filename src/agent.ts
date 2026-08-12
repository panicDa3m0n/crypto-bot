import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { NetworkHealthSource } from "./health.js";
import type { Database } from "./db.js";
import type { Decision, PortfolioSnapshot } from "./domain.js";
import { generateHypotheses, type MiniMaxBrain } from "./minimax.js";
import type { RiskEngine } from "./risk.js";
import type { NetworkResearcher } from "./research.js";
import type { ToolHub } from "./toolhub.js";
import type { StrategyEngine } from "./strategy.js";
import type { GateService } from "./gates.js";
import type { AutonomousExecution } from "./autonomy.js";
import type { OfficialDocumentWatcher } from "./documents.js";
import { BEX_VAULT } from "./bex.js";
import type { PositionService } from "./positions.js";
import type { OpportunityScanner } from "./opportunities.js";
import type { NetworkDiscovery, NetworkDiscoverySnapshot } from "./discovery.js";
import { StrategyCompiler, type CompiledStrategy } from "./compiler.js";
import type { MarketHistory } from "./history.js";
import type { PoolRiskScanner } from "./poolrisk.js";

export class AgentLoop {
  private timer?: NodeJS.Timeout;
  private dailyTimer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private evaluating = false;
  private researching = false;
  private readonly materialEventAt = new Map<string, number>();
  private latest?: { id: string; decision: Decision; portfolio: PortfolioSnapshot };
  private compiled: CompiledStrategy[] = [];
  private toolHub?: ToolHub;

  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly collector: NetworkHealthSource, private readonly research: NetworkResearcher, private readonly discovery: NetworkDiscovery, private readonly history: MarketHistory, private readonly poolRisk: PoolRiskScanner, private readonly db: Database, private readonly brain: MiniMaxBrain, private readonly risk: RiskEngine, private readonly strategies: StrategyEngine, private readonly gates: GateService, private readonly autonomy: AutonomousExecution, private readonly positions: PositionService, private readonly opportunities: OpportunityScanner, private readonly documents: OfficialDocumentWatcher, private readonly compiler: StrategyCompiler, private readonly logger: Logger) {}

  get lastDecision() { return this.latest; }
  get compiledStrategies(): readonly CompiledStrategy[] { return this.compiled; }
  setToolHub(toolHub: ToolHub): void { this.toolHub = toolHub; }

  /** A material event requests a new LLM review, never bypasses its decision or technical guards. */
  notifyMaterialEvent(key: string, detail: string): void {
    const now = Date.now();
    const previous = this.materialEventAt.get(key) ?? 0;
    if (now - previous < 5 * 60_000) return;
    this.materialEventAt.set(key, now);
    void this.evaluate(`material mainnet event: ${detail}`).catch((error) => this.logger.error({ err: error, key }, "material-event agent evaluation failed"));
  }

  async evaluate(reason = "scheduled portfolio review"): Promise<void> {
    if (this.evaluating) {
      this.logger.debug({ reason }, "agent evaluation skipped because another review is in progress");
      return;
    }
    this.evaluating = true;
    try {
    await this.collector.refresh();
    await this.research.hydrate();
    await this.discovery.hydrate();
    await this.history.hydrate();
    await this.poolRisk.hydrate();
    const dailyLossUsd = await this.db.dailyLossUsd();
    const portfolio = await this.positions.reconcile(await this.chain.portfolio(dailyLossUsd, this.collector.dataHealthy));
    await this.db.savePortfolio(portfolio);
    const safety = this.risk.validatePortfolio(portfolio);
    const candidate = await this.autonomy.candidate(portfolio);
    const context = {
      reason, latestNetwork: this.collector.latest ? {
        primaryBlock: this.collector.latest.primaryBlock.toString(), secondaryBlock: this.collector.latest.secondaryBlock.toString(),
        gasPriceWei: this.collector.latest.gasPriceWei.toString(), dataHealthy: this.collector.dataHealthy
      } : null,
      // These are deliberately separate facts.  A missing candidate means that
      // no adapter-bound action is presently safe/executable; it must never be
      // described to the model as an executor outage or a disabled wallet.
      safety,
      executionEnabled: this.config.EXECUTION_ENABLED,
      executableCandidateAvailable: candidate !== undefined,
      sources: ["https://rpc.berachain.com", "https://api.berachain.com/", "https://docs.berachain.com/general/proof-of-liquidity/overview"]
    };
    const market = this.research.latest;
    Object.assign(context, { marketResearch: compactMarketResearch(market) });
    Object.assign(context, { networkDiscovery: compactDiscovery(this.discovery.latest) });
    Object.assign(context, { officialTokenHistory: this.history.latest ?? { status: "No official price history is available yet; do not derive a directional signal." } });
    const hypotheses = await this.db.recentStrategyHypotheses();
    this.compiled = this.compiler.compile({ discovery: this.discovery.latest, hypotheses, opportunity: this.opportunities.latest, bend: this.strategies.report(portfolio, market).bendScanner, poolRisk: this.poolRisk.latest });
    Object.assign(context, { recentLlmHypotheses: hypotheses, poolRisk: this.poolRisk.latest ?? { status: "No dual-RPC pool-risk scan is available; LP theses cannot execute." }, compiledStrategies: this.compiled });
    Object.assign(context, { strategySleeves: this.strategies.report(portfolio, market) });
    Object.assign(context, { observationGate: await this.gates.observationGate() });
    Object.assign(context, { protocolGates: { bex: await this.gates.protocolObservationGate("bex", BEX_VAULT) } });
    Object.assign(context, { opportunityScan: this.opportunities.latest ?? null, opportunityGate: await this.db.opportunityGate() });
    Object.assign(context, { officialDocumentUpdates: this.documents.latest });
    Object.assign(context, { executableCandidate: candidate ? { id: candidate.id, kind: candidate.kind, rationale: candidate.rationale, plan: candidate.serializedPlan, instruction: "Approve only by returning action ENTER and strategyId exactly equal to the candidate id. Otherwise HOLD or RESEARCH_MORE." } : null });
    const brainResult = await this.brain.decide(portfolio, context, this.toolHub);
    const { decision } = brainResult;
    const id = randomUUID();
    await this.db.saveDecision(id, decision, safety.allowed ? "proposed" : "held_by_risk", brainResult.modelResponse, portfolio, context, candidate?.serializedPlan ?? null);
    this.latest = { id, decision, portfolio };
    if (safety.allowed) await this.autonomy.executeIfApproved(id, decision, portfolio, candidate).catch((error) => this.logger.error({ err: error, id }, "MiniMax-approved execution was blocked or failed"));
    void this.runResearch({ ...compactResearchContext(portfolio, this.discovery.latest, market, this.opportunities.latest), officialTokenHistory: this.history.latest, poolRisk: this.poolRisk.latest ?? { status: "unavailable" } });
    this.logger.info({ id, action: decision.action, strategy: decision.strategyId, confidence: decision.confidence, safety }, "MiniMax wallet decision recorded");
    } finally {
      this.evaluating = false;
    }
  }

  start(intervalMs = 6 * 60 * 60_000): void {
    void this.evaluate("startup portfolio review").catch((error) => this.logger.error({ err: error }, "startup agent evaluation failed"));
    this.startupTimer = setTimeout(() => void this.evaluate("post-collector mainnet portfolio review").catch((error) => this.logger.error({ err: error }, "post-collector agent evaluation failed")), 15_000);
    this.timer = setInterval(() => void this.evaluate().catch((error) => this.logger.error({ err: error }, "agent evaluation failed")), intervalMs);
    this.dailyTimer = setInterval(() => void this.evaluate("daily portfolio post-mortem").catch((error) => this.logger.error({ err: error }, "daily post-mortem failed")), 24 * 60 * 60_000);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); if (this.dailyTimer) clearInterval(this.dailyTimer); if (this.startupTimer) clearTimeout(this.startupTimer); }

  private async runResearch(context: Record<string, unknown>): Promise<void> {
    if (this.researching) return;
    this.researching = true;
    try {
      const generated = await generateHypotheses(this.config, context);
      await this.db.saveResearchTrace({ status: generated.status, context, modelResponse: generated.modelResponse, hypotheses: generated.hypotheses });
      if (generated.hypotheses.length) {
        await this.db.saveStrategyHypotheses(generated.hypotheses);
        this.logger.info({ count: generated.hypotheses.length, status: generated.status }, "MiniMax strategy hypotheses and research trace persisted");
      } else {
        this.logger.info({ status: generated.status }, "MiniMax strategy-research trace persisted with no falsifiable eligible hypothesis");
      }
    } catch (error) {
      await this.db.saveResearchTrace({ status: "failed", context, hypotheses: [], error: error instanceof Error ? error.message : "unknown MiniMax research failure" }).catch((traceError) => this.logger.error({ err: traceError }, "failed to persist MiniMax research failure trace"));
      this.logger.warn({ err: error }, "MiniMax strategy-research pass failed; wallet decision remains fail-closed");
    } finally {
      this.researching = false;
    }
  }
}

/** Keep the independent research call focused on fresh, falsifiable signals. */
function compactResearchContext(portfolio: PortfolioSnapshot, discovery: NetworkDiscoverySnapshot | undefined, market: unknown, opportunity: unknown): Record<string, unknown> {
  const snapshot = discovery;
  const research = market as { observedAt?: string; bendVaults?: unknown[]; topRewardVaults?: unknown[] } | undefined;
  return {
    observedAt: new Date().toISOString(),
    portfolio: { estimatedNavUsd: portfolio.estimatedNavUsd, bera: portfolio.bera, wbera: portfolio.wbera, usdcE: portfolio.usdcE, honey: portfolio.honey, beraUsd: portfolio.beraUsd, dataHealthy: portfolio.dataHealthy },
    discovery: { observedAt: snapshot?.observedAt, candidates: (snapshot?.candidates ?? []).slice(0, 12), tokenUniverse: (snapshot?.tokenUniverse ?? []).slice(0, 20) },
    protocolSummary: { observedAt: research?.observedAt, bendVaults: (research?.bendVaults ?? []).slice(0, 6), rewardVaults: (research?.topRewardVaults ?? []).slice(0, 8) },
    opportunity
  };
}

function compactDiscovery(discovery: NetworkDiscoverySnapshot | undefined): unknown {
  if (!discovery) return { status: "No broad BEX universe scan is available yet; research, do not trade." };
  return {
    observedAt: discovery.observedAt, poolCount: discovery.poolCount, eligiblePoolCount: discovery.eligiblePoolCount,
    candidates: discovery.candidates.slice(0, 12), tokenUniverse: discovery.tokenUniverse.slice(0, 20),
    exclusionCount: discovery.exclusions.length, exclusionPolicy: "Excluded pools are not executable; query the read-only discovery tool only if their details are needed."
  };
}

function compactMarketResearch(market: unknown): unknown {
  if (!market || typeof market !== "object") return { status: "not yet available; choose RESEARCH_MORE or HOLD" };
  const item = market as Record<string, unknown>;
  return {
    observedAt: item.observedAt, protocol: item.protocol, onchainVerification: item.onchainVerification,
    bendVaults: Array.isArray(item.bendVaults) ? item.bendVaults.slice(0, 6) : [],
    topRewardVaults: Array.isArray(item.topRewardVaults) ? item.topRewardVaults.slice(0, 8) : [],
    rewardVaultCount: Array.isArray(item.topRewardVaults) ? item.topRewardVaults.length : 0
  };
}
