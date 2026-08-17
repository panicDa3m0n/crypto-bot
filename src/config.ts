import { z } from "zod";
import { readFileSync } from "node:fs";
import { loadNetwork, type Network } from "./network.js";

const bool = z.enum(["true", "false"]).transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVICE_ROLE: z.enum(["all", "observer", "brain"]).default("all"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PRIMARY_RPC_HTTP_URL: z.string().url(),
  SECONDARY_RPC_HTTP_URL: z.string().url(),
  HEADS_RPC_WS_URL: z.string().url().optional(),
  // Precision lane: the RPC the oracle / liquidation reads use, kept OFF the sensor firehose
  // (primary) so they never starve on shared rate-limits. Fallback: the single RPC any lane
  // reroutes to when its reference RPC rate-limits (429) or errors. Both default from the profile.
  PRECISION_RPC_HTTP_URL: z.string().url().optional(),
  FALLBACK_RPC_HTTP_URL: z.string().url().optional(),
  // DEDICATED execution lane: used ONLY to broadcast real transactions (position buys/sells,
  // liquidations, arb) so it stays free + fresh when we need to fire — never contended by the
  // read firehose. Point it at a dedicated (ideally paid) endpoint; defaults to the fallback RPC.
  EXECUTION_RPC_HTTP_URL: z.string().url().optional(),
  // Chain selector: CHAIN_ID picks the networks/<CHAIN_ID>.json profile that fills every
  // chain-specific field below (RPC, addresses, explorer, DEXes, tokens, infra). Flip it to migrate.
  CHAIN_ID: z.coerce.number().int().positive().default(8453),
  CHAIN_NAME: z.string().min(1).default("Base"),
  EXPLORER_NAME: z.string().min(1).default("Explorer"),
  EXPLORER_URL: z.string().url().default("https://basescan.org"),
  // Infra contracts (from the network profile): aggregator, flash-loan vault, lending core.
  MORPHO_CORE: z.string().optional(),
  AGGREGATOR_1INCH: z.string().optional(),
  BALANCER_VAULT: z.string().optional(),
  // Legacy Berachain GraphQL API. Kept only so the disabled Berachain-era scanners
  // still compile; unused at runtime on Monad.
  BERA_API_URL: z.string().url().default("https://api.berachain.com/"),
  // Keyless DefiLlama coins API is the USD price oracle (works cross-chain). We
  // build "<slug>:<address>" keys, so PRICE_CHAIN_SLUG selects the chain.
  PRICE_API_URL: z.string().url().default("https://coins.llama.fi"),
  PRICE_CHAIN_SLUG: z.string().min(1).default("monad"),
  // Symbols used only for the human/LLM-facing self-model strings (chain-neutral).
  NATIVE_SYMBOL: z.string().min(1).default("MON"),
  WRAPPED_SYMBOL: z.string().min(1).default("WMON"),
  // Uniswap-V3-style factory + QuoterV2 used by the check_token honeypot gate.
  // Optional extra venues to seed (JSON array of {id,name,type,address,meta}) — a second V3 for
  // cross-venue arb, Morpho, etc., without a code change. Chain-specific, set per deployment.
  VENUE_EXTRA_JSON: z.string().optional(),
  DEX_FACTORY: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x204faca1764b154221e35c0d20abb3c525710498"),
  DEX_QUOTER: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x661e93cca42afacb172121ef892830ca3b70f08d"),
  DEX_ROUTER: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900"),
  // Etherscan V2 unified API: one key, every EVM chain (chainid selects it). Powers
  // verified-ABI resolution and the anti-scam gate. Read-only, rate-limited, free.
  ETHERSCAN_API_KEY: z.string().min(1).optional(),
  ETHERSCAN_API_KEY_FILE: z.string().min(1).optional(),
  ETHERSCAN_CHAIN_ID: z.coerce.number().int().positive().default(143),
  ETHERSCAN_API_URL: z.string().url().default("https://api.etherscan.io/v2/api"),
  // Blockscout: keyless indexer for enrichment/discovery/history (token metadata, full wallet
  // holdings, address history, wide-range event logs) — NOT the precision/execution path. Optional
  // API key raises the rate limit. Default from the network profile.
  BLOCKSCOUT_API_URL: z.string().url().default("https://base.blockscout.com/api"),
  BLOCKSCOUT_API_KEY: z.string().min(1).optional(),
  BLOCKSCOUT_ENABLED: bool.default(true),
  // DISPLAY price cache (Lane A): batch-refresh discovered tokens' indicative prices into token_prices
  // so the dashboard reads DB only (never saturates APIs). NOT used for arb/liquidation decisions.
  DISPLAY_PRICE_ENABLED: bool.default(true),
  DISPLAY_PRICE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(30_000),
  DISPLAY_PRICE_STALE_MS: z.coerce.number().int().min(10_000).default(25_000), // re-price a token only once it's this stale
  DISPLAY_PRICE_BATCH: z.coerce.number().int().min(10).max(200).default(120),   // tokens per DefiLlama batch call
  DISPLAY_BACKFILL_MAX: z.coerce.number().int().min(0).max(20).default(6),       // bounded aggregator backfills/tick for priority misses
  DISPLAY_DEAD_RECHECK_MS: z.coerce.number().int().min(60_000).default(1_800_000), // unpriced/no-liquidity tokens: re-check only this often (not every tick) → the active list stays the liquid tokens
  // Measured volatility (EWMA of log-return variance, two half-lives). Reacts up fast, baseline slow.
  VOL_TAU_FAST_SEC: z.coerce.number().int().min(60).default(1200),   // ~20 min
  VOL_TAU_SLOW_SEC: z.coerce.number().int().min(3600).default(86400), // ~24 h
  // Morpho indexer API — deterministic markets + at-risk positions (health) so
  // Scarlet never has to enumerate borrowers herself.
  MORPHO_API_URL: z.string().url().default("https://api.morpho.org/graphql"),
  // Market/discovery data sources (free, keyless). GT_NETWORK is the GeckoTerminal
  // network slug; LLAMA_CHAIN is the DefiLlama chain name.
  GECKOTERMINAL_API_URL: z.string().url().default("https://api.geckoterminal.com/api/v2"),
  YIELDS_API_URL: z.string().url().default("https://yields.llama.fi"),
  GT_NETWORK: z.string().min(1).default("monad"),
  LLAMA_CHAIN: z.string().min(1).default("Monad"),
  // DEX aggregator = the universal cross-venue sized-quote engine (`dexOut`). Keyless KyberSwap
  // by default; AGGREGATOR_CHAIN is its chain slug (set from the network profile's gtNetwork).
  AGGREGATOR_API_URL: z.string().url().default("https://aggregator-api.kyberswap.com"),
  AGGREGATOR_CHAIN: z.string().min(1).default("base"),
  // Arbitrage engine: the SYSTEM discovers cross-venue/triangular cycles, re-quotes them at real
  // size via the aggregator (net of gas), and surfaces/executes only the truly profitable ones.
  ARB_ENABLED: bool.default(true),
  ARB_INTERVAL_MS: z.coerce.number().int().min(15_000).default(60_000),
  // Size sweep: profit is size-dependent (gas dominates when too small, slippage when too big),
  // so each candidate is re-quoted at several sizes and the best net is kept. First a cheap
  // single-size scout at ARB_SCOUT_SIZE_USD prunes; only near-profitable survivors get the sweep.
  ARB_SCOUT_SIZE_USD: z.coerce.number().min(5).default(50),
  // Includes flashloan-scale sizes: gas is FIXED, so a real-but-tiny spread that loses to gas at
  // $50 can profit at $1k–5k where gas is negligible. Execution at scale uses the organ's 0-fee
  // flash-loan (capital-free). The profit gate filters the negatives (thin pools worsen at size).
  ARB_PROBE_SIZES_USD: z.string().default("20,80,250,1000,5000"),
  ARB_MIN_PROFIT_USD: z.coerce.number().min(0).default(0.05),
  ARB_MAX_CANDIDATES: z.coerce.number().int().min(1).max(60).default(16),
  ARB_TRIANGULAR: bool.default(true),
  ARB_WATCHLIST_MAX: z.coerce.number().int().min(0).max(30).default(10),
  // Execution realism: net is decided on the slippage-adjusted FLOOR (guaranteed min-out), not
  // the optimistic mid; gas is the ATOMIC bundle (2 swaps + organ/flashloan overhead) priced at
  // the live on-chain gas price, not the sum of two standalone aggregator gas estimates.
  ARB_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(500).default(50),
  ARB_ORGAN_GAS_OVERHEAD: z.coerce.number().int().min(0).default(120_000),
  // REALISTIC per-swap gas for the atomic-bundle estimate (a real swap is ~150-200k, NOT the
  // ~7x-inflated value aggregators report). Used with the live gas price + organ overhead.
  ARB_SWAP_GAS: z.coerce.number().int().min(50_000).default(180_000),
  // Chain scanner: builds the system's OWN address universe (tokens/pools/dexes) by ingesting
  // block-window event logs and classifying emitters mechanically — no curated list. Windowed
  // with a per-tick probe budget to respect public-RPC limits.
  SCANNER_ENABLED: bool.default(true), // bool (not z.coerce.boolean, which reads "false" as truthy)
  SCANNER_INTERVAL_MS: z.coerce.number().int().min(10_000).default(30_000),
  // Public RPCs cap eth_getLogs range (blastapi Base = 10 blocks), so the window is CHUNKED:
  // RANGE_BLOCKS per getLogs call, up to MAX_CHUNKS calls per tick, advancing the cursor only
  // over what was processed (no gaps; catches up over ticks if behind).
  SCANNER_RANGE_BLOCKS: z.coerce.number().int().min(1).max(10).default(10),
  SCANNER_MAX_CHUNKS: z.coerce.number().int().min(1).max(50).default(6),
  SCANNER_MAX_PROBES: z.coerce.number().int().min(5).max(500).default(40),
  // Registry enrichment: the Etherscan contract module (works on Base free) marks each token/dex/
  // contract with verified/name/proxy — a deterministic scam signal — throttled to respect the
  // free-tier rate limit (5 req/s, 100k/day) and cached (done once per address in its meta).
  ENRICH_ENABLED: bool.default(true),
  ENRICH_INTERVAL_MS: z.coerce.number().int().min(10_000).default(30_000),
  ENRICH_BATCH: z.coerce.number().int().min(1).max(50).default(12),
  // Lending position registry: enumerate ALL borrowers (old + new), classify into tiers, poll
  // adaptively — watch (near HF threshold, fast) / profitable (healthy, slow) / low_collateral /
  // blacklist / closed. Watch-tier feeds the existing flash-kill.
  LIQ_REGISTRY_ENABLED: bool.default(true),
  LIQ_ENUM_INTERVAL_MS: z.coerce.number().int().min(60_000).default(180_000),
  LIQ_TICK_INTERVAL_MS: z.coerce.number().int().min(10_000).default(20_000),
  LIQ_WATCH_HF: z.coerce.number().min(1).default(1.05),  // HF at/below which a position is "watch"
  LIQ_HF_CEIL: z.coerce.number().min(1).default(1.5),    // enumerate depth: positions up to this HF (the near+imminent pipeline)
  // Discovery focus: junk/spam Morpho markets are full of bad-debt husks (HF<1, unexitable) that
  // otherwise SATURATE the HF-ascending enumeration and starve the real targets. marketListed:true
  // restricts to Morpho's curated markets (verified: HF<1 on listed markets = 0 real targets — the
  // husks live only in unlisted junk). This is what lets a bounded budget reach the genuine pipeline.
  LIQ_MARKET_LISTED_ONLY: bool.default(true),
  LIQ_EXIT_HF: z.coerce.number().min(1).default(1.10),   // only run the (costly) aggregator exit quote for HF ≤ this; farther = "candidate" (known, HF-tracked, quoted once it approaches)
  LIQ_ENUM_MAX_PAGES: z.coerce.number().int().min(1).max(50).default(10), // 100 positions/page — covers the real curated near+imminent band without a husk flood
  LIQ_MIN_DEBT_USD: z.coerce.number().min(0).default(10),
  LIQ_EVENT_RANGE: z.coerce.number().int().min(1000).default(100_000), // block window for the Blockscout Borrow-event completeness/resilience cross-check
  // Wallet holdings read DIRECTLY from chain, keyless (Etherscan free tier excludes Base account
  // data). A wide-range logs RPC discovers tokens the wallet received (Transfer), then balanceOf
  // keeps the nonzero ones. Uses its OWN RPC so it never adds load to the rate-limited primary.
  // BLOCK INDEXER — the STARTING POINT of the system. It processes every new block once (1 filtered
  // getLogs/block, base.org feed + fallback), derives prices/pools/tokens LOCALLY and writes the DB;
  // everything else reads the DB, never the chain. Chain-sourced data is ALWAYS the indexer's job.
  INDEXER_ENABLED: bool.default(true),
  // Single-mode block source: 'blocks' (2s) now; 'flashblocks' (200ms) is a future reconfigure — never hybrid.
  BLOCK_SOURCE: z.enum(["blocks", "flashblocks"]).default("blocks"),
  // Debug: keep the raw block logs (24h) for development; off = discard after processing.
  DEBUG_KEEP_RAW_BLOCKS: bool.default(false),
  INDEXER_RAW_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  INDEXER_MAX_CATCHUP: z.coerce.number().int().min(10).max(50_000).default(2_000), // cap blocks caught up per tick
  INDEXER_POLL_MS: z.coerce.number().int().min(1_000).max(10_000).default(2_500),  // fallback poll if WS heads drops
  // Chainlink ETH/USD feed (Base) — the ROBUST anchor for USD conversion (one bad anchor cascades to all).
  CHAINLINK_ETH_USD_FEED: z.string().min(1).default("0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70"),
  WALLET_LOGS_RPC: z.string().url().default("https://mainnet.base.org"),
  WALLET_LOGS_RANGE: z.coerce.number().int().min(100).max(10_000).default(9_000),
  WALLET_BACKFILL_BLOCKS: z.coerce.number().int().min(10_000).default(500_000),
  WALLET_HOLDINGS_INTERVAL_MS: z.coerce.number().int().min(20_000).default(30_000),
  WALLET_TRANSFER_PAGES: z.coerce.number().int().min(1).max(10).default(3), // Blockscout token-transfer pages to discover the wallet's touched tokens
  // Auto-fire is OFF until the atomic executor's balance-aware leg-chaining is validated on-chain;
  // until then the engine discovers + verifies + notifies, and firing is a deliberate step.
  ARB_AUTOFIRE: bool.default(false),
  // Cross-cycle history: Scarlet carries her past cycles as running context. When the
  // estimated history reaches COMPACT_AT of the model's context, older cycles are
  // LLM-summarized down to KEEP_FRESH, so continuity survives without unbounded cost.
  HISTORY_MAX_TOKENS: z.coerce.number().int().min(50_000).default(1_000_000),
  HISTORY_COMPACT_AT_PCT: z.coerce.number().min(0.3).max(0.95).default(0.7),
  HISTORY_KEEP_FRESH_PCT: z.coerce.number().min(0.05).max(0.5).default(0.2),
  MINIMAX_API_KEY: z.string().min(1).optional(),
  MINIMAX_API_KEY_FILE: z.string().min(1).optional(),
  MINIMAX_MODEL: z.string().default("MiniMax-M3"),
  // OpenAI-compatible MiniMax endpoint. Our clients use the OpenAI SDK, so this
  // must be the /v1 compat base, not the /anthropic one.
  MINIMAX_BASE_URL: z.string().url().default("https://api.minimax.io/v1"),
  SCARLET_PROMPT_PATH: z.string().min(1).default("src/prompts/scarlet.md"),
  SCARLET_AGENT_PROMPT_PATH: z.string().min(1).default("src/prompts/scarlet-agent.md"),
  // Rebuild (Gradino 1): the clean ScarletAgent trading core. When true it drives instead of the legacy
  // Scarlet; woken by the periodic heartbeat (Channel A) + own-position/watchlist events (Channel B).
  SCARLET_V2_ENABLED: bool.default(false),
  SCARLET_CORE_PROMPT_PATH: z.string().min(1).default("src/prompts/scarlet-core.md"),
  SCARLET_MAX_ROUNDS: z.coerce.number().int().min(1).max(24).default(8),
  // Rest between cycles: the next activation starts this long AFTER the previous
  // one finishes (not a fixed interval), so Scarlet operates continuously with no
  // dead time while a slow cycle is still thinking.
  SCARLET_CYCLE_GAP_MS: z.coerce.number().int().min(2_000).max(300_000).default(30_000),
  // Idle-backoff: when the material state is unchanged cycle-to-cycle, the gap grows
  // (30s → 1m → 2m → cap) to stop burning LLM cost re-analysing an identical snapshot;
  // it snaps back to the base gap the instant something material changes. Time-critical
  // reactivity stays with the auto-flash watcher (4s poll), not the thinking loop.
  SCARLET_MAX_CYCLE_GAP_MS: z.coerce.number().int().min(30_000).max(1_800_000).default(180_000),
  // Read-only human dashboard port (wallet, actions, history). 0 disables it.
  DASHBOARD_PORT: z.coerce.number().int().min(0).max(65_535).default(8899),
  // When true, the agentic Scarlet core (she perceives, plans and drives her own
  // primitives) is the brain, activated on the heartbeat and on material events.
  // When false, the legacy deterministic candidate loop drives instead.
  SCARLET_AGENT_ENABLED: bool.default(true),
  AUTOARM_ENABLED: bool.default(false), // superseded by the on-chain LiquidationMonitor (no cap, HF on-chain, fire fresh)
  AUTOARM_MIN_DEBT_USD: z.coerce.number().min(0).default(2),
  AUTOARM_MAX_WATCHERS: z.coerce.number().int().min(1).max(80).default(15),
  AUTOARM_HORIZON_SEC: z.coerce.number().int().min(60).default(3600),   // imminence horizon T (how soon we care about a cross)
  AUTOARM_PRIOR_VOL: z.coerce.number().min(0).default(0.15),            // σ prior for unknown-vol tokens (assume volatile until measured)
  AUTOARM_MIN_IMMINENCE: z.coerce.number().min(0).default(0.15),        // include in the arm band iff σ(T) ≥ this × distance-to-cross
  // On-chain HF monitor: watch ALL near-threshold positions (no cap) by reading each market's oracle
  // price per tick and comparing to the precomputed liquidation price. Fire is built FRESH at the cross.
  LIQ_MONITOR_ENABLED: bool.default(true),
  LIQ_MONITOR_INTERVAL_MS: z.coerce.number().int().min(1500).default(3000),
  LIQ_MONITOR_MAX_FIRES: z.coerce.number().int().min(1).default(3),      // max fires attempted per tick (sequential)
  LIQ_NEAR_MARGIN: z.coerce.number().min(0).default(0.05),               // "near" = oracle price within this % of the (stale) liq_price → refresh its SIZE on-chain for a fresh HF
  // Profit-aware priority-fee bidding: liquidations are winner-take-all, so we bid an EIP-1559 priority
  // fee SCALED to the profit at stake (measured, not hardwired) to actually win block inclusion. The
  // budget is a fraction of the position's profit; per-gas priority = budget/gasUnits, clamped to a
  // sane [min,max] gwei band. On Base gas is ~$0.05 so a $200 liq can outbid everyone and still net ~$150.
  LIQ_PRIORITY_PROFIT_FRACTION: z.coerce.number().min(0).max(0.9).default(0.2), // max share of profit spent on priority fee
  LIQ_PRIORITY_FEE_MIN_GWEI: z.coerce.number().min(0).default(0.5),       // floor — always bid above Base's ~0.01 gwei default
  LIQ_PRIORITY_FEE_MAX_GWEI: z.coerce.number().min(0).default(1000),      // absolute safety cap on priority fee
  LIQ_GAS_UNITS: z.coerce.number().int().min(100_000).default(700_000),   // conservative gas estimate for flash-liq+swap (fee budget + on-chain profit floor)
  WHALE_INTEL_ENABLED: bool.default(true),
  WHALE_MAX_WALLETS: z.coerce.number().int().min(1).max(40).default(12),
  WHALE_FLOW_PAGES: z.coerce.number().int().min(1).max(10).default(3), // Blockscout token-transfer pages per wallet (~50 each)
  // Graduation-arb sensor (the Base strategy): fresh cross-venue price gaps on just-launched tokens.
  GRAD_ENABLED: bool.default(true),
  GRAD_MIN_LIQ_USD: z.coerce.number().min(0).default(3000),
  GRAD_MIN_VOL1H_USD: z.coerce.number().min(0).default(500),
  GRAD_MAX_PROBES: z.coerce.number().int().min(1).max(20).default(6),
  GRAD_MIN_SPREAD_PCT: z.coerce.number().min(0).default(2),
  MINIMAX_MAX_TOOL_ROUNDS: z.coerce.number().int().min(0).max(12).default(6),
  AGENT_REVIEW_INTERVAL_MS: z.coerce.number().int().min(60_000).max(6 * 60 * 60_000).default(5 * 60_000),
  WALLET_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  WALLET_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  WALLET_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_ADMIN_CHAT_ID: z.string().regex(/^-?\d+$/).transform(Number).optional(),
  EXECUTION_ENABLED: bool.default(false),
  DAILY_LOSS_LIMIT_USD: z.coerce.number().positive().default(5),
  MIN_NAV_USD: z.coerce.number().nonnegative().default(0.10),
  MIN_BERA_RESERVE: z.coerce.number().positive().default(1),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(500).default(100),
  // Tolerance (in blocks) for the dual-RPC preflight divergence + drift checks.
  // Monad's ~0.5s blocks make two parallel RPC reads land several blocks apart in
  // normal operation, so the Berachain-era ±1 falsely blocked valid executions.
  MAX_PREFLIGHT_BLOCK_LAG: z.coerce.number().int().min(1).max(50).default(8),
  MAX_QUOTE_AGE_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  BASE_ASSET: z.enum(["BERA", "USDC_E"]).default("BERA"),
  // Legacy field names kept to avoid a chain-wide rename; VALUES now point at Monad.
  // USDC_E_ADDRESS = primary stable (USDC). HONEY_ADDRESS = secondary stable
  // (USDT0) — the "reserve/accounting" slot in the self-model. WBERA_ADDRESS = WMON.
  USDC_E_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x754704Bc059F8C67012fEd69BC8A327a5aafb603"),
  HONEY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0xe7cd86e13AC4309349F30B3435a9d337750fC82D"),
  HONEY_DECIMALS: z.coerce.number().int().min(0).max(36).default(6),
  WBERA_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"),
  BEND_MORPHO_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x24147243f9c08d835C218Cda1e135f8dFD0517D0"),
  BEND_MARKET_IDS: z.string().min(66).default("0x950962c1cf2591f15806e938bfde9b5f9fbbfcc5fb640030952c08b536f1f167,0x1ba7904c73d337c39cb88b00180dffb215fc334a6ff47bbe829cd9ee2af00c97,0x63c2a7c20192095c15d1d668ccce6912999b01ea60eeafcac66eca32015674dd,0x1f05d324f604bd1654ec040311d2ac4f5820ecfd1801a3d19d2c6f09d4f7a614,0x147b032db82d765b9d971eac37c8176260dde0fe91f6a542f20cdd9ede1054df,0x594de722a090f8d0df41087c23e2187fb69d9cd6b7b425c6dd56ddc1cff545f0"),
  BEND_LOG_LOOKBACK_BLOCKS: z.coerce.number().int().min(1_000).max(500_000).default(50_000),
  // Small bounded ranges prevent a free/archive endpoint timeout from silently
  // creating blind spots in liquidation discovery.
  BEND_BACKFILL_BLOCKS_PER_SCAN: z.coerce.number().int().min(100).max(10_000).default(500),
  BEND_MAX_POSITION_READS_PER_SCAN: z.coerce.number().int().min(1).max(250).default(25),
  BEND_ARCHIVE_RPC_URL: z.string().url().default("https://berachain.drpc.org"),
  BEND_SCAN_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(20_000),
  OPPORTUNITY_SCAN_INTERVAL_MS: z.coerce.number().int().min(15_000).max(900_000).default(60_000),
  /**
   * Evidence needed before a third-party protocol write. This is deliberately
   * much shorter than the historical 72-hour blanket hold: every write still
   * receives a dual-RPC preflight immediately before broadcast.
   */
  OBSERVATION_GATE_HOURS: z.coerce.number().int().min(1).max(168).default(6),
  /** Self-custodial WBERA wrap/unwrap is the only action eligible for this gate. */
  BOOTSTRAP_GATE_MINUTES: z.coerce.number().int().min(10).max(180).default(20),
  /** Tolerates brief head races, but never an unavailable RPC or a stale stream. */
  MIN_OBSERVATION_HEALTH_RATIO: z.coerce.number().min(0.9).max(1).default(0.95),
  MAX_OBSERVATION_GAP_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
  MICRO_TEST_MAX_LOSS_USD: z.coerce.number().positive().max(0.05).default(0.05)
  // Action layer (Scarlet's position tools). She declares simple intent (token + size + optional
  // stop/target); the deterministic engine fills routing/slippage/gas/approve/wrap + arms SL/TP. These
  // bound her per-position size and how many positions can be open at once — safety without over-caution.
  ,POSITION_MIN_USD: z.coerce.number().positive().default(1)
  ,POSITION_MAX_USD: z.coerce.number().positive().default(25)
  ,POSITION_MAX_OPEN: z.coerce.number().int().min(1).max(50).default(6)
  ,POSITION_SLIPPAGE_PCT: z.coerce.number().min(0.1).max(50).default(8)
  // Capital bands drive which profit engines Scarlet may consider at the current
  // NAV. Micro-cent Berachain gas keeps micro strategies economic; larger bands
  // unlock liquidations and bigger allocations. Thresholds are inclusive upper
  // bounds in USD NAV (band = first threshold the NAV is strictly below).
  // Scarlet's HONEY reserve runway target (her "fat"). Reserve below this makes
  // her hungry and tilts her from exploring to exploiting; above it she is free
  // to explore. Expressed in HONEY (≈ USD for a stable), her store of value.
  ,HONEY_RUNWAY_TARGET: z.coerce.number().positive().default(10)
  // Profit milestones (USD): the objective ladder Scarlet climbs. The system leads
  // every briefing with progress to the next one — gains first, not losses.
  ,PROFIT_MILESTONES: z.string().default("100,250,500,1000,2500,5000,10000,25000,50000,100000")
  // Per-action downside cap for Scarlet's freely-composed agent actions. She may
  // compose any sequence, but no single action may put more than this at risk
  // (in HONEY/USD terms). The cumulative daily loss budget bounds the whole plan.
  ,AGENT_MAX_ACTION_LOSS_HONEY: z.coerce.number().positive().default(1)
  ,BAND_MICRO_MAX_USD: z.coerce.number().positive().default(5)
  ,BAND_SMALL_MAX_USD: z.coerce.number().positive().default(50)
  ,BAND_MEDIUM_MAX_USD: z.coerce.number().positive().default(500)
  ,ACTIVE_STRATEGY_MAX_ALLOCATION_PCT: z.coerce.number().min(0.05).max(0.8).default(0.5)
  ,ACTIVE_STRATEGY_MIN_CAPITAL_USD: z.coerce.number().positive().default(1)
  ,ACTIVE_YIELD_HORIZON_DAYS: z.coerce.number().int().min(7).max(365).default(30)
  ,ACTIVE_MIN_NET_PROFIT_USD: z.coerce.number().positive().default(0.03)
});

export type Config = z.infer<typeof schema> & { network: Network };

/** Fills chain-specific input fields from the network profile (env still wins if explicitly set). */
function applyNetwork(input: Record<string, string | undefined>, net: Network): void {
  const set = (k: string, v: string | undefined) => { if (input[k] === undefined && v !== undefined) input[k] = v; };
  const stables = net.tokens.filter((t) => t.kind === "stable");
  const dex0 = net.dexes[0];
  set("CHAIN_NAME", net.name);
  set("NATIVE_SYMBOL", net.nativeSymbol);
  set("WRAPPED_SYMBOL", net.wrapped.symbol);
  set("WBERA_ADDRESS", net.wrapped.address);
  set("PRIMARY_RPC_HTTP_URL", net.rpc.primary);
  set("SECONDARY_RPC_HTTP_URL", net.rpc.secondary);
  set("HEADS_RPC_WS_URL", net.rpc.ws);
  set("PRECISION_RPC_HTTP_URL", net.rpc.precision ?? net.rpc.secondary);
  set("FALLBACK_RPC_HTTP_URL", net.rpc.fallback ?? net.rpc.primary);
  set("EXECUTION_RPC_HTTP_URL", net.rpc.execution ?? net.rpc.fallback ?? net.rpc.primary);
  set("EXPLORER_NAME", net.explorer.name);
  set("EXPLORER_URL", net.explorer.url);
  set("BLOCKSCOUT_API_URL", net.explorer.blockscout);
  set("GT_NETWORK", net.data.gtNetwork);
  set("AGGREGATOR_CHAIN", net.data.gtNetwork);
  set("PRICE_CHAIN_SLUG", net.data.gtNetwork);
  set("LLAMA_CHAIN", net.data.llamaChain);
  set("ETHERSCAN_CHAIN_ID", String(net.data.etherscanChainId));
  set("USDC_E_ADDRESS", stables[0]?.address);
  set("HONEY_ADDRESS", stables[1]?.address ?? stables[0]?.address);
  set("MORPHO_CORE", net.infra.morpho);
  set("AGGREGATOR_1INCH", net.infra.aggregator1inch);
  set("BALANCER_VAULT", net.infra.balancerVault);
  if (dex0) { set("DEX_FACTORY", dex0.factory); set("DEX_ROUTER", dex0.router); set("DEX_QUOTER", dex0.quoter); }
  // Extra DEXes (beyond the primary) are seeded into the venue registry.
  if (net.dexes.length > 1) set("VENUE_EXTRA_JSON", JSON.stringify(net.dexes.slice(1).map((d) => ({ id: d.id, name: d.name, type: d.type, address: d.factory, meta: { role: "factory", swapRouter: d.router, quoter: d.quoter, note: d.note } }))));
}

export function loadConfig(env = process.env): Config {
  const input: Record<string, string | undefined> = { ...env };
  const chainId = Number(input.CHAIN_ID ?? 8453);
  const network = loadNetwork(chainId);
  applyNetwork(input, network);
  if (!input.MINIMAX_API_KEY && input.MINIMAX_API_KEY_FILE) {
    try {
      input.MINIMAX_API_KEY = readFileSync(input.MINIMAX_API_KEY_FILE, "utf8").trim();
    } catch {
      throw new Error("MINIMAX_API_KEY_FILE could not be read by the bot process");
    }
  }
  if (!input.WALLET_PRIVATE_KEY && input.WALLET_PRIVATE_KEY_FILE) {
    try {
      input.WALLET_PRIVATE_KEY = readFileSync(input.WALLET_PRIVATE_KEY_FILE, "utf8").trim();
    } catch {
      throw new Error("WALLET_PRIVATE_KEY_FILE could not be read by the bot process");
    }
  }
  if (!input.ETHERSCAN_API_KEY && input.ETHERSCAN_API_KEY_FILE) {
    try {
      input.ETHERSCAN_API_KEY = readFileSync(input.ETHERSCAN_API_KEY_FILE, "utf8").trim();
    } catch {
      throw new Error("ETHERSCAN_API_KEY_FILE could not be read by the bot process");
    }
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  if (parsed.data.EXECUTION_ENABLED && parsed.data.SERVICE_ROLE !== "observer" && (!parsed.data.WALLET_ADDRESS || !parsed.data.WALLET_PRIVATE_KEY)) {
    throw new Error("Execution requires both WALLET_ADDRESS and WALLET_PRIVATE_KEY from the server secret manager");
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.PRIMARY_RPC_HTTP_URL === parsed.data.SECONDARY_RPC_HTTP_URL) {
    throw new Error("Production requires two independent RPC HTTP endpoints; identical endpoints cannot satisfy the data-quality gate");
  }
  if (Boolean(parsed.data.TELEGRAM_BOT_TOKEN) !== Boolean(parsed.data.TELEGRAM_ADMIN_CHAT_ID)) {
    throw new Error("Telegram requires both TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID");
  }
  return { ...parsed.data, network };
}
