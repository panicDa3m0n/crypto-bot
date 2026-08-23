import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";

/**
 * WalletHoldings — the wallet, computed the RIGHT way and kept entirely in the DB.
 *
 * TRANSFERS (the movement history / which tokens we hold) come primarily from the MAIN INDEXER: its
 * full-ingestion stream sees every Transfer, cheap-filters the wallet's, writes `wallet_transactions`,
 * and fires `onWalletTransfer(tokens)` here — EVENT-DRIVEN, so a buy/sell reflects within one block.
 * This periodic scan (incremental `getLogs` on WALLET_LOGS_RPC, cursored) stays as the COLD-START
 * discovery (initial backfill of pre-existing holdings, which the indexer's filtered sync doesn't carry)
 * and a safety net; the two writers are idempotent (dedup by tx:logIndex), so the overlap is harmless.
 *
 * BALANCES are always NETWORK GROUND TRUTH: a `balanceOf` multicall (reliable-lane cascade) for the
 * touched tokens → `wallet_token_balances`. We do NOT derive balances by summing transfers — the network
 * read catches rebasing/airdrops/direct-sends too. The dashboard/holdings are then a pure DB triangulation:
 * balances(network) × the token registry (symbol/decimals/tagging) × token_prices (value, or $0). No
 * Blockscout, no per-render calls, surgical precision.
 */
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20_BAL = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SAFETY_RESCAN_TICKS = 120; // ~1h at 30s/tick: a rare re-scan safety net behind the indexer's live feed
type Holding = { token: string; symbol: string; decimals: number; balance: number; priceUsd: number | null; valueUsd: number };

export class WalletHoldings {
  private timer?: NodeJS.Timeout;
  private running = false;
  private ticks = 0;
  private backfilled = false; // the one-time cold-start Transfer backfill has completed (then indexer feeds)
  private readonly known: Set<string>;

  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly logger: Logger) {
    this.known = new Set(config.network.tokens.map((t) => t.address.toLowerCase()));
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.error({ err: e }, "wallet tick failed")), this.config.WALLET_HOLDINGS_INTERVAL_MS);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async rpc<T>(method: string, params: unknown[]): Promise<T | undefined> {
    try {
      const r = await fetch(this.config.WALLET_LOGS_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return undefined;
      return ((await r.json()) as { result?: T }).result;
    } catch { return undefined; }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const owner = this.config.WALLET_ADDRESS?.toLowerCase();
      if (!owner) return;
      // 1. COLD-START discovery + safety net. Steady-state transfer capture is now the INDEXER's job (its
      //    full-ingestion stream fires onWalletTransfer in real-time). This own getLogs scan runs ONLY as
      //    the initial backfill — to discover pre-existing holdings the indexer, starting at head, doesn't
      //    replay — and an occasional safety re-scan (catch a block the indexer served via filtered fallback).
      if (!this.backfilled || this.ticks % SAFETY_RESCAN_TICKS === 0) {
        const { transfers, cursor, ok } = await this.scanNewTransfers(owner);
        if (ok) {
          if (transfers.length) await this.db.insertWalletTransfers(this.config.CHAIN_ID, owner, transfers).catch(() => 0);
          await this.refreshBalances(owner, [...new Set(transfers.map((t) => t.token))]);
          await this.db.saveMarketSnapshot("wallet", "scan", { cursor, observedAt: new Date().toISOString() }).catch(() => undefined);
          this.backfilled = true;
        }
      }
      // 2. Periodic FULL balance refresh (ground truth for ALL held tokens) — catches rebasing tokens that
      //    move with no Transfer. Independent of the scan; ~every 20 ticks.
      if (this.ticks % 20 === 0) {
        const all = (await this.db.walletTokenBalances(this.config.CHAIN_ID, owner).catch(() => [])).map((b) => b.token);
        if (all.length) await this.refreshBalances(owner, all);
      }
      // 3. Assemble the display holdings from the DB (triangulation) + persist the portfolio/NAV.
      await this.assembleHoldings(owner);
      await this.persistPortfolio(owner);
      this.ticks += 1;
    } finally {
      this.running = false;
    }
  }

  /** Incremental Transfer scan (received + sent) on WALLET_LOGS_RPC from the saved cursor. Returns the
   * new transfers + the advanced cursor. ok=false (no head) → skip this cycle, keep prior state. */
  private async scanNewTransfers(owner: string): Promise<{ transfers: Array<{ txHash: string; logIndex: number; blockNumber: bigint; token: string; from: string; to: string; valueRaw: bigint; direction: string }>; cursor: string; ok: boolean }> {
    const headHex = await this.rpc<string>("eth_blockNumber", []);
    if (!headHex) return { transfers: [], cursor: "0", ok: false };
    const head = BigInt(headHex);
    const snap = await this.db.latestMarketSnapshot<{ cursor?: string }>("wallet", "scan").catch(() => undefined);
    const padded = "0x" + "0".repeat(24) + owner.slice(2);
    const range = BigInt(this.config.WALLET_LOGS_RANGE);
    let from = snap?.cursor ? BigInt(snap.cursor) + 1n : head - BigInt(this.config.WALLET_BACKFILL_BLOCKS);
    if (from < 0n) from = 0n;
    const seen = new Map<string, { txHash: string; logIndex: number; blockNumber: bigint; token: string; from: string; to: string; valueRaw: bigint; direction: string }>();
    type Log = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };
    for (let start = from; start <= head; start += range) {
      const end = start + range - 1n < head ? start + range - 1n : head;
      const fb = "0x" + start.toString(16), tb = "0x" + end.toString(16);
      const [recv, sent] = await Promise.all([
        this.rpc<Log[]>("eth_getLogs", [{ fromBlock: fb, toBlock: tb, topics: [TRANSFER, null, padded] }]),
        this.rpc<Log[]>("eth_getLogs", [{ fromBlock: fb, toBlock: tb, topics: [TRANSFER, padded] }])
      ]);
      for (const l of [...(recv ?? []), ...(sent ?? [])]) {
        if (!l.topics || l.topics.length < 3) continue; // standard ERC-20 Transfer has from+to indexed
        const key = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(key)) continue;
        const fromA = ("0x" + l.topics[1].slice(-40)).toLowerCase();
        const toA = ("0x" + l.topics[2].slice(-40)).toLowerCase();
        let valueRaw: bigint; try { valueRaw = BigInt(l.data && l.data !== "0x" ? l.data : "0"); } catch { valueRaw = 0n; }
        seen.set(key, { txHash: l.transactionHash, logIndex: Number(BigInt(l.logIndex)), blockNumber: BigInt(l.blockNumber), token: l.address.toLowerCase(), from: fromA, to: toA, valueRaw, direction: toA === owner ? (fromA === owner ? "self" : "in") : "out" });
      }
    }
    return { transfers: [...seen.values()], cursor: head.toString(), ok: true };
  }

  /** GROUND-TRUTH balances from the NETWORK: one balanceOf multicall for the given tokens. READ-lane cascade
   * (precision=nodies → primary=base.org → fallback) — NEVER the dedicated indexer (drpc) or execution
   * (publicnode) lanes, so the wallet read can't starve the indexer's block ingestion (which it did: the
   * indexer's drpc free-tier tipped over). One multicall = one eth_call, so a read lane handles it fine. */
  private async multicallBalances(owner: string, tokens: string[]): Promise<Array<{ status: string; result?: unknown }>> {
    const contracts = tokens.map((t) => ({ address: t as Address, abi: ERC20_BAL, functionName: "balanceOf" as const, args: [owner as Address] }));
    // The lane cascade below only ever advanced on a THROW — but a lane that answers a wide multicall with
    // all-failures throws nothing, so the cascade never ran and every balance silently kept its prior value.
    // bulkRead settles that question (bisect, then positive control) before the next lane is even considered.
    for (const client of [this.chain.precision, this.chain.primary, this.chain.fallback]) {
      const { results, laneFailed } = await this.chain.bulkRead(contracts, { label: "wallet-balances", client }).catch(() => ({ results: [] as Array<{ status: string; result?: unknown }>, laneFailed: true }));
      if (!laneFailed && results.some((r) => r?.status === "success")) return results;
    }
    return [];
  }

  /** Fresh balanceOf for the given tokens (network ground truth) → persist. */
  private async refreshBalances(owner: string, tokens: string[]): Promise<void> {
    if (!tokens.length) return;
    const results = await this.multicallBalances(owner, tokens);
    for (let i = 0; i < tokens.length; i++) {
      const r = results[i];
      if (!r || r.status !== "success" || typeof r.result !== "bigint") continue; // read failed → keep prior balance
      await this.db.upsertWalletTokenBalance(this.config.CHAIN_ID, owner, tokens[i], r.result).catch(() => undefined);
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: tokens[i], kind: "token", source: "wallet" }).catch(() => undefined); // register; scanner/enricher own metadata
    }
  }

  /** EVENT-DRIVEN (Canale wallet, fired by the indexer when a Transfer touched the wallet this block):
   * re-read JUST those tokens' balances FROM CHAIN (ground truth) + re-assemble the holdings immediately,
   * so the wallet reflects a buy/sell within one block instead of waiting for the periodic tick. The
   * indexer already persisted the movement to wallet_transactions (history); here we align the balances. */
  async onWalletTransfer(tokens: string[]): Promise<void> {
    const owner = this.config.WALLET_ADDRESS?.toLowerCase();
    if (!owner || !tokens.length) return;
    try {
      await this.refreshBalances(owner, tokens);
      await this.assembleHoldings(owner);
    } catch (e) { this.logger.debug({ err: e instanceof Error ? e.message : String(e) }, "wallet onWalletTransfer failed"); }
  }

  /** DB TRIANGULATION → the holdings snapshot the dashboard reads: wallet balances × registry
   * (symbol/decimals) × token_prices (value or $0). Resolves nothing; a token whose decimals aren't
   * in the registry yet is skipped (appears once the scanner resolves it). */
  private async assembleHoldings(owner: string): Promise<void> {
    const core = new Set([this.config.WBERA_ADDRESS, this.config.USDC_E_ADDRESS, this.config.HONEY_ADDRESS].map((a) => a.toLowerCase()));
    const balances = await this.db.walletTokenBalances(this.config.CHAIN_ID, owner).catch(() => []);
    const tokens = balances.map((b) => b.token);
    const [meta, prices] = await Promise.all([
      this.db.tokenMeta(this.config.CHAIN_ID, tokens).catch(() => new Map()),
      this.db.getTokenPrices(this.config.CHAIN_ID, tokens).catch(() => new Map())
    ]);
    const holdings: Holding[] = [];
    for (const b of balances) {
      if (core.has(b.token)) continue; // core shown separately by the dashboard from the portfolio read
      const m = meta.get(b.token);
      const decimals = m?.decimals;
      if (decimals == null || decimals > 36) continue; // not resolved yet → scanner will
      const balance = Number(BigInt(b.balanceRaw)) / 10 ** decimals;
      const cached = prices.get(b.token)?.priceUsd;
      const priceUsd = cached != null && cached > 0 ? cached : null;
      holdings.push({ token: b.token, symbol: m?.symbol ?? "?", decimals, balance, priceUsd, valueUsd: priceUsd != null ? balance * priceUsd : 0 });
    }
    holdings.sort((a, b) => (b.valueUsd - a.valueUsd) || ((a.priceUsd == null ? 1 : 0) - (b.priceUsd == null ? 1 : 0)));
    await this.db.saveMarketSnapshot("wallet", "holdings", { observedAt: new Date().toISOString(), holdings, source: "db" }).catch(() => undefined);
    this.logger.info({ balances: balances.length, held: holdings.length, priced: holdings.filter((h) => h.priceUsd != null).length }, "wallet holdings assembled from DB");
  }

  /** Snapshot the portfolio/NAV into the DB so the dashboard reads the last good value (never a live
   * call in its request path). Native/core USD prices come from the Lane-A cache, not a live oracle. */
  private async persistPortfolio(owner: string): Promise<void> {
    const dailyLoss = await this.db.dailyLossUsd().catch(() => 0);
    const net = await this.db.latestNetworkObservation().catch(() => undefined);
    const dataHealthy = net ? (net.primaryHealthy && net.secondaryHealthy) : true;
    // DB-first NAV: hand the indexed core-asset balances to portfolio() so it derives from the DB, not RPC
    // (native + any token the DB lacks still read on-chain). These balances are network ground-truth,
    // refreshed by this same service's event-driven + periodic multicall — so they're fresh, not stale.
    const known = new Map<string, bigint>();
    for (const b of await this.db.walletTokenBalances(this.config.CHAIN_ID, owner).catch(() => [])) { try { known.set(b.token.toLowerCase(), BigInt(b.balanceRaw)); } catch { /* skip */ } }
    const portfolio = await this.chain.portfolio(dailyLoss, dataHealthy, known).catch((e) => { this.logger.debug({ err: e instanceof Error ? e.message : String(e) }, "portfolio snapshot skipped (transient)"); return undefined; });
    if (!portfolio) return;
    const px = await this.db.getTokenPrices(this.config.CHAIN_ID, [this.config.WBERA_ADDRESS, this.config.HONEY_ADDRESS, this.config.USDC_E_ADDRESS]).catch(() => new Map());
    const beraUsd = px.get(this.config.WBERA_ADDRESS.toLowerCase())?.priceUsd ?? portfolio.beraUsd;
    const honeyUsd = px.get(this.config.HONEY_ADDRESS.toLowerCase())?.priceUsd ?? portfolio.honeyUsd;
    const usdcUsd = px.get(this.config.USDC_E_ADDRESS.toLowerCase())?.priceUsd ?? 1;
    const estimatedNavUsd = portfolio.usdcE * usdcUsd + portfolio.honey * honeyUsd + (portfolio.bera + portfolio.wbera) * beraUsd;
    await this.db.savePortfolio({ ...portfolio, beraUsd, honeyUsd, estimatedNavUsd }).catch(() => undefined);
  }
}
