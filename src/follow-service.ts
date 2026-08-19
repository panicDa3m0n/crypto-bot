import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";

/**
 * Smart-money follow tracker. SCARLET chooses which wallets to follow (via the `follow` tool);
 * the system then does the remembering: every cycle it pulls each followed wallet's new token
 * transfers, logs them, and notifies Scarlet ONCE per movement burst (debounced by the shared
 * wake) so she isn't bombarded. She never has to remember to check — she just reacts to the
 * notification and navigates the wallet's history with `follow(action:'history')`.
 */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SYM = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const WINDOW = 700n; // per-wallet backscan cap per tick

export class FollowService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly tokenMeta = new Map<string, { symbol: string; decimals: number }>();

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly wake: (key: string, reason: string) => void
  ) {}

  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => void this.tick().catch((error) => this.logger.error({ err: error }, "follow tick failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const chainId = this.config.CHAIN_ID;
      const follows = await this.db.activeFollows(chainId).catch(() => []);
      if (!follows.length) return;
      // DB-FIRST (db-first convergence): the block-indexer now captures followed wallets' transfers into
      // wallet_transactions (they're in its watched set). Read the moves from the DB — no own getLogs. Head
      // = the indexer cursor (the DB's notion of "now"), so we never surface moves past what's indexed.
      const head = await this.db.getIndexerCursor(chainId).catch(() => null);
      if (head == null) return;
      for (const f of follows) {
        const since = f.lastSeenBlock ? Number(f.lastSeenBlock) : Math.max(0, head - Number(WINDOW));
        const moves = await this.walletMoves(f.wallet, since).catch(() => []);
        let fresh = 0;
        for (const m of moves) if (await this.db.recordFollowMove({ chainId, ...m }).catch(() => false)) fresh += 1;
        await this.db.setFollowSeen(chainId, f.wallet, BigInt(head)).catch(() => undefined);
        if (fresh > 0) {
          this.wake(`follow:${f.wallet}`, `smart-money you follow moved: ${f.wallet.slice(0, 10)}… made ${fresh} new token move(s)${f.note ? ` (${f.note})` : ""}. Review with follow(action:'history', wallet).`);
          this.logger.info({ wallet: f.wallet, fresh }, "followed wallet moved");
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** A followed wallet's token moves since `sinceBlock`, read from wallet_transactions (indexer-fed) with
   * token symbol/decimals JOINed in — no getLogs, no per-token RPC. Mapped to the follow-move shape. */
  private async walletMoves(wallet: string, sinceBlock: number): Promise<Array<{ wallet: string; block: bigint; txHash: string; direction: string; token: string | null; symbol: string | null; amount: number | null; counterparty: string | null }>> {
    const rows = await this.db.walletTransfersSince(this.config.CHAIN_ID, wallet.toLowerCase(), sinceBlock).catch(() => []);
    return rows.slice(0, 80).map((r) => {
      let amount: number | null = null;
      if (r.decimals != null) { try { amount = Number(BigInt(r.valueRaw)) / 10 ** r.decimals; } catch { amount = null; } }
      const direction = r.direction === "in" ? "buy" : r.direction === "out" ? "sell" : "self";
      const counterparty = r.direction === "in" ? r.from : r.to; // the OTHER side of the transfer
      return { wallet: wallet.toLowerCase(), block: BigInt(r.block), txHash: r.txHash, direction, token: r.token, symbol: r.symbol, amount, counterparty };
    });
  }
}
