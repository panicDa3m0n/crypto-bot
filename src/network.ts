import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * A network profile — ALL the chain-unique data in one file, named `networks/<chainId>.json`.
 * Nothing chain-specific is hardcoded in the system: the main config picks a CHAIN_ID, this
 * loader reads the matching profile, and every layer (RPC, DEXes, tokens, explorer, dashboard,
 * infra) derives from it. Migrating chains = write a new `<chainId>.json` and flip CHAIN_ID.
 */
const addr = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

export const dexProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(), // free-form (was a closed enum): a seed with a new DEX type must NEVER crash startup — it's just metadata
  factory: addr,
  router: addr.optional(),
  quoter: addr.optional(),
  note: z.string().optional()
});

export const tokenProfileSchema = z.object({
  address: addr,
  symbol: z.string(),
  decimals: z.number().int().min(0).max(36),
  kind: z.string().default("token"),
  note: z.string().optional()
});

export const protocolProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),       // lending | perp | cdp | ...
  family: z.string().optional(), // morpho | aave-v3 | compound | ... (drives the position adapter)
  address: addr,
  role: z.string().optional(), // core | pool | comptroller | trading | provider
  tvlUsd: z.number().optional(),
  note: z.string().optional()
});

export const networkSchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string(),
  nativeSymbol: z.string(),
  wrapped: z.object({ address: addr, symbol: z.string(), decimals: z.number().int().default(18) }),
  explorer: z.object({ name: z.string(), url: z.string().url(), blockscout: z.string().url().optional() }),
  rpc: z.object({ primary: z.string().url(), secondary: z.string().url(), ws: z.string().optional(), precision: z.string().url().optional(), fallback: z.string().url().optional(), execution: z.string().url().optional() }),
  data: z.object({ gtNetwork: z.string(), llamaChain: z.string(), etherscanChainId: z.number().int() }),
  infra: z.object({ aggregator1inch: addr.optional(), balancerVault: addr.optional(), morpho: addr.optional(), permit2: addr.optional() }).default({}),
  dexes: z.array(dexProfileSchema).default([]),
  tokens: z.array(tokenProfileSchema).default([]),
  protocols: z.array(protocolProfileSchema).default([])
});

export type Network = z.infer<typeof networkSchema>;
export type DexProfile = z.infer<typeof dexProfileSchema>;
export type TokenProfile = z.infer<typeof tokenProfileSchema>;

/** Reads and validates `networks/<chainId>.json`. Throws a clear error if missing/invalid. */
export function loadNetwork(chainId: number): Network {
  const candidates = [
    resolve(process.cwd(), "networks", `${chainId}.json`),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "networks", `${chainId}.json`)
  ];
  let raw: string | undefined;
  for (const path of candidates) {
    try { raw = readFileSync(path, "utf8"); break; } catch { /* try next */ }
  }
  if (!raw) throw new Error(`Network profile not found for chainId ${chainId} (looked in ${candidates.join(", ")})`);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error(`Network profile networks/${chainId}.json is not valid JSON`); }
  const parsed = networkSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid network profile ${chainId}.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (parsed.data.chainId !== chainId) throw new Error(`Network profile ${chainId}.json declares chainId ${parsed.data.chainId}`);
  return parsed.data;
}
