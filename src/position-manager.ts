import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database, PositionPlan } from "./db.js";
import type { Primitives } from "./primitives.js";
import { NATIVE_ETH } from "./aggregator.js";

/**
 * Programmatic position engine. Scarlet PLANS a position (entry now or on a limit price, plus
 * stop-loss / take-profit / partial-sell rules) and the SYSTEM executes it deterministically —
 * so she never misses an entry or exit while she is between slow cognition cycles. Every fill
 * or exit is simulated first (the swap primitive reverts rather than losing), then broadcast,
 * and the result is pushed back to Scarlet immediately via the shared wake.
 *
 * Only realistic, near-future plans should exist — the engine polls prices continuously, so a
 * plan far from reality just idles. Scarlet is told to plan only what can plausibly trigger soon.
 */
const DEC = parseAbi(["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
const MAX_ENTRY_ATTEMPTS = 4; // after this many transient entry failures, block the strategy (status 'error')

export class PositionManager {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly dec = new Map<string, number>();
  private readonly sellFail = new Map<number, number>(); // planId → consecutive transfer-block strikes (honeypot detection)

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly primitives: Primitives,
    private readonly logger: Logger,
    private readonly wake: (key: string, reason: string) => void,
    private readonly isSynced?: () => boolean // pause entries/exits while the indexer realigns (stale data)
  ) {}

  start(intervalMs = 20_000): void {
    this.timer = setInterval(() => void this.tick().catch((error) => this.logger.error({ err: error }, "position manager tick failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async decimals(token: Address): Promise<number> {
    const k = token.toLowerCase();
    if (this.dec.has(k)) return this.dec.get(k)!;
    const d = Number(await this.chain.primary.readContract({ address: token, abi: DEC, functionName: "decimals" }).catch(() => 18));
    this.dec.set(k, d); return d;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    if (this.isSynced && !this.isSynced()) return; // indexer realigning → prices stale → don't fire entries/exits
    this.running = true;
    try {
      const plans = await this.db.activePositionPlans(this.config.CHAIN_ID).catch(() => []);
      for (const p of plans) {
        try {
          if (p.status === "entering" || p.status === "pending-entry") await this.tryEntry(p);
          else if (p.status === "open") await this.manageOpen(p);
        } catch (error) { this.logger.error({ err: error, plan: p.id }, "plan step failed"); }
      }
    } finally {
      this.running = false;
    }
  }

  /** Buy leg: 'now' fills immediately; a 'limit' plan fills once the token price ≤ entryPrice. */
  private async tryEntry(p: PositionPlan): Promise<void> {
    const token = p.token as Address; const base = p.baseToken as Address;
    const baseUsd = await this.chain.tokenPrice(base).catch(() => 0);
    if (!(baseUsd > 0)) return;
    const baseDec = await this.decimals(base);
    const baseAmount = BigInt(Math.floor((p.entryAmountUsd / baseUsd) * 10 ** baseDec));
    if (baseAmount <= 0n) return;
    // BUY with NATIVE ETH (`base` = WETH is used only to price/size). Native input needs no wrap, no ERC20
    // approval and no transferFrom — removing the whole "insufficient WETH / missing approval" failure class.
    const sim = await this.primitives.swapBest(NATIVE_ETH, token, baseAmount, 8, false).catch(() => undefined);
    if (!sim || !sim.ok || sim.mode !== "simulated") { return this.failEntry(p, sim && "reason" in sim ? String(sim.reason) : "non instradabile ora"); }
    const tokenDec = await this.decimals(token);
    const tokenOut = Number(BigInt(String((sim.detail as { expectedOut?: string }).expectedOut ?? "0"))) / 10 ** tokenDec;
    if (!(tokenOut > 0)) return this.failEntry(p, "quote di acquisto nulla");
    const priceNow = p.entryAmountUsd / tokenOut; // USD per token
    if (p.entryKind === "limit" && p.entryPrice != null && priceNow > p.entryPrice) return; // wait for the dip — NOT a failure
    const exec = await this.primitives.swapBest(NATIVE_ETH, token, baseAmount, 8, true).catch((e) => ({ ok: false as const, primitive: "swap", stage: "execute" as const, reason: e instanceof Error ? e.message : String(e) }));
    if (exec.ok && exec.mode === "executed") {
      await this.db.updatePositionPlan(p.id, { status: "open", entryAttempts: 0, filledAmountToken: tokenOut, filledPrice: priceNow, filledAt: new Date().toISOString(), lastResult: `filled ${tokenOut.toFixed(4)} ${p.symbol ?? ""} @ $${priceNow.toPrecision(4)}` });
      await this.db.addJournal("action", `POSITION #${p.id} ENTRY riempita: ${tokenOut.toFixed(4)} ${p.symbol ?? p.token.slice(0, 8)} @ $${priceNow.toPrecision(4)} (${p.entryAmountUsd}$)`, { plan: p.id, tx: (exec as { txHash?: string }).txHash }, "position").catch(() => undefined);
      this.wake(`position:${p.id}`, `Position #${p.id} (${p.symbol ?? "token"}) ENTRY filled @ $${priceNow.toPrecision(4)}. Stop ${p.stopLossPct ?? "—"}% / TP ${p.takeProfitPct ?? "—"}% now armed and auto-managed.`);
    } else {
      await this.failEntry(p, "reason" in exec ? exec.reason : "sconosciuto");
    }
  }

  /** Entry failure → retry on a transient error, but BLOCK (status 'error') on an on-chain revert or after
   * exhausting retries. A blocked strategy stops burning gas and is surfaced to Scarlet to modify/close. */
  private async failEntry(p: PositionPlan, reason: string): Promise<void> {
    const hard = /revert|STF|insufficient|honeypot|non vendibile|transfer/i.test(reason);
    const attempts = (p.entryAttempts ?? 0) + 1;
    if (hard || attempts >= MAX_ENTRY_ATTEMPTS) {
      await this.db.updatePositionPlan(p.id, { status: "error", entryAttempts: attempts, lastResult: `ENTRY BLOCCATA (${hard ? "revert on-chain" : `${attempts} tentativi falliti`}): ${reason.slice(0, 120)}` });
      this.wake(`position-error:${p.id}`, `Strategia #${p.id} (${p.symbol ?? "token"}) BLOCCATA in errore all'ingresso: ${reason.slice(0, 80)}. Modificala (adjust_position) o chiudila (close_position).`);
    } else {
      await this.db.updatePositionPlan(p.id, { entryAttempts: attempts, lastResult: `entry ritenta (${attempts}/${MAX_ENTRY_ATTEMPTS}): ${reason.slice(0, 100)}` });
    }
  }

  /** Sell legs: stop-loss, staged partials, and take-profit — checked against the live exit price. */
  private async manageOpen(p: PositionPlan): Promise<void> {
    if (!p.filledAmountToken || !p.filledPrice) return;
    const token = p.token as Address; const base = p.baseToken as Address;
    const tokenDec = await this.decimals(token);
    // Manual/tool-requested exit (close_position) — sell now via the SAME deterministic path. The request
    // is CLEARED only on a SUCCESSFUL sell (inside sell()), so a transient sim/RPC failure retries next
    // tick instead of silently dropping the close (the bug that made LFI look "stuck" for hours).
    if (p.exitNowPct != null && p.exitNowPct > 0) {
      return this.sell(p, Math.min(100, p.exitNowPct), `CLOSE (manuale) ${Math.min(100, p.exitNowPct)}%`, tokenDec, true);
    }
    const baseUsd = await this.chain.tokenPrice(base).catch(() => 0);
    if (!(baseUsd > 0)) { this.logger.warn({ id: p.id, base }, "manageOpen SKIP: base (WETH) price unavailable"); return; }
    const heldTokens = p.filledAmountToken * (p.remainingPct / 100);
    if (heldTokens <= 0) { await this.db.updatePositionPlan(p.id, { status: "closed" }); return; }
    const heldWei = BigInt(Math.floor(heldTokens * 10 ** tokenDec));
    // Simulate selling the held amount to read the REAL current exit price. Proceeds settle in NATIVE ETH
    // (18 dec, same as WETH) via the cross-venue aggregator — `base` (WETH) is only the pricing numéraire.
    const sim = await this.primitives.swapBest(token, NATIVE_ETH, heldWei, 8, false).catch(() => undefined);
    if (!sim || !sim.ok || sim.mode !== "simulated") { await this.db.updatePositionPlan(p.id, { lastResult: "can't sell right now (no route / honeypot) — watching" }); return; }
    const baseOut = Number(BigInt(String((sim.detail as { expectedOut?: string }).expectedOut ?? "0"))) / 10 ** 18;
    const priceNow = (baseOut * baseUsd) / heldTokens; // USD per token, REALLY executable at her size
    const gainPct = (priceNow / p.filledPrice - 1) * 100;
    // Persist the REAL executable price for this HELD token so the P&L (dashboard + Scarlet's data) shows the
    // TRUTH, not a phantom Lane-A/DefiLlama quote (a thin memecoin can display +85% while its real sellable
    // price is flat — that misled us into thinking a position had risen). Small size, updated each tick.
    if (priceNow > 0 && Number.isFinite(priceNow)) await this.db.upsertTokenPrices(this.config.CHAIN_ID, [{ token: p.token, priceUsd: priceNow, confidence: 0.9, source: "exec" }]).catch(() => undefined);

    // 1) Stop-loss → exit everything.
    if (p.stopLossPct != null && gainPct <= -p.stopLossPct) return this.sell(p, 100, `STOP-LOSS ${gainPct.toFixed(1)}%`, tokenDec);
    // 2) Take-profit → exit everything.
    if (p.takeProfitPct != null && gainPct >= p.takeProfitPct) return this.sell(p, 100, `TAKE-PROFIT +${gainPct.toFixed(1)}%`, tokenDec);
    // 3) Staged partials (each fires once).
    const partials = p.partials ?? [];
    for (let i = 0; i < partials.length; i++) {
      const part = partials[i];
      if (!part.done && gainPct >= part.atPct) {
        await this.sell(p, part.sellPct, `PARTIAL ${part.sellPct}% @ +${gainPct.toFixed(1)}%`, tokenDec);
        partials[i] = { ...part, done: true };
        await this.db.updatePositionPlan(p.id, { partials }); // persist so it fires only once
        return;
      }
    }
  }

  /** Executes a sell of `pct`% of the ORIGINAL filled amount; updates remaining + notifies. When
   * `wasManualExit`, clears the pending exit request ONLY on success so a transient failure retries. */
  private async sell(p: PositionPlan, pct: number, reason: string, tokenDec: number, wasManualExit = false): Promise<void> {
    const token = p.token as Address;
    const sellTokens = (p.filledAmountToken ?? 0) * (pct / 100);
    let sellWei = BigInt(Math.floor(sellTokens * 10 ** tokenDec));
    if (sellWei <= 0n) return;
    // NEVER sell more than we actually HOLD. `filledAmountToken` is the pre-trade SIMULATION; the real
    // received amount is a hair less (execution slippage), so selling the recorded amount reverts the
    // router's transferFrom on insufficient balance (the VIRTUAL case: held 8.77089, tried 8.77101). Cap to
    // the live on-chain balance — and for a full/over-exit sweep exactly what's there.
    const owner = this.config.WALLET_ADDRESS as Address;
    // The sell amount the tx will spend → read on the EXECUTION lane (same node as preflight+send), so the
    // cap matches exactly what that node sees (no cross-node lag). fallback as a resilience net.
    let bal: bigint | null = null;
    for (const client of [this.chain.exec, this.chain.fallback]) {
      try { bal = await client.readContract({ address: token, abi: DEC, functionName: "balanceOf", args: [owner] }) as bigint; break; } catch { /* next lane */ }
    }
    if (bal != null) {
      if (bal <= 0n) { await this.db.updatePositionPlan(p.id, { remainingPct: 0, status: "closed", lastResult: `${reason} — nessun saldo on-chain (già venduto/spostato)`, ...(wasManualExit ? { exitNowPct: null } : {}) }); return; }
      if (sellWei > bal) sellWei = bal; // cap to what we truly hold
    }
    // Sell token → NATIVE ETH via the aggregator (one-time MAX approval to the router handled downstream).
    const exec = await this.primitives.swapBest(token, NATIVE_ETH, sellWei, 10, true).catch((e) => ({ ok: false as const, primitive: "swap", stage: "execute" as const, reason: e instanceof Error ? e.message : String(e) }));
    if (exec.ok && exec.mode === "executed") {
      this.sellFail.delete(p.id); // a real sell went through → clear the honeypot strike counter
      const remaining = Math.max(0, p.remainingPct - pct);
      await this.db.updatePositionPlan(p.id, { remainingPct: remaining, status: remaining <= 0.01 ? "closed" : "open", lastResult: reason, ...(wasManualExit ? { exitNowPct: null } : {}) });
      await this.db.addJournal("action", `POSITION #${p.id} ${reason}: venduto ${pct}% di ${p.symbol ?? p.token.slice(0, 8)} (rimane ${remaining.toFixed(0)}%)`, { plan: p.id, tx: (exec as { txHash?: string }).txHash }, "position").catch(() => undefined);
      this.wake(`position:${p.id}`, `Position #${p.id} (${p.symbol ?? "token"}): ${reason} — sold ${pct}%, ${remaining.toFixed(0)}% left. Review and re-plan if needed.`);
    } else {
      const why = "reason" in exec ? exec.reason : "unknown";
      // An RPC/transport failure is NOT the token's fault → ALWAYS retry (now rare after the TX-cycle
      // unification: preflight/send/receipt on one node, portfolio resilient). Never blacklist on these.
      const rpcish = /rpc request failed|over rate limit|429|too many|timeout|timed out|fetch failed|missing or invalid parameters|internal error|-32603|econnreset|socket/i.test(why);
      // A TOKEN-LEVEL transfer/sell block = HONEYPOT (transfer_from_failed / STF / sell-tax / blacklist / trading
      // disabled). With the TX cycle unified (no approval-visibility race) and sellWei capped to the REAL balance
      // (no VIRTUAL over-sell), a PERSISTENT transfer-block is the token's fault. Confirm over 2 strikes to tolerate
      // a one-off, then block it FOREVER + blacklist → we stop retrying AND never buy it again.
      const transferBlock = !rpcish && /transfer_from_failed|\bstf\b|transfer.?fail|sell.?tax|blacklist|not.?(allowed|whitelist)|cannot.?(sell|transfer)|trading.?(not|disabled)|max.?(tx|wallet)|honeypot/i.test(why);
      const strikes = transferBlock ? (this.sellFail.get(p.id) ?? 0) + 1 : 0;
      if (transferBlock) this.sellFail.set(p.id, strikes); else this.sellFail.delete(p.id);
      if (transferBlock && strikes >= 2) {
        await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: p.token, kind: "token", meta: { sellBlocked: true, honeypot: true, sellBlockReason: why.slice(0, 80), sellBlockedAt: new Date().toISOString() }, source: "sell-fail" }).catch(() => undefined);
        await this.db.addBlacklist({ scope: "token", value: p.token, tier: "exclude", source: "system", reason: `honeypot: ${why.slice(0, 80)}` }).catch(() => undefined);
        await this.db.updatePositionPlan(p.id, { status: "error", exitNowPct: null, lastResult: `VENDITA BLOCCATA (honeypot — transferFrom reverta ${strikes}×): ${why.slice(0, 90)}` });
        this.sellFail.delete(p.id);
        this.wake(`position-error:${p.id}`, `Strategia #${p.id} (${p.symbol ?? "token"}): HONEYPOT — la vendita è bloccata dal token (${why.slice(0, 50)}). Blacklistato: non lo ricompreremo.`);
      } else {
        // First strike / transient (RPC / route) → keep the pending exit and retry next tick (free, idempotent).
        await this.db.updatePositionPlan(p.id, { lastResult: `${reason} — ritenta (${rpcish ? "RPC transitorio" : transferBlock ? `sospetto honeypot ${strikes}/2` : "transitorio"}): ${why.slice(0, 70)}` });
      }
    }
  }

}
