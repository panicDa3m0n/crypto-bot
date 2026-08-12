import { z } from "zod";
import { readFileSync } from "node:fs";

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
  BERA_API_URL: z.string().url().default("https://api.berachain.com/"),
  MINIMAX_API_KEY: z.string().min(1).optional(),
  MINIMAX_API_KEY_FILE: z.string().min(1).optional(),
  MINIMAX_MODEL: z.string().default("MiniMax-M2.7"),
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
  MAX_QUOTE_AGE_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  BASE_ASSET: z.enum(["BERA", "USDC_E"]).default("BERA"),
  USDC_E_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  HONEY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  WBERA_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default("0x6969696969696969696969696969696969696969"),
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
  ,ACTIVE_STRATEGY_MAX_ALLOCATION_PCT: z.coerce.number().min(0.05).max(0.8).default(0.5)
  ,ACTIVE_STRATEGY_MIN_CAPITAL_USD: z.coerce.number().positive().default(1)
  ,ACTIVE_YIELD_HORIZON_DAYS: z.coerce.number().int().min(7).max(365).default(30)
  ,ACTIVE_MIN_NET_PROFIT_USD: z.coerce.number().positive().default(0.03)
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env = process.env): Config {
  const input = { ...env };
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
  return parsed.data;
}
