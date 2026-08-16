import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { BerachainClients } from "./chain.js";

/**
 * AddressClassifier — mechanical, chain-native recognition of what an address IS, for ANY
 * address (present or future), with zero curated lists. The deterministic ladder:
 *   getCode empty                → wallet (EOA)      [7702-delegated EOAs flagged separately]
 *   ERC-20 view shape responds   → token             (decimals/symbol/name/totalSupply)
 *   pool view shape responds     → pool + archetype  (token0/token1 [+fee for v3])
 *   factory view shape responds  → dex (factory)     (allPairsLength / owner+parameters)
 *   else                         → contract (unknown dapp)
 * The class is a deterministic SKELETON; APIs (price/security) and simulation (executability)
 * are layered ON TOP by callers — this module never pretends a shape-match proves safety.
 */
export type EntityKind = "wallet" | "token" | "pool" | "dex" | "contract";
export type Classification = { kind: EntityKind; confidence: number; symbol?: string; name?: string; decimals?: number; meta: Record<string, unknown> };

const ERC20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function name() view returns (string)", "function totalSupply() view returns (uint256)"]);
const V3POOL = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function tickSpacing() view returns (int24)"]);
const V2POOL = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)", "function factory() view returns (address)"]);
const SOLIDLY = parseAbi(["function stable() view returns (bool)"]);
const FACTORY = parseAbi(["function allPairsLength() view returns (uint256)", "function owner() view returns (address)"]);

export class AddressClassifier {
  constructor(private readonly chain: BerachainClients, private readonly logger: Logger) {}

  private read<T>(address: Address, abi: readonly unknown[], fn: string, args: unknown[] = []): Promise<T | undefined> {
    return this.chain.primary.readContract({ address, abi: abi as never, functionName: fn as never, args: args as never }).then((v) => v as T).catch(() => undefined);
  }

  /** Full deterministic ladder. Used for a genuinely unknown address (e.g. Scarlet inspects one). */
  async classify(address: Address): Promise<Classification> {
    const code = await this.chain.primary.getBytecode({ address }).catch(() => undefined);
    if (!code || code === "0x") return { kind: "wallet", confidence: 1, meta: {} };
    if (code.startsWith("0xef0100")) return { kind: "wallet", confidence: 0.9, meta: { delegated7702: true } }; // EIP-7702 delegated EOA
    const pool = await this.poolInfo(address);
    if (pool) return { kind: "pool", confidence: 0.9, meta: pool };
    const tok = await this.tokenInfo(address);
    if (tok) return { kind: "token", confidence: 0.85, symbol: tok.symbol, name: tok.name, decimals: tok.decimals, meta: {} };
    const pairs = await this.read<bigint>(address, FACTORY, "allPairsLength");
    if (pairs !== undefined) return { kind: "dex", confidence: 0.7, meta: { poolCount: pairs.toString() } };
    return { kind: "contract", confidence: 0.4, meta: { hasCode: true } };
  }

  /** Reads ERC-20 identity; returns undefined if the address is not a sane token. */
  async tokenInfo(address: Address): Promise<{ symbol: string; name: string; decimals: number } | undefined> {
    const [decimals, symbol, name, supply] = await Promise.all([
      this.read<number>(address, ERC20, "decimals"),
      this.read<string>(address, ERC20, "symbol"),
      this.read<string>(address, ERC20, "name"),
      this.read<bigint>(address, ERC20, "totalSupply")
    ]);
    if (decimals === undefined || supply === undefined) return undefined; // not an ERC-20
    if (Number(decimals) > 36) return undefined; // nonsense
    return { symbol: (symbol ?? "?").slice(0, 32), name: (name ?? "?").slice(0, 64), decimals: Number(decimals) };
  }

  /** Reads pool identity + archetype (v3 tick-based, or v2/solidly reserve-based). */
  async poolInfo(address: Address, hint?: "v3" | "v2"): Promise<{ archetype: string; token0: string; token1: string; fee?: number; stable?: boolean } | undefined> {
    const [token0, token1] = await Promise.all([this.read<string>(address, V3POOL, "token0"), this.read<string>(address, V3POOL, "token1")]);
    if (!token0 || !token1) return undefined; // no pool shape
    // v3 exposes fee(); v2/solidly expose getReserves() (and solidly stable()).
    const fee = hint === "v2" ? undefined : await this.read<number>(address, V3POOL, "fee");
    if (fee !== undefined) return { archetype: "v3", token0: token0.toLowerCase(), token1: token1.toLowerCase(), fee: Number(fee) };
    const reserves = await this.read<readonly bigint[]>(address, V2POOL, "getReserves");
    if (reserves !== undefined) { const stable = await this.read<boolean>(address, SOLIDLY, "stable"); return { archetype: stable !== undefined ? "solidly" : "v2", token0: token0.toLowerCase(), token1: token1.toLowerCase(), stable: stable ?? undefined }; }
    return { archetype: "unknown", token0: token0.toLowerCase(), token1: token1.toLowerCase() };
  }
}
