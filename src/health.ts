import type { Collector } from "./collector.js";
import type { Database } from "./db.js";
import type { NetworkObservation } from "./domain.js";

/** Minimal shared boundary used by both the in-process collector and a DB-backed brain. */
export type NetworkHealthSource = Pick<Collector, "latest" | "dataHealthy"> & { refresh(): Promise<void> };

/** Reads the observer's latest persisted dual-RPC result; it never calls an RPC itself. */
export class DatabaseNetworkHealth implements NetworkHealthSource {
  private last?: NetworkObservation;
  constructor(private readonly db: Database, private readonly maxAgeMs = 15_000) {}
  get latest() { return this.last; }
  get dataHealthy() {
    return Boolean(this.last?.primaryHealthy && this.last.secondaryHealthy && this.last.blockGap <= 1n && Date.now() - this.last.observedAt.getTime() <= this.maxAgeMs);
  }
  async refresh(): Promise<void> { this.last = await this.db.latestNetworkObservation(); }
}
