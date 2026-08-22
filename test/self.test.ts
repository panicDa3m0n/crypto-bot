import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { selfState } from "../src/self.js";
import type { PortfolioSnapshot } from "../src/domain.js";

const config = loadConfig({
  DATABASE_URL: "postgres://bot:bot@localhost:5432/berabot",
  REDIS_URL: "redis://localhost:6379",
  PRIMARY_RPC_HTTP_URL: "https://rpc.berachain.com",
  SECONDARY_RPC_HTTP_URL: "https://berachain-rpc.publicnode.com",
  USDC_E_ADDRESS: "0x549943e04f40284185054145c6E4e9568C1D3241",
  HONEY_ADDRESS: "0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce",
  HONEY_RUNWAY_TARGET: "10"
});

const base: PortfolioSnapshot = { observedAt: new Date().toISOString(), walletAddress: "0x0000000000000000000000000000000000000001", bera: 3, wbera: 0, usdcE: 0, honey: 0, baseAsset: "BERA", baseAssetBalance: 3, estimatedNavUsd: 0.46, beraUsd: 0.15, honeyUsd: 1, dailyLossUsd: 0, lockedUsd: 0, dataHealthy: true };

describe("Scarlet self-model", () => {
  it("keeps a gas-survival energy floor out of spendable energy", () => {
    const self = selfState(base, config);
    // 3 native BERA minus the 1 BERA reserve = 2 spendable, plus 0 WBERA.
    expect(self.energy.spendableWbera).toBeCloseTo(2, 6);
    expect(self.energy.healthy).toBe(true);
  });

  it("is starving and set to exploit when net worth is far below the runway target", () => {
    const self = selfState(base, config); // net worth ≈ $0.46 in HONEY vs 10 target
    expect(self.netWorthHoney).toBeCloseTo(0.46, 1);
    expect(self.hunger).toBeGreaterThan(0.9);
    expect(self.temperament).toBe("exploit");
  });

  // These two used to assert a RUNWAY model (sated once NAV passed HONEY_RUNWAY_TARGET). The self-model was
  // deliberately changed to MILESTONE-based levelling — hunger is progress toward the next rung of
  // PROFIT_MILESTONES (default 100,250,500,…), not distance from a survival runway — and the tests were left
  // asserting the old design, so they had been red ever since. They now describe what the model actually does.
  it("is hungry just after clearing a milestone, because the next rung is far", () => {
    const self = selfState({ ...base, estimatedNavUsd: 110 }, config); // just past the 100 rung, next is 250
    expect(self.level).toBe(2);
    expect(self.nextMilestoneUsd).toBe(250);
    expect(self.hunger).toBeGreaterThan(0.66);
    expect(self.temperament).toBe("exploit");
  });

  it("is balanced halfway between two milestones", () => {
    const self = selfState({ ...base, estimatedNavUsd: 175 }, config); // midpoint of 100 → 250
    expect(self.xpToNextPct).toBeCloseTo(50, 0);
    expect(self.temperament).toBe("balanced");
  });

  it("is sated only once every milestone is behind it", () => {
    const self = selfState({ ...base, estimatedNavUsd: 200_000 }, config); // past the last rung
    expect(self.nextMilestoneUsd).toBeNull();
    expect(self.hunger).toBe(0);
    expect(self.temperament).toBe("explore");
  });

  it("loses energy health when native BERA falls below the gas floor", () => {
    const self = selfState({ ...base, bera: 0.5 }, config);
    expect(self.energy.healthy).toBe(false);
    expect(self.energy.spendableWbera).toBe(0);
  });
});
