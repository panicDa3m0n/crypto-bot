import type { Archetype } from "../router/types.js";
import { simulateExactInputStateful } from "../router/v3-sim.js";
import { getTickAtSqrtRatio } from "../router/tick-math.js";
import { stableGetAmountOut } from "../router/solidly-math.js";

/**
 * STATEFUL SIMULATION KERNEL — the state model of the Liquidity Graph. The KG is not a fixed-weight
 * graph but a STATE-TRANSITION SYSTEM: a state S = (typed portfolio, mutable venue state), and a
 * transformation mutates BOTH. This file holds the state; operators (swap/wrap/flash) live in
 * operators.ts, the driver/objective in kernel.ts.
 *
 * Design commitments (agreed):
 *  - PROTOCOL-SPECIFIC pool state: V2 needs (r0,r1); V3 needs (sqrtPrice,tick,liquidity,ticks) because a
 *    large swap crosses ticks and liquidity changes DURING the swap. Each PoolSim knows how to mutate
 *    itself, and a second swap through the same pool sees the moved price.
 *  - COPY-ON-WRITE forks: exploring thousands of routes must NOT clone the whole graph. A VenueFork
 *    shares an immutable base snapshot and clones only the pools a plan actually touches.
 *  - VERSIONED snapshots: every simulation is pinned to (chainId, blockNumber, blockHash) so freshness /
 *    reorg can gate execution.
 */

export type AssetId = string; // lowercased ERC-20 address (native ETH mapped to WETH upstream)

export interface StateVersion {
  chainId: number;
  blockNumber: number;
  blockHash?: string;
}

/** Result of one swap: output, input actually consumed, whether it was a floor (V3 ran out of ticks), and
 * whether it is CERTIFIABLY EXACT (Item 3): constant-product/stable math is always exact; a concentrated
 * swap is exact only when the pool's tick map is `complete` AND the swap didn't hit a floor (`partial`). */
export interface SwapOutcome { amountOut: bigint; amountInUsed: bigint; partial: boolean; exact: boolean }

// ─────────────────────────────────────────────────────────────────────────────
// Pool simulators — protocol-specific, mutable, cloneable (for COW).
// ─────────────────────────────────────────────────────────────────────────────

export abstract class PoolSim {
  abstract readonly poolId: string;
  abstract readonly token0: string;
  abstract readonly token1: string;
  abstract readonly archetype: Archetype;
  /** Pure quote — no mutation. Same integer math the DEX runs. */
  abstract quote(tokenIn: string, amountIn: bigint): SwapOutcome | null;
  /** Execute the swap, MUTATING this pool's state. Returns the outcome. */
  abstract applySwap(tokenIn: string, amountIn: bigint): SwapOutcome | null;
  /** Deep-enough copy for copy-on-write (immutable sub-structures may be shared). */
  abstract clone(): PoolSim;
  /** Reserve (real for cp, in-range virtual for concentrated) of `token`, raw wei — for sizing bounds. */
  abstract reserveOf(token: string): bigint;
  has(token: string): boolean { const t = token.toLowerCase(); return t === this.token0 || t === this.token1; }
  other(token: string): string { return token.toLowerCase() === this.token0 ? this.token1 : this.token0; }
}

/** Constant-product (Uniswap-V2 / Solidly-volatile). Exact at any size; mutation is reserve bookkeeping. */
export class V2PoolSim extends PoolSim {
  constructor(
    readonly poolId: string, readonly token0: string, readonly token1: string,
    public r0: bigint, public r1: bigint, public feePpm: number, readonly archetype: Archetype = "v2"
  ) { super(); }

  private amountOut(rIn: bigint, rOut: bigint, amountIn: bigint): bigint {
    const fee = this.feePpm > 0 && this.feePpm < 1_000_000 ? BigInt(Math.round(this.feePpm)) : 3000n;
    const inWithFee = amountIn * (1_000_000n - fee);
    return (inWithFee * rOut) / (rIn * 1_000_000n + inWithFee);
  }

  quote(tokenIn: string, amountIn: bigint): SwapOutcome | null {
    if (amountIn <= 0n || this.r0 <= 0n || this.r1 <= 0n || !this.has(tokenIn)) return null;
    const inIs0 = tokenIn.toLowerCase() === this.token0;
    const [rIn, rOut] = inIs0 ? [this.r0, this.r1] : [this.r1, this.r0];
    const out = this.amountOut(rIn, rOut, amountIn);
    return out > 0n && out < rOut ? { amountOut: out, amountInUsed: amountIn, partial: false, exact: true } : null;
  }

  applySwap(tokenIn: string, amountIn: bigint): SwapOutcome | null {
    const o = this.quote(tokenIn, amountIn);
    if (!o) return null;
    if (tokenIn.toLowerCase() === this.token0) { this.r0 += amountIn; this.r1 -= o.amountOut; }
    else { this.r1 += amountIn; this.r0 -= o.amountOut; }
    return o;
  }

  clone(): PoolSim { return new V2PoolSim(this.poolId, this.token0, this.token1, this.r0, this.r1, this.feePpm, this.archetype); }
  reserveOf(token: string): bigint { return token.toLowerCase() === this.token0 ? this.r0 : this.r1; }
}

/** Concentrated liquidity (Uniswap-V3 / V4 / Slipstream). Tick-crossing exact via v3-sim; the tick array
 * is immutable (only sqrtPrice/tick/liquidity move) so clones share it. */
export class V3PoolSim extends PoolSim {
  constructor(
    readonly poolId: string, readonly token0: string, readonly token1: string,
    public sqrtPriceX96: bigint, public liquidity: bigint, public tick: number, public feePpm: number,
    readonly ticks: ReadonlyArray<{ tick: number; liquidityNet: bigint }>, readonly archetype: Archetype = "v3",
    readonly tickCoverage: "complete" | "partial" = "partial" // Item 3: certified from pool_tick_status, never ticks.length
  ) { super(); }

  private sim(tokenIn: string, amountIn: bigint) {
    const zeroForOne = tokenIn.toLowerCase() === this.token0;
    const r = simulateExactInputStateful({ sqrtPriceX96: this.sqrtPriceX96, liquidity: this.liquidity, tick: this.tick, feePips: this.feePpm > 0 ? this.feePpm : 3000, ticks: [...this.ticks] }, zeroForOne, amountIn);
    return r;
  }

  quote(tokenIn: string, amountIn: bigint): SwapOutcome | null {
    if (amountIn <= 0n || !this.has(tokenIn)) return null;
    const r = this.sim(tokenIn, amountIn);
    return r && r.amountOut > 0n ? { amountOut: r.amountOut, amountInUsed: r.amountInUsed, partial: r.partial, exact: this.tickCoverage === "complete" && !r.partial } : null;
  }

  applySwap(tokenIn: string, amountIn: bigint): SwapOutcome | null {
    if (amountIn <= 0n || !this.has(tokenIn)) return null;
    const r = this.sim(tokenIn, amountIn);
    if (!r || r.amountOut <= 0n) return null;
    this.sqrtPriceX96 = r.sqrtPriceX96; this.tick = r.tick; this.liquidity = r.liquidity;
    return { amountOut: r.amountOut, amountInUsed: r.amountInUsed, partial: r.partial, exact: this.tickCoverage === "complete" && !r.partial };
  }

  clone(): PoolSim { return new V3PoolSim(this.poolId, this.token0, this.token1, this.sqrtPriceX96, this.liquidity, this.tick, this.feePpm, this.ticks, this.archetype, this.tickCoverage); }
  reserveOf(token: string): bigint {
    const Q96 = 2n ** 96n;
    return token.toLowerCase() === this.token0 ? (this.liquidity * Q96) / this.sqrtPriceX96 : (this.liquidity * this.sqrtPriceX96) / Q96;
  }

  static tickFromSqrt(sqrtPriceX96: bigint): number { return getTickAtSqrtRatio(sqrtPriceX96); }
}

/** Solidly/Aerodrome STABLE pool (x³y+xy³=k). Uses the integer-exact shared math (solidly-math.ts), so
 * quote == on-chain getAmountOut. Needs the two tokens' decimal SCALES (10**decimals) and the factory fee
 * in bps. The reserve mutation matches the contract: the fee LEAVES the pool (to PoolFees), so the input
 * reserve grows by (amountIn − fee), not the full amountIn — critical for a second swap in a VenueFork. */
export class StablePoolSim extends PoolSim {
  constructor(
    readonly poolId: string, readonly token0: string, readonly token1: string,
    public r0: bigint, public r1: bigint, readonly dec0: bigint, readonly dec1: bigint, public feeBps: number,
    readonly archetype: Archetype = "aerodrome-stable"
  ) { super(); }

  quote(tokenIn: string, amountIn: bigint): SwapOutcome | null {
    if (amountIn <= 0n || this.r0 <= 0n || this.r1 <= 0n || !this.has(tokenIn)) return null;
    const inIs0 = tokenIn.toLowerCase() === this.token0;
    const out = stableGetAmountOut(amountIn, inIs0, this.r0, this.r1, this.dec0, this.dec1, this.feeBps);
    const rOut = inIs0 ? this.r1 : this.r0;
    return out > 0n && out < rOut ? { amountOut: out, amountInUsed: amountIn, partial: false, exact: true } : null;
  }

  applySwap(tokenIn: string, amountIn: bigint): SwapOutcome | null {
    const o = this.quote(tokenIn, amountIn);
    if (!o) return null;
    const fee = (amountIn * BigInt(Math.round(this.feeBps))) / 10_000n; // fee moved out of the pool (PoolFees)
    if (tokenIn.toLowerCase() === this.token0) { this.r0 += amountIn - fee; this.r1 -= o.amountOut; }
    else { this.r1 += amountIn - fee; this.r0 -= o.amountOut; }
    return o;
  }

  clone(): PoolSim { return new StablePoolSim(this.poolId, this.token0, this.token1, this.r0, this.r1, this.dec0, this.dec1, this.feeBps, this.archetype); }
  reserveOf(token: string): bigint { return token.toLowerCase() === this.token0 ? this.r0 : this.r1; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Venue state — an immutable base snapshot + copy-on-write forks.
// ─────────────────────────────────────────────────────────────────────────────

/** The immutable mirror of venue state at one block. Never mutated; forks overlay changes. */
export class VenueSnapshot {
  constructor(readonly version: StateVersion, readonly pools: ReadonlyMap<string, PoolSim>) {}
  fork(): VenueFork { return new VenueFork(this.pools); }
  get size(): number { return this.pools.size; }
}

/** A copy-on-write overlay over a base pool map: reads fall through to base; the first mutation of a pool
 * clones it into `overrides`, so a 3-hop cycle duplicates 3 pools, not the whole graph. */
export class VenueFork {
  private overrides = new Map<string, PoolSim>();
  constructor(private readonly base: ReadonlyMap<string, PoolSim>) {}

  readonly(poolId: string): PoolSim | undefined { const id = poolId.toLowerCase(); return this.overrides.get(id) ?? this.base.get(id); }

  private mutable(poolId: string): PoolSim | undefined {
    const id = poolId.toLowerCase();
    const existing = this.overrides.get(id);
    if (existing) return existing;
    const b = this.base.get(id);
    if (!b) return undefined;
    const copy = b.clone();
    this.overrides.set(id, copy);
    return copy;
  }

  /** Execute a swap through a pool, mutating only this fork's overlay. */
  applySwap(poolId: string, tokenIn: string, amountIn: bigint): SwapOutcome | null {
    const p = this.mutable(poolId);
    return p ? p.applySwap(tokenIn, amountIn) : null;
  }

  /** Number of pools this fork has copied (touched). */
  get touched(): number { return this.overrides.size; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio state — typed holdings + transient flash obligations.
// ─────────────────────────────────────────────────────────────────────────────

export class PortfolioState {
  private bal = new Map<AssetId, bigint>();
  private owed = new Map<string, bigint>(); // key = `${provider}|${token}` → amount that MUST be repaid

  get(token: AssetId): bigint { return this.bal.get(token.toLowerCase()) ?? 0n; }

  credit(token: AssetId, amount: bigint): void {
    if (amount <= 0n) return;
    const t = token.toLowerCase();
    this.bal.set(t, (this.bal.get(t) ?? 0n) + amount);
  }

  /** Spend `amount` of `token`; returns false (no mutation) if the balance is insufficient. */
  debit(token: AssetId, amount: bigint): boolean {
    if (amount <= 0n) return true;
    const t = token.toLowerCase();
    const cur = this.bal.get(t) ?? 0n;
    if (cur < amount) return false;
    this.bal.set(t, cur - amount);
    return true;
  }

  addOwed(provider: string, token: AssetId, amount: bigint): void {
    const k = `${provider.toLowerCase()}|${token.toLowerCase()}`;
    this.owed.set(k, (this.owed.get(k) ?? 0n) + amount);
  }

  /** Clear `amount` of a flash obligation; false if it would over-repay or the obligation is missing. */
  clearOwed(provider: string, token: AssetId, amount: bigint): boolean {
    const k = `${provider.toLowerCase()}|${token.toLowerCase()}`;
    const cur = this.owed.get(k) ?? 0n;
    if (cur < amount) return false;
    if (cur === amount) this.owed.delete(k); else this.owed.set(k, cur - amount);
    return true;
  }

  totalOwed(): bigint { let s = 0n; for (const v of this.owed.values()) s += v; return s; }

  /** Non-zero token balances (for closed-portfolio checks / reporting). */
  nonZero(): Array<{ token: AssetId; amount: bigint }> {
    const out: Array<{ token: AssetId; amount: bigint }> = [];
    for (const [t, v] of this.bal) if (v !== 0n) out.push({ token: t, amount: v });
    return out;
  }

  clone(): PortfolioState {
    const c = new PortfolioState();
    for (const [t, v] of this.bal) c.bal.set(t, v);
    for (const [k, v] of this.owed) c.owed.set(k, v);
    return c;
  }
}

/** One executed swap leg, recorded when a trace sink is attached — the encoder needs the exact per-hop
 * input/output amounts (leg N's input = leg N−1's output, unknown until simulated). */
export interface SwapTrace { poolId: string; tokenIn: AssetId; tokenOut: AssetId; amountIn: bigint; amountOut: bigint }

/** The full simulation state: version + portfolio + venue overlay + accumulated gas (units). An optional
 * `trace` sink records swap legs (off in the hot search; on when encoding the winner). `lending` overlays
 * the Morpho markets/positions (F5), so a LiquidateOp mutates the same state a SwapOp does — a
 * flash-liquidation is then an ordinary plan. Absent for pure-swap plans. */
export interface SimulationState {
  version: StateVersion;
  portfolio: PortfolioState;
  venue: VenueFork;
  gasUnits: bigint;
  trace?: SwapTrace[];
  lending?: import("./lending.js").LendingFork;
  /** Item 3: false once ANY leg was not certifiably exact (partial tick coverage / floor). A plan can be a
   * positive-PnL economicCandidate with exact=false, but it can NEVER be certified executable. */
  exact: boolean;
}
