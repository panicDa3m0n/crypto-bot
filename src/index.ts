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
import { LocalRouter } from "./router/router.js";
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
const health = config.SERVICE_ROLE === "brain" ? new DatabaseNetworkHealth(db, config.CHAIN_ID) : collector;

// The sensorium + real-time sensors are the world-model; Scarlet the agentic core reasons on it.
const venues = new VenueRegistry(db, config);
const sensorium = new Sensorium(config, chain, db, venues, logger);
const launchWatcher = new LaunchWatcher(config, chain, db, venues, logger);
const flowSensor = new FlowSensor(config, chain, db, logger);
const whaleIntel = new WhaleIntel(config, chain, db, etherscan, blockscout, logger);
const graduationSensor = new GraduationSensor(config, chain, db, logger);
const classifier = new AddressClassifier(chain, logger);
const chainScanner = new ChainScanner(config, chain, db, classifier, logger);
// LocalRouter IS an Aggregator (drop-in): quotes come from our local AMM mirror (kills the quote
// firehose / 400-429 storm); the external aggregator remains the fallback for venues we don't index
// and still builds execution calldata in Phase 2. Every consumer keeps its `Aggregator` type.
const aggregator = new LocalRouter(config, logger, db, chain);
const oracle = new PriceOracle(config, chain, db, logger);
chain.setOracle(oracle); // align system-wide tokenPrice to our on-chain oracle (API is the fallback)
const monadSignals = new MonadSignals(config, chain, db, aggregator, logger);
const perception = new Perception(sensorium, db, chain, monadSignals, positions, config);
const primitives = new Primitives(config, chain, db, executor, positions, wberaAdapter, allowanceAdapter, logger, aggregator);
const chronicle = new Chronicle(config, db, logger);
const marketData = new MarketData(config);
const resolver = new EntityResolver(config, chain, db, logger);
const scarlet = new Scarlet(config, chain, db, health, positions, perception, primitives, venues, etherscan, chronicle, marketData, resolver, monadSignals, logger);
// Rebuild (Gradino 1): the clean trading core. Constructed always; only DRIVES when SCARLET_V2_ENABLED.
const llm = new Llm(config, logger);
// The v2 core runs on its OWN chronology stream — detached from the legacy agent's diary (same
// compaction machinery, fresh history). The legacy 'main' journal/summary is not inherited.
const chronicleV2 = new Chronicle(config, db, logger, SCARLET_STREAM);
// THE STARTING POINT: derive prices/pools/tokens from every block → DB. Constructed here (before its
// consumers) so Scarlet + the position manager can read its `synced` gate (wait while it realigns).
const blockIndexer = new BlockIndexer(config, chain, db, logger);
const scarletV2 = new ScarletAgent(config, chain, db, health, positions, chronicleV2, llm, marketData, primitives, blockscout, logger, () => blockIndexer.synced);
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
const positionManager = new PositionManager(config, chain, db, primitives, logger, agentWake, () => blockIndexer.synced);
const arbEngine = new ArbEngine(config, chain, db, oracle, logger, wake);
const positionRegistry = new PositionRegistry(config, chain, db, oracle, aggregator, blockscout, logger, wake);
const walletHoldings = new WalletHoldings(config, chain, db, logger);
// Event-driven wallet (Canale wallet): the indexer detects our Transfers in the block stream → WalletHoldings
// re-reads just those balances from chain. Keeps the wallet aligned within one block, on the reliable lane.
blockIndexer.onWalletTransfer = (tokens) => void walletHoldings.onWalletTransfer(tokens);
const displayPrices = new DisplayPrices(config, db, aggregator, logger);
// The enrichment worker lives WITH the indexer (same process): the indexer writes bare entities, the worker
// drains them on the dedicated enrichment RPC and backfills price via the indexer's repriceFromState.
const registryEnricher = new RegistryEnricher(config, chain, db, etherscan, blockscout, logger, (tokens) => blockIndexer.repriceFromState(tokens).then(() => undefined));
// PUSH: when a block discovers a new/incomplete entity, nudge the enricher to drain the buffer immediately
// (no per-block full-DB scan — the buffer is the index-backed pending subset). See db-first convergence.
blockIndexer.onDiscovery = () => registryEnricher.nudge();

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
  if (config.SERVICE_ROLE !== "brain") {
    collector.start(); sensorium.start(); launchWatcher.start(); flowSensor.start();
    if (config.WHALE_INTEL_ENABLED) whaleIntel.start();
    if (config.GRAD_ENABLED) graduationSensor.start();
    if (config.SCANNER_ENABLED) chainScanner.start();
    else logger.warn("ChainScanner RETIRED by config (SCANNER_ENABLED=false): discovery is the block-indexer's job now — it writes the same dex/pool/token entities from every block. Set SCANNER_ENABLED=true only to A/B.");
  }
  if (config.SERVICE_ROLE !== "observer") {
    reconciler.start();
    blockIndexer.start(); // THE STARTING POINT: derive prices/pools/tokens from every block → DB (everything reads the DB)
    if (config.ENRICH_ENABLED) registryEnricher.start(); // enrichment worker — co-located with the indexer (drains its bare-entity queue)
    walletHoldings.start(); // keyless direct-from-chain wallet token holdings for the dashboard
    displayPrices.start(); // Lane A: batch-refresh indicative token prices into DB (dashboard reads cache, never APIs)
    dashboard = startDashboard({ config, db, chain, positions, logger, primitives, aggregator });
    // GATE (db-first convergence): acting services operate ONLY on FRESH, COMPLETE data — wait for the
    // indexer at head AND the enrichment RESYNC set drained (every entity discovered up to head enriched
    // or terminally-failed). The always-on DB writers (indexer/enrichment/dashboard/walletHoldings/
    // displayPrices) keep running during the wait. Same gate for a cold-start or a resync; resolves fast
    // when already at head with nothing outstanding. Extends the old "Scarlet-only" gate to EVERY service
    // that acts (liquidations included), so none acts on partial data during catch-up.
    const waitResyncDrained = async (): Promise<void> => {
      if (!config.ENRICH_ENABLED) { logger.warn("enrichment disabled — skipping resync-drain gate"); return; }
      const deadline = config.ENRICH_RESYNC_MAX_WAIT_MS > 0 ? Date.now() + config.ENRICH_RESYNC_MAX_WAIT_MS : Infinity;
      let last = -1;
      for (;;) {
        const n = await db.countResyncOutstanding(config.CHAIN_ID).catch(() => 0);
        if (n === 0) { if (last > 0) logger.info("enrichment resync drained — gate open"); return; }
        if (n !== last) { logger.info({ outstanding: n }, "waiting for enrichment resync to drain…"); last = n; }
        registryEnricher.nudge();
        if (Date.now() >= deadline) { logger.warn({ outstanding: n }, "resync-drain gate TIMED OUT — proceeding anyway (investigate stuck enrichment)"); return; }
        await new Promise<void>((r) => setTimeout(r, 1000));
      }
    };
    // THE ONE EXCEPTION TO THE GATE. Every acting service waits for a fresh mirror, because acting on
    // partial data is worse than not acting. The liquidation monitor is the exception, and deliberately so:
    // it takes NO decision from the mirror. The oracle price, the position size and the health factor are
    // all read live from the chain each tick (and re-read at the cross), and the on-chain `require` is the
    // real safety boundary. The DB supplies only the CANDIDATE LIST — which moves slowly, in hours, not
    // blocks. A stale candidate list costs us a position we haven't discovered yet; a closed gate costs us
    // every position we already know about. During catch-up after a deploy the second is the larger loss,
    // and it is not hypothetical: the gate is shut for minutes on every restart, and liquidations are
    // arity-1 — each one is profit on its own and cannot wait for a graph to converge.
    if (config.EXECUTION_ENABLED && config.LIQ_MONITOR_ENABLED) liquidationMonitor.start();
    logger.info("waiting for indexer head + enrichment resync before starting acting services…");
    await blockIndexer.ready;
    await waitResyncDrained();
    logger.info("system fresh (indexer at head, resync drained) — starting acting services");
    await (aggregator as { reportVenueCoverage?: () => Promise<void> }).reportVenueCoverage?.().catch(() => undefined); // worklist: which active DEXes we can/can't own-execute
    // The liquidation system needs the atomic organ (Morpho 0-fee flash-loan executor) to fire. Deploy it
    // ONCE (db-persisted) BEFORE the services that use it, so the flash-kill path is live, not a dead branch.
    if (config.EXECUTION_ENABLED && config.LIQ_REGISTRY_ENABLED) {
      const organ = await db.getOrgan("atomic-executor").catch(() => undefined);
      if (!organ) {
        const r = await primitives.deployOrgan(true).catch((e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
        logger.warn({ result: r }, "atomic organ auto-deploy");
      } else { logger.info({ organ: organ.address }, "atomic organ present"); }
    }
    // Liquidation engines — act on OTHERS' positions from the fresh DB + on-chain HF (need the organ above).
    if (config.SCARLET_AGENT_ENABLED && config.EXECUTION_ENABLED) autoflash.start();
    if (config.SCARLET_AGENT_ENABLED && config.EXECUTION_ENABLED && config.AUTOARM_ENABLED) autoArm.start();
    // (The on-chain HF monitor already started ABOVE, ahead of the gate — see the exception there.)
    // Scarlet's managed intents (smart-money follows + programmed SL/TP/partials) + trading + arb + registry.
    if (config.SCARLET_AGENT_ENABLED) followService.start();
    if (config.SCARLET_AGENT_ENABLED && config.EXECUTION_ENABLED) positionManager.start();
    if (config.SCARLET_AGENT_ENABLED && config.ARB_ENABLED) arbEngine.start();
    // The position registry is a DATA pipeline (discover → resolve size/health → tier), not part of the agent.
    // Gating it on SCARLET_AGENT_ENABLED meant that keeping Scarlet off — precisely so the data could be
    // completed first — was what stopped the data from being completed: 8,624 borrowers discovered by the
    // indexer sat unvalued for days because the only thing that classifies them never ran. It follows its own
    // flag now. Acting still does not: firing stays with the liquidation monitor above, behind EXECUTION_ENABLED.
    if (config.LIQ_REGISTRY_ENABLED) positionRegistry.start();
    if (config.SCARLET_AGENT_ENABLED) {
      // Continuous operation: each cycle re-schedules the next a short gap AFTER it finishes.
      const loop = async () => {
        if (scarletStopped) return;
        await activeAgent.live("continuous cycle").catch((error) => logger.error({ err: error }, "Scarlet cycle failed"));
        if (!scarletStopped) scarletHeartbeat = setTimeout(loop, activeAgent.nextGapMs);
      };
      scarletHeartbeat = setTimeout(() => void loop(), 10_000);
    } else {
      // DISABLED-BY-CONFIG log (pattern to extend everywhere): when a subsystem is intentionally off,
      // say so LOUDLY once, so a forgotten flag doesn't look like a silent failure. Only the AGENT is
      // stopped — indexer/enrichment/dashboard/walletHoldings keep running (no need to kill the container).
      logger.warn("Scarlet AGENT DISABLED by config (SCARLET_AGENT_ENABLED=false): trading loop, position-manager, follow, arb and registry NOT started. Indexer/enrichment/dashboard still run. Set SCARLET_AGENT_ENABLED=true to re-enable.");
    }
  }
  logger.info({ role: config.SERVICE_ROLE, chain: config.CHAIN_NAME, executionEnabled: config.EXECUTION_ENABLED, agent: config.SCARLET_V2_ENABLED ? "v2 (rebuild core)" : "legacy", llmAvailable: activeAgent.available, walletConfigured: Boolean(config.WALLET_ADDRESS) }, "Scarlet service started");
}

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  // Each component must be stopped on the role where it actually RUNS. registryEnricher started under the
  // brain branch but was stopped under the observer one, so on brain it was never stopped at all and its
  // 400ms drain kept querying after the pool was closed. Keep these two lists mirror images of the start ones.
  if (config.SERVICE_ROLE !== "brain") { collector.stop(); sensorium.stop(); launchWatcher.stop(); flowSensor.stop(); whaleIntel.stop(); graduationSensor.stop(); chainScanner.stop(); }
  if (config.SERVICE_ROLE !== "observer") { reconciler.stop(); autoflash.stop(); autoArm.stop(); liquidationMonitor.stop(); followService.stop(); positionManager.stop(); arbEngine.stop(); walletHoldings.stop(); displayPrices.stop(); blockIndexer.stop(); registryEnricher.stop(); positionRegistry.stop(); scarletStopped = true; if (scarletHeartbeat) clearTimeout(scarletHeartbeat); dashboard?.close(); }
  // DRAIN before closing the connection pool. stop() only stops NEW work from being scheduled; whatever was
  // already running keeps going, and closing the pool underneath it produced "Cannot use a pool after calling
  // end on the pool" — an alarming error for what is simply an unclean shutdown. Bounded: we wait for the
  // in-flight tick to notice the stop flag, and give up rather than hang if something does not settle.
  const drainDeadline = Date.now() + 5_000;
  while (blockIndexer.busy && Date.now() < drainDeadline) await new Promise((r) => setTimeout(r, 100));
  if (blockIndexer.busy) logger.warn("indexer still in flight at shutdown — closing anyway");
  await db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
void main().catch((error) => {
  logger.fatal({ err: error }, "fatal startup failure");
  process.exit(1);
});
