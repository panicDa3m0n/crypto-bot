import { z } from "zod";
import type { AgentLoop } from "./agent.js";
import type { BerachainClients } from "./chain.js";
import type { NetworkHealthSource } from "./health.js";
import type { Database } from "./db.js";
import type { NetworkResearcher } from "./research.js";
import type { StrategyEngine } from "./strategy.js";
import type { GateService } from "./gates.js";
import type { OfficialDocumentWatcher } from "./documents.js";
import { BEX_VAULT } from "./bex.js";
import type { PositionService } from "./positions.js";
import type { OpportunityScanner } from "./opportunities.js";
import type { NetworkDiscovery } from "./discovery.js";
import type { PoolRiskScanner } from "./poolrisk.js";

export const walletStateArgs = z.object({}).strict();
export const networkHealthArgs = z.object({}).strict();
export const marketResearchArgs = z.object({}).strict();
export const protocolGatesArgs = z.object({}).strict();
export const opportunitiesArgs = z.object({}).strict();
export const recentDecisionsArgs = z.object({ limit: z.number().int().min(1).max(20).default(8) }).strict();
export const recentResearchArgs = z.object({ limit: z.number().int().min(1).max(6).default(3) }).strict();
export const contractCodeArgs = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }).strict();

export const walletBrainTools = [
  {
    type: "function" as const,
    function: { name: "get_compiled_strategies", description: "Get the current compiler result binding MiniMax research to live BEX/Bend evidence. Only eligible items may progress to adapter/preflight; research and blocked items are never executable. Read only.", parameters: { type: "object", additionalProperties: false, properties: {}, required: [] } }
  },
  {
    type: "function" as const,
    function: { name: "get_network_discovery", description: "Get broad BEX pool/token discovery candidates, liquidity, volume, fee/PoL APR and exclusions. Scores are research signals, never trade authorization. Read only.", parameters: { type: "object", additionalProperties: false, properties: {}, required: [] } }
  },
  {
    type: "function" as const,
    function: {
      name: "get_wallet_state",
      description: "Get the latest real on-chain wallet balance, NAV, 24-hour loss and locked capital. Read only.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_opportunity_scan",
      description: "Get the latest same-block BEX cycle calculation and the real 14-day qualified-opportunity gate for the atomic module. Read only.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_protocol_gates",
      description: "Get persisted on-chain observation gates for the official BEX Vault and discovered Bend/Reward Vaults. A protocol is not executable unless its gate is ready. Read only.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_official_updates",
      description: "Get the latest hashes and change flags for Berachain official documentation and governance sources. Read only.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_strategy_sleeves",
      description: "Get real multi-strategy sleeve eligibility and explicit blockers. This is an allocation report, not an order. Read only.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_network_health",
      description: "Get dual-RPC mainnet freshness and reconciliation state. Read only.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_market_research",
      description: "Get latest Bera API discovery plus on-chain verification results for Bend and Reward Vault candidates. Read only.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_pool_risk",
      description: "Get dual-RPC BEX pool balances, normalized weights, historical counterfactual impermanent loss and stress IL. A rejected or stale scan prohibits LP execution. Read only.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_recent_decisions",
      description: "Get recent persisted MiniMax decisions and their actual outcomes. Read only.",
      parameters: { type: "object", additionalProperties: false, properties: { limit: { type: "number", minimum: 1, maximum: 20 } }, required: [] }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_research_memory",
      description: "Get persisted MiniMax research traces from earlier cycles, including empty or invalid results. Use them to avoid repeating a falsified thesis; they are research evidence, never an order. Read only.",
      parameters: { type: "object", additionalProperties: false, properties: { limit: { type: "number", minimum: 1, maximum: 6 } }, required: [] }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "verify_contract_code",
      description: "Check that an address has deployed bytecode on current Berachain mainnet. This never implies a protocol is trusted or executable.",
      parameters: { type: "object", additionalProperties: false, properties: { address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" } }, required: ["address"] }
    }
  }
];

/** Read-only tool boundary for the LLM. It deliberately has no signer and cannot send a transaction. */
export class ToolHub {
  constructor(
    private readonly chain: BerachainClients,
    private readonly collector: NetworkHealthSource,
    private readonly research: NetworkResearcher,
    private readonly db: Database,
    private readonly agent: Pick<AgentLoop, "lastDecision" | "compiledStrategies">,
    private readonly strategies: StrategyEngine,
    private readonly gates: GateService,
    private readonly documents: OfficialDocumentWatcher,
    private readonly positions: PositionService,
    private readonly opportunities: OpportunityScanner,
    private readonly discovery: NetworkDiscovery,
    private readonly poolRisk: PoolRiskScanner
  ) {}

  async invoke(name: string, rawArguments: string): Promise<unknown> {
    let input: unknown = {};
    try { input = rawArguments ? JSON.parse(rawArguments) : {}; } catch { return { error: "tool arguments are not valid JSON" }; }
    try {
      switch (name) {
        case "get_compiled_strategies":
          walletStateArgs.parse(input);
          return this.agent.compiledStrategies.length ? this.agent.compiledStrategies : { status: "No compiler pass has completed yet." };
        case "get_wallet_state": {
          walletStateArgs.parse(input);
          await this.collector.refresh();
          const loss = await this.db.dailyLossUsd();
          return this.positions.reconcile(await this.chain.portfolio(loss, this.collector.dataHealthy));
        }
        case "get_network_health": {
          networkHealthArgs.parse(input);
          await this.collector.refresh();
          const latest = this.collector.latest;
          return {
            dataHealthy: this.collector.dataHealthy,
            observedAt: latest?.observedAt.toISOString() ?? null,
            primaryBlock: latest?.primaryBlock.toString() ?? null,
            secondaryBlock: latest?.secondaryBlock.toString() ?? null,
            blockGap: latest?.blockGap.toString() ?? null,
            gasPriceWei: latest?.gasPriceWei.toString() ?? null,
            observationGate: await this.gates.observationGate()
          };
        }
        case "get_market_research":
          marketResearchArgs.parse(input);
          return this.research.latest ?? { status: "No completed mainnet research scan is available yet." };
        case "get_network_discovery":
          walletStateArgs.parse(input);
          return this.discovery.latest ?? { status: "No completed broad BEX discovery scan is available yet." };
        case "get_pool_risk":
          walletStateArgs.parse(input);
          return this.poolRisk.latest ?? { status: "No dual-RPC BEX pool-risk scan is available yet." };
        case "get_protocol_gates": {
          protocolGatesArgs.parse(input);
          const research = this.research.latest;
          const bend = research ? await Promise.all(research.bendVaults.map(async (vault) => ({ address: vault.vaultAddress, ready: (await this.gates.protocolObservationGate("bend-vault", vault.vaultAddress)).ready }))) : [];
          const rewards = research ? await Promise.all(research.topRewardVaults.map(async (vault) => (await this.gates.protocolObservationGate("reward-vault", vault.vaultAddress)).ready)) : [];
          return { bex: { address: BEX_VAULT, ready: (await this.gates.protocolObservationGate("bex", BEX_VAULT)).ready }, bend, rewardVaults: { observed: rewards.length, ready: rewards.filter(Boolean).length } };
        }
        case "get_opportunity_scan":
          opportunitiesArgs.parse(input);
          return { latest: this.opportunities.latest ?? { status: "No completed same-block opportunity scan is available yet." }, gate: await this.db.opportunityGate() };
        case "get_recent_decisions": {
          const args = recentDecisionsArgs.parse(input);
          return this.db.recentDecisions(args.limit);
        }
        case "get_research_memory": {
          const args = recentResearchArgs.parse(input);
          return (await this.db.recentResearchTraces(args.limit)).map(compactResearchTrace);
        }
        case "verify_contract_code": {
          const args = contractCodeArgs.parse(input);
          const code = await this.chain.primary.getCode({ address: args.address as `0x${string}` });
          return { address: args.address, deployed: Boolean(code && code !== "0x"), bytecodeLength: code ? (code.length - 2) / 2 : 0 };
        }
        case "get_strategy_sleeves": {
          walletStateArgs.parse(input);
          await this.collector.refresh();
          const loss = await this.db.dailyLossUsd();
          const portfolio = await this.positions.reconcile(await this.chain.portfolio(loss, this.collector.dataHealthy));
          return this.strategies.report(portfolio, this.research.latest);
        }
        case "get_official_updates":
          walletStateArgs.parse(input);
          return this.documents.latest.length ? this.documents.latest : this.db.recentOfficialDocuments();
        default:
          return { error: `Unknown or unauthorized tool: ${name}` };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : "tool invocation failed" };
    }
  }
}

/** Keep tool results useful without replaying an unbounded historical prompt. */
function compactResearchTrace(trace: { createdAt: string; status: string; hypotheses: unknown; modelResponse: unknown; error?: string }) {
  const response = trace.modelResponse as { model?: unknown; usage?: unknown; message?: { content?: unknown } } | null;
  const content = typeof response?.message?.content === "string" ? response.message.content.slice(0, 6_000) : undefined;
  return {
    createdAt: trace.createdAt, status: trace.status, hypotheses: trace.hypotheses,
    model: response?.model, usage: response?.usage, modelContent: content, error: trace.error
  };
}
