import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { Etherscan } from "./etherscan.js";
import type { Blockscout } from "./blockscout.js";

/**
 * Whale & smart-money intelligence. "Le occasioni bisogna quasi crearle" — so instead of only
 * reacting to prices, Scarlet studies WHO is moving them. Each cycle this takes the wallets the
 * flow sensor saw trading + the whales behind the biggest swaps, and reads their NET token flow
 * over a recent block window (Etherscan tokentx, bounded so it doesn't time out). From that it
 * derives:
 *   - per-wallet profiles: what each is ACCUMULATING (conviction / a thesis forming) vs EXITING
 *   - conviction signals: tokens that MULTIPLE tracked wallets are net-accumulating at once —
 *     smart-money agreeing early, before the price fully reflects it.
 * Scarlet turns these into proactive plays: front-run the thesis (accumulate what whales
 * accumulate), backrun their price impact via cross-venue arb, or be their counterparty with
 * Kuru limit orders. Reading is zero-risk; every resulting trade still simulates first.
 */
const WINDOW_BLOCKS = 8000; // ~40 min at ~3 blocks/s — recent enough to be a live signal

type FlowSnap = { activeWallets?: Array<{ wallet?: string }>; bigSwaps?: Array<{ wallet?: string }> };

export class WhaleIntel {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly etherscan: Etherscan,
    private readonly blockscout: Blockscout,
    private readonly logger: Logger
  ) {}

  start(intervalMs = 90_000): void {
    // Blockscout (keyless) unblocks this on Base, where Etherscan's account module is paid.
    if (!this.blockscout.available && !this.etherscan.available) { this.logger.info("whale-intel disabled (no Blockscout/Etherscan)"); return; }
    this.timer = setInterval(() => void this.tick().catch((error) => this.logger.error({ err: error }, "whale-intel tick failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  /** Net token flow for a wallet over the recent window: Blockscout token-transfers first (keyless),
   * Etherscan as fallback. Returns per-token net human amount + tx count, biggest movement first. */
  private async walletFlow(wallet: string, from: number, head: number): Promise<Array<{ token: string; symbol: string; netAmount: number; txCount: number }>> {
    if (this.blockscout.available) {
      const transfers = await this.blockscout.tokenTransfers(wallet, this.config.WHALE_FLOW_PAGES).catch(() => null);
      if (transfers) {
        const w = wallet.toLowerCase();
        const agg = new Map<string, { token: string; symbol: string; net: number; tx: number }>();
        for (const t of transfers) {
          if (t.blockNumber && t.blockNumber < from) continue; // keep the recent window
          if (t.decimals == null) continue; // can't scale without decimals — skip (no guess)
          const amt = Number(t.valueRaw) / 10 ** t.decimals;
          const dir = t.to === w ? 1 : t.from === w ? -1 : 0;
          if (dir === 0) continue;
          const e = agg.get(t.token) ?? { token: t.token, symbol: t.symbol, net: 0, tx: 0 };
          e.net += dir * amt; e.tx += 1; agg.set(t.token, e);
        }
        return [...agg.values()].map((e) => ({ token: e.token, symbol: e.symbol, netAmount: e.net, txCount: e.tx })).sort((a, b) => Math.abs(b.netAmount) - Math.abs(a.netAmount));
      }
    }
    if (this.etherscan.available) return this.etherscan.walletTokenFlow(wallet, from, head, 100).catch(() => []);
    return [];
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const flow = await this.db.latestMarketSnapshot<FlowSnap>("flow", "recent").catch(() => undefined);
      if (!flow) return;
      const candidates = [...new Set([...(flow.activeWallets ?? []), ...(flow.bigSwaps ?? [])].map((w) => (w.wallet ?? "").toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w)))].slice(0, this.config.WHALE_MAX_WALLETS);
      if (!candidates.length) return;
      const head = Number(await this.chain.primary.getBlockNumber());
      const from = Math.max(0, head - WINDOW_BLOCKS);

      const profiles: Array<{ wallet: string; accumulating: Array<{ symbol: string; token: string; net: number; tx: number }>; distributing: Array<{ symbol: string; token: string; net: number; tx: number }>; activeTokens: number }> = [];
      for (const wallet of candidates) {
        // Sequential (not parallel) to stay well under the source's rate limit.
        const flows = await this.walletFlow(wallet, from, head);
        if (!flows.length) continue;
        const shape = (f: { token: string; symbol: string; netAmount: number; txCount: number }) => ({ symbol: f.symbol, token: f.token, net: Number(f.netAmount.toFixed(6)), tx: f.txCount });
        profiles.push({
          wallet,
          accumulating: flows.filter((f) => f.netAmount > 0).slice(0, 4).map(shape),
          distributing: flows.filter((f) => f.netAmount < 0).slice(0, 4).map(shape),
          activeTokens: flows.length
        });
      }

      // Conviction: tokens MULTIPLE tracked wallets are net-accumulating right now. Exclude the
      // base currencies (WMON/USDC/USDT0) — active wallets are market-makers that round-trip them,
      // so their net flow is churn, not a directional thesis. Real signal = non-base accumulation.
      const base = new Set([this.config.WBERA_ADDRESS, this.config.USDC_E_ADDRESS, this.config.HONEY_ADDRESS].map((a) => a.toLowerCase()));
      const conviction = new Map<string, { symbol: string; token: string; wallets: number }>();
      for (const p of profiles) for (const f of p.accumulating) {
        if (base.has(f.token.toLowerCase()) || f.net <= 0) continue;
        const e = conviction.get(f.token) ?? { symbol: f.symbol, token: f.token, wallets: 0 };
        e.wallets += 1; conviction.set(f.token, e);
      }
      const accumulatingNow = [...conviction.values()].filter((t) => t.wallets >= 2).sort((a, b) => b.wallets - a.wallets).slice(0, 8);

      await this.db.saveMarketSnapshot("whale", "recent", {
        observedAt: new Date().toISOString(), head, windowBlocks: WINDOW_BLOCKS, walletsProfiled: profiles.length,
        note: "Whale/smart-money flow (net token movement per wallet over the recent window). accumulatingNow = tokens 2+ tracked wallets are buying at once (early conviction — check_token then consider front-running the thesis, or backrun their price impact via crossVenueArb). Reading only; simulate any trade.",
        accumulatingNow, profiles
      }).catch(() => undefined);
      this.logger.info({ walletsProfiled: profiles.length, conviction: accumulatingNow.length }, "whale-intel snapshot saved");
    } finally {
      this.running = false;
    }
  }
}
