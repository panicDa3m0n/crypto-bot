import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { BerachainClients } from "./chain.js";
import { Collector } from "./collector.js";
import { Database } from "./db.js";
import { AgentLoop } from "./agent.js";
import { MiniMaxBrain } from "./minimax.js";
import { RiskEngine } from "./risk.js";
import { createLogger } from "./logger.js";
import { startTelegram } from "./telegram.js";
import { NetworkResearcher } from "./research.js";
import { ToolHub } from "./toolhub.js";
import { BendScanner } from "./bend.js";
import { StrategyEngine } from "./strategy.js";
import { GateService } from "./gates.js";
import { BexQuoteScanner, BexAdapter, BEX_VAULT } from "./bex.js";
import { ExactAllowanceAdapter, WberaAdapter } from "./adapters.js";
import { GuardedExecutor } from "./executor.js";
import { AutonomousExecution } from "./autonomy.js";
import { OfficialDocumentWatcher } from "./documents.js";
import { ReceiptReconciler } from "./reconciler.js";
import { PositionService } from "./positions.js";
import { OpportunityScanner } from "./opportunities.js";
import { DatabaseNetworkHealth } from "./health.js";
import { NetworkDiscovery } from "./discovery.js";
import { StrategyCompiler } from "./compiler.js";
import { MarketHistory } from "./history.js";
import { PoolRiskScanner } from "./poolrisk.js";

const config = loadConfig();
const logger = createLogger(config);
const db = new Database(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const chain = new BerachainClients(config);
const collector = new Collector(chain, db, logger);
const research = new NetworkResearcher(config, chain, db, logger);
const bendScanner = new BendScanner(config, chain, db, logger);
const bexScanner = new BexQuoteScanner(config, chain, db, logger);
const opportunities = new OpportunityScanner(config, chain, db, bexScanner, logger);
const documents = new OfficialDocumentWatcher(db, logger);
const discovery = new NetworkDiscovery(config, db, logger);
const history = new MarketHistory(config, db, discovery, logger);
const poolRisk = new PoolRiskScanner(chain, db, discovery, history, logger);
const compiler = new StrategyCompiler();

// Each selector is tied to a deterministic adapter candidate; the model cannot supply calldata.
const risk = new RiskEngine(config, new Map([
  ["0x6969696969696969696969696969696969696969", new Set(["0xd0e30db0", "0x2e1a7d4d", "0x095ea7b3"])],
  [config.HONEY_ADDRESS.toLowerCase(), new Set(["0x095ea7b3"])],
  [BEX_VAULT.toLowerCase(), new Set(["0x52bbbe29"])]
]), new Map([
  ["0x6969696969696969696969696969696969696969", new Set([BEX_VAULT.toLowerCase()])],
  [config.HONEY_ADDRESS.toLowerCase(), new Set([BEX_VAULT.toLowerCase()])]
]));
const brain = new MiniMaxBrain(config);
const strategies = new StrategyEngine(config, bendScanner);
const gates = new GateService(config, chain, db);
const positions = new PositionService(chain, db);
const executor = new GuardedExecutor(chain, risk, db, positions, logger);
const reconciler = new ReceiptReconciler(chain, db, positions, logger);
const autonomy = new AutonomousExecution(config, chain, db, gates, research, new WberaAdapter(chain), new ExactAllowanceAdapter(chain), new BexAdapter(config, chain), bexScanner, executor, logger);
const health = config.SERVICE_ROLE === "brain" ? new DatabaseNetworkHealth(db) : collector;
const agent = new AgentLoop(config, chain, health, research, discovery, history, poolRisk, db, brain, risk, strategies, gates, autonomy, positions, opportunities, documents, compiler, logger);
agent.setToolHub(new ToolHub(chain, health, research, db, agent, strategies, gates, documents, positions, opportunities, discovery, poolRisk));
if (config.SERVICE_ROLE === "all") {
  collector.onHealthChange((healthy) => agent.notifyMaterialEvent("network-health", healthy ? "dual-RPC data health recovered" : "dual-RPC data health degraded"));
  bexScanner.onPauseChange((paused) => agent.notifyMaterialEvent("bex-pause", paused ? "BEX is paused" : "BEX pause has cleared"));
  bendScanner.onLiquidationChange((summary) => agent.notifyMaterialEvent("bend-liquidation", `${summary.liquidatable} newly changed Bend liquidation candidate(s) at block ${summary.blockNumber}`));
  opportunities.onQualifiedChange((summary) => agent.notifyMaterialEvent("qualified-opportunity", `same-block BEX route qualified at block ${summary.blockNumber} with expected net $${summary.expectedNetUsd.toFixed(6)}`));
  documents.onChange((updates) => agent.notifyMaterialEvent("official-documents", `official documentation changed: ${updates.map((update) => update.url).join(", ")}`));
}

async function main() {
  await db.migrate();
  await redis.connect();
  await redis.ping();
  if (config.SERVICE_ROLE !== "brain") {
    collector.start(); research.start(); discovery.start(); history.start(); poolRisk.start(); bendScanner.start(); bexScanner.start(); opportunities.start(); documents.start();
  }
  if (config.SERVICE_ROLE !== "observer") {
    await research.hydrate();
    reconciler.start(); agent.start(config.AGENT_REVIEW_INTERVAL_MS); startTelegram(config, agent, db, strategies, research, logger);
  }
  logger.info({ role: config.SERVICE_ROLE, executionEnabled: config.EXECUTION_ENABLED, minimaxAvailable: brain.available, walletConfigured: Boolean(config.WALLET_ADDRESS) }, "Wallet Brain service started");
}

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  if (config.SERVICE_ROLE !== "brain") { collector.stop(); research.stop(); discovery.stop(); history.stop(); poolRisk.stop(); bendScanner.stop(); bexScanner.stop(); opportunities.stop(); documents.stop(); }
  if (config.SERVICE_ROLE !== "observer") { reconciler.stop(); agent.stop(); }
  await redis.quit();
  await db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
void main().catch((error) => {
  logger.fatal({ err: error }, "fatal startup failure");
  process.exit(1);
});
