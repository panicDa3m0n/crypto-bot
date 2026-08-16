import type { Collector } from "./collector.js";
import type { Database } from "./db.js";
import type { NetworkObservation } from "./domain.js";

/** Minimal shared boundary used by both the in-process collector and a DB-backed brain. */
export type NetworkHealthSource = Pick<Collector, "latest" | "dataHealthy"> & { refresh(): Promise<void> };

/** Reads the observer's latest persisted result. `dataHealthy` reflects the BLOCK-INDEXER's liveness —
 * the indexer (on base.org) is the single source of truth for all chain data, so "is our data live"
 * means "is the indexer cursor advancing", NOT whether the rate-limited primary/secondary public RPCs
 * agree. The legacy dual-RPC observation is still surfaced via `latest` for the block-number display. */
export class DatabaseNetworkHealth implements NetworkHealthSource {
  private last?: NetworkObservation;
  private indexerAgeMs?: number | null;
  constructor(private readonly db: Database, private readonly chainId: number, private readonly maxAgeMs = 30_000) {}
  get latest() { return this.last; }
  get dataHealthy() {
    return this.indexerAgeMs != null && this.indexerAgeMs <= this.maxAgeMs;
  }
  async refresh(): Promise<void> {
    this.last = await this.db.latestNetworkObservation();
    this.indexerAgeMs = await this.db.indexerCursorAgeMs(this.chainId).catch(() => null);
  }
}
