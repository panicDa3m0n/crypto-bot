import { describe, expect, it } from "vitest";
import { valuationContext, type WalletValuationSnapshot } from "../src/valuation.js";

describe("wallet valuation semantics", () => {
  it("does not call an absent valuation NAV", () => {
    expect(valuationContext(undefined)).toMatchObject({ status: "not-collected" });
  });
  it("preserves the non-attested USDC.e unit warning", () => {
    const snapshot: WalletValuationSnapshot = { schemaVersion: 1, id: "valuation_test", observedAt: "2026-01-01T00:00:00.000Z", walletAddress: "0x0000000000000000000000000000000000000001", unit: { asset: "USDC.e", address: "0x0000000000000000000000000000000000000002", decimals: 6, usdStatus: "not-attested", warning: "not USD" }, portfolioSnapshotId: "portfolio_1", quoteAssets: [], totalUsdceRaw: "0", totalUsdceFormatted: "0", integrity: { status: "verified-dual-rpc", errors: [] }, coverage: { included: [], excluded: ["USD"] } };
    expect(valuationContext(snapshot)).toMatchObject({ unit: { usdStatus: "not-attested" }, coverage: { excluded: ["USD"] } });
  });
});
