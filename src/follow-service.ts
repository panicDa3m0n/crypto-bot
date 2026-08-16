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
      const head = await this.chain.secondary.getBlockNumber().catch(() => this.chain.primary.getBlockNumber());
      for (const f of follows) {
        let from = f.lastSeenBlock ? BigInt(f.lastSeenBlock) + 1n : (head > WINDOW ? head - WINDOW : 0n);
        if (head - from > WINDOW) from = head - WINDOW; // never backscan too far
        if (from > head) { continue; }
        const moves = await this.walletMoves(f.wallet as Address, from, head).catch(() => []);
        let fresh = 0;
        for (const m of moves) if (await this.db.recordFollowMove({ chainId, ...m }).catch(() => false)) fresh += 1;
        await this.db.setFollowSeen(chainId, f.wallet, head).catch(() => undefined);
        if (fresh > 0) {
          this.wake(`follow:${f.wallet}`, `smart-money you follow moved: ${f.wallet.slice(0, 10)}… made ${fresh} new token move(s)${f.note ? ` (${f.note})` : ""}. Review with follow(action:'history', wallet).`);
          this.logger.info({ wallet: f.wallet, fresh }, "followed wallet moved");
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** The wallet's token transfers (in + out) in a block window, decoded to logged moves. */
  private async walletMoves(wallet: Address, from: bigint, to: bigint): Promise<Array<{ wallet: string; block: bigint; txHash: string; direction: string; token: string | null; symbol: string | null; amount: number | null; counterparty: string | null }>> {
    const padded = ("0x" + wallet.slice(2).padStart(64, "0")) as `0x${string}`;
    const fb = ("0x" + from.toString(16)) as `0x${string}`; const tb = ("0x" + to.toString(16)) as `0x${string}`;
    type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string };
    const [out, inc] = await Promise.all([
      this.chain.secondary.request({ method: "eth_getLogs", params: [{ fromBlock: fb, toBlock: tb, topics: [TRANSFER_TOPIC, padded] }] } as never).catch(() => []) as Promise<RawLog[]>,
      this.chain.secondary.request({ method: "eth_getLogs", params: [{ fromBlock: fb, toBlock: tb, topics: [TRANSFER_TOPIC, null, padded] }] } as never).catch(() => []) as Promise<RawLog[]>
    ]);
    const rows: Array<{ wallet: string; block: bigint; txHash: string; direction: string; token: string | null; symbol: string | null; amount: number | null; counterparty: string | null }> = [];
    for (const [dir, logs] of [["sell", out], ["buy", inc]] as const) {
      for (const l of logs.slice(0, 40)) {
        const token = l.address.toLowerCase();
        const meta = await this.meta(l.address as Address);
        const raw = l.data && l.data !== "0x" ? BigInt(l.data) : 0n;
        const amount = meta ? Number(raw) / 10 ** meta.decimals : null;
        const cp = dir === "sell" ? l.topics[2] : l.topics[1];
        rows.push({ wallet: wallet.toLowerCase(), block: l.blockNumber ? BigInt(l.blockNumber) : to, txHash: l.transactionHash ?? "", direction: dir, token, symbol: meta?.symbol ?? null, amount, counterparty: cp ? ("0x" + cp.slice(26)) : null });
      }
    }
    return rows;
  }

  private async meta(token: Address): Promise<{ symbol: string; decimals: number } | undefined> {
    const key = token.toLowerCase();
    if (this.tokenMeta.has(key)) return this.tokenMeta.get(key);
    // Token registry (indexer/scanner-maintained) FIRST — chain-sourced metadata already lives in the DB.
    // RPC only as a one-shot bootstrap for a token the system has genuinely never seen.
    const reg = (await this.db.tokenMeta(this.config.CHAIN_ID, [key]).catch(() => new Map())).get(key);
    if (reg && reg.symbol && reg.decimals != null) { const m = { symbol: reg.symbol, decimals: reg.decimals }; this.tokenMeta.set(key, m); return m; }
    try {
      const [symbol, decimals] = await Promise.all([
        this.chain.secondary.readContract({ address: token, abi: SYM, functionName: "symbol" }).catch(() => "?") as Promise<string>,
        this.chain.secondary.readContract({ address: token, abi: SYM, functionName: "decimals" }).catch(() => 18) as Promise<number>
      ]);
      const m = { symbol, decimals: Number(decimals) };
      this.tokenMeta.set(key, m);
      return m;
    } catch { return undefined; }
  }
}
