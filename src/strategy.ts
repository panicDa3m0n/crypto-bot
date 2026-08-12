import type { BendScanSummary, BendScanner } from "./bend.js";
import type { Config } from "./config.js";
import type { PortfolioSnapshot } from "./domain.js";
import type { ResearchSnapshot } from "./research.js";

export type Sleeve = "gas_reserve" | "idle_bera" | "stable_idle" | "lending_prudent" | "pol_incentives" | "relative_value" | "opportunistic" | "research";

export type StrategyReport = {
  generatedAt: string;
  sleeves: Array<{ id: Sleeve; capitalUsd: number; status: "active" | "eligible" | "blocked" | "research"; reason: string }>;
  candidates: Array<{ id: string; sleeve: Sleeve; status: "research" | "blocked"; protocol?: string; reason: string; evidence: string[] }>;
  bendScanner?: BendScanSummary;
};

/**
 * Allocations are an evidence report, never an order. MiniMax may approve only a
 * separately generated, adapter-bound execution plan after all protocol gates pass.
 */
export class StrategyEngine {
  constructor(private readonly config: Config, private readonly bend: BendScanner) {}

  report(portfolio: PortfolioSnapshot, research?: ResearchSnapshot): StrategyReport {
    const gasReserveUsd = Math.min(portfolio.estimatedNavUsd, portfolio.beraUsd * this.config.MIN_BERA_RESERVE);
    const spendableBeraUsd = Math.max(0, portfolio.estimatedNavUsd - gasReserveUsd);
    const canAllocate = portfolio.dataHealthy && portfolio.estimatedNavUsd >= this.config.MIN_NAV_USD && portfolio.bera >= this.config.MIN_BERA_RESERVE;
    const verifiedBend = research?.onchainVerification.verified ?? 0;
    const rewardVaults = research?.topRewardVaults.length ?? 0;
    const scanner = this.bend.latest;
    return {
      generatedAt: new Date().toISOString(),
      sleeves: [
        { id: "gas_reserve", capitalUsd: gasReserveUsd, status: "active", reason: `${this.config.MIN_BERA_RESERVE} BERA retained for gas` },
        { id: "idle_bera", capitalUsd: spendableBeraUsd, status: canAllocate ? "eligible" : "blocked", reason: canAllocate ? "Unallocated BERA pending a verified positive-net strategy" : "NAV/data/reserve gate prevents deployment" },
        { id: "stable_idle", capitalUsd: portfolio.usdcE, status: portfolio.usdcE > 0 ? "eligible" : "research", reason: portfolio.usdcE > 0 ? "USDC.e available; reserve percentage is enforced by the executor" : "No USDC.e currently held" },
        { id: "lending_prudent", capitalUsd: portfolio.lockedUsd, status: portfolio.lockedUsd > 0 ? "active" : (verifiedBend >= 2 && canAllocate ? "eligible" : "research"), reason: portfolio.lockedUsd > 0 ? "Capital is valued from current ERC-4626 previewRedeem on-chain, not from a deposit estimate." : `${verifiedBend} Bend vaults have current on-chain verification; asset conversion and withdrawal path still require protocol gate` },
        { id: "pol_incentives", capitalUsd: 0, status: rewardVaults > 0 ? "research" : "blocked", reason: "Reward vault receipt-token acquisition, active emissions and exit liquidity must be verified before allocation" },
        { id: "relative_value", capitalUsd: 0, status: "research", reason: "Requires fresh multi-route executable quotes and a positive-net simulation" },
        { id: "opportunistic", capitalUsd: 0, status: scanner?.liquidatable ? "research" : "research", reason: scanner?.liquidatable ? "Potential Bend liquidations require atomic profit, oracle and flash-loan preflight" : "No currently indexed liquidatable Bend position" },
        { id: "research", capitalUsd: 0, status: "active", reason: "Continuous protocol, governance, oracle and liquidity observation" }
      ],
      candidates: [
        { id: "bend-lending-observation", sleeve: "lending_prudent", status: "research", protocol: "Bend", reason: "No funded supported lending asset or verified real withdrawal evidence for this wallet yet.", evidence: ["https://docs.berachain.com/build/bend/overview", "https://docs.berachain.com/bend/learn/vault"] },
        { id: "pol-vault-observation", sleeve: "pol_incentives", status: "research", protocol: "RewardVault", reason: "APR discovery is not enough: receipt-token cost, emissions, liquidity and exit must be priced on-chain.", evidence: ["https://docs.berachain.com/general/proof-of-liquidity/reward-vaults"] },
        { id: "bend-liquidation-observation", sleeve: "opportunistic", status: scanner?.liquidatable ? "research" : "blocked", protocol: "Bend", reason: scanner?.liquidatable ? "An on-chain health candidate exists but no AtomicExecutor/profit simulation has passed." : "No liquidatable position in the currently indexed event range.", evidence: ["https://docs.berachain.com/bend/learn/liquidation", "https://docs.berachain.com/bend/learn/flash-loans"] }
      ],
      bendScanner: scanner
    };
  }
}
