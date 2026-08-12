import { describe, expect, it } from "vitest";
import { kodiakContext, type KodiakPositionsSnapshot } from "../src/kodiak.js";

describe("Kodiak position coverage", () => {
  it("does not present an uncollected Kodiak snapshot as absence of exposure", () => {
    expect(kodiakContext(undefined)).toMatchObject({ status: "not-collected" });
  });
  it("preserves a non-zero NFT count as an explicitly unsupported enumeration", () => {
    const snapshot: KodiakPositionsSnapshot = { schemaVersion: 1, id: "kodiak_test", observedAt: "2026-01-01T00:00:00.000Z", walletAddress: "0x0000000000000000000000000000000000000001", source: { positionManager: "0x0000000000000000000000000000000000000002", contracts: "source" }, network: { chainId: "0x138de", pinnedBlock: "0x1", primaryHead: "0x1", secondaryHead: "0x1", headDifference: "0" }, integrity: { status: "degraded", errors: ["enumeration unavailable"] }, v3NftPositions: { state: "unsupported", ownerNftCount: "1", positions: [], error: "enumeration unavailable" }, coverage: { included: [], excluded: ["positions"] } };
    expect(kodiakContext(snapshot)).toMatchObject({ v3NftPositions: { state: "unsupported", ownerNftCount: "1" }, coverage: { excluded: ["positions"] } });
  });
});
