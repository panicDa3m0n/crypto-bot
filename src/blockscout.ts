import type { Logger } from "pino";
import type { Config } from "./config.js";

/**
 * Blockscout — a keyless INDEXER lane for enrichment, discovery and history: token metadata, the
 * COMPLETE token holdings of an address, address transaction/transfer history, and wide-range event
 * logs (not bound by the RPC 10-block getLogs cap). It fills exactly the gaps we hand-rolled around
 * (wallet holdings, decimals reads, address history blocked by Etherscan's paid Base account module).
 *
 * HARD BOUNDARY: Blockscout is an indexer, NOT an RPC and NOT executable-at-a-block state. It must
 * never touch the precision/execution path (reserves, getAmountOut, the fire decision) — its indexed
 * prices/balances lag and are a mirage for decisions. Every method is failure-tolerant: a hiccup or
 * rate-limit returns null/[], never throws, so a caller degrades to RPC/existing behaviour.
 */
export type BsToken = { address: string; symbol: string; name: string; decimals: number | null; type: string };
export type BsBalance = { token: string; symbol: string; decimals: number | null; valueRaw: bigint; type: string; exchangeRate: number | null };
export type BsTransfer = { token: string; symbol: string; decimals: number | null; from: string; to: string; valueRaw: bigint; blockNumber: number; timestamp: string };
export type BsLog = { address: string; topics: string[]; data: string; blockNumber: number; txHash: string };

export class Blockscout {
  private readonly base: string; // e.g. https://base.blockscout.com/api
  private readonly enabled: boolean;
  // Pace requests under the public instance's limit (a key raises it). Excess calls queue.
  private nextAt = 0;
  private readonly MIN_INTERVAL_MS = 120; // ~8/s, conservative for the keyless public instance

  constructor(private readonly config: Config, private readonly logger: Logger) {
    this.base = config.BLOCKSCOUT_API_URL.replace(/\/$/, "");
    this.enabled = config.BLOCKSCOUT_ENABLED;
  }

  get available(): boolean { return this.enabled; }

  private async pace(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.MIN_INTERVAL_MS;
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  }

  private async getJson<T>(path: string): Promise<T | null> {
    if (!this.enabled) return null;
    await this.pace();
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.config.BLOCKSCOUT_API_KEY) headers["Authorization"] = `Bearer ${this.config.BLOCKSCOUT_API_KEY}`;
      const r = await fetch(`${this.base}${path}`, { headers, signal: AbortSignal.timeout(12_000) });
      if (!r.ok) { this.logger.debug({ status: r.status, path }, "blockscout http error"); return null; }
      return (await r.json()) as T;
    } catch (error) { this.logger.debug({ err: error instanceof Error ? error.message : String(error), path }, "blockscout request failed"); return null; }
  }

  /** Authoritative token metadata (decimals/symbol/name) — the enrichment source for the registry. */
  async tokenInfo(address: string): Promise<BsToken | null> {
    const d = await this.getJson<{ symbol?: string; name?: string; decimals?: string; type?: string }>(`/v2/tokens/${address}`);
    if (!d || d.symbol == null) return null;
    const dec = d.decimals != null && d.decimals !== "" ? Number(d.decimals) : null;
    return { address: address.toLowerCase(), symbol: d.symbol ?? "?", name: d.name ?? "", decimals: dec != null && Number.isFinite(dec) ? dec : null, type: d.type ?? "" };
  }

  /** RICH address dossier in one call (`/v2/addresses/{addr}`): contract/verified/name/proxy + the token
   * sub-object (holders, total supply, market cap, type) + creator/creation. Far more than we can read
   * on-chain cheaply — the enrichment a `sync_address` persists. Returns null if unavailable. */
  async addressInfo(address: string): Promise<Record<string, unknown> | null> {
    const d = await this.getJson<{
      is_contract?: boolean; is_verified?: boolean; name?: string | null;
      implementations?: Array<{ address?: string; name?: string }>; implementation_address?: string | null;
      creation_tx_hash?: string | null; creator_address_hash?: string | null;
      public_tags?: Array<{ display_name?: string }>; private_tags?: Array<{ display_name?: string }>;
      token?: { symbol?: string; name?: string; decimals?: string; type?: string; holders?: string; total_supply?: string; exchange_rate?: string | null; circulating_market_cap?: string | null; volume_24h?: string | null };
    }>(`/v2/addresses/${address}`);
    if (!d) return null;
    const tok = d.token ?? {};
    const tags = [...(d.public_tags ?? []), ...(d.private_tags ?? [])].map((t) => t.display_name).filter(Boolean);
    return {
      isContract: d.is_contract ?? null,
      isVerified: d.is_verified ?? null,
      contractName: d.name ?? null,
      implementation: d.implementation_address ?? d.implementations?.[0]?.address ?? null,
      creator: d.creator_address_hash ?? null,
      creationTx: d.creation_tx_hash ?? null,
      tags: tags.length ? tags : null,
      token: tok.symbol != null || tok.holders != null ? {
        symbol: tok.symbol ?? null, name: tok.name ?? null, decimals: tok.decimals != null ? Number(tok.decimals) : null, type: tok.type ?? null,
        holders: tok.holders != null ? Number(tok.holders) : null, totalSupply: tok.total_supply ?? null,
        exchangeRate: tok.exchange_rate ?? null, marketCapUsd: tok.circulating_market_cap ?? null, volume24hUsd: tok.volume_24h ?? null
      } : null
    };
  }

  /** The COMPLETE ERC-20 holdings of an address (symbol+decimals+raw value). Replaces the hand-rolled
   * Transfer-log scan. Caller must spam-filter (indexers list junk airdrops too). */
  async tokenBalances(address: string): Promise<BsBalance[] | null> {
    const d = await this.getJson<Array<{ value?: string; token?: { address?: string; address_hash?: string; symbol?: string; decimals?: string; type?: string; exchange_rate?: string | null } }>>(`/v2/addresses/${address}/token-balances`);
    if (!Array.isArray(d)) return null;
    const out: BsBalance[] = [];
    for (const x of d) {
      const t = x.token; const addr = t?.address_hash ?? t?.address; if (!addr) continue; // Blockscout v2 uses address_hash
      if ((t?.type ?? "ERC-20") !== "ERC-20") continue; // holdings = fungibles only
      const dec = t?.decimals != null && t.decimals !== "" ? Number(t.decimals) : null;
      let valueRaw: bigint; try { valueRaw = BigInt(x.value ?? "0"); } catch { valueRaw = 0n; }
      if (valueRaw <= 0n) continue;
      const xr = t?.exchange_rate != null && t.exchange_rate !== "" ? Number(t.exchange_rate) : null; // indicative display price, free with the balances call
      out.push({ token: addr.toLowerCase(), symbol: t?.symbol ?? "?", decimals: dec != null && Number.isFinite(dec) ? dec : null, valueRaw, type: t?.type ?? "ERC-20", exchangeRate: xr != null && Number.isFinite(xr) ? xr : null });
    }
    return out;
  }

  /** ERC-20 transfers touching `address` (recent first), keyless — the whale/flow history Etherscan
   * charges for on Base. `pages` bounds pagination (each page ~50). */
  async tokenTransfers(address: string, pages = 1): Promise<BsTransfer[] | null> {
    const out: BsTransfer[] = [];
    let next = `/v2/addresses/${address}/token-transfers?type=ERC-20`;
    for (let p = 0; p < pages && next; p++) {
      const d = await this.getJson<{ items?: Array<{ token?: { address?: string; address_hash?: string; symbol?: string; decimals?: string }; from?: { hash?: string }; to?: { hash?: string }; total?: { value?: string }; block_number?: number; timestamp?: string }>; next_page_params?: Record<string, string | number> | null }>(next);
      if (!d?.items) break;
      for (const i of d.items) {
        const t = i.token; const addr = t?.address_hash ?? t?.address; if (!addr) continue; // Blockscout v2 uses address_hash
        const dec = t?.decimals != null && t.decimals !== "" ? Number(t.decimals) : null;
        let valueRaw: bigint; try { valueRaw = BigInt(i.total?.value ?? "0"); } catch { valueRaw = 0n; }
        out.push({ token: addr.toLowerCase(), symbol: t?.symbol ?? "?", decimals: dec != null && Number.isFinite(dec) ? dec : null, from: (i.from?.hash ?? "").toLowerCase(), to: (i.to?.hash ?? "").toLowerCase(), valueRaw, blockNumber: Number(i.block_number ?? 0), timestamp: i.timestamp ?? "" });
      }
      const np = d.next_page_params;
      next = np ? `/v2/addresses/${address}/token-transfers?type=ERC-20&${new URLSearchParams(Object.entries(np).map(([k, v]) => [k, String(v)])).toString()}` : "";
    }
    return out;
  }

  /** Event logs for `address`, indexed (NOT bound by the RPC 10-block getLogs cap). Uses the
   * Etherscan-compatible logs API (the v2 endpoint doesn't filter by topic) so we can filter by
   * topic0 over a block range in one call (capped at 1000 results). Discovery/backfill for protocol
   * events. blockNumber comes back as a hex string here. */
  async contractLogs(address: string, opts: { topic0?: string; fromBlock?: number; toBlock?: number | "latest" } = {}): Promise<BsLog[] | null> {
    const params = new URLSearchParams({ module: "logs", action: "getLogs", address, fromBlock: String(opts.fromBlock ?? 0), toBlock: opts.toBlock != null ? String(opts.toBlock) : "latest" });
    if (opts.topic0) params.set("topic0", opts.topic0);
    const d = await this.getJson<{ status?: string; result?: Array<{ address?: string; topics?: string[]; data?: string; blockNumber?: string; transactionHash?: string }> }>(`?${params.toString()}`);
    if (!d || !Array.isArray(d.result)) return null;
    return d.result.map((r) => ({ address: (r.address ?? address).toLowerCase(), topics: (r.topics ?? []).filter((t): t is string => !!t), data: r.data ?? "0x", blockNumber: r.blockNumber ? parseInt(r.blockNumber, 16) : 0, txHash: r.transactionHash ?? "" }));
  }
}
