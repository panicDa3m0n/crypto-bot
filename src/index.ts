import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { BerachainClients } from "./chain.js";
import { Collector } from "./collector.js";
import { Database } from "./db.js";
import { RiskEngine } from "./risk.js";
import { createLogger } from "./logger.js";
import { ExactAllowanceAdapter, WberaAdapter } from "./adapters.js";
import { GuardedExecutor } from "./executor.js";
import { ReceiptReconciler } from "./reconciler.js";
import { PositionService } from "./positions.js";
import { DatabaseNetworkHealth } from "./health.js";
import { Perception } from "./perception.js";
import { Sensorium } from "./sensorium.js";
import { VenueRegistry } from "./venues.js";
import { Primitives } from "./primitives.js";
import { Scarlet } from "./scarlet.js";
import { ScarletAgent, SCARLET_STREAM } from "./scarlet/agent.js";
import { Llm } from "./llm.js";
import { BlockIndexer } from "./block-indexer.js";
import { Etherscan } from "./etherscan.js";
import { MonadSignals } from "./monad-signals.js";
import { Chronicle } from "./chronicle.js";
import { MarketData } from "./market-data.js";
import { AutoflashService } from "./autoflash.js";
import { AutoArmReconciler } from "./autoarm-reconciler.js";
import { LiquidationMonitor } from "./liquidation-monitor.js";
import { LaunchWatcher } from "./launch-watcher.js";
import { FlowSensor } from "./flow-sensor.js";
import { WhaleIntel } from "./whale-intel.js";
import { GraduationSensor } from "./graduation-sensor.js";
import { EntityResolver } from "./entity-resolver.js";
import { FollowService } from "./follow-service.js";
import { PositionManager } from "./position-manager.js";
import { Aggregator } from "./aggregator.js";
import { Blockscout } from "./blockscout.js";
import { DisplayPrices } from "./display-prices.js";
import { ArbEngine } from "./arb-engine.js";
import { AddressClassifier } from "./classifier.js";
import { ChainScanner } from "./chain-scanner.js";
import { PriceOracle } from "./price-oracle.js";
import { PositionRegistry } from "./position-registry.js";
import { WalletHoldings } from "./wallet-holdings.js";
import { RegistryEnricher } from "./registry-enricher.js";
import { startDashboard } from "./dashboard.js";

const config = loadConfig();
const logger = createLogger(config);
const db = new Database(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const chain = new BerachainClients(config, logger);
const etherscan = new Etherscan(config);
const blockscout = new Blockscout(config, logger);
const collector = new Collector(chain, db, logger);
const positions = new PositionService(config, chain, db, etherscan);

// Allowlist for the risk-gated convenience primitives (wrap/unwrap/approve). Everything else
// — swaps, lending, liquidations — goes through the direct/call_contract path (simulate-first,
// no allowlist). So this only needs the wrapped-native token, the stables, and the DEX router.
const WNATIVE = config.WBERA_ADDRESS.toLowerCase();
const ROUTER = config.DEX_ROUTER.toLowerCase();
const risk = new RiskEngine(config, new Map([
  [WNATIVE, new Set(["0xd0e30db0", "0x2e1a7d4d", "0x095ea7b3"])], // deposit / withdraw / approve
  [config.USDC_E_ADDRESS.toLowerCase(), new Set(["0x095ea7b3"])],
  [config.HONEY_ADDRESS.toLowerCase(), new Set(["0x095ea7b3"])]
]), new Map([
  [WNATIVE, new Set([ROUTER])],
  [config.USDC_E_ADDRESS.toLowerCase(), new Set([ROUTER])],
  [config.HONEY_ADDRESS.toLowerCase(), new Set([ROUTER])]
]));
const executor = new GuardedExecutor(chain, risk, db, positions, logger, BigInt(config.MAX_PREFLIGHT_BLOCK_LAG));
const reconciler = new ReceiptReconciler(chain, db, positions, logger);
const wberaAdapter = new WberaAdapter(config, chain);
const allowanceAdapter = new ExactAllowanceAdapter(chain);
const health = config.SERVICE_ROLE === "brain" ? new DatabaseNetworkHealth(db) : collector;

// The sensorium + real-time sensors are the world-model; Scarlet the agentic core reasons on it.
const venues = new VenueRegistry(db, config);
const sensorium = new Sensorium(config, chain, db, venues, logger);
const launchWatcher = new LaunchWatcher(config, chain, db, venues, logger);
const flowSensor = new FlowSensor(config, chain, db, logger);
const whaleIntel = new WhaleIntel(config, chain, db, etherscan, blockscout, logger);
const graduationSensor = new GraduationSensor(config, chain, db, logger);
const classifier = new AddressClassifier(chain, logger);
const chainScanner = new ChainScanner(config, chain, db, classifier, logger);
const registryEnricher = new RegistryEnricher(config, db, etherscan, blockscout, logger);
const aggregator = new Aggregator(config, logger);
const oracle = new PriceOracle(config, chain, db, logger);
chain.setOracle(oracle); // align system-wide tokenPrice to our on-chain oracle (API is the fallback)
const monadSignals = new MonadSignals(config, chain, db, aggregator, logger);
const perception = new Perception(sensorium, db, chain, monadSignals, positions, config);
const primitives = new Primitives(config, chain, db, executor, positions, wberaAdapter, allowanceAdapter, logger);
const chronicle = new Chronicle(config, db, logger);
const marketData = new MarketData(config);
const resolver = new EntityResolver(config, chain, logger);
const scarlet = new Scarlet(config, chain, db, health, positions, perception, primitives, venues, etherscan, chronicle, marketData, resolver, monadSignals, logger);
// Rebuild (Gradino 1): the clean trading core. Constructed always; only DRIVES when SCARLET_V2_ENABLED.
const llm = new Llm(config, logger);
// The v2 core runs on its OWN chronology stream — detached from the legacy agent's diary (same
// compaction machinery, fresh history). The legacy 'main' journal/summary is not inherited.
const chronicleV2 = new Chronicle(config, db, logger, SCARLET_STREAM);
const scarletV2 = new ScarletAgent(config, chain, db, health, positions, chronicleV2, llm, marketData, primitives, blockscout, logger);
// The agent actually in charge this run — v2 when flagged, else the legacy Scarlet.
const activeAgent = config.SCARLET_V2_ENABLED ? scarletV2 : scarlet;

// A material event is a reflex: it wakes the LEGACY Scarlet (debounced per key) with its reason. Under
// v2 this stays silent — the trading agent is woken ONLY by its own concerns (Channel B, see agentWake);
// the liquidation/arb/follow engines run autonomously and do not drive the trading agent.
const wakenAt = new Map<string, number>();
function wake(key: string, reason: string): void {
  if (config.SERVICE_ROLE === "observer" || !config.SCARLET_AGENT_ENABLED) return;
  if (config.SCARLET_V2_ENABLED) return;
  const now = Date.now();
  if (now - (wakenAt.get(key) ?? 0) < 5 * 60_000) return;
  wakenAt.set(key, now);
  void scarlet.live(`material event: ${reason}`).catch((error) => logger.error({ err: error, key }, "Scarlet event activation failed"));
}
// Channel B sink for the trading agent: own-position (and future watchlist) events only. Debounce lives
// inside ScarletAgent.wake. Routes to v2 when flagged, else falls back to the legacy wake.
function agentWake(key: string, reason: string): void {
  if (config.SERVICE_ROLE === "observer" || !config.SCARLET_AGENT_ENABLED) return;
  if (config.SCARLET_V2_ENABLED) { scarletV2.wake(key, reason); return; }
  wake(key, reason);
}
const autoflash = new AutoflashService(db, primitives, logger, wake, config.CHAIN_ID);
const autoArm = new AutoArmReconciler(config, chain, db, monadSignals, primitives, aggregator, logger);
const liquidationMonitor = new LiquidationMonitor(config, chain, db, primitives, aggregator, logger, wake);
const followService = new FollowService(config, chain, db, logger, wake);
const positionManager = new PositionManager(config, chain, db, primitives, logger, agentWake);
const arbEngine = new ArbEngine(config, chain, db, oracle, logger, wake);
const positionRegistry = new PositionRegistry(config, chain, db, oracle, aggregator, blockscout, logger, wake);
const walletHoldings = new WalletHoldings(config, chain, db, logger);
const displayPrices = new DisplayPrices(config, db, aggregator, logger);
const blockIndexer = new BlockIndexer(config, chain, db, logger);

let scarletHeartbeat: NodeJS.Timeout | undefined;
let scarletStopped = false;
let dashboard: { close: () => void } | undefined;

async function main() {
  await db.migrate();
  await venues.seed().catch((error) => logger.warn({ err: error }, "venue registry seed failed"));
  // Seed the chain registry from the network profile: preloaded tokens + DEXes so Scarlet
  // starts knowing them (chain-classified) instead of re-discovering from zero every time.
  for (const t of config.network.tokens) await db.upsertEntity({ chainId: config.CHAIN_ID, address: t.address, kind: "token", symbol: t.symbol, decimals: t.decimals, meta: { class: t.kind, note: t.note }, source: "seed" }).catch(() => undefined);
  for (const d of config.network.dexes) await db.upsertEntity({ chainId: config.CHAIN_ID, address: d.factory, kind: "dex", symbol: d.id, name: d.name, meta: { type: d.type, router: d.router, quoter: d.quoter, note: d.note }, source: "seed" }).catch(() => undefined);
  // Protocols map (lending/perp) — the surfaces liquidations & other strategies derive from.
  for (const p of config.network.protocols) await db.upsertEntity({ chainId: config.CHAIN_ID, address: p.address, kind: "protocol", symbol: p.id, name: p.name, meta: { category: p.category, family: p.family, role: p.role, tvlUsd: p.tvlUsd, note: p.note }, source: "seed" }).catch(() => undefined);
  await redis.connect();
  await redis.ping();
  if (config.SERVICE_ROLE !== "brain") {
    collector.start(); sensorium.start(); launchWatcher.start(); flowSensor.start();
    if (config.WHALE_INTEL_ENABLED) whaleIntel.start();
    if (config.GRAD_ENABLED) graduationSensor.start();
    if (config.SCANNER_ENABLED) chainScanner.start();
    if (config.ENRICH_ENABLED) registryEnricher.start();
  }
  if (config.SERVICE_ROLE !== "observer") {
    reconciler.start();
    blockIndexer.start(); // THE STARTING POINT: derive prices/pools/tokens from every block → DB (everything reads the DB)
    walletHoldings.start(); // keyless direct-from-chain wallet token holdings for the dashboard
    displayPrices.start(); // Lane A: batch-refresh indicative token prices into DB (dashboard reads cache, never APIs)
    dashboard = startDashboard({ config, db, chain, positions, logger });
    if (config.SCARLET_AGENT_ENABLED && config.EXECUTION_ENABLED) autoflash.start();
    if (config.SCARLET_AGENT_ENABLED && config.EXECUTION_ENABLED && config.AUTOARM_ENABLED) autoArm.start();
    // On-chain HF monitor: watches ALL near-threshold positions (no cap), fires fresh at the cross.
    if (config.EXECUTION_ENABLED && config.LIQ_MONITOR_ENABLED) liquidationMonitor.start();
    // Managed intents: the system tracks the smart-money Scarlet follows and executes her
    // programmed positions (SL/TP/partials) so she never misses an entry or exit.
    if (config.SCARLET_AGENT_ENABLED) followService.start();
    if (config.SCARLET_AGENT_ENABLED && config.EXECUTION_ENABLED) positionManager.start();
    // Arb engine: the system hunts cross-venue/triangular cycles across the whole network and
    // verifies each at real size via the aggregator before surfacing it (no false positives).
    if (config.SCARLET_AGENT_ENABLED && config.ARB_ENABLED) arbEngine.start();
    // The liquidation system needs the atomic organ (Morpho 0-fee flash-loan executor) to fire.
    // Deploy it ONCE (db-persisted) so the flash-kill path is live, not a dead branch.
    if (config.EXECUTION_ENABLED && config.LIQ_REGISTRY_ENABLED) {
      const organ = await db.getOrgan("atomic-executor").catch(() => undefined);
      if (!organ) {
        const r = await primitives.deployOrgan(true).catch((e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
        logger.warn({ result: r }, "atomic organ auto-deploy");
      } else { logger.info({ organ: organ.address }, "atomic organ present"); }
    }
    if (config.SCARLET_AGENT_ENABLED && config.LIQ_REGISTRY_ENABLED) positionRegistry.start();
    if (config.SCARLET_AGENT_ENABLED) {
      // Continuous operation: each cycle re-schedules the next a short gap AFTER it finishes.
      const loop = async () => {
        if (scarletStopped) return;
        await activeAgent.live("continuous cycle").catch((error) => logger.error({ err: error }, "Scarlet cycle failed"));
        if (!scarletStopped) scarletHeartbeat = setTimeout(loop, activeAgent.nextGapMs);
      };
      scarletHeartbeat = setTimeout(() => void loop(), 10_000);
    }
  }
  logger.info({ role: config.SERVICE_ROLE, chain: config.CHAIN_NAME, executionEnabled: config.EXECUTION_ENABLED, agent: config.SCARLET_V2_ENABLED ? "v2 (rebuild core)" : "legacy", llmAvailable: activeAgent.available, walletConfigured: Boolean(config.WALLET_ADDRESS) }, "Scarlet service started");
}

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  if (config.SERVICE_ROLE !== "brain") { collector.stop(); sensorium.stop(); launchWatcher.stop(); flowSensor.stop(); whaleIntel.stop(); graduationSensor.stop(); chainScanner.stop(); registryEnricher.stop(); }
  if (config.SERVICE_ROLE !== "observer") { reconciler.stop(); autoflash.stop(); autoArm.stop(); liquidationMonitor.stop(); followService.stop(); positionManager.stop(); arbEngine.stop(); walletHoldings.stop(); displayPrices.stop(); blockIndexer.stop(); positionRegistry.stop(); scarletStopped = true; if (scarletHeartbeat) clearTimeout(scarletHeartbeat); dashboard?.close(); }
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
