import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { capitalBand, engineEnabled, enabledEngines } from "../src/strategy-selector.js";

const config = loadConfig({
  DATABASE_URL: "postgres://bot:bot@localhost:5432/berabot",
  REDIS_URL: "redis://localhost:6379",
  PRIMARY_RPC_HTTP_URL: "https://rpc.berachain.com",
  SECONDARY_RPC_HTTP_URL: "https://berachain-rpc.publicnode.com",
  USDC_E_ADDRESS: "0x549943e04f40284185054145c6E4e9568C1D3241",
  HONEY_ADDRESS: "0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce"
});

describe("capital-aware strategy selector", () => {
  it("stays in bootstrap until the self-custodial cycle is proven, regardless of NAV", () => {
    expect(capitalBand(1_000, false, config)).toBe("bootstrap");
    expect(enabledEngines("bootstrap")).toEqual(["bootstrap_selfcustodial"]);
  });

  it("maps NAV to the right band once bootstrap is proven", () => {
    expect(capitalBand(0.30, true, config)).toBe("micro");
    expect(capitalBand(20, true, config)).toBe("small");
    expect(capitalBand(200, true, config)).toBe("medium");
    expect(capitalBand(5_000, true, config)).toBe("large");
  });

  it("enables micro engines but not liquidations at the micro band", () => {
    expect(engineEnabled("micro", "micro_yield")).toBe(true);
    expect(engineEnabled("micro", "micro_arbitrage")).toBe(true);
    expect(engineEnabled("micro", "active_yield")).toBe(false);
    expect(engineEnabled("micro", "liquidation")).toBe(false);
  });

  it("unlocks the promoted allocation sleeve at the small band and liquidations at medium", () => {
    expect(engineEnabled("small", "active_yield")).toBe(true);
    expect(engineEnabled("small", "reward_vault")).toBe(true);
    expect(engineEnabled("small", "liquidation")).toBe(false);
    expect(engineEnabled("medium", "liquidation")).toBe(true);
  });

  it("treats a non-finite NAV as the micro band (fail-small)", () => {
    expect(capitalBand(Number.NaN, true, config)).toBe("micro");
  });
});
