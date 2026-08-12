import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type CycleStatus = "running" | "completed" | "failed";
export type CycleEventKind = "input" | "tool_call" | "tool_result" | "model_response" | "error";

export type CycleEvent = {
  sequence: number;
  at: string;
  kind: CycleEventKind;
  payload: unknown;
};

export type CycleRecord = {
  id: string;
  createdAt: string;
  completedAt?: string;
  status: CycleStatus;
  trigger: string;
  promptSha256: string;
  model: string;
  input: unknown;
  events: CycleEvent[];
  summary?: string;
  finalResponse?: string;
  parsedFinalResponse?: unknown;
  error?: string;
};

export type CycleIndexEntry = Pick<CycleRecord, "id" | "createdAt" | "completedAt" | "status" | "trigger" | "promptSha256" | "model" | "summary">;

/**
 * File-backed, append-in-spirit cycle memory. A cycle is always written in
 * full to its own file; the index contains only compact summaries. Atomic
 * replace avoids partially written records after a process interruption.
 */
export class CycleStore {
  constructor(private readonly dataDirectory: string) {}

  async create(input: Omit<CycleRecord, "id" | "createdAt" | "status" | "events">): Promise<CycleRecord> {
    const record: CycleRecord = { ...input, id: `cycle_${randomUUID()}`, createdAt: new Date().toISOString(), status: "running", events: [] };
    await this.write(record);
    return record;
  }

  async append(id: string, kind: CycleEventKind, payload: unknown): Promise<CycleRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`Cycle not found: ${id}`);
    if (record.status !== "running") throw new Error(`Cycle ${id} is already ${record.status}`);
    record.events.push({ sequence: record.events.length + 1, at: new Date().toISOString(), kind, payload });
    await this.write(record);
    return record;
  }

  async complete(id: string, value: { summary: string; finalResponse: string; parsedFinalResponse?: unknown }): Promise<CycleRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`Cycle not found: ${id}`);
    record.status = "completed";
    record.completedAt = new Date().toISOString();
    record.summary = value.summary;
    record.finalResponse = value.finalResponse;
    record.parsedFinalResponse = value.parsedFinalResponse;
    await this.write(record);
    return record;
  }

  async fail(id: string, error: unknown): Promise<CycleRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`Cycle not found: ${id}`);
    record.status = "failed";
    record.completedAt = new Date().toISOString();
    record.error = error instanceof Error ? error.message : String(error);
    await this.write(record);
    return record;
  }

  async get(id: string): Promise<CycleRecord | undefined> {
    try { return JSON.parse(await readFile(this.recordPath(id), "utf8")) as CycleRecord; }
    catch (error: unknown) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async list(): Promise<CycleIndexEntry[]> {
    try {
      const entries = JSON.parse(await readFile(this.indexPath(), "utf8")) as CycleIndexEntry[];
      return Array.isArray(entries) ? entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt)) : [];
    } catch (error: unknown) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** Preserves an interrupted record and makes its terminal state explicit. */
  async recoverInterrupted(reason = "Cycle process ended before a terminal response was persisted."): Promise<number> {
    const running = (await this.list()).filter((entry) => entry.status === "running");
    for (const entry of running) {
      const record = await this.get(entry.id);
      if (!record || record.status !== "running") continue;
      record.status = "failed";
      record.completedAt = new Date().toISOString();
      record.error = reason;
      record.events.push({ sequence: record.events.length + 1, at: record.completedAt, kind: "error", payload: { message: reason, recovered: true } });
      await this.write(record);
    }
    return running.length;
  }

  /** Compact continuity context; full records remain available by ID. */
  async historyContext(recent = 8): Promise<{ recent: CycleIndexEntry[]; older: CycleIndexEntry[]; total: number }> {
    const entries = await this.list();
    return { recent: entries.slice(0, recent), older: entries.slice(recent), total: entries.length };
  }

  private async write(record: CycleRecord): Promise<void> {
    await mkdir(this.cyclesDirectory(), { recursive: true });
    await atomicJson(this.recordPath(record.id), record);
    const entries = (await this.list()).filter((entry) => entry.id !== record.id);
    entries.push(toIndex(record));
    await atomicJson(this.indexPath(), entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  private cyclesDirectory() { return join(this.dataDirectory, "cycles"); }
  private recordPath(id: string) { return join(this.cyclesDirectory(), `${id}.json`); }
  private indexPath() { return join(this.dataDirectory, "cycle-index.json"); }
}

function toIndex(record: CycleRecord): CycleIndexEntry {
  const { id, createdAt, completedAt, status, trigger, promptSha256, model, summary } = record;
  return { id, createdAt, completedAt, status, trigger, promptSha256, model, summary };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}
