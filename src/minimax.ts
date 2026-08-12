import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { Config } from "./config.js";
import { decisionSchema, type Decision, type PortfolioSnapshot } from "./domain.js";
import { walletBrainTools, type ToolHub } from "./toolhub.js";

const systemPrompt = `You are Wallet Brain, the sole strategic decision-maker for a Berachain mainnet wallet.
Use only the supplied evidence. Never invent a quote, balance, contract, or profit. Prefer HOLD or RESEARCH_MORE when evidence is stale, incomplete, or risk is not quantifiable.
All operations must be legitimate: do not manipulate markets, exploit vulnerabilities, sandwich users, or use private keys.
When the context contains exactly one executable candidate whose kind is micro_test, return ENTER with its exact strategyId unless the supplied evidence identifies a concrete current safety failure. A self-custodial wrap/unwrap micro-test may have zero expected profit because it validates production signing, fee and receipt paths; it is an approved operational milestone, not an investment allocation. For a candidate whose kind is allocation, choose ENTER only when its supplied net-yield thesis is positive; for a candidate whose required action is EXIT, choose EXIT when its invalidation condition holds. All other entries require positive net-profit or verified yield evidence.
Return exactly one JSON object with these exact keys and no others: action, strategyId, rationale, confidence, riskUsd, expectedNetProfitUsd, capitalUsd, expiresAt, evidence, needsResearch.
action must be one of ENTER, RESIZE, HARVEST, EXIT, HOLD, RESEARCH_MORE. confidence must be a fraction from 0 to 1 (for example 0.95, never 95). rationale is a string, evidence is an array of direct HTTPS URLs, and expiresAt is an ISO-8601 timestamp. Never use keys named decision, timestamp, riskFactors, nextReview, or evidenceUrls.`;

export class MiniMaxBrain {
  private readonly client?: OpenAI;

  constructor(private readonly config: Config) {
    this.client = config.MINIMAX_API_KEY ? new OpenAI({ apiKey: config.MINIMAX_API_KEY, baseURL: "https://api.minimax.io/v1", timeout: 120_000, maxRetries: 0 }) : undefined;
  }

  get available(): boolean { return Boolean(this.client); }

  async decide(snapshot: PortfolioSnapshot, context: Record<string, unknown>, toolHub?: ToolHub): Promise<BrainDecision> {
    if (!this.client) return { decision: hold("MiniMax API key is not configured; execution is intentionally unavailable."), modelResponse: { unavailable: true } };
    const now = new Date();
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify({ now: now.toISOString(), portfolio: snapshot, context, instruction: "Use available read-only tools when you need fresher evidence. Do not propose a transaction; output a decision only after evidence is sufficient." }) }
    ];
    const toolTrace: unknown[] = [];
    if (toolHub) {
      for (let round = 0; round < this.config.MINIMAX_MAX_TOOL_ROUNDS; round += 1) {
        const toolResponse = await this.client.chat.completions.create({ model: this.config.MINIMAX_MODEL, temperature: 0.2, messages, tools: walletBrainTools, tool_choice: "auto" });
        const message = toolResponse.choices[0]?.message;
        toolTrace.push({ round, model: toolResponse.model, usage: toolResponse.usage, message });
        if (!message) break;
        messages.push(message);
        if (!message.tool_calls?.length) break;
        for (const call of message.tool_calls) {
          if (call.type !== "function") {
            toolTrace.push({ tool: "unsupported", result: { error: "Only function tools are authorized." } });
            continue;
          }
          const result = await toolHub.invoke(call.function.name, call.function.arguments);
          toolTrace.push({ tool: call.function.name, arguments: call.function.arguments, result });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
    }
    messages.push({ role: "user", content: "Return the final Wallet Brain decision now. It must be exactly one JSON object matching the decision schema. If evidence is insufficient, return HOLD or RESEARCH_MORE." });
    const response = await this.client.chat.completions.create({
      model: this.config.MINIMAX_MODEL,
      temperature: 0.2,
      response_format: { type: "json_schema", json_schema: { name: "wallet_decision", strict: true, schema: zodToJsonSchema() } },
      messages,
      tool_choice: "none"
    });
    const content = response.choices[0]?.message.content;
    const modelResponse: { final: unknown; repair?: unknown; toolTrace: unknown[] } = { final: { model: response.model, usage: response.usage, message: response.choices[0]?.message }, toolTrace };
    if (!content) return { decision: hold("MiniMax returned no structured decision."), modelResponse };
    const direct = parseDecision(content);
    if (direct.success) return { decision: direct.decision, modelResponse };

    // Some reasoning models emit a valid but different JSON shape despite
    // response_format. One bounded repair pass preserves LLM authorship rather
    // than silently mapping strategic fields in application code.
    const repair = await this.client.chat.completions.create({
      model: this.config.MINIMAX_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Your preceding response was invalid (${direct.reason}). Return only the exact Wallet Brain JSON object now. Do not include analysis, markdown, a wrapper key, or extra fields. Use this source response only as evidence:\n${content.slice(0, 12_000)}` }
      ],
      response_format: { type: "json_object" }
    });
    const repairedContent = repair.choices[0]?.message.content;
    modelResponse.repair = { model: repair.model, usage: repair.usage, message: repair.choices[0]?.message };
    if (!repairedContent) return { decision: hold("MiniMax returned no content during schema repair."), modelResponse };
    const repaired = parseDecision(repairedContent);
    if (repaired.success) return { decision: repaired.decision, modelResponse };
    return { decision: hold(`MiniMax decision rejected after schema repair: ${repaired.reason}`), modelResponse };
  }
}

export type BrainDecision = { decision: Decision; modelResponse: unknown };

export type StrategyHypothesis = { id: string; category: "arbitrage" | "liquidation" | "momentum" | "relative_value" | "lp" | "lending"; direction: "BUY" | "SELL" | "DEPLOY" | "WATCH"; thesis: string; invalidation: string; expectedHorizon: string; evidence: string[]; requiredData: string[] };

function hold(rationale: string): Decision {
  return {
    action: "HOLD", strategyId: "capital-preservation", rationale, confidence: 1,
    riskUsd: 0, expectedNetProfitUsd: 0, capitalUsd: 0,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    evidence: ["https://docs.berachain.com/build/getting-started/common-resources"], needsResearch: []
  };
}

export type ResearchGeneration = {
  hypotheses: StrategyHypothesis[];
  /** Complete provider response, excluding credentials, for persistent audit memory. */
  modelResponse: unknown;
  status: "completed" | "no_content" | "invalid_json" | "unavailable";
};

export async function generateHypotheses(config: Config, context: Record<string, unknown>): Promise<ResearchGeneration> {
  if (!config.MINIMAX_API_KEY) return { hypotheses: [], modelResponse: { unavailable: true }, status: "unavailable" };
  const client = new OpenAI({ apiKey: config.MINIMAX_API_KEY, baseURL: "https://api.minimax.io/v1", timeout: 120_000, maxRetries: 0 });
  const hypothesisSchema = {
    type: "object", additionalProperties: false, required: ["hypotheses"], properties: {
      hypotheses: { type: "array", maxItems: 3, items: {
        type: "object", additionalProperties: false,
        required: ["id", "category", "direction", "thesis", "invalidation", "expectedHorizon", "evidence", "requiredData"],
        properties: {
          id: { type: "string" }, category: { type: "string", enum: ["arbitrage", "liquidation", "momentum", "relative_value", "lp", "lending"] },
          direction: { type: "string", enum: ["BUY", "SELL", "DEPLOY", "WATCH"] }, thesis: { type: "string" }, invalidation: { type: "string" }, expectedHorizon: { type: "string" },
          evidence: { type: "array", items: { type: "string" } }, requiredData: { type: "array", items: { type: "string" } }
        }
      } }
    }
  };
  const response = await client.chat.completions.create({ model: config.MINIMAX_MODEL, temperature: 0.15, response_format: { type: "json_schema", json_schema: { name: "strategy_hypotheses", strict: true, schema: hypothesisSchema } }, messages: [
    { role: "system", content: "You are a Berachain market-research agent. Generate at most three falsifiable research hypotheses from supplied on-chain discovery data. Never claim a profit or recommend execution. Reject low-liquidity, paused, unverified, or data-poor pools. Read poolRisk when supplied: its status is dual-RPC verified; for any pool whose return90dIlPct is at or below -5, never use direction DEPLOY and explicitly treat the LP thesis as invalidated until a fresh risk scan reverses that condition. Every hypothesis must cite one supplied discovery candidate id (pool:<id>) in evidence; otherwise return an empty hypotheses list. Official chart momentum is a research signal only, never sufficient to buy. Return JSON only: {hypotheses:[{id,category,direction,thesis,invalidation,expectedHorizon,evidence,requiredData}]}. category is arbitrage, liquidation, momentum, relative_value, lp, lending; direction is BUY, SELL, DEPLOY, or WATCH." },
    { role: "user", content: JSON.stringify(context) }
  ] });
  const raw = response.choices[0]?.message.content;
  const modelResponse = { model: response.model, usage: response.usage, message: response.choices[0]?.message };
  if (!raw) return { hypotheses: [], modelResponse, status: "no_content" };
  try {
    // M2 models may prepend a reasoning block even when the provider accepts
    // response_format. Extracting the final object preserves exactly the model
    // output instead of treating a valid research pass as an empty result.
    const parsed = parseResearchHypotheses(raw);
    return { hypotheses: parsed, modelResponse, status: "completed" };
  } catch {
    return { hypotheses: [], modelResponse, status: "invalid_json" };
  }
}

function validHypothesis(value: unknown): value is StrategyHypothesis {
  const item = value as Partial<StrategyHypothesis>;
  return Boolean(item && typeof item.id === "string" && typeof item.thesis === "string" && typeof item.invalidation === "string" && ["arbitrage","liquidation","momentum","relative_value","lp","lending"].includes(item.category ?? "") && ["BUY","SELL","DEPLOY","WATCH"].includes(item.direction ?? "") && Array.isArray(item.evidence) && Array.isArray(item.requiredData));
}

/**
 * M2 occasionally writes a single evidence/data item as a JSON string despite
 * the requested array schema. This only wraps the model's own text in an array;
 * it never adds a thesis, pool, action, or financial claim.
 */
function normalizeResearchHypothesisShape(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (typeof result.evidence === "string") result.evidence = [result.evidence];
  if (typeof result.requiredData === "string") result.requiredData = [result.requiredData];
  return result;
}

export function parseResearchHypotheses(content: string): StrategyHypothesis[] {
  const parsed = JSON.parse(extractLastJsonObject(content) ?? content) as { hypotheses?: unknown[] };
  return (parsed.hypotheses ?? []).map(normalizeResearchHypothesisShape).filter(validHypothesis).slice(0, 3);
}

export function parseDecision(content: string): { success: true; decision: Decision } | { success: false; reason: string } {
  const json = extractLastJsonObject(content);
  if (!json) return { success: false, reason: "no JSON object was found" };
  try {
    const decoded = decisionSchema.safeParse(normalizeDecisionShape(JSON.parse(json)));
    return decoded.success ? { success: true, decision: decoded.data } : { success: false, reason: decoded.error.issues[0]?.message ?? "schema validation failed" };
  } catch {
    return { success: false, reason: "JSON could not be parsed" };
  }
}

/**
 * MiniMax can express confidence as a qualitative token despite a JSON-schema
 * response request. This conversion is deliberately structural: it never
 * chooses an action, changes an amount/risk/profit, or invents evidence. A
 * missing id is repaired only for non-executing preservation decisions.
 */
function normalizeDecisionShape(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const confidence = result.confidence;
  if (typeof confidence === "string") {
    const normalized: Record<string, number> = { very_low: 0.1, low: 0.3, medium: 0.5, moderate: 0.5, high: 0.8, very_high: 0.95 };
    const parsed = normalized[confidence.toLowerCase().replace(/[ -]/g, "_")];
    if (parsed !== undefined) result.confidence = parsed;
  }
  // MiniMax occasionally renders the requested fractional confidence as a
  // human-readable percentage (for example 95 rather than 0.95). This is a
  // lossless unit conversion of its own confidence signal, not a strategic
  // judgement or a modification of any financial field.
  if (typeof result.confidence === "number" && Number.isFinite(result.confidence) && result.confidence > 1 && result.confidence <= 100) {
    result.confidence /= 100;
  }
  if ((result.action === "HOLD" || result.action === "RESEARCH_MORE") && (result.strategyId === null || result.strategyId === undefined || result.strategyId === "")) {
    result.strategyId = "capital-preservation";
  }
  if (typeof result.needsResearch === "string") result.needsResearch = [result.needsResearch];
  // The provider sometimes returns a boolean here despite the requested array.
  // This preserves its own signal without modifying any financial field.
  if (typeof result.needsResearch === "boolean") result.needsResearch = result.needsResearch ? ["MiniMax indicated that further research is required."] : [];
  // Evidence is an audit/source field. Preserve only model-supplied HTTPS
  // citations accepted by the schema; explanatory strings remain in rationale.
  if (Array.isArray(result.evidence)) result.evidence = result.evidence.filter((item) => typeof item === "string" && /^https:\/\//i.test(item));
  return result;
}

/** Extracts a complete trailing JSON object from models that prepend <think> text. */
export function extractLastJsonObject(content: string): string | undefined {
  let depth = 0;
  let start = -1;
  let last: string | undefined;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) last = content.slice(start, index + 1);
    }
  }
  return last;
}

// Kept local and explicit so the provider returns a bounded decision object.
function zodToJsonSchema() {
  return {
    type: "object", additionalProperties: false,
    required: ["action", "strategyId", "rationale", "confidence", "riskUsd", "expectedNetProfitUsd", "capitalUsd", "expiresAt", "evidence", "needsResearch"],
    properties: {
      action: { type: "string", enum: ["ENTER", "RESIZE", "HARVEST", "EXIT", "HOLD", "RESEARCH_MORE"] },
      strategyId: { type: "string" }, rationale: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 },
      riskUsd: { type: "number", minimum: 0 }, expectedNetProfitUsd: { type: "number" }, capitalUsd: { type: "number", minimum: 0 },
      expiresAt: { type: "string", format: "date-time" }, evidence: { type: "array", minItems: 1, items: { type: "string", format: "uri" } },
      needsResearch: { type: "array", maxItems: 8, items: { type: "string" } }
    }
  };
}
