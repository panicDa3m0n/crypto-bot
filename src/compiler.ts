import type { BendScanSummary } from "./bend.js";
import type { NetworkDiscoverySnapshot } from "./discovery.js";
import type { StrategyHypothesis } from "./minimax.js";
import type { OpportunitySummary } from "./opportunities.js";
import type { PoolRiskSnapshot } from "./poolrisk.js";

export type CompiledStrategy = {
  id: string; source: "llm" | "deterministic"; category: StrategyHypothesis["category"];
  status: "eligible" | "research" | "blocked"; action: StrategyHypothesis["direction"];
  rationale: string; requirements: string[]; evidence: string[];
};

/**
 * The compiler is deliberately stricter than the LLM. It does not invent an
 * executable route: it associates an LLM thesis with current mainnet evidence
 * and states exactly why it remains research, blocked, or eligible for a later
 * adapter/preflight stage.
 */
export class StrategyCompiler {
  compile(input: { discovery?: NetworkDiscoverySnapshot; hypotheses: unknown[]; opportunity?: OpportunitySummary; bend?: BendScanSummary; poolRisk?: PoolRiskSnapshot }): CompiledStrategy[] {
    const output: CompiledStrategy[] = [];
    if (input.opportunity?.qualified) output.push({ id: `bex-cycle:${input.opportunity.blockNumber}`, source: "deterministic", category: "arbitrage", status: "eligible", action: "BUY", rationale: `Same-block BEX cycle has expected net $${input.opportunity.expectedNetUsd.toFixed(6)}.`, requirements: ["atomic route compiler", "dual-RPC transaction preflight", "positive minProfit"], evidence: ["mainnet BEX SOR quote"] });
    else output.push({ id: "bex-cycle", source: "deterministic", category: "arbitrage", status: "blocked", action: "WATCH", rationale: "No same-block BEX cycle currently exceeds the absolute and gas-adjusted profit floor.", requirements: ["positive-net live route"], evidence: ["mainnet BEX SOR quote"] });
    if ((input.bend?.liquidatable ?? 0) > 0) output.push({ id: `bend-liquidation:${input.bend?.blockNumber}`, source: "deterministic", category: "liquidation", status: "research", action: "WATCH", rationale: `${input.bend?.liquidatable} indexed Bend position(s) are liquidatable, but atomic profitability remains uncompiled.`, requirements: ["complete account index", "flash-loan simulation", "repayment and minProfit"], evidence: ["Bend oracle/position read"] });
    for (const raw of input.hypotheses) {
      if (!isHypothesis(raw)) continue;
      const pool = input.discovery?.candidates.find((candidate) => raw.evidence.some((item) => item.includes(candidate.poolId) || item.includes(candidate.id)));
      if (raw.category === "arbitrage" || raw.category === "liquidation") continue; // deterministic modules above own these paths.
      if (!pool) { output.push({ id: raw.id, source: "llm", category: raw.category, status: "research", action: raw.direction, rationale: raw.thesis, requirements: [...raw.requiredData, "bind thesis to an eligible current pool/token"], evidence: raw.evidence }); continue; }
      if (pool.liquidityUsd < 10_000 || pool.volume24hUsd < 500 || pool.warnings.length) { output.push({ id: raw.id, source: "llm", category: raw.category, status: "blocked", action: raw.direction, rationale: raw.thesis, requirements: ["sufficient liquid exit depth", "no pool-risk warning"], evidence: raw.evidence }); continue; }
      const risk = input.poolRisk?.pools.find((item) => item.poolId === pool.poolId);
      if ((raw.category === "lp" || raw.category === "relative_value") && (!risk || risk.status !== "verified")) { output.push({ id: raw.id, source: "llm", category: raw.category, status: "research", action: raw.direction, rationale: raw.thesis, requirements: [...raw.requiredData, "dual-RPC pool balance/weight verification"], evidence: raw.evidence }); continue; }
      if ((raw.category === "lp" || raw.category === "relative_value") && risk && (risk.return90dIlPct ?? 0) <= -5) { output.push({ id: raw.id, source: "llm", category: raw.category, status: "blocked", action: raw.direction, rationale: raw.thesis, requirements: [`90-day no-fee IL ${risk.return90dIlPct?.toFixed(2)}% exceeds the -5% risk limit`, "price stabilization and fresh IL re-evaluation"], evidence: raw.evidence }); continue; }
      const category = raw.category;
      const adapterRequirement = category === "lp" ? "BEX join/exit adapter and IL simulation" : category === "momentum" || category === "relative_value" ? "token route adapter, historical-price signal and exact reverse quote" : "protocol-specific adapter";
      output.push({ id: raw.id, source: "llm", category, status: "research", action: raw.direction, rationale: raw.thesis, requirements: [...raw.requiredData, adapterRequirement, `invalidation: ${raw.invalidation}`], evidence: raw.evidence });
    }
    return output;
  }
}

function isHypothesis(value: unknown): value is StrategyHypothesis {
  const item = value as Partial<StrategyHypothesis>;
  return Boolean(item && typeof item.id === "string" && typeof item.thesis === "string" && typeof item.invalidation === "string" && Array.isArray(item.evidence) && Array.isArray(item.requiredData) && ["arbitrage", "liquidation", "momentum", "relative_value", "lp", "lending"].includes(item.category ?? "") && ["BUY", "SELL", "DEPLOY", "WATCH"].includes(item.direction ?? ""));
}
