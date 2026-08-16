import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database, PositionPlan } from "./db.js";
import type { Primitives } from "./primitives.js";

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

export class PositionManager {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly dec = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly primitives: Primitives,
    private readonly logger: Logger,
    private readonly wake: (key: string, reason: string) => void
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
    // Simulate the buy to read the executable token price now.
    const sim = await this.primitives.swapV3(base, token, baseAmount, 8, false).catch(() => undefined);
    if (!sim || !sim.ok || sim.mode !== "simulated") { return; } // not routable yet
    const tokenDec = await this.decimals(token);
    const tokenOut = Number(BigInt(String((sim.detail as { expectedOut?: string }).expectedOut ?? "0"))) / 10 ** tokenDec;
    if (!(tokenOut > 0)) return;
    const priceNow = p.entryAmountUsd / tokenOut; // USD per token
    if (p.entryKind === "limit" && p.entryPrice != null && priceNow > p.entryPrice) return; // wait for the dip
    // Ensure we hold enough base (wrap native → WETH if the base is the wrapped-native).
    await this.ensureBase(base, baseAmount).catch(() => undefined);
    const exec = await this.primitives.swapV3(base, token, baseAmount, 8, true).catch((e) => ({ ok: false as const, primitive: "swap", stage: "execute" as const, reason: e instanceof Error ? e.message : String(e) }));
    if (exec.ok && exec.mode === "executed") {
      await this.db.updatePositionPlan(p.id, { status: "open", filledAmountToken: tokenOut, filledPrice: priceNow, filledAt: new Date().toISOString(), lastResult: `filled ${tokenOut.toFixed(4)} ${p.symbol ?? ""} @ $${priceNow.toPrecision(4)}` });
      await this.db.addJournal("action", `POSITION #${p.id} ENTRY riempita: ${tokenOut.toFixed(4)} ${p.symbol ?? p.token.slice(0, 8)} @ $${priceNow.toPrecision(4)} (${p.entryAmountUsd}$)`, { plan: p.id, tx: (exec as { txHash?: string }).txHash }, "position").catch(() => undefined);
      this.wake(`position:${p.id}`, `Position #${p.id} (${p.symbol ?? "token"}) ENTRY filled @ $${priceNow.toPrecision(4)}. Stop ${p.stopLossPct ?? "—"}% / TP ${p.takeProfitPct ?? "—"}% now armed and auto-managed.`);
    } else {
      await this.db.updatePositionPlan(p.id, { lastResult: `entry failed: ${"reason" in exec ? exec.reason.slice(0, 100) : "unknown"}` });
    }
  }

  /** Sell legs: stop-loss, staged partials, and take-profit — checked against the live exit price. */
  private async manageOpen(p: PositionPlan): Promise<void> {
    if (!p.filledAmountToken || !p.filledPrice) return;
    const token = p.token as Address; const base = p.baseToken as Address;
    const tokenDec = await this.decimals(token);
    // Manual/tool-requested exit (close_position) — sell now via the SAME deterministic path, then clear.
    if (p.exitNowPct != null && p.exitNowPct > 0) {
      await this.db.updatePositionPlan(p.id, { exitNowPct: null }).catch(() => undefined);
      return this.sell(p, Math.min(100, p.exitNowPct), `CLOSE (manuale) ${Math.min(100, p.exitNowPct)}%`, tokenDec);
    }
    const baseUsd = await this.chain.tokenPrice(base).catch(() => 0);
    if (!(baseUsd > 0)) return;
    const heldTokens = p.filledAmountToken * (p.remainingPct / 100);
    if (heldTokens <= 0) { await this.db.updatePositionPlan(p.id, { status: "closed" }); return; }
    const heldWei = BigInt(Math.floor(heldTokens * 10 ** tokenDec));
    // Simulate selling the held amount to read the REAL current exit price.
    const sim = await this.primitives.swapV3(token, base, heldWei, 8, false).catch(() => undefined);
    if (!sim || !sim.ok || sim.mode !== "simulated") { await this.db.updatePositionPlan(p.id, { lastResult: "can't sell right now (no route / honeypot) — watching" }); return; }
    const baseOut = Number(BigInt(String((sim.detail as { expectedOut?: string }).expectedOut ?? "0"))) / 10 ** (await this.decimals(base));
    const priceNow = (baseOut * baseUsd) / heldTokens; // USD per token, executable
    const gainPct = (priceNow / p.filledPrice - 1) * 100;

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

  /** Executes a sell of `pct`% of the ORIGINAL filled amount; updates remaining + notifies. */
  private async sell(p: PositionPlan, pct: number, reason: string, tokenDec: number): Promise<void> {
    const token = p.token as Address; const base = p.baseToken as Address;
    const sellTokens = (p.filledAmountToken ?? 0) * (pct / 100);
    const sellWei = BigInt(Math.floor(sellTokens * 10 ** tokenDec));
    if (sellWei <= 0n) return;
    const exec = await this.primitives.swapV3(token, base, sellWei, 10, true).catch((e) => ({ ok: false as const, primitive: "swap", stage: "execute" as const, reason: e instanceof Error ? e.message : String(e) }));
    if (exec.ok && exec.mode === "executed") {
      const remaining = Math.max(0, p.remainingPct - pct);
      await this.db.updatePositionPlan(p.id, { remainingPct: remaining, status: remaining <= 0.01 ? "closed" : "open", lastResult: reason });
      await this.db.addJournal("action", `POSITION #${p.id} ${reason}: venduto ${pct}% di ${p.symbol ?? p.token.slice(0, 8)} (rimane ${remaining.toFixed(0)}%)`, { plan: p.id, tx: (exec as { txHash?: string }).txHash }, "position").catch(() => undefined);
      this.wake(`position:${p.id}`, `Position #${p.id} (${p.symbol ?? "token"}): ${reason} — sold ${pct}%, ${remaining.toFixed(0)}% left. Review and re-plan if needed.`);
    } else {
      await this.db.updatePositionPlan(p.id, { lastResult: `${reason} — SELL FAILED: ${"reason" in exec ? exec.reason.slice(0, 80) : "unknown"}` });
      this.wake(`position-stuck:${p.id}`, `Position #${p.id} (${p.symbol ?? "token"}) hit ${reason} but the SELL FAILED (likely honeypot/locked). Manual attention needed.`);
    }
  }

  /** Wraps native → wrapped-native if the base is the wrapped token and the balance is short. */
  private async ensureBase(base: Address, needWei: bigint): Promise<void> {
    if (base.toLowerCase() !== this.config.WBERA_ADDRESS.toLowerCase()) return; // only auto-wrap the native
    const owner = this.config.WALLET_ADDRESS as Address; if (!owner) return;
    const bal = await this.chain.primary.readContract({ address: base, abi: DEC, functionName: "balanceOf", args: [owner] }).catch(() => 0n) as bigint;
    if (bal >= needWei) return;
    await this.primitives.wrap(needWei - bal + needWei / 100n, true).catch(() => undefined); // wrap the shortfall (+1% buffer)
  }
}
