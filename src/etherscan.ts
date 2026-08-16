import type { Config } from "./config.js";

/**
 * Etherscan V2 unified API client: one key, every EVM chain (chainid selects it).
 * Read-only, rate-limited, free. It gives Scarlet two powers she lacked:
 *  - resolveAbi: fetch a contract's VERIFIED ABI instead of brute-forcing function
 *    signatures (she wasted whole cycles guessing on Berachain). With the ABI she
 *    reads/writes any verified contract precisely.
 *  - contractMeta: verification status, name, proxy/implementation — an anti-scam
 *    signal (an unverified contract is a real red flag) and a proxy resolver.
 */
export type ContractMeta = {
  address: string;
  verified: boolean;
  contractName?: string;
  isProxy: boolean;
  implementation?: string;
  compilerVersion?: string;
  note: string;
};

export class Etherscan {
  private readonly abiCache = new Map<string, string | null>();
  constructor(private readonly config: Config) {}

  get available(): boolean { return Boolean(this.config.ETHERSCAN_API_KEY); }

  private async call(params: Record<string, string>): Promise<unknown> {
    if (!this.config.ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY is not configured");
    const q = new URLSearchParams({ chainid: String(this.config.ETHERSCAN_CHAIN_ID), apikey: this.config.ETHERSCAN_API_KEY, ...params });
    const res = await fetch(`${this.config.ETHERSCAN_API_URL}?${q.toString()}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Etherscan request failed: ${res.status}`);
    return res.json();
  }

  /** Returns the verified ABI JSON string, or null if the contract is not verified. */
  async resolveAbi(address: string): Promise<string | null> {
    const key = address.toLowerCase();
    if (this.abiCache.has(key)) return this.abiCache.get(key) ?? null;
    const json = await this.call({ module: "contract", action: "getabi", address }) as { status?: string; result?: string };
    const ok = json.status === "1" && typeof json.result === "string" && json.result.trim().startsWith("[");
    const abi = ok ? json.result! : null;
    this.abiCache.set(key, abi);
    return abi;
  }

  /** Distinct ERC-20 tokens this wallet has ever received/sent (from token-transfer
   * history). Free-tier: `addresstokenbalance` (all balances at once) is PRO-only, so
   * we derive the candidate set from `tokentx` and read live balances on-chain. */
  async walletTokens(address: string, max = 40): Promise<Array<{ address: string; symbol: string; decimals: number }>> {
    const json = await this.call({ module: "account", action: "tokentx", address, page: "1", offset: String(max * 4), sort: "desc" }) as { status?: string; result?: Array<{ contractAddress?: string; tokenSymbol?: string; tokenDecimal?: string }> };
    if (json.status !== "1" || !Array.isArray(json.result)) return [];
    const seen = new Map<string, { address: string; symbol: string; decimals: number }>();
    for (const t of json.result) {
      const addr = t.contractAddress?.toLowerCase();
      if (!addr || seen.has(addr)) continue;
      seen.set(addr, { address: addr, symbol: t.tokenSymbol ?? "?", decimals: Number(t.tokenDecimal ?? 18) });
      if (seen.size >= max) break;
    }
    return [...seen.values()];
  }

  /** A wallet's NET token flow over a bounded block window (accumulating vs distributing).
   * The window bound is required — unbounded tokentx on an active wallet times out. This is
   * how we spy on whales/smart-money: net-in = accumulating (conviction), net-out = exiting. */
  async walletTokenFlow(address: string, startBlock: number, endBlock: number, offset = 100): Promise<Array<{ token: string; symbol: string; netAmount: number; txCount: number }>> {
    const json = await this.call({ module: "account", action: "tokentx", address, startblock: String(startBlock), endblock: String(endBlock), page: "1", offset: String(offset), sort: "desc" }) as { status?: string; result?: Array<{ contractAddress?: string; tokenSymbol?: string; tokenDecimal?: string; value?: string; to?: string }> };
    if (json.status !== "1" || !Array.isArray(json.result)) return [];
    const self = address.toLowerCase();
    const net = new Map<string, { token: string; symbol: string; netAmount: number; txCount: number }>();
    for (const t of json.result) {
      const token = t.contractAddress?.toLowerCase(); if (!token) continue;
      const dec = Number(t.tokenDecimal ?? 18); const v = Number(t.value ?? 0) / 10 ** dec;
      if (!Number.isFinite(v)) continue;
      const dir = (t.to ?? "").toLowerCase() === self ? 1 : -1;
      const e = net.get(token) ?? { token, symbol: t.tokenSymbol ?? "?", netAmount: 0, txCount: 0 };
      e.netAmount += dir * v; e.txCount += 1; net.set(token, e);
    }
    return [...net.values()].sort((a, b) => Math.abs(b.netAmount) - Math.abs(a.netAmount));
  }

  /** Verification status + name + proxy/implementation for anti-scam and proxy resolution. */
  async contractMeta(address: string): Promise<ContractMeta> {
    const json = await this.call({ module: "contract", action: "getsourcecode", address }) as { status?: string; result?: Array<Record<string, string>> };
    const row = Array.isArray(json.result) ? json.result[0] : undefined;
    const verified = Boolean(row && row.ABI && row.ABI !== "Contract source code not verified" && (row.SourceCode?.length ?? 0) > 0);
    const isProxy = row?.Proxy === "1";
    const implementation = isProxy && row?.Implementation && /^0x[a-fA-F0-9]{40}$/.test(row.Implementation) ? row.Implementation : undefined;
    return {
      address,
      verified,
      contractName: row?.ContractName || undefined,
      isProxy,
      implementation,
      compilerVersion: row?.CompilerVersion || undefined,
      note: verified
        ? `Verified${row?.ContractName ? ` as ${row.ContractName}` : ""}${isProxy ? ` (proxy → ${implementation ?? "unknown impl"}: resolve the ABI on the implementation)` : ""}.`
        : "UNVERIFIED source code — treat as a red flag; do not deposit or approve without an independent reason to trust it."
    };
  }
}
