import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolRegistryStore, protocolCatalog, registryContext, type ProtocolRegistrySnapshot } from "../src/protocol-registry.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("protocol catalog", () => {
  it("covers the agreed Berachain ecosystem without inventing unverified deployments", () => {
    expect(protocolCatalog.map((protocol) => protocol.id)).toEqual(["bex", "bend", "beraborrow", "dolomite", "bulla", "kodiak", "infrared", "origami"]);
    for (const protocol of protocolCatalog) {
      expect(protocol.sources.length).toBeGreaterThan(0);
      for (const candidate of protocol.candidates) expect(candidate.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(protocolCatalog.find((protocol) => protocol.id === "bex")?.candidates).toHaveLength(3);
    expect(protocolCatalog.find((protocol) => protocol.id === "bulla")?.candidates).toEqual([]);
    expect(protocolCatalog.find((protocol) => protocol.id === "origami")?.candidates).toEqual([]);
  });

  it("persists a snapshot and exposes a compact, evidence-labelled prompt context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scarlet-registry-")); directories.push(directory);
    const snapshot: ProtocolRegistrySnapshot = {
      schemaVersion: 1,
      id: "registry_test", observedAt: "2026-08-11T00:00:00.000Z",
      network: { chainId: "0x138de", primaryHead: "0x1", secondaryHead: "0x2", headDifference: "1" },
      protocols: protocolCatalog.map((protocol) => ({ ...protocol, status: protocol.id === "origami" ? "source-pending" : "partial", candidates: protocol.candidates.map((candidate) => ({ ...candidate, verification: { state: "rpc-unavailable", error: "fixture" } })) })),
      summary: { protocolCount: 8, verifiedContracts: 0, unavailableContracts: 1, rejectedContracts: 0, sourcePendingProtocols: ["origami"] }
    };
    const store = new ProtocolRegistryStore(directory);
    await store.save(snapshot);
    expect(await store.latest()).toEqual(snapshot);
    expect(registryContext(snapshot)).toMatchObject({ observedAt: snapshot.observedAt, summary: snapshot.summary });
  });
});
