import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { Database } from "./db.js";

const OFFICIAL_SOURCES = [
  "https://docs.berachain.com/llms.txt",
  "https://docs.berachain.com/build/bend/deployed-markets",
  "https://docs.berachain.com/build/bex/deployed-contracts",
  "https://docs.berachain.com/general/governance/reward-vault-governance"
] as const;

export class OfficialDocumentWatcher {
  private timer?: NodeJS.Timeout;
  private updates: Array<{ url: string; changed: boolean; observedAt: string }> = [];
  private readonly listeners = new Set<(updates: Array<{ url: string; changed: boolean; observedAt: string }>) => void>();
  constructor(private readonly db: Database, private readonly logger: Logger) {}
  get latest() { return this.updates; }
  onChange(listener: (updates: Array<{ url: string; changed: boolean; observedAt: string }>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async scan(): Promise<void> {
    const updates: Array<{ url: string; changed: boolean; observedAt: string }> = [];
    for (const url of OFFICIAL_SOURCES) {
      const response = await fetch(url, { headers: { "user-agent": "berachain-wallet-brain/0.1" }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`official document request failed: ${url} (${response.status})`);
      const body = await response.text();
      const hash = createHash("sha256").update(body).digest("hex");
      const changed = await this.db.recordOfficialDocument(url, hash, Buffer.byteLength(body));
      updates.push({ url, changed, observedAt: new Date().toISOString() });
    }
    this.updates = updates;
    const changed = updates.filter((update) => update.changed);
    if (changed.length) for (const listener of this.listeners) listener(changed);
    this.logger.info({ changed: changed.map((update) => update.url), checked: updates.length }, "official documentation scan saved");
  }

  start(intervalMs = 6 * 60 * 60_000): void {
    void this.scan().catch((error) => this.logger.error({ err: error }, "initial official documentation scan failed"));
    this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "official documentation scan failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}
