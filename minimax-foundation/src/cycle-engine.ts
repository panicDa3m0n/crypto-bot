import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { MiniMaxClient } from "./client.js";
import type { MiniMaxConfig } from "./config.js";
import { BerachainRpc } from "./berachain-rpc.js";
import { CycleStore, type CycleRecord } from "./cycle-store.js";
import { ScarletToolHub, scarletTools } from "./tools.js";
import { ProtocolRegistryStore, registryContext } from "./protocol-registry.js";
import { PortfolioStore, portfolioContext } from "./portfolio.js";
import { BendPositionsStore, bendContext } from "./bend.js";
import { DolomiteAccountStore, dolomiteContext } from "./dolomite.js";
import { BexStore, bexContext } from "./bex.js";
import { BexQuoteStore, bexQuoteContext } from "./bex-quote.js";
import { KodiakPositionsStore, kodiakContext } from "./kodiak.js";
import { DecisionStore } from "./decision-record.js";
import { WalletValuationStore, valuationContext } from "./valuation.js";

export type CycleInput = {
  trigger: string;
  walletAddress: string;
  declaredCapital?: Record<string, string | number>;
  openPositions?: unknown[];
  notes?: string;
};

export class CycleEngine {
  private readonly store: CycleStore;
  private readonly rpc: BerachainRpc;
  private readonly tools: ScarletToolHub;
  private readonly brain: MiniMaxClient;
  private readonly registry: ProtocolRegistryStore;
  private readonly portfolio: PortfolioStore;
  private readonly bend: BendPositionsStore;
  private readonly dolomite: DolomiteAccountStore;
  private readonly bex: BexStore;
  private readonly bexQuotes: BexQuoteStore;
  private readonly kodiak: KodiakPositionsStore;
  private readonly decisions: DecisionStore;
  private readonly valuation: WalletValuationStore;

  constructor(private readonly config: MiniMaxConfig) {
    this.store = new CycleStore(config.dataDirectory);
    this.rpc = new BerachainRpc(config.berachainRpcUrl);
    this.registry = new ProtocolRegistryStore(config.dataDirectory);
    this.portfolio = new PortfolioStore(config.dataDirectory);
    this.bend = new BendPositionsStore(config.dataDirectory);
    this.dolomite = new DolomiteAccountStore(config.dataDirectory);
    this.bex = new BexStore(config.dataDirectory);
    this.bexQuotes = new BexQuoteStore(config.dataDirectory);
    this.kodiak = new KodiakPositionsStore(config.dataDirectory);
    this.decisions = new DecisionStore(config.dataDirectory);
    this.valuation = new WalletValuationStore(config.dataDirectory);
    this.tools = new ScarletToolHub(this.rpc, this.store, this.registry, this.portfolio, this.bend, this.dolomite, this.bex, new BerachainRpc(config.berachainSecondaryRpcUrl), config.dataDirectory);
    this.brain = new MiniMaxClient(config);
  }

  async run(input: CycleInput): Promise<CycleRecord> {
    validateInput(input);
    await this.store.recoverInterrupted();
    const nativeBalance = await this.rpc.nativeBalance(input.walletAddress);
    const history = await this.store.historyContext();
    const protocolRegistry = registryContext(await this.registry.latest());
    const portfolio = portfolioContext(await this.portfolio.latest(input.walletAddress));
    const bendPositions = bendContext(await this.bend.latest(input.walletAddress));
    const dolomiteAccount = dolomiteContext(await this.dolomite.latest(input.walletAddress));
    const bexMarket = bexContext(await this.bex.getLatest(input.walletAddress));
    const bexQuotes = await bexQuoteContext(this.bexQuotes, input.walletAddress);
    const kodiakPositions = kodiakContext(await this.kodiak.latest(input.walletAddress));
    const valuationSnapshot = await this.valuation.latest(input.walletAddress);
    const walletValuation = valuationContext(valuationSnapshot);
    const initialContext = {
      cycleTrigger: input.trigger,
      wallet: { address: input.walletAddress, nativeBalance, source: "Berachain RPC eth_getBalance" },
      declaredCapital: input.declaredCapital === undefined ? { status: "not supplied" } : { status: "operator-supplied", value: input.declaredCapital },
      declaredOpenPositions: input.openPositions === undefined ? { status: "not supplied" } : { status: "operator-supplied", value: input.openPositions },
      notes: input.notes ?? "",
      history,
      protocolRegistry,
      portfolio,
      bendPositions,
      dolomiteAccount,
      bexMarket,
      bexQuotes,
      kodiakPositions,
      walletValuation,
      toolCapabilities: scarletTools.flatMap((tool) => tool.type === "function" ? [tool.function.name] : []),
      executionCapability: "disabled in this milestone; tools provide real Berachain reads only"
    };
    const record = await this.store.create({ trigger: input.trigger, promptSha256: this.brain.promptSha256, model: this.config.model, input: initialContext });
    await this.store.append(record.id, "input", initialContext);
    try {
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: this.brain.systemInstructions },
        { role: "user", content: `Start cycle ${record.id}. Here is the complete initial context:\n${JSON.stringify(initialContext)}` }
      ];
      let toolRounds = 0;
      while (true) {
        if (toolRounds >= this.config.maxToolRounds) {
          messages.push({ role: "user", content: "The finite evidence-collection phase is complete. Do not call further tools. Return the required final JSON now, stating the evidence gathered and any unresolved uncertainty." });
          const final = await this.brain.complete(messages);
          const content = final.choices[0]?.message.content?.trim();
          if (!content) throw new Error("MiniMax returned an empty forced-final response.");
          const parsed = extractLastJsonObject(content);
          const summary = summaryFrom(parsed, content);
          await this.store.append(record.id, "model_response", { model: final.model || this.config.model, usage: final.usage ?? null, content, parsed, forcedFinal: true });
          return this.completeWithDecision(record, { summary, finalResponse: content, parsedFinalResponse: parsed }, { usdAttestationUnavailable: valuationSnapshot?.unit.usdStatus === "not-attested", positionCoverageIncomplete: true });
        }
        const response = await this.brain.complete(messages, scarletTools);
        const message = response.choices[0]?.message;
        if (!message) throw new Error("MiniMax returned no assistant message for this cycle.");
        if (!message.tool_calls?.length) {
          const content = message.content?.trim();
          if (!content) throw new Error("MiniMax completed the cycle with an empty response.");
          const parsed = extractLastJsonObject(content);
          const summary = summaryFrom(parsed, content);
          await this.store.append(record.id, "model_response", { model: response.model || this.config.model, usage: response.usage ?? null, content, parsed });
          return this.completeWithDecision(record, { summary, finalResponse: content, parsedFinalResponse: parsed }, { usdAttestationUnavailable: valuationSnapshot?.unit.usdStatus === "not-attested", positionCoverageIncomplete: true });
        }
        toolRounds += 1;
        await this.store.append(record.id, "model_response", { model: response.model || this.config.model, usage: response.usage ?? null, content: message.content ?? null, toolCallCount: message.tool_calls.length });
        messages.push(message);
        for (const call of message.tool_calls) {
          if (call.type !== "function") continue;
          await this.store.append(record.id, "tool_call", { id: call.id, name: call.function.name, arguments: call.function.arguments });
          const result = await this.tools.invoke(call.function.name, call.function.arguments);
          await this.store.append(record.id, "tool_result", { id: call.id, name: call.function.name, result });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
    } catch (error) {
      await this.store.append(record.id, "error", { message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      await this.store.fail(record.id, error);
      throw error;
    }
  }

  private async completeWithDecision(record: CycleRecord, value: { summary: string; finalResponse: string; parsedFinalResponse?: unknown }, semantic: { usdAttestationUnavailable?: boolean; positionCoverageIncomplete?: boolean }): Promise<CycleRecord> {
    const prospective: CycleRecord = { ...record, status: "completed", completedAt: new Date().toISOString(), summary: value.summary, finalResponse: value.finalResponse, parsedFinalResponse: value.parsedFinalResponse };
    await this.decisions.record(prospective, semantic);
    return this.store.complete(record.id, value);
  }
}

function validateInput(input: CycleInput): void {
  if (!input.trigger.trim()) throw new Error("cycle trigger is required");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress)) throw new Error("walletAddress must be a 20-byte hexadecimal address");
  if (input.openPositions !== undefined && !Array.isArray(input.openPositions)) throw new Error("openPositions must be an array");
}

function extractLastJsonObject(content: string): unknown | undefined {
  let depth = 0; let start = -1; let last: string | undefined; let inString = false; let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inString) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') { inString = true; continue; }
    if (char === "{") { if (depth === 0) start = index; depth += 1; }
    if (char === "}" && depth > 0) { depth -= 1; if (depth === 0 && start >= 0) last = content.slice(start, index + 1); }
  }
  if (!last) return undefined;
  try { return JSON.parse(last); } catch { return undefined; }
}

function summaryFrom(parsed: unknown, raw: string): string {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).summary === "string") return (parsed as Record<string, string>).summary;
  return raw.replace(/<think>[\s\S]*?<\/think>/, "").trim().slice(0, 1_000) || "Cycle completed without a machine-readable summary.";
}
