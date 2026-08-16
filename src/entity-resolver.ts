import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";

/**
 * The deterministic address resolver. Scarlet works with an ADDRESS; the system does the rest:
 * reads the contract on-chain and queries GeckoTerminal for realtime market data, returning a
 * complete, trustworthy object. Scarlet cannot alter these facts — she can only add the object
 * to her registry, blacklist it, and attach her own utility note. Prices are always realtime.
 */
const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)"
]);

export type ResolvedEntity = {
  address: string;
  kind: "token" | "contract";
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  verifiedBytecode: boolean;
  priceUsd: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  priceChange24hPct: number | null;
  topPool: string | null;
  gtName: string | null;
};

export class EntityResolver {
  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly logger: Logger) {}

  async resolve(address: Address): Promise<ResolvedEntity> {
    const [symbol, name, decimals, code] = await Promise.all([
      this.chain.primary.readContract({ address, abi: ERC20, functionName: "symbol" }).catch(() => null) as Promise<string | null>,
      this.chain.primary.readContract({ address, abi: ERC20, functionName: "name" }).catch(() => null) as Promise<string | null>,
      this.chain.primary.readContract({ address, abi: ERC20, functionName: "decimals" }).catch(() => null) as Promise<number | null>,
      this.chain.primary.getCode({ address }).catch(() => undefined)
    ]);
    const isToken = decimals !== null && symbol !== null;
    const gt = await this.gtToken(address).catch(() => undefined);
    return {
      address: address.toLowerCase(),
      kind: isToken ? "token" : "contract",
      symbol, name, decimals: decimals === null ? null : Number(decimals),
      verifiedBytecode: Boolean(code && code !== "0x"),
      priceUsd: gt?.priceUsd ?? null,
      volume24hUsd: gt?.volume24hUsd ?? null,
      liquidityUsd: gt?.liquidityUsd ?? null,
      priceChange24hPct: gt?.priceChange24hPct ?? null,
      topPool: gt?.topPool ?? null,
      gtName: gt?.name ?? null
    };
  }

  /** Realtime market data for a token from GeckoTerminal (price/volume/liquidity, all chains). */
  private async gtToken(address: Address): Promise<{ priceUsd: number | null; volume24hUsd: number | null; liquidityUsd: number | null; priceChange24hPct: number | null; topPool: string | null; name: string | null } | undefined> {
    const res = await fetch(`${this.config.GECKOTERMINAL_API_URL}/networks/${this.config.GT_NETWORK}/tokens/${address}?include=top_pools`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) }).catch(() => undefined);
    if (!res || !res.ok) return undefined;
    const json = await res.json() as { data?: { attributes?: Record<string, unknown> }; included?: Array<{ id?: string; attributes?: Record<string, unknown> }> };
    const a = json.data?.attributes ?? {};
    const pool = json.included?.[0]?.attributes ?? {};
    return {
      priceUsd: a.price_usd != null ? Number(a.price_usd) : null,
      volume24hUsd: a.volume_usd != null ? Math.round(Number((a.volume_usd as { h24?: string }).h24) || 0) : null,
      liquidityUsd: a.total_reserve_in_usd != null ? Math.round(Number(a.total_reserve_in_usd)) : null,
      priceChange24hPct: pool.price_change_percentage != null ? Number((pool.price_change_percentage as { h24?: string }).h24) || 0 : null,
      topPool: json.included?.[0]?.id?.split("_")[1] ?? null,
      name: (a.name as string) ?? null
    };
  }
}
