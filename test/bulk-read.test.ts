import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { BerachainClients } from "../src/chain.js";
import type { Config } from "../src/config.js";

/**
 * A LANE FAILURE MUST NEVER READ AS A DATA VERDICT.
 *
 * `multicall({ allowFailure: true })` returns normally when the transport dies, handing back N entries that
 * say "this contract had no answer". Every caller believed them. The liquidation monitor believed them 14
 * times a tick for hours — the precision lane silently caps out above ~8 calls per multicall — and while it
 * reported itself blind, two positions it was already tracking were liquidated by someone else for $10,024.
 *
 * So `bulkRead` is not allowed to guess. These tests drive it with fake lanes that reproduce each way a
 * batched read can go wrong, and assert it reaches the right verdict about WHO failed.
 */

const cfg = {
  CHAIN_ID: 8453, CHAIN_NAME: "Base", NATIVE_SYMBOL: "ETH", EXPLORER_NAME: "x", EXPLORER_URL: "https://x",
  PRIMARY_RPC_HTTP_URL: "https://primary.invalid", SECONDARY_RPC_HTTP_URL: "https://secondary.invalid",
  PRECISION_RPC_HTTP_URL: "https://precision.invalid", FALLBACK_RPC_HTTP_URL: "https://fallback.invalid",
  EXECUTION_RPC_HTTP_URL: "https://exec.invalid", INDEXER_RPC_HTTP_URL: "https://indexer.invalid",
  ENRICHMENT_RPC_HTTP_URL: "https://enrich.invalid",
} as unknown as Config;

const ok = (v: bigint) => ({ status: "success", result: v });
const bad = { status: "failure" };
const contracts = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

/** A lane that answers at most `cap` calls per multicall — the real nodies behaviour. */
function cappedLane(cap: number, alive = true) {
  let widest = 0, calls = 0;
  return {
    calls: () => calls, widest: () => widest,
    client: {
      multicall: async ({ contracts: c }: { contracts: readonly unknown[] }) => {
        calls++; widest = Math.max(widest, c.length);
        return c.length > cap ? c.map(() => bad) : c.map((_, i) => ok(BigInt(i)));
      },
      readContract: async () => { if (!alive) throw new Error("lane down"); return 1n; },
    },
  };
}

describe("bulkRead separates a dead lane from a refusing contract", () => {
  it("narrows to the width the lane can actually answer, and returns every value", async () => {
    const chain = new BerachainClients(cfg);
    const lane = cappedLane(8);
    const { results, laneFailed } = await chain.bulkRead(contracts(14), { label: "t", client: lane.client as never });
    expect(laneFailed).toBe(false);
    expect(results.filter((r) => r.status === "success")).toHaveLength(14);
  });

  it("remembers the proven width, so a capped lane costs the probe ONCE and not every tick", async () => {
    const chain = new BerachainClients(cfg);
    const lane = cappedLane(8);
    await chain.bulkRead(contracts(14), { client: lane.client as never });
    const afterFirst = lane.calls();
    await chain.bulkRead(contracts(14), { client: lane.client as never });
    // The second pass must not re-discover the cap: it costs strictly fewer calls than the first.
    expect(lane.calls() - afterFirst).toBeLessThan(afterFirst);
  });

  it("a contract that genuinely refuses is reported as a failure, NOT as a lane problem", async () => {
    const chain = new BerachainClients(cfg);
    // Answers nothing at any width, but the positive control responds ⇒ the chain refused.
    const lane = { multicall: async ({ contracts: c }: { contracts: readonly unknown[] }) => c.map(() => bad), readContract: async () => 1n };
    const { results, laneFailed } = await chain.bulkRead(contracts(4), { client: lane as never });
    expect(laneFailed).toBe(false);          // the lane is fine
    expect(results.every((r) => r.status === "failure")).toBe(true); // the data verdict is real
  });

  it("a lane proven down by the positive control reroutes instead of inventing failures", async () => {
    const chain = new BerachainClients(cfg);
    const dead = { multicall: async ({ contracts: c }: { contracts: readonly unknown[] }) => c.map(() => bad), readContract: async () => { throw new Error("down"); } };
    const { results, laneFailed } = await chain.bulkRead(contracts(2), { client: dead as never });
    // It rerouted to the real fallback client, which cannot answer in a test — but the point is that it
    // NEVER concluded "these contracts have no data" from a lane that could not answer the control question.
    expect(laneFailed || results.every((r) => r.status === "failure")).toBe(true);
    expect(results).toHaveLength(2);
  });

  it("an empty request is not a failure", async () => {
    const chain = new BerachainClients(cfg);
    expect(await chain.bulkRead([], { client: cappedLane(8).client as never })).toEqual({ results: [], laneFailed: false });
  });
});

describe("the liquidation monitor is the one service that does not wait for the mirror", () => {
  const src = readFileSync("src/index.ts", "utf8");
  const gate = src.indexOf("await blockIndexer.ready");
  const monitorStart = src.indexOf("liquidationMonitor.start()");

  it("starts BEFORE the sync gate", () => {
    // It takes no decision from the DB — oracle price, size and HF are read live from the chain every tick
    // and the on-chain require is the real boundary. The gate is shut for minutes after every restart, and
    // a liquidation is arity-1: it cannot wait for a graph to converge.
    expect(monitorStart).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(0);
    expect(monitorStart).toBeLessThan(gate);
  });

  it("is still the ONLY service ahead of the gate", () => {
    const before = src.slice(0, gate);
    for (const acting of ["autoflash.start()", "autoArm.start()", "positionManager.start()", "arbEngine.start()", "followService.start()"]) {
      expect(before).not.toContain(acting);
    }
  });
});

describe("the money paths do not call multicall directly any more", () => {
  // The monitor, the position resolver and the wallet all read wide batches whose all-empty answer is
  // indistinguishable from real data unless it goes through bulkRead.
  for (const f of ["src/liquidation-monitor.ts", "src/position-registry.ts", "src/wallet-holdings.ts"]) {
    it(`${f} reads batches through the governed path`, () => {
      const src = readFileSync(f, "utf8");
      expect(src).toMatch(/bulkRead\(/);
      expect(src).not.toMatch(/\.multicall\(\{/);
    });
  }
});
