import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { NetworkObservation } from "./domain.js";

export class Collector {
  private timer?: NodeJS.Timeout;
  private unwatch?: () => void;
  private sampling = false;
  private previousHealth?: boolean;
  private readonly healthListeners = new Set<(healthy: boolean) => void>();
  private last?: NetworkObservation;

  constructor(private readonly chain: BerachainClients, private readonly db: Database, private readonly logger: Logger) {}

  get latest(): NetworkObservation | undefined { return this.last; }
  onHealthChange(listener: (healthy: boolean) => void): () => void { this.healthListeners.add(listener); return () => this.healthListeners.delete(listener); }
  get dataHealthy(): boolean {
    if (!this.last?.primaryHealthy || !this.last.secondaryHealthy || this.last.blockGap > 1n) return false;
    return Date.now() - this.last.observedAt.getTime() <= 15_000;
  }
  async refresh(): Promise<void> { /* The live collector already owns the newest sample. */ }

  private trigger(source: "poll" | "websocket"): void {
    if (this.sampling) return;
    void this.sample(source).catch((error) => this.logger.error({ err: error, source }, "collector sample failed"));
  }

  async sample(source: "poll" | "websocket" = "poll"): Promise<NetworkObservation> {
    if (this.sampling) return this.last ?? this.chain.observe(source);
    this.sampling = true;
    try {
      const observation = await this.chain.observe(source);
      await this.db.saveObservation(observation);
      this.last = observation;
      const health = this.dataHealthy;
      if (this.previousHealth !== undefined && this.previousHealth !== health) for (const listener of this.healthListeners) listener(health);
      this.previousHealth = health;
      this.logger.info({ source, primaryBlock: observation.primaryBlock.toString(), secondaryBlock: observation.secondaryBlock.toString(), gap: observation.blockGap.toString(), gasPriceWei: observation.gasPriceWei.toString(), dataHealthy: health }, "mainnet observation saved");
      return observation;
    } finally {
      this.sampling = false;
    }
  }

  start(intervalMs = 2_000): void {
    this.trigger("poll");
    this.unwatch = this.chain.watchHeads(() => this.trigger("websocket"), (error) => this.logger.warn({ err: error }, "newHeads WebSocket unavailable; poll fallback remains active"));
    this.timer = setInterval(() => this.trigger("poll"), intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.unwatch?.(); }
}
