import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { BerachainRpc } from "./berachain-rpc.js";
import type { CycleStore } from "./cycle-store.js";
import { ProtocolRegistryStore, registryContext, type ProtocolId } from "./protocol-registry.js";
import { PortfolioStore, portfolioContext } from "./portfolio.js";
import { BendPositionsStore, bendContext } from "./bend.js";
import { DolomiteAccountStore, dolomiteContext } from "./dolomite.js";
import { BexStore, bexContext } from "./bex.js";
import { BexQuoteService, BexQuoteStore, bexQuoteContext } from "./bex-quote.js";
import { KodiakPositionsStore, kodiakContext } from "./kodiak.js";
import { DecisionStore } from "./decision-record.js";
import { WalletValuationStore, valuationContext } from "./valuation.js";

export const scarletTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_wallet_valuation",
      description: "Read the latest BEX-simulated wallet valuation in USDC.e units. It explicitly is not an independently attested USD NAV and must not be used as proof that a dollar-denominated risk gate passes.",
      parameters: { type: "object", additionalProperties: false, required: ["address"], properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_logs",
      description: "Read real Berachain contract events for one explicit 4096-block-or-smaller interval. Use only verified addresses and explicit hexadecimal blocks; page historical scans deliberately. This is read-only raw event evidence.",
      parameters: { type: "object", additionalProperties: false, required: ["address", "fromBlock", "toBlock"], properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, fromBlock: { type: "string", pattern: "^0x[0-9a-fA-F]+$" }, toBlock: { type: "string", pattern: "^0x[0-9a-fA-F]+$" }, topics: { type: "array", maxItems: 4, items: {} } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_decision_by_cycle",
      description: "Read the typed DecisionRecord generated from a completed Scarlet cycle. validation is independent of model prose; read-only execution always remains not-submitted in this milestone.",
      parameters: { type: "object", additionalProperties: false, required: ["cycleId"], properties: { cycleId: { type: "string", minLength: 7, maxLength: 100 } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_chain_head",
      description: "Read the current Berachain chain ID and latest block from the configured real RPC.",
      parameters: { type: "object", additionalProperties: false, properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_bex_quote_history",
      description: "Read compact persisted BEX exact-input quote evidence for a wallet. Every item states the point-in-time pinned block and coverage; it is not wallet P&L or a trade recommendation.",
      parameters: { type: "object", additionalProperties: false, required: ["address"], properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_kodiak_positions",
      description: "Read the latest dual-RPC Kodiak position-manager snapshot for an address. It proves V3 NFT absence only when ownerNftCount is zero; coverage explicitly states that V2 LPs, Islands and non-zero NFT enumeration require separate adapters.",
      parameters: { type: "object", additionalProperties: false, required: ["address"], properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_bex_market_overview",
      description: "Read the latest BEX market snapshot: official API discovery plus BEX Vault state verified by two RPCs. The coverage declares the scan limit and unsupported pool versions.",
      parameters: { type: "object", additionalProperties: false, required: ["address"], properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_bex_exact_in_quote",
      description: "Request a real exact-input BEX quote. The official SOR route must use only V2 pools in the latest dual-RPC-verified BEX scan, then the route is simulated at one pinned block through two RPCs. This never creates approval or swap calldata and never executes a transaction. amountInRaw is the token's integer base-unit amount.",
      parameters: { type: "object", additionalProperties: false, required: ["address", "tokenIn", "tokenOut", "amountInRaw"], properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, tokenIn: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, tokenOut: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, amountInRaw: { type: "string", pattern: "^[0-9]+$" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_dolomite_account",
      description: "Read the latest dual-RPC Dolomite account snapshot. The default supported account is number 0; coverage states that account-number discovery is not yet implemented.",
      parameters: { type: "object", additionalProperties: false, required: ["address"], properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, accountNumber: { type: "string", pattern: "^[0-9]+$" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_bend_positions",
      description: "Read the latest dual-RPC Bend/Morpho position snapshot for an address. It states the published-market coverage and does not infer USD health or positions outside that scope.",
      parameters: { type: "object", additionalProperties: false, required: ["address"], properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_wallet_portfolio",
      description: "Read the latest persisted, dual-RPC-reconciled portfolio snapshot for an address. It explicitly states token/allowance coverage and unimplemented position or valuation data.",
      parameters: { type: "object", additionalProperties: false, required: ["address"], properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_protocol_registry",
      description: "Read the latest dual-RPC protocol registry snapshot. It includes source links, verified address anchors and explicit gaps; an unverified address must never be guessed or treated as operational.",
      parameters: { type: "object", additionalProperties: false, properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_protocol",
      description: "Read the complete latest registry observation for one protocol: bex, bend, beraborrow, dolomite, bulla, kodiak, infrared or origami.",
      parameters: { type: "object", additionalProperties: false, required: ["protocolId"], properties: { protocolId: { type: "string", enum: ["bex", "bend", "beraborrow", "dolomite", "bulla", "kodiak", "infrared", "origami"] } }
    }
    }
  },
  {
    type: "function",
    function: {
      name: "get_recent_blocks",
      description: "Read 1 to 20 recent complete blocks from Berachain. This is real chain data, not an indexer summary.",
      parameters: { type: "object", additionalProperties: false, required: ["count"], properties: { count: { type: "integer", minimum: 1, maximum: 20 } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_block",
      description: "Read one complete Berachain block by hexadecimal number or latest.",
      parameters: { type: "object", additionalProperties: false, required: ["blockNumber"], properties: { blockNumber: { type: "string" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_transaction",
      description: "Read a Berachain transaction by 32-byte hash.",
      parameters: { type: "object", additionalProperties: false, required: ["txHash"], properties: { txHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_native_balance",
      description: "Read the current native BERA balance of an address from Berachain.",
      parameters: { type: "object", additionalProperties: false, required: ["address"], properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "read_contract",
      description: "Execute an eth_call against a Berachain contract. It is read-only and requires explicit target and calldata.",
      parameters: { type: "object", additionalProperties: false, required: ["to", "data"], properties: { to: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, data: { type: "string", pattern: "^0x[0-9a-fA-F]*$" }, from: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, block: { type: "string" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "get_cycle_history",
      description: "Read compact summaries of previous Scarlet cycles. Older full records can be retrieved with get_cycle by ID.",
      parameters: { type: "object", additionalProperties: false, properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_cycle",
      description: "Read the full persistent record of a previous cycle, including input, tool calls/results and final response.",
      parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 7, maxLength: 100 } } }
    }
  }
];

export class ScarletToolHub {
  private readonly bexQuote: BexQuoteService;
  private readonly bexQuotes: BexQuoteStore;
  private readonly kodiak: KodiakPositionsStore;
  private readonly decisions: DecisionStore;
  private readonly valuation: WalletValuationStore;
  constructor(private readonly rpc: BerachainRpc, private readonly store: CycleStore, private readonly registry: ProtocolRegistryStore, private readonly portfolio: PortfolioStore, private readonly bend: BendPositionsStore, private readonly dolomite: DolomiteAccountStore, private readonly bex: BexStore, secondaryRpc: BerachainRpc, dataDirectory: string) { this.bexQuotes = new BexQuoteStore(dataDirectory); this.bexQuote = new BexQuoteService(rpc, secondaryRpc, bex, this.bexQuotes); this.kodiak = new KodiakPositionsStore(dataDirectory); this.decisions = new DecisionStore(dataDirectory); this.valuation = new WalletValuationStore(dataDirectory); }

  async invoke(name: string, rawArguments: string): Promise<unknown> {
    let input: Record<string, unknown>;
    try { input = JSON.parse(rawArguments) as Record<string, unknown>; }
    catch { return { ok: false, error: "Tool arguments are not valid JSON." }; }
    try {
      switch (name) {
        case "get_wallet_valuation": return { ok: true, data: valuationContext(await this.valuation.latest(requireString(input, "address"))) };
        case "get_logs": return { ok: true, data: await this.rpc.logs({ address: requireString(input, "address"), fromBlock: requireString(input, "fromBlock"), toBlock: requireString(input, "toBlock"), ...(optionalTopics(input) ? { topics: optionalTopics(input) } : {}) }) };
        case "get_decision_by_cycle": {
          const decision = await this.decisions.byCycle(requireString(input, "cycleId"));
          return decision ? { ok: true, data: decision } : { ok: false, error: "No DecisionRecord exists for this cycle." };
        }
        case "get_chain_head": return { ok: true, data: await this.rpc.chainHead() };
        case "get_recent_blocks": return { ok: true, data: await this.rpc.recentBlocks(requireInteger(input, "count")) };
        case "get_block": return { ok: true, data: await this.rpc.block(requireString(input, "blockNumber")) };
        case "get_transaction": return { ok: true, data: await this.rpc.transaction(requireString(input, "txHash")) };
        case "get_native_balance": return { ok: true, data: await this.rpc.nativeBalance(requireString(input, "address")) };
        case "read_contract": return { ok: true, data: await this.rpc.readContract({ to: requireString(input, "to"), data: requireString(input, "data"), ...(optionalString(input, "from") ? { from: optionalString(input, "from") } : {}), ...(optionalString(input, "block") ? { block: optionalString(input, "block") } : {}) }) };
        case "get_protocol_registry": return { ok: true, data: registryContext(await this.registry.latest()) };
        case "get_protocol": {
          const snapshot = await this.registry.latest();
          const protocolId = requireProtocolId(input, "protocolId");
          const protocol = snapshot?.protocols.find((item) => item.id === protocolId);
          return protocol ? { ok: true, data: { observedAt: snapshot?.observedAt, network: snapshot?.network, protocol } } : { ok: false, error: "No registry observation exists. Run the read-only registry scan first." };
        }
        case "get_wallet_portfolio": return { ok: true, data: portfolioContext(await this.portfolio.latest(requireString(input, "address"))) };
        case "get_bend_positions": return { ok: true, data: bendContext(await this.bend.latest(requireString(input, "address"))) };
        case "get_kodiak_positions": return { ok: true, data: kodiakContext(await this.kodiak.latest(requireString(input, "address"))) };
        case "get_dolomite_account": return { ok: true, data: dolomiteContext(await this.dolomite.latest(requireString(input, "address"), optionalString(input, "accountNumber") ?? "0")) };
        case "get_bex_market_overview": return { ok: true, data: bexContext(await this.bex.getLatest(requireString(input, "address"))) };
        case "get_bex_exact_in_quote": return { ok: true, data: await this.bexQuote.exactIn({ walletAddress: requireString(input, "address"), tokenIn: requireString(input, "tokenIn"), tokenOut: requireString(input, "tokenOut"), amountInRaw: requireString(input, "amountInRaw") }) };
        case "get_bex_quote_history": return { ok: true, data: await bexQuoteContext(this.bexQuotes, requireString(input, "address")) };
        case "get_cycle_history": return { ok: true, data: await this.store.historyContext() };
        case "get_cycle": {
          const cycle = await this.store.get(requireString(input, "id"));
          return cycle ? { ok: true, data: cycle } : { ok: false, error: "Cycle ID does not exist." };
        }
        default: return { ok: false, error: `Tool is not available: ${name}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function requireString(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function optionalString(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  return typeof value === "string" && value ? value : undefined;
}
function requireInteger(input: Record<string, unknown>, name: string): number {
  const value = input[name];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
function optionalTopics(input: Record<string, unknown>): Array<string | null> | undefined {
  const value = input.topics;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((topic) => topic !== null && typeof topic !== "string")) throw new Error("topics must be an array of strings or null");
  return value as Array<string | null>;
}
function requireProtocolId(input: Record<string, unknown>, name: string): ProtocolId {
  const value = requireString(input, name);
  if (!["bex", "bend", "beraborrow", "dolomite", "bulla", "kodiak", "infrared", "origami"].includes(value)) throw new Error("protocolId is not in the registry");
  return value as ProtocolId;
}
