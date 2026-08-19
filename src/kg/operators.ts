import type { SimulationState, AssetId } from "./state.js";

/**
 * TRANSFORMATIONS — the typed edges of the stateful Liquidity Graph. Each is an economic state-transition
 * ONLY: applicable? / apply (mutating portfolio + venue) / gas. Calldata generation is DELIBERATELY absent
 * here — the search runs apply() millions of times and must never build bytes; encoding a finished plan to
 * ExecutorCall[] is a separate concern handled once, for the winner (the executor-bridge step).
 *
 * Step-2 operator set (agreed, deliberately small): Swap, Wrap/Unwrap, FlashBorrow/FlashRepay accounting.
 * FlashBorrow/Repay are almost transaction-context rather than economic ops: they let a plan hold capital
 * transiently, under the hard constraint that the obligation is zero by the end state.
 */

export type ApplyResult = { ok: true; note?: string } | { ok: false; reason: string };

export interface Transformation {
  readonly kind: string;
  /** Cheap precondition check (does not mutate). */
  applicable(s: SimulationState): boolean;
  /** Execute the transition, MUTATING s. Returns ok/false with a reason (and does not partially mutate on false). */
  apply(s: SimulationState): ApplyResult;
  /** Approximate gas units this transition adds (for the net-profit gate). */
  gas(): bigint;
  describe(): string;
}

// Approximate gas per op (Base), refined later against real receipts.
const GAS_SWAP: Record<string, bigint> = { v2: 90_000n, aerodrome: 110_000n, v3: 130_000n, v4: 150_000n, slipstream: 140_000n };
const GAS_WRAP = 45_000n;
const GAS_FLASH = 90_000n; // flash borrow+callback overhead (charged once on borrow)

/** Swap through `poolId`, mutating the pool's price. `full=true` swaps the ENTIRE held balance of
 * `tokenIn` at apply time — the natural chaining for a cycle, where each leg spends the previous leg's
 * output (unknown until run). `full=false` swaps the fixed `amountIn`. */
export class SwapOp implements Transformation {
  readonly kind = "swap";
  constructor(readonly poolId: string, readonly tokenIn: AssetId, readonly tokenOut: AssetId, readonly amountIn: bigint, readonly archetype: string = "v3", readonly full = false) {}

  private amt(s: SimulationState): bigint { return this.full ? s.portfolio.get(this.tokenIn) : this.amountIn; }

  applicable(s: SimulationState): boolean {
    const a = this.amt(s);
    if (a <= 0n || s.portfolio.get(this.tokenIn) < a) return false;
    return !!s.venue.readonly(this.poolId)?.has(this.tokenIn);
  }

  apply(s: SimulationState): ApplyResult {
    const a = this.amt(s);
    if (a <= 0n) return { ok: false, reason: `zero input ${this.tokenIn}` };
    if (!s.portfolio.debit(this.tokenIn, a)) return { ok: false, reason: `insufficient ${this.tokenIn}` };
    const o = s.venue.applySwap(this.poolId, this.tokenIn, a);
    if (!o) { s.portfolio.credit(this.tokenIn, a); return { ok: false, reason: "pool quote failed" }; }
    s.portfolio.credit(this.tokenOut, o.amountOut);
    s.gasUnits += this.gas();
    return { ok: true, note: `${a}→${o.amountOut}${o.partial ? " (partial)" : ""}` };
  }

  gas(): bigint { return GAS_SWAP[this.archetype] ?? 130_000n; }
  describe(): string { return `swap ${this.full ? "ALL" : this.amountIn} ${this.tokenIn.slice(0, 8)}→${this.tokenOut.slice(0, 8)} @${this.poolId.slice(0, 8)}(${this.archetype})`; }
}

/** Wrap native ETH → WETH (or the reverse), 1:1. Native ETH is the zero-address sentinel. */
export class WrapOp implements Transformation {
  readonly kind = "wrap";
  constructor(readonly weth: AssetId, readonly amount: bigint, readonly unwrap = false, readonly native: AssetId = "0x0000000000000000000000000000000000000000") {}
  applicable(s: SimulationState): boolean { return s.portfolio.get(this.unwrap ? this.weth : this.native) >= this.amount; }
  apply(s: SimulationState): ApplyResult {
    const [from, to] = this.unwrap ? [this.weth, this.native] : [this.native, this.weth];
    if (!s.portfolio.debit(from, this.amount)) return { ok: false, reason: `insufficient ${from}` };
    s.portfolio.credit(to, this.amount);
    s.gasUnits += this.gas();
    return { ok: true };
  }
  gas(): bigint { return GAS_WRAP; }
  describe(): string { return `${this.unwrap ? "unwrap" : "wrap"} ${this.amount}`; }
}

/** Flash-borrow `amount` of `token` from `provider` — credits the token and records the obligation. */
export class FlashBorrowOp implements Transformation {
  readonly kind = "flashBorrow";
  constructor(readonly provider: string, readonly token: AssetId, readonly amount: bigint) {}
  applicable(): boolean { return this.amount > 0n; }
  apply(s: SimulationState): ApplyResult {
    s.portfolio.credit(this.token, this.amount);
    s.portfolio.addOwed(this.provider, this.token, this.amount);
    s.gasUnits += this.gas();
    return { ok: true, note: `flash +${this.amount}` };
  }
  gas(): bigint { return GAS_FLASH; }
  describe(): string { return `flashBorrow ${this.amount} ${this.token.slice(0, 8)} @${this.provider}`; }
}

/** Repay a flash obligation: `amount` principal + `fee` (Morpho = 0). Fails if funds/obligation short. */
export class FlashRepayOp implements Transformation {
  readonly kind = "flashRepay";
  constructor(readonly provider: string, readonly token: AssetId, readonly amount: bigint, readonly fee: bigint = 0n) {}
  applicable(s: SimulationState): boolean { return s.portfolio.get(this.token) >= this.amount + this.fee; }
  apply(s: SimulationState): ApplyResult {
    if (!s.portfolio.debit(this.token, this.amount + this.fee)) return { ok: false, reason: `cannot repay flash ${this.token}` };
    if (!s.portfolio.clearOwed(this.provider, this.token, this.amount)) { s.portfolio.credit(this.token, this.amount + this.fee); return { ok: false, reason: "no matching obligation" }; }
    return { ok: true, note: `repay ${this.amount}+${this.fee}` };
  }
  gas(): bigint { return 0n; } // accounted in FlashBorrow overhead
  describe(): string { return `flashRepay ${this.amount}+${this.fee} ${this.token.slice(0, 8)}`; }
}
