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

  it("is sated and set to explore once net worth exceeds the runway target", () => {
    const self = selfState({ ...base, estimatedNavUsd: 12 }, config);
    expect(self.hunger).toBe(0);
    expect(self.temperament).toBe("explore");
  });

  it("is balanced at a mid net worth", () => {
    const self = selfState({ ...base, estimatedNavUsd: 5 }, config);
    expect(self.temperament).toBe("balanced");
  });

  it("loses energy health when native BERA falls below the gas floor", () => {
    const self = selfState({ ...base, bera: 0.5 }, config);
    expect(self.energy.healthy).toBe(false);
    expect(self.energy.spendableWbera).toBe(0);
  });
});
