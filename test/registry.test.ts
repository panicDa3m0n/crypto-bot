import { describe, expect, it } from "vitest";
import { protocolCatalog, protocolStatus, registryContext, type VerifiedContract } from "../src/registry.js";

const verified = (address: string): VerifiedContract => ({ label: "x", address, role: "core", source: { title: "t", url: "https://x", trust: "project-official" }, verification: { state: "verified-dual-rpc" } });
const rejected = (address: string): VerifiedContract => ({ label: "x", address, role: "core", source: { title: "t", url: "https://x", trust: "project-official" }, verification: { state: "no-code" } });

describe("protocol registry", () => {
  it("never seeds a guessed address for Bulla or Origami", () => {
    const bulla = protocolCatalog.find((protocol) => protocol.id === "bulla");
    const origami = protocolCatalog.find((protocol) => protocol.id === "origami");
    expect(bulla?.candidates).toHaveLength(0);
    expect(origami?.candidates).toHaveLength(0);
    // Bulla is documented by a project source (partial until an address is verified);
    // Origami's only source is pending, so it stays source-pending.
    expect(protocolStatus(bulla!, [])).toBe("partial");
    expect(protocolStatus(origami!, [])).toBe("source-pending");
  });

  it("marks a protocol verified only when every candidate agrees dual-RPC", () => {
    const bend = protocolCatalog.find((protocol) => protocol.id === "bend")!;
    expect(protocolStatus(bend, [verified("0x24147243f9c08d835C218Cda1e135f8dFD0517D0")])).toBe("verified");
    expect(protocolStatus(bend, [rejected("0x24147243f9c08d835C218Cda1e135f8dFD0517D0")])).toBe("rejected");
  });

  it("exposes only verified anchors in the prompt-safe context", () => {
    const context = registryContext({
      observedAt: "2026-01-01T00:00:00.000Z",
      network: { primaryHead: "1", secondaryHead: "1", headDifference: "0" },
      protocols: [{ id: "bend", name: "Bend", description: "d", sources: [], discoveryNotes: [], status: "partial", candidates: [verified("0xaaaa000000000000000000000000000000000000"), rejected("0xbbbb000000000000000000000000000000000000")] }],
      summary: { protocolCount: 1, verifiedContracts: 1, unavailableContracts: 0, rejectedContracts: 1, sourcePendingProtocols: [] }
    }) as { protocols: Array<{ verifiedContracts: unknown[] }> };
    expect(context.protocols[0].verifiedContracts).toHaveLength(1);
  });

  it("instructs the model not to guess when no snapshot exists", () => {
    expect(registryContext(undefined)).toMatchObject({ status: "not-collected" });
  });
});
