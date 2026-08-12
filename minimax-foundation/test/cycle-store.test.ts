import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CycleStore } from "../src/cycle-store.js";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("persistent cycle memory", () => {
  it("keeps compact history and the complete event record addressable by ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scarlet-cycle-"));
    paths.push(directory);
    const store = new CycleStore(directory);
    const created = await store.create({ trigger: "manual-test", promptSha256: "prompt-hash", model: "MiniMax-M2.7", input: { wallet: "0xabc" } });
    await store.append(created.id, "input", { realSource: "RPC" });
    await store.append(created.id, "tool_call", { name: "get_chain_head" });
    await store.complete(created.id, { summary: "Read the chain head from the configured RPC.", finalResponse: '{"summary":"Read the chain head from the configured RPC."}' });

    expect(await store.historyContext()).toMatchObject({ total: 1, recent: [expect.objectContaining({ id: created.id, status: "completed" })] });
    expect(await store.get(created.id)).toMatchObject({ id: created.id, status: "completed", events: [expect.objectContaining({ kind: "input" }), expect.objectContaining({ kind: "tool_call" })] });
  });

  it("marks an interrupted running cycle as failed without erasing its evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scarlet-cycle-"));
    paths.push(directory);
    const store = new CycleStore(directory);
    const created = await store.create({ trigger: "interrupted", promptSha256: "prompt-hash", model: "MiniMax-M2.7", input: {} });
    await store.append(created.id, "tool_result", { ok: true, data: "preserved" });
    expect(await store.recoverInterrupted("intentional test interruption")).toBe(1);
    expect(await store.get(created.id)).toMatchObject({ status: "failed", error: "intentional test interruption", events: expect.arrayContaining([expect.objectContaining({ kind: "tool_result" }), expect.objectContaining({ kind: "error" })]) });
  });
});
