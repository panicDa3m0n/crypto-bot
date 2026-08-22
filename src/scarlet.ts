import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions.js";
import { getAddress, parseAbi, parseUnits, type Address } from "viem";
import type { Logger } from "pino";
import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { PortfolioSnapshot } from "./domain.js";
import type { NetworkHealthSource } from "./health.js";
import type { Perception } from "./perception.js";
import type { MonadSignals } from "./monad-signals.js";
import type { PositionService } from "./positions.js";
import type { Primitives } from "./primitives.js";
import { selfState } from "./self.js";
import { VENUE_TYPES, type VenueRegistry, type VenueType } from "./venues.js";
import type { Etherscan } from "./etherscan.js";
import { COMPACTION_SYSTEM, type Chronicle } from "./chronicle.js";
import type { MarketData, MarketKind } from "./market-data.js";
import type { EntityResolver } from "./entity-resolver.js";
import { LIQUIDATE_SIG, buildLiquidateArgs } from "./autoflash.js";

const FALLBACK_PROMPT = "You are Scarlet, a living on-chain profit agent on Base. Perceive by simulating, act through your primitives (and call_contract for anything), respect your reflexes, and grow your net worth without draining your ETH gas energy.";

/** The agentic core: Scarlet perceives, reasons, and drives her own hands. */
export class Scarlet {
  private readonly client?: OpenAI;
  private readonly systemPrompt: string;
  private living = false;
  private lastFingerprint = "";
  private idleStreak = 0;

  /** Next cycle gap: grows while the material state is unchanged (idle-backoff),
   * snaps back to the base gap the instant something material changes. */
  get nextGapMs(): number {
    return Math.min(this.config.SCARLET_CYCLE_GAP_MS * 2 ** Math.min(this.idleStreak, 8), this.config.SCARLET_MAX_CYCLE_GAP_MS);
  }

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly health: NetworkHealthSource,
    private readonly positions: PositionService,
    private readonly perception: Perception,
    private readonly primitives: Primitives,
    private readonly venues: VenueRegistry,
    private readonly etherscan: Etherscan,
    private readonly chronicle: Chronicle,
    private readonly marketData: MarketData,
    private readonly resolver: EntityResolver,
    private readonly monadSignals: MonadSignals,
    private readonly logger: Logger
  ) {
    this.client = config.MINIMAX_API_KEY ? new OpenAI({ apiKey: config.MINIMAX_API_KEY, baseURL: config.MINIMAX_BASE_URL, timeout: 150_000, maxRetries: 2 }) : undefined;
    this.systemPrompt = loadPrompt(config.SCARLET_AGENT_PROMPT_PATH);
  }

  get available(): boolean { return Boolean(this.client); }

  /** One activation: perceive, reason, and act (or simulate) until Scarlet rests. */
  async live(reason: string): Promise<void> {
    if (!this.client) { this.logger.info({ reason }, "Scarlet cannot wake: MiniMax API key is not configured"); return; }
    if (this.living) { this.logger.debug({ reason }, "Scarlet is already awake; skipping re-entry"); return; }
    this.living = true;
    try {
      await this.health.refresh();
      const dailyLoss = await this.db.dailyLossUsd();
      const portfolio = await this.positions.reconcile(await this.chain.portfolio(dailyLoss, this.health.dataHealthy));
      const self = selfState(portfolio, this.config);
      const briefing = await this.perception.brief(self);
      // Idle-backoff bookkeeping: unchanged material state → grow the streak (slower
      // cadence); any real change resets it. The fingerprint is internal, not shown.
      const { fingerprint, ...briefingForModel } = briefing;
      if (fingerprint === this.lastFingerprint) this.idleStreak += 1; else this.idleStreak = 0;
      this.lastFingerprint = fingerprint;
      // Cross-cycle continuity: her past cycles (compacted summary + recent chronicle)
      // travel with her as running context, so she builds on what she already did.
      const history = await this.chronicle.loadContext().catch(() => ({ text: "", tokens: 0, freshCount: 0 }));
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: this.systemPrompt },
        ...(history.text ? [{ role: "user" as const, content: `LA TUA STORIA (continuità tra i cicli — ciò che hai pensato, deciso e fatto finora; ogni voce ha il suo id-ciclo, recuperabile con recall_cycle):\n\n${history.text}` }] : []),
        { role: "user", content: JSON.stringify({ reason, now: new Date().toISOString(), executionEnabled: this.config.EXECUTION_ENABLED, briefing: briefingForModel, instruction: "Perceive from the inside by simulating. Continue from your history — do not repeat work already done. Act through your primitives when a simulated net outcome is positive and within your reflexes; otherwise probe a frontier signal or rest. Prefer execute=false to simulate first." }) }
      ];
      const cycle = randomUUID().slice(0, 8);
      for (let round = 0; round < this.config.SCARLET_MAX_ROUNDS; round += 1) {
        const response = await this.client.chat.completions.create({ model: this.config.MINIMAX_MODEL, temperature: 0.3, messages, tools: scarletTools, tool_choice: "auto" });
        const message = response.choices[0]?.message;
        if (!message) break;
        messages.push(message);
        // Persist her reasoning (M3 emits it in the message content) so the human
        // dashboard can show her thinking, not only her actions.
        const thought = cleanThought(message.content);
        if (thought) await this.db.addJournal("thought", thought, { round }, cycle).catch(() => undefined);
        if (!message.tool_calls?.length) {
          await this.db.addJournal("rest", thought || "Rested without a machine-readable summary.", { round }, cycle).catch(() => undefined);
          this.logger.info({ reason, cycle, summary: thought.slice(0, 400) }, "Scarlet rested");
          break;
        }
        for (const call of message.tool_calls) {
          if (call.type !== "function") { messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "only function tools are available" }) }); continue; }
          const result = await this.dispatch(call.function.name, call.function.arguments, portfolio, cycle);
          this.logger.info({ round, cycle, tool: call.function.name, args: compact(call.function.arguments), result: compact(result) }, "Scarlet tool");
          // Record the human-readable action she took (not the read-only lookups).
          if (ACTION_TOOLS.has(call.function.name)) await this.db.addJournal("action", actionSummary(call.function.name, call.function.arguments, result), { tool: call.function.name }, cycle).catch(() => undefined);
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      // Grow the history, then compact the oldest cycles if it crossed the threshold.
      await this.chronicle.maybeCompact((prior, older) => this.summarizeHistory(prior, older)).catch((error) => this.logger.warn({ err: error }, "history compaction check failed"));
    } catch (error) {
      this.logger.error({ err: error, reason }, "Scarlet activation failed");
    } finally {
      this.living = false;
    }
  }

  /** LLM consolidation of the oldest cycles into a structured summary (Scarlet's terms). */
  private async summarizeHistory(priorSummary: string, olderChronicle: string): Promise<string> {
    if (!this.client) throw new Error("no LLM client for compaction");
    const user = `${priorSummary ? `RIASSUNTO STORICO PRECEDENTE:\n${priorSummary}\n\n` : ""}CICLI DA COMPATTARE (dal più vecchio):\n${olderChronicle}`;
    const response = await this.client.chat.completions.create({
      model: this.config.MINIMAX_MODEL, temperature: 0.2,
      messages: [{ role: "system", content: COMPACTION_SYSTEM }, { role: "user", content: user }]
    });
    const out = cleanThought(response.choices[0]?.message?.content);
    if (!out) throw new Error("empty compaction summary");
    return out;
  }

  private async dispatch(name: string, rawArgs: string, portfolio: PortfolioSnapshot, cycle: string): Promise<unknown> {
    let args: Record<string, unknown> = {};
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return { error: "tool arguments are not valid JSON" }; }
    // Normalise every address-shaped argument to its EIP-55 checksum so a casing
    // slip from the model can never revert a transaction and waste gas.
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
        try { args[key] = getAddress(value.toLowerCase() as `0x${string}`); } catch { /* leave as-is */ }
      }
    }
    try {
      switch (name) {
        case "note": {
          const text = String(args.text ?? "").trim();
          if (!text) return { ok: false, reason: "note text is empty" };
          await this.db.addJournal("note", text, {}, cycle);
          return { ok: true, published: true };
        }
        case "swap": {
          if (!args.tokenIn || !args.tokenOut || args.amountIn == null) return { ok: false, reason: "need tokenIn, tokenOut, amountIn" };
          const tokenIn = getAddress(String(args.tokenIn).toLowerCase()); const tokenOut = getAddress(String(args.tokenOut).toLowerCase());
          const amountIn = parseUnits(String(args.amountIn), this.decimalsFor(tokenIn));
          const maxSlippagePct = Number(args.maxSlippagePct ?? 1);
          return this.primitives.swapV3(tokenIn, tokenOut, amountIn, maxSlippagePct, args.execute === true);
        }
        case "wrap": return this.primitives.wrap(parseUnits(String(args.amountBera), 18), args.execute === true);
        case "unwrap": return this.primitives.unwrap(parseUnits(String(args.amountWbera), 18), args.execute === true);
        case "approve_exact": {
          const token = args.token as Address;
          return this.primitives.approveExact(token, args.spender as Address, parseUnits(String(args.amount), this.decimalsFor(token)), args.execute === true);
        }
        case "lend": {
          const vault = args.vault as Address, asset = args.asset as Address;
          return this.primitives.lend(vault, asset, parseUnits(String(args.assets), this.decimalsFor(asset)), args.execute === true);
        }
        case "redeem": {
          const vault = args.vault as Address, asset = args.asset as Address;
          return this.primitives.redeem(vault, asset, parseUnits(String(args.assets), this.decimalsFor(asset)), args.execute === true);
        }
        case "call_contract": {
          const to = args.address as Address;
          const signature = String(args.signature ?? "").trim();
          if (!signature) return { error: "signature is required, e.g. 'deposit(uint256,address)'" };
          const callArgs = coerceArgArray(args.args).map((v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v);
          const valueWei = args.valueBera != null ? parseUnits(String(args.valueBera), 18) : 0n;
          return this.primitives.callContract(to, signature, callArgs, valueWei, args.execute === true);
        }
        case "deploy_contract": {
          const bytecode = String(args.bytecode ?? "") as `0x${string}`;
          if (!/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode.length < 10) return { error: "bytecode must be the 0x-prefixed creation bytecode" };
          return this.primitives.deployContract(bytecode, args.valueBera != null ? parseUnits(String(args.valueBera), 18) : 0n, args.execute === true);
        }
        case "deploy_organ": return this.primitives.deployOrgan(args.execute === true);
        case "flash_liquidate": {
          const req = ["organ", "loanToken", "collateralToken", "oracle", "irm", "lltv", "borrower", "seizedAssets", "flashAmount"].filter((k) => !args[k]);
          if (req.length) return { ok: false, reason: `missing: ${req.join(", ")} (organ from briefing.organ; marketParams+borrower from signals; seizedAssets/flashAmount are base-unit amounts you size)` };
          // The swap fee tier selects WHICH pool the seized collateral is sold through. Defaulting it sent the
          // trade to a pool the caller never chose, so it is required: an omitted tier is a caller error.
          if (args.swapFeeBps == null || !Number.isFinite(Number(args.swapFeeBps))) return { ok: false, reason: "swapFeeBps is required — the fee tier selects the exit pool and must not be defaulted" };
          try {
            return await this.primitives.flashLiquidate({
              organ: getAddress(String(args.organ).toLowerCase()), loanToken: getAddress(String(args.loanToken).toLowerCase()), collateralToken: getAddress(String(args.collateralToken).toLowerCase()),
              oracle: getAddress(String(args.oracle).toLowerCase()), irm: getAddress(String(args.irm).toLowerCase()), lltv: String(args.lltv), borrower: getAddress(String(args.borrower).toLowerCase()),
              seizedAssets: BigInt(String(args.seizedAssets)), flashAmount: BigInt(String(args.flashAmount)), swapFeeBps: Number(args.swapFeeBps), minProfitWei: BigInt(String(args.minProfit ?? "0"))
            }, args.execute === true);
          } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "flash_liquidate failed" }; }
        }
        case "flash_execute": {
          if (!args.organ || !args.loanToken || args.amount == null) return { ok: false, reason: "need organ, loanToken, amount (+ optional minProfit, calls[])" };
          const organ = getAddress(String(args.organ).toLowerCase());
          const calls = coerceArgArray(args.calls).map((c) => [getAddress(String((c as Record<string, unknown>).target).toLowerCase()), BigInt(String((c as Record<string, unknown>).value ?? "0")), String((c as Record<string, unknown>).data)]);
          const feSig = "flashExecute(address,uint256,uint256,(address,uint256,bytes)[])";
          return this.primitives.callContract(organ, feSig, [getAddress(String(args.loanToken).toLowerCase()), BigInt(String(args.amount)), BigInt(String(args.minProfit ?? "0")), calls], 0n, args.execute === true);
        }
        case "check_token": {
          const token = args.token as Address;
          return this.primitives.checkToken(token);
        }
        case "watch_wallet": {
          const wallet = String(args.wallet ?? "").toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(wallet)) return { error: "wallet must be a 20-byte address" };
          const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
          const padded = ("0x" + wallet.slice(2).padStart(64, "0")) as `0x${string}`;
          const latest = await this.chain.tools.getBlockNumber();
          const fromBlock = latest - BigInt(Math.min(Number(args.blocks ?? 3000), 4096));
          const fb = ("0x" + fromBlock.toString(16)) as `0x${string}`;
          const tb = ("0x" + latest.toString(16)) as `0x${string}`;
          try {
            const outgoing = await this.chain.tools.request({ method: "eth_getLogs", params: [{ fromBlock: fb, toBlock: tb, topics: [transfer as `0x${string}`, padded] }] } as never) as Array<{ address: string; transactionHash: string }>;
            const incoming = await this.chain.tools.request({ method: "eth_getLogs", params: [{ fromBlock: fb, toBlock: tb, topics: [transfer as `0x${string}`, null, padded] }] } as never) as Array<{ address: string; transactionHash: string }>;
            const moves = [...outgoing.map((l) => ({ dir: "out", token: l.address, tx: l.transactionHash })), ...incoming.map((l) => ({ dir: "in", token: l.address, tx: l.transactionHash }))].slice(0, 30);
            return { wallet, fromBlock: fromBlock.toString(), tokenMoves: moves.length, sample: moves, note: "Tokens this wallet moved recently. Investigate its trades with read_contract; mirror the good ideas." };
          } catch (error) { return { wallet, error: error instanceof Error ? error.message : "watch failed" }; }
        }
        case "get_logs": {
          const address = args.address as Address;
          const latest = await this.chain.tools.getBlockNumber();
          const WINDOW = 100n; // public RPC caps eth_getLogs at 100 blocks
          let toBlock = args.toBlock != null ? BigInt(String(args.toBlock)) : latest;
          if (toBlock > latest) toBlock = latest;
          let fromBlock = args.fromBlock != null ? BigInt(String(args.fromBlock)) : toBlock - (WINDOW - 1n);
          // Auto-clamp to the RPC window (most-recent slice of the requested range)
          // and hand back paging hints, so she never wastes a call on a range error.
          let clamped = false;
          if (toBlock - fromBlock > WINDOW - 1n) { fromBlock = toBlock - (WINDOW - 1n); clamped = true; }
          if (fromBlock < 0n) fromBlock = 0n;
          try {
            const logs = await this.chain.tools.getLogs({ address, fromBlock, toBlock });
            return { address, chainHead: latest.toString(), fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), count: logs.length, ...(clamped ? { note: `clamped to the RPC's ${WINDOW}-block window (most recent slice). To page older, call again with toBlock=${(fromBlock - 1n).toString()}.` } : {}), logs: logs.slice(0, 25).map((l) => ({ block: l.blockNumber?.toString(), tx: l.transactionHash, topics: l.topics, data: l.data })) };
          } catch (error) {
            return { address, chainHead: latest.toString(), error: error instanceof Error ? error.message : "get_logs failed" };
          }
        }
        case "remember": {
          const key = String(args.key ?? "").trim();
          const content = String(args.content ?? "").trim();
          if (!key || !content) return { ok: false, reason: "remember needs a key and content" };
          await this.db.saveMemory(key, String(args.category ?? "note"), content, Array.isArray(args.tags) ? args.tags.map(String) : []);
          return { ok: true, saved: key };
        }
        case "recall": {
          const key = args.key ? String(args.key).trim() : undefined;
          if (key) { const m = await this.db.getMemory(key); return m ?? { notFound: key, hint: "use recall with a category or search term to list what you have saved" }; }
          return { results: await this.db.searchMemory({ category: args.category ? String(args.category) : undefined, search: args.search ? String(args.search) : undefined }) };
        }
        case "forget": {
          const key = String(args.key ?? "").trim();
          if (!key) return { ok: false, reason: "forget needs a key" };
          return { ok: await this.db.deleteMemory(key), key };
        }
        case "list_venues":
          return { venues: this.venues.all.map((v) => ({ id: v.id, name: v.name, type: v.type, address: v.address, meta: v.meta })) };
        case "add_venue": {
          const id = String(args.id ?? "").trim();
          const type = String(args.type ?? "").trim() as VenueType;
          const address = args.address as Address;
          if (!id || !address || !VENUE_TYPES.includes(type)) return { ok: false, reason: `need id, address and a valid type (${VENUE_TYPES.join(", ")})` };
          await this.venues.add({ id, name: String(args.name ?? id), type, address, meta: (args.meta as Record<string, unknown>) ?? {} });
          return { ok: true, added: id };
        }
        case "remove_venue": {
          const id = String(args.id ?? "").trim();
          if (!id) return { ok: false, reason: "need the venue id" };
          return { ok: await this.venues.remove(id), removed: id };
        }
        case "read_contract": {
          const address = args.address as Address;
          const signature = String(args.signature ?? "").trim();
          if (!signature) return { error: "signature is required, e.g. 'balanceOf(address) view returns (uint256)'" };
          const fnName = signature.split("(")[0].trim();
          const callArgs = coerceArgArray(args.args);
          try {
            // signature is a runtime string, so parseAbi's literal validation cannot apply.
            const abi = parseAbi([`function ${signature}`] as unknown as readonly string[]);
            const result = await this.chain.tools.readContract({ address, abi, functionName: fnName as never, args: callArgs as never });
            return JSON.parse(JSON.stringify({ address, call: signature, result }, (_k, v) => typeof v === "bigint" ? v.toString() : v));
          } catch (error) {
            return { address, call: signature, error: error instanceof Error ? error.message : "read failed" };
          }
        }
        case "resolve_abi": {
          if (!this.etherscan.available) return { error: "ABI resolver is not configured (no Etherscan key)" };
          const address = getAddress(String(args.address).toLowerCase());
          try {
            const abi = await this.etherscan.resolveAbi(address);
            if (!abi) return { address, verified: false, note: "no verified ABI on the explorer — brute-force signatures with read_contract, or treat as unverified/risky." };
            const parsed = JSON.parse(abi) as Array<{ type?: string; name?: string; stateMutability?: string; inputs?: unknown[]; outputs?: unknown[] }>;
            const fns = parsed.filter((e) => e.type === "function").map((f) => `${f.name}(${(f.inputs ?? []).map((i) => (i as { type?: string }).type).join(",")})${f.stateMutability && f.stateMutability !== "nonpayable" ? ` ${f.stateMutability}` : ""}`);
            return { address, verified: true, functionCount: fns.length, functions: fns.slice(0, 120), note: "Use these exact signatures with read_contract / call_contract instead of guessing." };
          } catch (error) { return { address, error: error instanceof Error ? error.message : "abi resolve failed" }; }
        }
        case "contract_meta": {
          if (!this.etherscan.available) return { error: "contract metadata is not configured (no Etherscan key)" };
          const address = getAddress(String(args.address).toLowerCase());
          try { return await this.etherscan.contractMeta(address); }
          catch (error) { return { address, error: error instanceof Error ? error.message : "meta lookup failed" }; }
        }
        case "open_position": {
          const label = String(args.label ?? "").trim();
          const note = String(args.note ?? "").trim();
          if (!label || !note) return { ok: false, reason: "label and note (your thesis: why you opened it) are both required" };
          const kind = args.kind === "erc4626" ? "erc4626" : "token";
          try {
            if (kind === "token") {
              if (!args.token) return { ok: false, reason: "token address required for a token position" };
              const token = getAddress(String(args.token).toLowerCase());
              const r = await this.positions.openTokenPosition(token, label, note, cycle);
              return { ok: true, id: r.id, kind, token, label, entryValueUsd: r.entryValueUsd, balance: r.balance, note: r.balance > 0 ? "position tracked; value is read live from chain each cycle" : "you hold 0 of this token now — entry value is $0. Acquire it first, then re-open." };
            }
            if (!args.vault || !args.asset) return { ok: false, reason: "vault and asset addresses required for an erc4626 position" };
            const vault = getAddress(String(args.vault).toLowerCase()); const asset = getAddress(String(args.asset).toLowerCase());
            const r = await this.positions.openVaultPosition(vault, asset, label, note, cycle);
            return { ok: true, id: r.id, kind, vault, asset, label, entryValueUsd: r.entryValueUsd };
          } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "open_position failed" }; }
        }
        case "annotate_position": {
          const ref = String(args.id ?? args.label ?? "").trim();
          const note = String(args.note ?? "").trim();
          if (!ref || !note) return { ok: false, reason: "need the position id (or label) and the new note" };
          return { ok: await this.db.annotatePosition(ref, note), updated: ref };
        }
        case "close_position": {
          const ref = String(args.id ?? args.label ?? "").trim();
          if (!ref) return { ok: false, reason: "need the position id or label" };
          return { ok: await this.db.closePosition(ref), closed: ref, note: "ledger entry closed. This does NOT move funds — exit on-chain yourself (swap/redeem) if you still hold the asset." };
        }
        case "recall_cycle": {
          const c = String(args.cycle ?? "").trim();
          if (!c) return { error: "need the cycle id (from your history, e.g. '3ce11a1f')" };
          const entries = await this.db.journalForCycle(c);
          if (!entries.length) return { cycle: c, note: "no transcript found for that cycle id" };
          return { cycle: c, entries: entries.map((e) => ({ kind: e.kind, at: e.at, content: e.content })) };
        }
        case "market_data": {
          const kind = String(args.kind ?? "") as MarketKind;
          if (!["yields", "new_pools", "trending", "token", "ohlcv"].includes(kind)) return { error: "kind must be one of: yields, new_pools, trending, token, ohlcv" };
          try { return await this.marketData.query(kind, { token: args.token ? String(args.token) : undefined, pool: args.pool ? String(args.pool) : undefined, timeframe: args.timeframe ? String(args.timeframe) : undefined, limit: typeof args.limit === "number" ? args.limit : undefined }); }
          catch (error) { return { kind, error: error instanceof Error ? error.message : "market_data failed" }; }
        }
        case "arm_autoflash": {
          const req = ["loanToken", "collateralToken", "oracle", "irm", "lltv", "borrower"].filter((k) => !args[k]);
          if (req.length) return { ok: false, reason: `missing: ${req.join(", ")} (all from signals.onTheEdge[].marketParams + user)` };
          const seizedAssets = String(args.seizedAssets ?? "0"); const repaidShares = String(args.repaidShares ?? "0");
          if ((seizedAssets !== "0") === (repaidShares !== "0")) return { ok: false, reason: "provide EXACTLY ONE of seizedAssets or repaidShares (base units, sized to the loanToken you hold); the other stays 0" };
          try {
            const p = { loanToken: getAddress(String(args.loanToken).toLowerCase()), collateralToken: getAddress(String(args.collateralToken).toLowerCase()), oracle: getAddress(String(args.oracle).toLowerCase()), irm: getAddress(String(args.irm).toLowerCase()), lltv: String(args.lltv), borrower: getAddress(String(args.borrower).toLowerCase()), seizedAssets, repaidShares };
            const argsArr = buildLiquidateArgs(p);
            const label = String(args.label ?? "").trim() || `liq:${p.borrower.slice(0, 8)}`;
            const sim = await this.primitives.callContract(this.config.MORPHO_CORE as Address, LIQUIDATE_SIG, argsArr, 0n, false);
            const id = await this.db.armAutoflash({ label, marketId: String(args.marketId ?? ""), borrower: p.borrower, target: this.config.MORPHO_CORE as Address, signature: LIQUIDATE_SIG, args: argsArr, note: String(args.note ?? ""), cycle });
            const ready = sim.ok && sim.mode === "simulated";
            return { ok: true, id, label, armed: true, status: ready ? "position is liquidatable NOW — will fire within seconds" : `armed and watching. Currently NOT firable (${!sim.ok && "reason" in sim ? sim.reason.slice(0, 120) : "healthy"}). It fires the instant it crosses hf<1 AND you hold enough ${p.loanToken.slice(0, 8)}… with Morpho approved. Ensure both, or it will never fire.` };
          } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "arm_autoflash failed" }; }
        }
        case "arm_watcher": {
          const signature = String(args.signature ?? "").trim();
          if (!args.target || !signature) return { ok: false, reason: "target and signature are required" };
          const target = getAddress(String(args.target).toLowerCase());
          const callArgs = coerceArgArray(args.args);
          const label = String(args.label ?? "").trim() || `watch:${signature.split("(")[0]}`;
          try {
            const sim = await this.primitives.callContract(target, signature, callArgs, 0n, false);
            const id = await this.db.armAutoflash({ label, marketId: "", borrower: "", target, signature, args: callArgs, note: String(args.note ?? ""), cycle });
            const ready = sim.ok && sim.mode === "simulated";
            return { ok: true, id, label, status: ready ? "condition already met — will fire within seconds" : `armed. Fires the INSTANT this call's simulation passes. Encode your condition IN the call (e.g. a swap whose amountOutMinimum only succeeds at your target price). Currently: ${!sim.ok && "reason" in sim ? sim.reason.slice(0, 110) : "not yet"}. Manage with list_autoflash / kill_autoflash.` };
          } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "arm_watcher failed" }; }
        }
        case "list_autoflash": return { watchers: await this.db.listAutoflash() };
        case "arb": {
          const snap = await this.db.latestMarketSnapshot<Record<string, unknown>>("arb", "recent").catch(() => undefined);
          return snap ?? { note: "arb engine warming up; no verified cycles yet", candidates: [], watchlist: [] };
        }
        case "liquidations": {
          const [f, tiers, watch, profitable] = await Promise.all([
            this.monadSignals.fetch().catch(() => undefined),
            this.db.lendingTierCounts(this.config.CHAIN_ID).catch(() => ({})),
            this.db.listLendingPositions(this.config.CHAIN_ID, { tier: "watch", limit: 30 }).catch(() => []),
            this.db.listLendingPositions(this.config.CHAIN_ID, { tier: "profitable", limit: 20 }).catch(() => [])
          ]);
          return {
            note: f?.note ?? "feed via registry",
            registry: { tiers, note: "Complete position registry (old+new), tiered + adaptively polled. watch=near threshold (armed), profitable=healthy but would profit, low_collateral=exit≤debt, blacklist=scam collateral.", watch, profitable },
            liquidatableNow: f?.liquidatableNow ?? [], onTheEdge: f?.onTheEdge ?? [], skipped: f?.skipped ?? [],
            watchers: await this.db.listAutoflash(["armed", "fired"]).catch(() => [])
          };
        }
        case "kill_autoflash": {
          const id = Number(args.id); if (!Number.isInteger(id)) return { ok: false, reason: "need the numeric watcher id" };
          return { ok: await this.db.killAutoflash(id), killed: id };
        }
        case "blacklist": {
          const action = String(args.action ?? "list");
          if (action === "list") return { blacklist: await this.db.listBlacklist() };
          const scope = args.scope === "token" ? "token" : "symbol";
          const value = String(args.value ?? "").trim();
          if (!value) return { ok: false, reason: "need value: a token address (scope=token) or a symbol substring like 'TEST' (scope=symbol)" };
          if (action === "remove") return { ok: await this.db.removeBlacklist(scope, value), removed: { scope, value } };
          if (action === "add") {
            const tier = args.tier === "secondary" ? "secondary" : "exclude";
            await this.db.addBlacklist({ scope, value, tier, source: "scarlet", reason: String(args.reason ?? "") });
            return { ok: true, added: { scope, value, tier }, note: tier === "exclude" ? "hidden from your feed" : "demoted to secondary (occasional-check) bucket" };
          }
          return { ok: false, reason: "action must be add | remove | list" };
        }
        case "registry": {
          const action = String(args.action ?? "inspect");
          const chainId = this.config.CHAIN_ID;
          if (action === "list") return { chainId, entities: await this.db.listEntities(chainId, { kind: args.kind ? String(args.kind) : undefined }) };
          const address = getAddress(String(args.address ?? "").toLowerCase());
          if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return { ok: false, reason: "need a valid address" };
          if (action === "inspect" || action === "add") {
            const resolved = await this.resolver.resolve(address);              // DETERMINISTIC: contract + realtime market data
            const known = await this.db.getEntity(chainId, address);
            if (action === "add") {
              const kind = String(args.kind ?? resolved.kind);
              await this.db.upsertEntity({ chainId, address, kind, symbol: resolved.symbol, name: resolved.name ?? resolved.gtName, decimals: resolved.decimals, meta: { priceUsd: resolved.priceUsd, volume24hUsd: resolved.volume24hUsd, liquidityUsd: resolved.liquidityUsd, verifiedBytecode: resolved.verifiedBytecode, topPool: resolved.topPool }, source: "scarlet" });
              if (args.note != null) await this.db.setEntityNote(chainId, address, kind, String(args.note));
              return { ok: true, registered: { address, kind, symbol: resolved.symbol }, resolved, note: "added to your chain registry — deterministic data is system-set; your note is saved" };
            }
            return { resolved, registered: known.length ? known : null, hint: "call registry(action:'add', kind, note) to keep it; blacklist to hide it. You cannot change the deterministic data, only your note." };
          }
          if (action === "blacklist") {
            const kind = String(args.kind ?? "token");
            await this.db.setEntityStatus(chainId, address, kind, "blacklist");
            await this.db.addBlacklist({ scope: "token", value: address, tier: "exclude", source: "scarlet", reason: String(args.note ?? "") });
            return { ok: true, blacklisted: address };
          }
          if (action === "note") {
            const kind = String(args.kind ?? "token");
            const ok = await this.db.setEntityNote(chainId, address, kind, String(args.note ?? ""));
            return { ok, note: ok ? "note updated" : "entity not in registry — add it first" };
          }
          return { ok: false, reason: "action must be inspect | add | note | blacklist | list" };
        }
        case "follow": {
          const chainId = this.config.CHAIN_ID;
          const action = String(args.action ?? "list");
          if (action === "list") return { follows: await this.db.activeFollows(chainId), recentActivity: await this.db.recentFollowActivity(chainId, 120) };
          const wallet = String(args.wallet ?? "").toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(wallet)) return { ok: false, reason: "need a valid wallet address" };
          if (action === "history") return { wallet, moves: await this.db.followMoves(chainId, wallet, Math.min(Number(args.limit ?? 20), 50), args.before ? BigInt(String(args.before)) : undefined) };
          if (action === "remove") return { ok: await this.db.removeFollow(chainId, wallet), removed: wallet };
          if (action === "note") return { ok: await this.db.noteFollow(chainId, wallet, String(args.note ?? "")), note: "updated" };
          if (action === "add") {
            const code = await this.chain.tools.getCode({ address: getAddress(wallet) }).catch(() => undefined);
            if (code && code !== "0x") return { ok: false, reason: "that address is a CONTRACT (dapp/token/pool), not a smart-money wallet — follow EOA trader wallets only" };
            if (!args.note) return { ok: false, reason: "a note is required: why is this wallet worth following?" };
            await this.db.addFollow(chainId, wallet, String(args.note));
            return { ok: true, following: wallet, note: "the system now tracks this wallet automatically and will notify you when it moves — you don't have to remember it. Navigate its history with follow(action:'history')." };
          }
          return { ok: false, reason: "action must be add | remove | note | list | history" };
        }
        case "position": {
          const chainId = this.config.CHAIN_ID;
          const action = String(args.action ?? "list");
          if (action === "list") return { plans: await this.db.activePositionPlans(chainId) };
          if (action === "status") { const p = await this.db.getPositionPlan(Number(args.id)); return p ?? { ok: false, reason: "no such plan" }; }
          if (action === "cancel") { await this.db.updatePositionPlan(Number(args.id), { status: "cancelled" }); return { ok: true, cancelled: Number(args.id) }; }
          if (action === "plan") {
            const token = String(args.token ?? "").toLowerCase();
            if (!/^0x[0-9a-f]{40}$/.test(token)) return { ok: false, reason: "need the token address to buy" };
            const amountUsd = Number(args.amountUsd);
            if (!(amountUsd > 0)) return { ok: false, reason: "need amountUsd (how much to spend on entry)" };
            if (!args.note) return { ok: false, reason: "a note (your thesis + plan) is required" };
            const entryKind = args.entryKind === "limit" ? "limit" : "now";
            if (entryKind === "limit" && !(Number(args.entryPrice) > 0)) return { ok: false, reason: "a 'limit' entry needs entryPrice (USD per token); plan only realistic, near-future triggers" };
            const baseToken = (args.baseToken ? String(args.baseToken) : this.config.WBERA_ADDRESS).toLowerCase();
            const resolved = await this.resolver.resolve(getAddress(token)).catch(() => null);
            const partials = coerceArgArray(args.partials).filter((x): x is { atPct: number; sellPct: number } => typeof x === "object" && x !== null && "atPct" in x && "sellPct" in x);
            const id = await this.db.createPositionPlan({ chainId, token, symbol: resolved?.symbol ?? null, baseToken, entryKind, entryPrice: entryKind === "limit" ? Number(args.entryPrice) : null, entryAmountUsd: amountUsd, stopLossPct: args.stopLossPct != null ? Number(args.stopLossPct) : null, takeProfitPct: args.takeProfitPct != null ? Number(args.takeProfitPct) : null, partials, note: String(args.note) });
            return { ok: true, planId: id, note: `Position #${id} planned. The system will ${entryKind === "now" ? "enter now" : `enter when price ≤ $${args.entryPrice}`} and then auto-manage stop-loss/take-profit/partials — you don't need to watch it. You'll be notified on each fill/exit.` };
          }
          return { ok: false, reason: "action must be plan | list | status | cancel" };
        }
        case "get_wallet_state": {
          const loss = await this.db.dailyLossUsd();
          return this.positions.reconcile(await this.chain.portfolio(loss, this.health.dataHealthy));
        }
        case "verify_contract_code": {
          const address = getAddress(String(args.address).toLowerCase());
          const code = await this.chain.tools.getCode({ address });
          return { address, deployed: Boolean(code && code !== "0x"), bytecodeLength: code ? (code.length - 2) / 2 : 0 };
        }
        default: return { error: `Unknown tool: ${name}` };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : "tool invocation failed" };
    }
  }

  private decimalsFor(address: string): number {
    const a = address.toLowerCase();
    if (a === this.config.USDC_E_ADDRESS.toLowerCase()) return 6;
    if (a === this.config.HONEY_ADDRESS.toLowerCase()) return this.config.HONEY_DECIMALS;
    return 18; // WETH and most tokens
  }
}

/** Read + action tool surface. Actions default to simulate (execute=false). */
const actionExecuteProp = { execute: { type: "boolean", description: "false (default) simulates on-chain without sending; true signs and broadcasts, only permitted when execution is enabled." } };
const scarletTools: ChatCompletionTool[] = [
  { type: "function", function: { name: "note", description: "Publish a short plain-language note to the human dashboard explaining what you are about to do and why. Call this BEFORE every action (wrap/approve/swap/lend/redeem) and whenever a decision is worth narrating.", parameters: { type: "object", additionalProperties: false, properties: { text: { type: "string", description: "One or two sentences a non-technical human can understand." } }, required: ["text"] } } },
  { type: "function", function: { name: "get_wallet_state", description: "Real on-chain wallet balances, positions and NAV. Read only.", parameters: { type: "object", additionalProperties: false, properties: {}, required: [] } } },
  { type: "function", function: { name: "verify_contract_code", description: "Check an address has deployed bytecode on current mainnet.", parameters: { type: "object", additionalProperties: false, properties: { address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" } }, required: ["address"] } } },
  { type: "function", function: { name: "list_venues", description: "List the profit-surface registry: the DEXes, lending cores and vaults you can operate, each with its standard type. The sensorium reads every enabled venue for you.", parameters: { type: "object", additionalProperties: false, properties: {}, required: [] } } },
  { type: "function", function: { name: "add_venue", description: "Add a profit surface you discovered to the registry so it gets scanned. Give a short id, its standard type (uni-v3, uni-v2, balancer, morpho, dolomite, erc4626, reward-vault), and the factory/core/vault address.", parameters: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, name: { type: "string" }, type: { type: "string" }, address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, meta: { type: "object" } }, required: ["id", "type", "address"] } } },
  { type: "function", function: { name: "remove_venue", description: "Disable a venue that is dead or invalid, so it is no longer scanned.", parameters: { type: "object", additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"] } } },
  { type: "function", function: { name: "open_position", description: "Track a position you just opened, WITH your thesis note (why you opened it — kept for the future so you remember your reasoning). Entry value and live value are ALWAYS read on-chain — you cannot set a value, only the label and note. kind 'token' = a wallet-held token (snipe/swap/seized collateral), needs `token`. kind 'erc4626' = a vault, needs `vault`+`asset`. The position then travels in every briefing with entry/current/P&L until you close it.", parameters: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: ["token", "erc4626"] }, token: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, vault: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, asset: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, label: { type: "string", description: "a short unique handle, e.g. 'snipe:XYZ' or 'liq:wstETH'" }, note: { type: "string", description: "your thesis: WHY you opened it and your plan/exit" } }, required: ["kind", "label", "note"] } } },
  { type: "function", function: { name: "annotate_position", description: "Update the thesis NOTE of an open position (your reasoning as it evolves). Only the note changes; all values stay on-chain-reconciled.", parameters: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, label: { type: "string" }, note: { type: "string" } }, required: ["note"] } } },
  { type: "function", function: { name: "close_position", description: "Close a position in your ledger (mark it exited). This does NOT move funds — first exit on-chain (swap/redeem), then close the ledger entry. Reference it by id or label.", parameters: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, label: { type: "string" } } } } },
  { type: "function", function: { name: "recall_cycle", description: "Retrieve the FULL uncompacted transcript (every thought/note/action) of a past cycle by its id, from your history. Use it when your compacted summary references a cycle and you need the exact details.", parameters: { type: "object", additionalProperties: false, properties: { cycle: { type: "string", description: "the cycle id, e.g. '3ce11a1f'" } }, required: ["cycle"] } } },
  { type: "function", function: { name: "market_data", description: "One faculty for off-chain market/discovery data (free sources). kind='yields' → every pool by TVL/APY (yield/lending surface); kind='new_pools' → freshly created pools (new-token discovery — check_token before buying!); kind='trending' → pools with momentum; kind='token' → a token's price/volume/liquidity (needs `token`); kind='ohlcv' → price candles for a pool (needs `pool`, optional `timeframe` day|hour|minute). Use it to SEE the chain beyond what you read on-chain.", parameters: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: ["yields", "new_pools", "trending", "token", "ohlcv"] }, token: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, pool: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, timeframe: { type: "string", enum: ["day", "hour", "minute"] }, limit: { type: "number" } }, required: ["kind"] } } },
  { type: "function", function: { name: "arm_autoflash", description: "Arm an AUTO-FLASH liquidation on an on-the-edge Morpho position. A background watcher simulates it every few seconds and fires the REAL liquidation the instant the position crosses hf<1 (and your funds are ready), then wakes you with the result. Pass the marketParams + borrower straight from signals.onTheEdge[] and EXACTLY ONE of seizedAssets/repaidShares sized to the loanToken you hold. PRECONDITION: hold enough loanToken and approve Morpho first, or it can never fire. Use it to capture a liquidation without watching every block yourself.", parameters: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, marketId: { type: "string" }, loanToken: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, collateralToken: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, oracle: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, irm: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, lltv: { type: "string" }, borrower: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, seizedAssets: { type: "string", description: "collateral base units to seize (0 if using repaidShares)" }, repaidShares: { type: "string", description: "debt shares to repay (0 if using seizedAssets)" }, note: { type: "string", description: "your thesis for this auto-flash" } }, required: ["loanToken", "collateralToken", "oracle", "irm", "lltv", "borrower"] } } },
  { type: "function", function: { name: "arm_watcher", description: "GENERAL conditional executor (the auto-flash pattern for ANY action): arm a call_contract that a background watcher fires the INSTANT its on-chain simulation passes. Encode the condition IN the call — e.g. a swap whose amountOutMinimum only succeeds at your target price (fires when price crosses), a buy that only succeeds once liquidity exists (snipe), an arb leg that only nets positive above the fee. The watcher simulates every few seconds and executes on pass, then wakes you. This is your reactive fast-layer; use it so you don't have to watch every block. Manage with list_autoflash / kill_autoflash.", parameters: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, target: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, signature: { type: "string", description: "Solidity function signature of the action, e.g. 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'" }, args: { type: "array", items: {}, description: "the call args, encoding your trigger condition (e.g. amountOutMinimum)" }, note: { type: "string" } }, required: ["target", "signature"] } } },
  { type: "function", function: { name: "list_autoflash", description: "List your watchers (auto-flash liquidations AND general arm_watcher conditionals) with status and result.", parameters: { type: "object", additionalProperties: false, properties: {}, required: [] } } },
  { type: "function", function: { name: "arb", description: "Retrieve the ARBITRAGE surface the system tracks FOR you: `candidates` = cross-venue/triangular cycles verified profitable at the slippage floor + real atomic gas (usually empty — the market is efficient), and `watchlist` = the tokens under exam (from the registry) with their price on EACH pool/venue + the spread, so you can SEE where prices diverge. Read it whenever you want the live picture; the system already hunts and would notify you of a real cycle.", parameters: { type: "object", additionalProperties: false, properties: {}, required: [] } } },
  { type: "function", function: { name: "liquidations", description: "Retrieve the LIQUIDATION surface: `liquidatableNow` = profitable prey (collateral > debt, exit-verified), `onTheEdge` = near the threshold (the system auto-arms a flash-kill on these), and `skipped` = positions the system sees but WON'T fire, each with the REASON (bad debt / no DEX exit / PT-locked). Plus your armed/fired watchers. Read it whenever you want the picture; the system auto-arms the edge and notifies you on a fire.", parameters: { type: "object", additionalProperties: false, properties: {}, required: [] } } },
  { type: "function", function: { name: "kill_autoflash", description: "Disarm an armed auto-flash watcher by its numeric id (to modify one, kill it and arm a new one).", parameters: { type: "object", additionalProperties: false, properties: { id: { type: "number" } }, required: ["id"] } } },
  { type: "function", function: { name: "follow", description: "Manage the smart-money wallets YOU choose to follow. YOU pick them (from flow/whales, or any wallet you judge sharp); the SYSTEM then tracks them automatically — you never have to remember to check. It logs their token moves and NOTIFIES you (debounced, no spam) when a followed wallet moves. action='add' (wallet, note=why it's sharp) — must be an EOA wallet, not a contract. action='remove'. action='note' (update your memory of it). action='list' (your follows + recent activity). action='history' (wallet, limit, before=block) to navigate its past moves, newest first. Use this to study and shadow real winners over time.", parameters: { type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["add", "remove", "note", "list", "history"] }, wallet: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, note: { type: "string" }, limit: { type: "number" }, before: { type: "string", description: "block number to page older than" } }, required: ["action"] } } },
  { type: "function", function: { name: "position", description: "PROGRAM a position so the SYSTEM executes it — you never miss an entry or exit while you think slowly between cycles. action='plan': buy `amountUsd` of `token` either entryKind='now' or entryKind='limit' at `entryPrice` (USD/token), and set exit rules the system enforces automatically: stopLossPct, takeProfitPct, and partials=[{atPct,sellPct}] (e.g. sell 50% at +30%). Give a `note` (thesis+plan). The system fills the entry, then auto-fires stop-loss/take-profit/partials on the LIVE executable price, and notifies you on every fill/exit. ONLY plan realistic, near-future triggers (a limit far from price just idles). action='list'/'status'(id)/'cancel'(id). This is how you stop losing on missed exits.", parameters: { type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["plan", "list", "status", "cancel"] }, token: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, baseToken: { type: "string", description: "what you pay with (default WETH)" }, entryKind: { type: "string", enum: ["now", "limit"] }, entryPrice: { type: "number", description: "USD per token, for a limit entry" }, amountUsd: { type: "number" }, stopLossPct: { type: "number" }, takeProfitPct: { type: "number" }, partials: { type: "array", items: { type: "object", properties: { atPct: { type: "number" }, sellPct: { type: "number" } } } }, note: { type: "string" }, id: { type: "number" } }, required: ["action"] } } },
  { type: "function", function: { name: "registry", description: "Your KNOWLEDGE BASE, keyed by address. You work with an ADDRESS; the system resolves everything deterministically (reads the contract + realtime market data) — you never guess or edit those facts. action='inspect' (address) → the complete object (symbol/name/decimals, verified bytecode, realtime price/volume/liquidity, top pool) + whether it's already known. action='add' (address, kind token|dex|dapp|wallet|bot, note) → keep it in your chain registry with YOUR utility note (why it matters). action='note' → update your note. action='blacklist' → hide it. action='list' (optional kind) → everything you know on this chain. Build and curate this so you stop re-discovering the same things.", parameters: { type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["inspect", "add", "note", "blacklist", "list"] }, address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, kind: { type: "string", enum: ["token", "dex", "dapp", "wallet", "bot"] }, note: { type: "string", description: "your utility note (required when adding — say WHY it matters)" } }, required: ["action"] } } },
  { type: "function", function: { name: "blacklist", description: "Curate your OWN signal quality. When a market/token in your feed turns out to be a test/synthetic/junk market (e.g. no real DEX exit, fake TVL, a scam), blacklist it so it stops wasting your attention: action='add' with scope='symbol' (a substring like 'TEST' matches every symbol containing it) or scope='token' (an exact address); tier='exclude' hides it entirely, tier='secondary' demotes it to the occasional-check bucket. action='remove' to reverse, action='list' to review. Your feed is where opportunities are born — keep it REAL.", parameters: { type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["add", "remove", "list"] }, scope: { type: "string", enum: ["symbol", "token"] }, value: { type: "string", description: "symbol substring (e.g. 'TEST') or token address" }, tier: { type: "string", enum: ["exclude", "secondary"], description: "exclude=hide, secondary=demote (default exclude)" }, reason: { type: "string" } }, required: ["action"] } } },
  { type: "function", function: { name: "read_contract", description: "Examine ANY contract on Base: call one of its read-only (view/pure) functions and get the decoded result. Use this to investigate protocols, reserves, rates, oracle prices, your positions, incentives, borrow costs and liquidation thresholds before deciding — this is how you discover real on-chain opportunities yourself. TIP: resolve_abi first to get exact function signatures instead of guessing.", parameters: { type: "object", additionalProperties: false, properties: { address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, signature: { type: "string", description: "Solidity function signature, e.g. 'balanceOf(address) view returns (uint256)' or 'getReserves() view returns (uint112,uint112,uint32)'" }, args: { type: "array", items: {}, description: "arguments in order (addresses, numbers as strings)" } }, required: ["address", "signature"] } } },
  { type: "function", function: { name: "resolve_abi", description: "Fetch a contract's VERIFIED ABI (function signatures) from the block explorer, so you can call read_contract/call_contract with exact signatures instead of brute-forcing. Also tells you if the contract is unverified (a risk signal). Do this before probing any unfamiliar protocol.", parameters: { type: "object", additionalProperties: false, properties: { address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" } }, required: ["address"] } } },
  { type: "function", function: { name: "contract_meta", description: "Verification status, contract name, and proxy/implementation of a contract. Use it as an anti-scam signal (unverified = red flag) and to resolve a proxy to its implementation (then resolve_abi on the implementation).", parameters: { type: "object", additionalProperties: false, properties: { address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" } }, required: ["address"] } } },
  { type: "function", function: { name: "call_contract", description: "TOTAL POWER: write to ANY contract on Base — call a state-changing function on any protocol (deposit, borrow, stake, mint, provide liquidity, liquidate, swap on a router, anything), without needing a pre-built adapter. It is always simulated first; if the simulation reverts it is NOT sent. Set execute=true to broadcast for real. Approve tokens first with approve_exact if the call pulls an ERC-20. This is how you swap (Uniswap V3 SwapRouter exactInputSingle) and operate the whole chain, not just the built-in actions.", parameters: { type: "object", additionalProperties: false, properties: { address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, signature: { type: "string", description: "Solidity function signature, e.g. 'deposit(uint256,address)' or 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'" }, args: { type: "array", items: {}, description: "arguments in order (addresses; numbers as strings in base units)" }, valueBera: { type: "string", description: "native ETH to send with the call, decimal (default 0)" }, ...actionExecuteProp }, required: ["address", "signature"] } } },
  { type: "function", function: { name: "deploy_contract", description: "Deploy a contract you have the creation bytecode for — build your own atomic executors, bundlers, liquidation routers (Morpho 0%-fee flash-loan liquidators). Always simulated first (estimateGas); execute=true broadcasts. Deploying costs only gas.", parameters: { type: "object", additionalProperties: false, properties: { bytecode: { type: "string", description: "0x creation bytecode (with constructor args appended)" }, valueBera: { type: "string" }, ...actionExecuteProp }, required: ["bytecode"] } } },
  { type: "function", function: { name: "deploy_organ", description: "Deploy your ATOMIC ORGAN (AtomicExecutor) — a zero-custody, owner-only engine that runs an atomic call-batch funded by a Morpho 0%-fee flash loan and reverts unless it nets >= minProfit. Deploy it ONCE (it costs only gas); then drive it with flash_liquidate / flash_execute. This is what makes your $58 irrelevant for atomic ops (arb, liquidations) — you operate at flash-loan scale. Its address then appears in your briefing as `organ`.", parameters: { type: "object", additionalProperties: false, properties: { ...actionExecuteProp }, required: [] } } },
  { type: "function", function: { name: "flash_liquidate", description: "CAPITAL-FREE liquidation via your organ: flash-loans the loan token, liquidates the position, swaps the seized collateral back to loan token, repays, and keeps the bonus — all atomic. It SIMULATES the whole flow first and only fires if it nets >= minProfit, so it can't lose (only gas on a revert). Use it on a signals liquidatableNow/onTheEdge position with collateralClass='liquid'. Pass marketParams+borrower from the signal; size seizedAssets (collateral base units to seize) and flashAmount (loan-token base units to borrow, >= the repay). deploy_organ first.", parameters: { type: "object", additionalProperties: false, properties: { organ: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, loanToken: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, collateralToken: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, oracle: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, irm: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, lltv: { type: "string" }, borrower: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, seizedAssets: { type: "string", description: "collateral base units to seize" }, flashAmount: { type: "string", description: "loan-token base units to flash-borrow (>= the repay)" }, swapFeeBps: { type: "number", description: "V3 fee tier for the collateral→loanToken swap (default 3000)" }, minProfit: { type: "string", description: "minimum loan-token profit in base units (default 0)" }, ...actionExecuteProp }, required: ["organ", "loanToken", "collateralToken", "oracle", "irm", "lltv", "borrower", "seizedAssets", "flashAmount"] } } },
  { type: "function", function: { name: "flash_execute", description: "GENERIC atomic flash-loan strategy via your organ: flash-loan `amount` of loanToken, run your `calls` batch (each {target,value,data}), repay, keep >= minProfit or revert. Use it for atomic cross-venue ARB (swap A→B on DEX1, B→A on DEX2) or any composed atomic op. Simulated first — fires only if profitable. Build each call's `data` with the exact function calldata (resolve_abi helps).", parameters: { type: "object", additionalProperties: false, properties: { organ: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, loanToken: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, amount: { type: "string", description: "loan-token base units to flash-borrow" }, minProfit: { type: "string", description: "min loan-token profit base units (default 0)" }, calls: { type: "array", items: { type: "object", properties: { target: { type: "string" }, value: { type: "string" }, data: { type: "string" } } }, description: "the atomic call batch" }, ...actionExecuteProp }, required: ["organ", "loanToken", "amount", "calls"] } } },
  { type: "function", function: { name: "check_token", description: "SURVIVAL GATE before buying any token: confirms it has a wrapped-native (WMON) pool with liquidity and — above all — that it can be SOLD BACK (honeypot/sell-tax detection) via on-chain quotes on the DEEPEST pool. Never buy a token that does not pass this. Note: a 'no pool' result may just mean it trades on venues you can't read (Uniswap V4, Kuru, Curve) — check the 0x aggregator before dismissing it.", parameters: { type: "object", additionalProperties: false, properties: { token: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" } }, required: ["token"] } } },
  { type: "function", function: { name: "watch_wallet", description: "Spy on another wallet: list the tokens it moved recently (Transfer events). Mirror smart-money's good ideas, then operate yourself.", parameters: { type: "object", additionalProperties: false, properties: { wallet: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, blocks: { type: "number" } }, required: ["wallet"] } } },
  { type: "function", function: { name: "get_logs", description: "Examine on-chain events from a contract. Defaults to the most recent 100 blocks (the RPC window) ending at the current head; omit fromBlock/toBlock for 'right now'. Wider ranges auto-clamp to 100 and return a paging hint. The response includes chainHead. Use it for live activity, not for enumerating full history (the system already hands you Morpho markets + liquidatable positions in the briefing).", parameters: { type: "object", additionalProperties: false, properties: { address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, fromBlock: { type: "string" }, toBlock: { type: "string" } }, required: ["address"] } } },
  { type: "function", function: { name: "remember", description: "Save or update a durable note in your notebook under a KEY (overwrites if the key exists). Use it for tokens, addresses, rates, routes, theses, protocol quirks — anything you want to find again. Your notebook's index (keys + categories) is always in your briefing; open a note's full content with recall.", parameters: { type: "object", additionalProperties: false, properties: { key: { type: "string", description: "a short unique handle, e.g. 'token:HONEY' or 'idea:arb-wbera-honey' or 'route:bend-8pct'" }, content: { type: "string", description: "the note itself" }, category: { type: "string", description: "one of: token, address, route, idea, protocol, thesis, note" }, tags: { type: "array", items: { type: "string" } } }, required: ["key", "content"] } } },
  { type: "function", function: { name: "recall", description: "Read from your notebook. Give a key to open one note's full content, or a category/search term to list matching notes. Use this to retrieve tokens, ideas, routes and theses you saved before.", parameters: { type: "object", additionalProperties: false, properties: { key: { type: "string" }, category: { type: "string" }, search: { type: "string" } } } } },
  { type: "function", function: { name: "forget", description: "Delete a note from your notebook by its key (use when a thesis is falsified or a note is stale).", parameters: { type: "object", additionalProperties: false, properties: { key: { type: "string" } }, required: ["key"] } } },
  { type: "function", function: { name: "swap", description: "Swap tokenIn→tokenOut on Uniswap V3 in ONE call: it auto-picks the best fee tier, sets amountOutMinimum from the live quote and your slippage, approves the router, and executes. This is your one-call hand for sniping (WMON→newToken), rotating idle capital (WMON→USDC to stop MON drift), and taking profit. Simulate first (execute=false) to see expectedOut/minOut. tokenIn is usually WMON or USDC (wrap MON→WMON first if needed).", parameters: { type: "object", additionalProperties: false, properties: { tokenIn: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, tokenOut: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }, amountIn: { type: "string", description: "human decimal amount of tokenIn" }, maxSlippagePct: { type: "string", description: "e.g. '1' for 1% (default 1)" }, ...actionExecuteProp }, required: ["tokenIn", "tokenOut", "amountIn"] } } },
  { type: "function", function: { name: "wrap", description: "Wrap native MON into WMON (needed before swapping/LPing on DEXes).", parameters: { type: "object", additionalProperties: false, properties: { amountBera: { type: "string", description: "human decimal amount of native MON to wrap" }, ...actionExecuteProp }, required: ["amountBera"] } } },
  { type: "function", function: { name: "unwrap", description: "Unwrap WMON back into native MON.", parameters: { type: "object", additionalProperties: false, properties: { amountWbera: { type: "string", description: "human decimal amount of WMON to unwrap" }, ...actionExecuteProp }, required: ["amountWbera"] } } },
  { type: "function", function: { name: "approve_exact", description: "Set an exact finite ERC-20 allowance for a verified spender (never unlimited).", parameters: { type: "object", additionalProperties: false, properties: { token: { type: "string" }, spender: { type: "string" }, amount: { type: "string" }, ...actionExecuteProp }, required: ["token", "spender", "amount"] } } },
  { type: "function", function: { name: "lend", description: "Deposit assets into a dual-RPC-verified ERC-4626 vault.", parameters: { type: "object", additionalProperties: false, properties: { vault: { type: "string" }, asset: { type: "string" }, assets: { type: "string" }, ...actionExecuteProp }, required: ["vault", "asset", "assets"] } } },
  { type: "function", function: { name: "redeem", description: "Withdraw assets from a dual-RPC-verified ERC-4626 vault.", parameters: { type: "object", additionalProperties: false, properties: { vault: { type: "string" }, asset: { type: "string" }, assets: { type: "string" }, ...actionExecuteProp }, required: ["vault", "asset", "assets"] } } }
];

const ACTION_TOOLS = new Set(["swap", "wrap", "unwrap", "approve_exact", "lend", "redeem", "call_contract", "deploy_contract", "deploy_organ", "flash_liquidate", "flash_execute", "position", "follow"]);

/** Strips M3's <think> wrapper so the journal shows readable reasoning. */
function cleanThought(content: string | null | undefined): string {
  if (!content) return "";
  const inner = content.match(/<think>([\s\S]*?)<\/think>/i)?.[1];
  const rest = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return [inner?.trim(), rest].filter(Boolean).join("\n\n").trim().slice(0, 4_000);
}

/** Human-readable one-line summary of an action she took. */
/** MiniMax sometimes serializes an ARRAY tool-arg as a (occasionally truncated) JSON STRING —
 * e.g. args: "[\"0x..\"" instead of ["0x.."]. Left unhandled it becomes an empty list and every
 * call fails with "ABI encoding length mismatch". This recovers arrays, JSON-string arrays, and
 * unclosed/one-sided ones, so Scarlet's call_contract / flash_execute / arm_watcher actually work. */
function coerceArgArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  const s = v.trim();
  if (!s) return [];
  for (const cand of [s, s + "]", "[" + s + "]", s + '"]']) {
    try { const p = JSON.parse(cand); if (Array.isArray(p)) return p; } catch { /* try next repair */ }
  }
  return [];
}

function actionSummary(name: string, rawArgs: string, result: unknown): string {
  let a: Record<string, unknown> = {};
  try { a = rawArgs ? JSON.parse(rawArgs) : {}; } catch { /* ignore */ }
  const r = result as { ok?: boolean; mode?: string; txHash?: string; reason?: string; detail?: Record<string, unknown> };
  const did = a.execute === true ? "EXECUTE" : "simulate";
  const head = name === "swap" ? `${did} swap ${a.amountIn} of ${short(a.tokenIn)} → ${short(a.tokenOut)}`
    : name === "wrap" ? `${did} wrap ${a.amountBera} BERA → WBERA`
    : name === "unwrap" ? `${did} unwrap ${a.amountWbera} WBERA → BERA`
    : name === "approve_exact" ? `${did} approve ${a.amount} of ${short(a.token)} to ${short(a.spender)}`
    : name === "lend" ? `${did} lend ${a.assets} of ${short(a.asset)} to vault ${short(a.vault)}`
    : name === "redeem" ? `${did} redeem ${a.assets} from vault ${short(a.vault)}`
    : name === "call_contract" ? `${did} call ${a.signature} on ${short(a.address)}${a.valueBera ? ` (value ${a.valueBera} BERA)` : ""}`
    : name === "deploy_contract" ? `${did} deploy contract (${((String(a.bytecode ?? "").length - 2) / 2)} bytes)`
    : `${did} ${name}`;
  if (r?.ok === false) return `${head} — FAILED: ${(r.reason ?? "").slice(0, 200)}`;
  if (r?.mode === "executed") return `${head} — SENT: ${r.txHash}`;
  if (r?.mode === "simulated") return `${head} — simulated ok${r.detail?.expectedOut ? ` (out ${r.detail.expectedOut})` : ""}`;
  return head;
}

function short(v: unknown): string { const s = String(v ?? ""); return s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s; }

function loadPrompt(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return FALLBACK_PROMPT; }
}

/** Compact a tool argument/result for a single readable log line. */
function compact(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > 500 ? `${text.slice(0, 500)}…` : (text ?? "");
}
