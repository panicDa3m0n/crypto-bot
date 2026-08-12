import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BerachainNetworkConfig = {
  dataDirectory: string;
  berachainRpcUrl: string;
  berachainSecondaryRpcUrl: string;
};

export type MiniMaxConfig = BerachainNetworkConfig & {
  apiKey: string;
  baseURL: string;
  model: string;
  systemPromptPath: string;
  maxToolRounds: number;
};

export function loadConfig(env = process.env): MiniMaxConfig {
  const apiKey = env.MINIMAX_API_KEY?.trim() || readKeyFile(env.MINIMAX_API_KEY_FILE);
  if (!apiKey) throw new Error("Set MINIMAX_API_KEY or MINIMAX_API_KEY_FILE; do not store the key in this project.");
  return {
    ...loadNetworkConfig(env),
    apiKey,
    baseURL: env.MINIMAX_BASE_URL?.trim() || "https://api.minimax.io/v1",
    model: env.MINIMAX_MODEL?.trim() || "MiniMax-M2.7",
    systemPromptPath: resolve(env.MINIMAX_SYSTEM_PROMPT_FILE?.trim() || "prompts/wallet-brain.md"),
    maxToolRounds: positiveInteger(env.SCARLET_MAX_TOOL_ROUNDS, 12)
  };
}

/** Network-only configuration: safe to use by read-only observatory commands. */
export function loadNetworkConfig(env = process.env): BerachainNetworkConfig {
  const primary = env.BERACHAIN_RPC_URL?.trim() || "https://rpc.berachain.com";
  const secondary = env.BERACHAIN_SECONDARY_RPC_URL?.trim() || "https://berachain.drpc.org";
  if (primary === secondary) throw new Error("BERACHAIN_RPC_URL and BERACHAIN_SECONDARY_RPC_URL must be distinct for independent verification.");
  return {
    dataDirectory: resolve(env.SCARLET_DATA_DIRECTORY?.trim() || "data"),
    berachainRpcUrl: primary,
    berachainSecondaryRpcUrl: secondary
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error("SCARLET_MAX_TOOL_ROUNDS must be an integer from 1 to 100.");
  return parsed;
}

function readKeyFile(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined;
  try { return readFileSync(path, "utf8").trim() || undefined; }
  catch { throw new Error("MINIMAX_API_KEY_FILE could not be read by this process."); }
}
