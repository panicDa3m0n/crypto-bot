import type { Logger } from "pino";
import type { Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { AddressClassifier } from "./classifier.js";

/**
 * ChainScanner — builds the system's OWN universe of addresses by reading the chain, so we are
 * no longer restricted to a third-party indexer's top-N. It ingests each block window's event
 * logs, classifies emitters mechanically by their event signature (topic0), confirms + reads
 * invariants on-chain, and upserts everything into the shared `entities` registry that every
 * strategy reads. Tokens come FREE from the token0/token1 of discovered pools — so we never
 * scan the noisy Transfer firehose.
 *
 * Windowed (not per-block streaming) to respect public-RPC limits: a persisted cursor advances
 * to head each tick (capped to a cold-start window), with a per-tick probe budget so a warmup
 * burst is spread over ticks rather than hammering the RPC.
 */
const SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const SWAP_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const POOL_CREATED_V3 = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const PAIR_CREATED_V2 = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const SWAP_TOPICS = new Set([SWAP_V3, SWAP_V2]);
const CREATED_TOPICS = new Set([POOL_CREATED_V3, PAIR_CREATED_V2]);
type RawLog = { address: string; topics: string[]; blockNumber: string };

export class ChainScanner {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly seen = new Set<string>(); // addresses already probed this process

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly classifier: AddressClassifier,
    private readonly logger: Logger
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick().catch((error) => this.logger.error({ err: error }, "scanner tick failed")), this.config.SCANNER_INTERVAL_MS);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    if (this.running || !this.config.SCANNER_ENABLED) return;
    this.running = true;
    try {
      const head = await this.chain.primary.getBlockNumber();
      const cursor = await this.db.latestMarketSnapshot<{ block: string }>("scanner", "cursor").catch(() => undefined);
      const range = BigInt(this.config.SCANNER_RANGE_BLOCKS);
      const maxSpan = range * BigInt(this.config.SCANNER_MAX_CHUNKS);
      let from = cursor?.block ? BigInt(cursor.block) + 1n : head - maxSpan;
      if (head - from > maxSpan) from = head - maxSpan; // don't over-backfill in one tick — catch up over ticks
      if (from > head) { return; }

      // Chunk the span into RPC-legal ≤RANGE-block getLogs calls; advance the cursor only over
      // blocks actually processed so nothing is skipped.
      const logs: RawLog[] = [];
      let processedTo = from - 1n;
      for (let start = from; start <= head; start += range) {
        const end = start + range - 1n < head ? start + range - 1n : head;
        logs.push(...await this.getLogs(start, end));
        processedTo = end;
      }
      // Bucket by class from topic0.
      const pools = new Map<string, "v3" | "v2">(); const dexes = new Set<string>();
      for (const l of logs) {
        const addr = l.address.toLowerCase(); const t0 = (l.topics[0] ?? "").toLowerCase();
        if (SWAP_TOPICS.has(t0)) { if (!pools.has(addr)) pools.set(addr, t0 === SWAP_V3 ? "v3" : "v2"); }
        else if (CREATED_TOPICS.has(t0)) dexes.add(addr);
      }

      let budget = this.config.SCANNER_MAX_PROBES;
      let newPools = 0, newTokens = 0, newDexes = 0;
      // New factories → DEXes (auto-discovery of unknown venues).
      for (const f of dexes) {
        if (budget <= 0) break;
        if (this.seen.has(f)) continue; this.seen.add(f); budget -= 1;
        await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: f, kind: "dex", meta: { role: "factory", discoveredBy: "scanner" }, source: "scanner" }).catch(() => undefined);
        newDexes += 1;
      }
      // New pools → read token0/token1(/fee), upsert pool + its two tokens.
      for (const [pool, hint] of pools) {
        if (budget <= 0) break;
        if (this.seen.has(pool)) continue; this.seen.add(pool); budget -= 1;
        const info = await this.classifier.poolInfo(pool as Address, hint);
        if (!info) continue;
        await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: pool, kind: "pool", symbol: null, meta: { archetype: info.archetype, token0: info.token0, token1: info.token1, fee: info.fee, stable: info.stable, discoveredBy: "scanner" }, source: "scanner" }).catch(() => undefined);
        newPools += 1;
        for (const t of [info.token0, info.token1]) {
          if (this.seen.has(t)) continue; this.seen.add(t);
          const tok = await this.classifier.tokenInfo(t as Address).catch(() => undefined);
          if (!tok) continue;
          await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: t, kind: "token", symbol: tok.symbol, name: tok.name, decimals: tok.decimals, meta: { discoveredBy: "scanner" }, source: "scanner" }).catch(() => undefined);
          newTokens += 1;
        }
      }

      await this.db.saveMarketSnapshot("scanner", "cursor", { block: processedTo.toString(), observedAt: new Date().toISOString() }).catch(() => undefined);
      if (newPools || newTokens || newDexes) this.logger.info({ from: from.toString(), to: processedTo.toString(), logs: logs.length, newPools, newTokens, newDexes, seen: this.seen.size }, "chain scanner discovered entities");
    } finally {
      this.running = false;
    }
  }

  private async getLogs(from: bigint, to: bigint): Promise<RawLog[]> {
    const fb = ("0x" + from.toString(16)) as `0x${string}`; const tb = ("0x" + to.toString(16)) as `0x${string}`;
    const topics = [[SWAP_V3, SWAP_V2, POOL_CREATED_V3, PAIR_CREATED_V2]];
    return await (this.chain.primary.request({ method: "eth_getLogs", params: [{ fromBlock: fb, toBlock: tb, topics }] } as never).catch(() => []) as Promise<RawLog[]>);
  }
}
