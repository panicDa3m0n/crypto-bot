import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { Etherscan } from "./etherscan.js";
import type { Blockscout } from "./blockscout.js";

/**
 * RegistryEnricher — layers verified/name/proxy metadata onto the mechanically-classified entity
 * registry, using the one Etherscan module that works on Base's free tier (contract/getsourcecode).
 * This is the "APIs enrich the chain-native skeleton" layer: the scanner says WHAT an address is
 * (deterministic), Etherscan adds whether its code is VERIFIED — a deterministic scam signal
 * (an unverified token contract is a red flag). It never changes an entity's class or status; it
 * just records the signal in meta for Scarlet and the Explorer to use.
 *
 * Strictly throttled: a small batch per tick with per-call spacing keeps well under the free-tier
 * 5 req/s, and each address is enriched ONCE (cached via meta.verifiedCheckedAt), so the daily
 * 100k budget is never a concern.
 */
export class RegistryEnricher {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly config: Config, private readonly db: Database, private readonly etherscan: Etherscan, private readonly blockscout: Blockscout, private readonly logger: Logger) {}

  start(): void {
    // Runs if EITHER source is available. Etherscan adds verified/proxy; Blockscout (keyless) fills
    // the immutable decimals the oracle needs — so the price path resolves from system data, not RPC.
    if (!this.etherscan.available && !this.blockscout.available) { this.logger.info("registry enricher idle (no Etherscan/Blockscout)"); return; }
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.error({ err: e }, "enricher tick failed")), this.config.ENRICH_INTERVAL_MS);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.enrichDecimals();  // keyless, cheap, strengthens the oracle's system-first decimals
      await this.enrichVerified();  // Etherscan verified/name/proxy signal (if a key is present)
    } finally {
      this.running = false;
    }
  }

  /** Resolve missing token symbol+decimals from Blockscout (with an RPC fallback for the symbol) —
   * IMMUTABLE facts, persisted to the registry (the source of truth) so consumers like the wallet
   * read them from the DB and never resolve metadata themselves. */
  private async enrichDecimals(): Promise<void> {
    if (!this.blockscout.available) return;
    // Union of tokens missing decimals OR missing a real symbol ("?"/null).
    const need = [...await this.db.entitiesNeedingDecimals(this.config.CHAIN_ID, this.config.ENRICH_BATCH).catch(() => []),
                  ...await this.db.entitiesNeedingSymbol(this.config.CHAIN_ID, this.config.ENRICH_BATCH).catch(() => [])];
    const seen = new Set<string>(); const batch = need.filter((e) => !seen.has(e.address) && seen.add(e.address));
    if (!batch.length) return;
    let filled = 0;
    for (const e of batch) {
      const info = await this.blockscout.tokenInfo(e.address).catch(() => null);
      const symbol = info?.symbol && info.symbol !== "?" ? info.symbol : undefined;
      const decimals = info?.decimals != null && Number.isFinite(info.decimals) ? info.decimals : undefined;
      if (symbol || decimals != null) { await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: e.address, kind: "token", symbol, name: info?.name, decimals, source: "blockscout" }).catch(() => undefined); filled += 1; }
      // Mark checked so a genuinely unresolvable token isn't retried forever.
      await this.db.mergeEntityMeta(this.config.CHAIN_ID, e.address, "token", { decimalsCheckedAt: new Date().toISOString(), symbolCheckedAt: new Date().toISOString() }).catch(() => undefined);
    }
    if (filled) this.logger.info({ checked: batch.length, filled }, "token symbol/decimals resolved from Blockscout");
  }

  private async enrichVerified(): Promise<void> {
    if (!this.etherscan.available) return;
    const batch = await this.db.entitiesNeedingMeta(this.config.CHAIN_ID, this.config.ENRICH_BATCH).catch(() => []);
    if (!batch.length) return;
    let verified = 0, unverified = 0;
    for (const e of batch) {
      const m = await this.etherscan.contractMeta(e.address).catch(() => undefined);
      const patch: Record<string, unknown> = m
        ? { verified: m.verified, contractName: m.contractName ?? null, isProxy: m.isProxy, implementation: m.implementation ?? null, verifiedCheckedAt: new Date().toISOString() }
        : { verifiedCheckedAt: new Date().toISOString(), metaError: true };
      await this.db.mergeEntityMeta(this.config.CHAIN_ID, e.address, e.kind, patch).catch(() => undefined);
      if (m?.verified) verified += 1; else if (m) unverified += 1;
      await new Promise((r) => setTimeout(r, 250)); // < 5 req/s
    }
    this.logger.info({ enriched: batch.length, verified, unverified }, "registry entities enriched");
  }
}
