import { z } from "zod";
import { readFileSync } from "node:fs";
import { loadNetwork, type Network } from "./network.js";

const bool = z.enum(["true", "false"]).transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVICE_ROLE: z.enum(["all", "observer", "brain"]).default("all"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // UNIFIED OBSERVABILITY FILE — every subsystem's log (they all share one pino logger) is ALSO written to a
  // single timestamped, ROTATING file on a mounted volume, so we can review "everything that happened" across
  // restarts without gaps. Rotation keeps it from growing forever (a ~12h window is enough to spot bugs) and
  // is fully settable to widen for longer test runs.
  LOG_FILE_ENABLED: bool.default(true),
  LOG_DIR: z.string().default("logs"),                          // mounted host dir (persists across restarts)
  LOG_FILE_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("debug"), // file catches MORE detail than stdout
  LOG_ROTATE_INTERVAL: z.string().default("12h"),               // rotate on this cadence (e.g. '12h', '1d', '6h')
  LOG_RETENTION_FILES: z.coerce.number().int().min(1).max(200).default(4), // keep this many rotated files (retention)
  LOG_MAX_SIZE: z.string().default("100M"),                     // also rotate if a single file exceeds this size
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
  /** BULK lane: every batched multicall goes here. Measured on Base with the liquidation monitor's own
   * reads (14 oracles, 250 Morpho positions): nodies 0/14 and 0/250, base.org 14/14 but 60/250, blastapi
   * 250/250 in 197ms. A lane that cannot take a batch turns one read into forty and cost the monitor 42
   * SECONDS per tick on a 2-second chain — so batches get a lane chosen for exactly that. */
  BULK_RPC_HTTP_URL: z.string().url().optional(),
  // DEDICATED execution lane: used ONLY to broadcast real transactions (position buys/sells,
  // liquidations, arb) so it stays free + fresh when we need to fire — never contended by the
  // read firehose. Point it at a dedicated (ideally paid) endpoint; defaults to the fallback RPC.
  EXECUTION_RPC_HTTP_URL: z.string().url().optional(),
  // DEDICATED INDEXER LANE. The block-indexer does 1 getLogs/block + a burst of metadata reads on
  // discovery; a rate-limit here loses a block and unbalances the whole system, so it gets its OWN RPC,
  // used ONLY by the indexer — full-ingestion (eth_getBlockReceipts real-time) AND sync (eth_getLogs).
  // ── RPC LANE ASSIGNMENT (measured 2026-08-18; see memory `rpc-lane-assignment`). Chosen by tool need +
  // burst + timing, one RPC per tool, each with a capable fallback. base.org BLOCKS getBlockReceipts (403),
  // so the indexer runs on drpc (52ms, receipts+getLogs; fallback publicnode/nodies → degrade to getLogs).
  // Key timing: the indexer's sync burst (~50/s, 8→6 concurrency) happens ONLY while Scarlet is GATED, so it
  // never coincides with Scarlet's tools. Execution → publicnode (MEV-protected send). General reads →
  // base.org. PriceOracle precision + enrichment → nodies. Secondary/fallbacks → 1rpc/blastapi.
  INDEXER_RPC_HTTP_URL: z.string().url().default("https://base.drpc.org"),
  // DEDICATED ENRICHMENT LANE. Enrichment (token decimals/symbol/name + pool token0/1/fee) is BURSTY —
  // a first-run/catch-up can queue thousands of reads — so it gets its OWN endpoint, isolated from the
  // indexer's per-block critical path. When this RPC throttles, the enrichment queue simply waits (the
  // indexer never blocks). Configurable so we can swap it in one env change.
  ENRICHMENT_RPC_HTTP_URL: z.string().url().default("https://base-pokt.nodies.app"),
  // Scarlet's TOOL reads (honeypot probe, balanceOf/allowance for the final pre-trade checks). Low-volume
  // + bursty-in-short-windows; ALIGNED with the indexer lane by default (they don't collide at steady
  // state), but overridable to split them if needed. Purpose→endpoint is logged at startup ("RPC lanes").
  TOOLS_RPC_HTTP_URL: z.string().url().optional(),
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
  // OWN EXECUTION (Phase 3): when true, swaps are built + broadcast from OUR local route via the venue's
  // router (Uniswap V3 SwapRouter02 / Aerodrome / Uniswap V2), not the external aggregator's calldata —
  // the aggregator stays the FALLBACK (tried only if our build/preflight fails BEFORE broadcast), and that
  // fallback is LOGGED as an anomaly to diagnose, not an accepted outcome. Default ON (db-first convergence:
  // we execute, not KyberSwap). The preflight eth_call is the safety boundary: a mis-encode reverts in
  // simulation and falls back, never sends. Flip false only to force the aggregator path for A/B.
  LOCAL_EXECUTION_ENABLED: bool.default(true),
  // Venue routers for own execution (Base defaults; overridden from the network profile's dexes).
  AERODROME_ROUTER: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"),
  AERODROME_POOL_FACTORY: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x420DD381b31aEf6683db6B902084cB0FFECe40Da"),
  UNIV2_ROUTER: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"),
  UNIV2_FACTORY: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"),
  // Aerodrome SlipStream (Base CL): V3-style pricing but the router keys pools by int24 tickSpacing (not
  // fee) + takes a deadline. Its own encoder covers the top own-execution gap (SlipStream's fresh pools).
  SLIPSTREAM_POOL_FACTORY: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A"),
  SLIPSTREAM_ROUTER: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5"),
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
  // RETIRED (db-first convergence): the block-indexer now discovers the SAME dex/pool/token entities from
  // every block (PoolCreated/PairCreated + bare-pool-on-swap), so the scanner's own getLogs discovery is
  // pure duplication — no consumer reads scanner-specific output (all read `entities`). Default OFF; the
  // observer logs it disabled. Flip true only to A/B against the indexer's discovery.
  SCANNER_ENABLED: bool.default(false), // bool (not z.coerce.boolean, which reads "false" as truthy)
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
  // Inter-read spacing (ms) for the enrichment worker — paces sustained reads UNDER free-tier RPC limits
  // (a tight burst gets 429'd). Lower it when the enrichment lane is a keyed/paid endpoint with headroom.
  ENRICH_SPACING_MS: z.coerce.number().int().min(0).max(2_000).default(150),
  // STARTUP GATE safety: acting services wait for the indexer at head AND the enrichment RESYNC set drained.
  // If the resync set doesn't drain within this budget (a stuck/rate-limited lane), proceed anyway with a
  // LOUD warning rather than bricking the whole bot. 0 = wait indefinitely. Terminal-fail (MAX_ATTEMPTS)
  // normally guarantees the set resolves, so hitting this is a real anomaly to investigate.
  ENRICH_RESYNC_MAX_WAIT_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
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
  // FULL INGESTION: in REAL-TIME, fetch the WHOLE block via eth_getBlockReceipts (every log + receipt),
  // not just our topic-filtered subset — the cost is ~+10ms/block but we stop being blind to ~97% of the
  // network (other venues, token flows, LP liquidity, …). base.org blocks getBlockReceipts, so it runs on
  // the precision lane (publicnode). Off → legacy filtered getLogs. Historical SYNC stays filtered (bulk).
  INDEXER_FULL_INGESTION: bool.default(true),
  // Rolling raw-block buffer: keep the last N blocks' FULL logs (backup + reorg handling + discovery of
  // event types worth decoding). 0 = off. ~0.5MB/block → 100 blocks ≈ 50MB.
  INDEXER_RAW_BUFFER_BLOCKS: z.coerce.number().int().min(0).max(5_000).default(100),
  INDEXER_POLL_MS: z.coerce.number().int().min(1_000).max(10_000).default(2_500),  // fallback poll if WS heads drops
  // COLD START = RESYNC, no history replay (db-first convergence). A fresh DB (no cursor) starts AT head
  // (default 0): pre-existing state is NOT replayed — it comes from seeds + live discovery + enrichment
  // reading current on-chain data. A resume (cursor exists) covers the gap FORWARD from the last block.
  INDEXER_COLD_START_BLOCKS: z.coerce.number().int().min(0).max(60_000_000).default(0),
  // Safety: if the resume gap exceeds this, DON'T replay it — jump to head−COLD_START_BLOCKS (treat as a
  // fresh start). Bounds a pathological multi-day catch-up (state re-derives forward + enrichment fills).
  INDEXER_MAX_RESYNC_GAP: z.coerce.number().int().min(1_000).max(10_000_000).default(50_000),
  // SYNC vs real-time: a lag above this = "behind" → parallel FULL-ingestion catch-up + acting services
  // gated (wait). Below it = synced → real-time on the dedicated lane. A few blocks of lag is normal.
  INDEXER_RESYNC_LAG: z.coerce.number().int().min(2).max(10_000).default(60),
  // Behind (catch-up): full-ingest this many blocks CONCURRENTLY across the receipts-capable lanes
  // (indexer/exec/precision — base.org can't serve getBlockReceipts) to cut catch-up time; process up to
  // SYNC_MAX_CATCHUP blocks per tick. ONE pipeline: catch-up uses the SAME full ingestion as real-time
  // (not filtered getLogs) so wallet transfers / token_stats are captured identically. Kept at 6.
  INDEXER_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(24).default(6),
  // Per-tick block cap when behind. Full ingestion is one getBlockReceipts/block, so this is far smaller
  // than the old filtered-getLogs cap (100k) — a tick stays bounded and progress stays visible.
  INDEXER_SYNC_MAX_CATCHUP: z.coerce.number().int().min(100).max(2_000_000).default(2_000),
  // token_stats bucket uses wall-clock (5-min): during a big catch-up, blocks older than this (48h in blocks)
  // must NOT write stats or they'd dump historical volume into the current bucket. Guarded in processBlock.
  INDEXER_STATS_MAX_LAG_BLOCKS: z.coerce.number().int().min(3_600).max(2_000_000).default(86_400),
  // FLOW capture (db-first convergence): the indexer records each priced swap's wallet + USD into
  // recent_swaps so the FlowSensor derives hotPools/activeWallets/bigSwaps from the DB, not its own getLogs.
  INDEXER_FLOW_ENABLED: bool.default(true),
  INDEXER_FLOW_MIN_USD: z.coerce.number().min(0).default(1),          // skip dust swaps (bounds the table)
  INDEXER_FLOW_RETAIN_BLOCKS: z.coerce.number().int().min(30).max(50_000).default(150), // ~5min on Base (2s blocks)
  // Uniswap V4 singleton PoolManager (Base) + the block to backfill its Initialize events from (V4 pools
  // exist only in the Initialize log — the `resync v4pools` task scans them so existing pools like BSW price).
  V4_POOLMANAGER: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x498581fF718922c3f8e6A244956aF099B2652b2b"),
  V4_BACKFILL_FROM_BLOCK: z.coerce.number().int().min(0).default(38_000_000), // safely before V4 Base launch (~Jan 2026)
  // ROUTER FRESHNESS: a quote/route leg whose pool_state is more than this many blocks behind the indexer
  // head is "stale" → the local router refreshes it on-chain or skips it (never quotes on blindly-old state).
  // On Base (~2s blocks) 5 blocks ≈ 10s. Cross-cutting freshness stamp: every datum carries its update-block.
  ROUTE_MAX_BLOCKS_BEHIND: z.coerce.number().int().min(1).max(10_000).default(5),
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
  // State machine prompts. Identity = stable core (loaded as system[0]); the phase prompts and the
  // per-strategy prompts are attached on top of it as the turn moves through activation → operative → conclusion.
  SCARLET_CORE_PROMPT_PATH: z.string().min(1).default("src/prompts/scarlet-identity.md"),
  SCARLET_ACTIVATION_PROMPT_PATH: z.string().min(1).default("src/prompts/scarlet-activation.md"),
  SCARLET_CONCLUSION_PROMPT_PATH: z.string().min(1).default("src/prompts/scarlet-conclusion.md"),
  SCARLET_STRATEGY_DIR: z.string().min(1).default("src/strategy"),
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
  // Action layer. Scarlet declares INTENT (token + stop + conviction); the system SIZES the position
  // like a human trader: risk-based (size = risk / stop-distance), capped by concentration (per token
  // quality), by pool liquidity (exit cleanly), and by total portfolio heat (which sets how MANY
  // positions can be open — not a fixed number). % of NAV so it auto-scales with capital.
  ,POSITION_RISK_PCT: z.coerce.number().positive().max(20).default(2)          // % of NAV risked per trade (loss if stopped)
  ,POSITION_MAX_NAV_PCT_FRESH: z.coerce.number().positive().max(100).default(15)   // hard concentration cap, fresh/thin token
  ,POSITION_MAX_NAV_PCT_QUALITY: z.coerce.number().positive().max(100).default(30) // hard concentration cap, established token
  ,POSITION_MAX_LIQ_PCT: z.coerce.number().positive().max(20).default(1.5)     // ≤ this % of the token's liquidity (clean exit)
  ,PORTFOLIO_HEAT_PCT: z.coerce.number().positive().max(100).default(18)       // total open risk cap → emergent position count
  ,POSITION_MIN_USD: z.coerce.number().positive().default(0.10)                // floor: even a 10-cent lottery ticket is allowed (gas on Base is ~1-5¢)
  ,POSITION_MAX_USD: z.coerce.number().positive().default(40)                  // absolute per-position ceiling (safety)
  ,POSITION_MAX_OPEN: z.coerce.number().int().min(1).max(50).default(20)       // hard sanity cap (heat is the real limiter)
  // LAUNCHTOKEN sizing is DIFFERENT from bluechip: it's a power-law LOTTERY. You go in almost expecting to
  // lose the ticket; the edge is the rare 10-100× spike. So a launch bet is a TINY fixed ticket (a small %
  // of NAV, conviction-scaled), NOT the risk/stop model — the whole ticket is the risk (a memecoin dumps
  // past any stop). Many small uncorrelated tickets; the spikes pay for the zeros.
  ,LAUNCH_TICKET_PCT: z.coerce.number().positive().max(10).default(0.6)        // % of NAV per launch ticket (× conviction)
  ,LAUNCH_MAX_USD: z.coerce.number().positive().default(5)                     // absolute ceiling on a single launch ticket
  // PER-CATEGORY BUDGETS (of NAV) — Scarlet organizes her capital into buckets, NOT one daily/total cap. Each
  // strategy can deploy up to ITS bucket; the rest stays as stable/native RESERVE (maintenance; future: LP for
  // fees). She sees the live allocation (used/free) in the briefing and works within it. Defaults are guardrails.
  ,LAUNCH_BUDGET_PCT: z.coerce.number().min(0).max(100).default(20)            // lottery money → launches
  ,BLUECHIP_BUDGET_PCT: z.coerce.number().min(0).max(100).default(50)          // complex/long-term (+ future borrow/lending) → bluechips
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
  set("BULK_RPC_HTTP_URL", net.rpc.bulk ?? net.rpc.fallback ?? net.rpc.primary);
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
  // Own-execution venue routers (Phase 3): source from the profile's dexes so a chain switch reroutes them.
  const aeroDex = net.dexes.find((d) => d.id === "aerodrome" || d.type === "aerodrome-v2");
  if (aeroDex?.router) set("AERODROME_ROUTER", aeroDex.router);
  if (aeroDex?.factory) set("AERODROME_POOL_FACTORY", aeroDex.factory);
  const univ2Dex = net.dexes.find((d) => d.id === "uniswap-v2" || d.type === "uni-v2");
  if (univ2Dex?.router) set("UNIV2_ROUTER", univ2Dex.router);
  if (univ2Dex?.factory) set("UNIV2_FACTORY", univ2Dex.factory);
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
