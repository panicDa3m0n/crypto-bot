/**
 * ARCHETYPE CAPABILITIES — the single source of truth for what each pool family can and cannot tell us.
 *
 * These facts were previously written out by hand in twelve independent places (six copies of `CONC`, four of
 * `MODELABLE`, plus inline lists inside a dozen SQL statements) and they had drifted into FIVE different
 * memberships for the same question. That is not untidiness: it is why Uniswap V4 — half of every pool we
 * know — stayed invisible through four separate exclusions, each of which looked deliberate in isolation.
 *
 * A capability answered here is answered everywhere. Adding a family means editing this file, and any place
 * that needs a different answer has to say so explicitly rather than by quietly keeping its own list.
 */
import type { Archetype } from "./router/types.js";

/** Families whose liquidity lives in TICKS (a per-tick map is required to quote them exactly). */
export const CONCENTRATED: ReadonlySet<string> = new Set<Archetype | string>(["v3", "v4", "slipstream", "algebra", "solidly-v3"]);

/** Families priced by x·y=k reserves. */
export const CONSTANT_PRODUCT: ReadonlySet<string> = new Set(["v2", "aerodrome", "solidly"]);

/** Families using the Solidly stable curve (x³y+xy³=k) — needs BOTH token scales and a real fee. */
export const STABLE_CURVE: ReadonlySet<string> = new Set(["aerodrome-stable"]);

/** The pool contract itself exposes `fee()`. Anywhere else the fee comes from the factory or from state. */
export const PER_POOL_FEE: ReadonlySet<string> = new Set(["v3", "slipstream"]);

/** The fee is a property of the PROTOCOL (its factory), not of the pool. */
export const PROTOCOL_LEVEL_FEE: ReadonlySet<string> = new Set(["v2", "aerodrome", "aerodrome-stable", "solidly"]);

/** The fee is DYNAMIC and only knowable from live state (V4 hooks; Algebra's per-block fee; Solidly V3
 * carries a mutable fee INSIDE slot0, which is why its pools revert on fee() and looked broken). */
export const DYNAMIC_FEE: ReadonlySet<string> = new Set(["v4", "algebra", "solidly-v3"]);

/** `tickSpacing` is a meaningful, readable property. */
export const HAS_TICK_SPACING: ReadonlySet<string> = CONCENTRATED;

/** What `buildPoolSim` can actually simulate today. Anything else is surfaced but never quoted. */
export const MODELABLE: ReadonlySet<string> = new Set(["v2", "aerodrome", "aerodrome-stable", "v3", "slipstream", "solidly-v3"]);

/**
 * Canonical Uniswap fee-tier → tickSpacing. Four separate copies of this existed and they disagreed: one was
 * missing the 2500 (Pancake) tier entirely, and the fallbacks when a tier was unknown ranged over 0, 1 and a
 * live contract read. It is a LAST RESORT — a fork with non-standard spacing must supply its own, which is
 * why `tickSpacingFor` returns undefined rather than a plausible number when it does not know.
 */
const CANONICAL_SPACING: Readonly<Record<number, number>> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };

/** The pool's own tickSpacing if known, else the canonical one for its fee tier, else UNDEFINED — never a
 * guess. A wrong spacing silently breaks the word-boundary walk, so "I don't know" has to stay expressible. */
export function tickSpacingFor(poolSpacing: number | null | undefined, feePpm: number | null | undefined): number | undefined {
  if (poolSpacing != null && poolSpacing > 0) return poolSpacing;
  if (feePpm != null && CANONICAL_SPACING[feePpm] != null) return CANONICAL_SPACING[feePpm];
  return undefined;
}

/**
 * The fee to charge, in ppm — or `null` when it is genuinely unknown.
 *
 * `fee || 3000` was written in eight production sites, silently turning "unknown" into 0.30%. It is the
 * single most damaging default in the codebase: on a strategy whose whole edge is basis points, an invented
 * fee produces confident numbers that are simply wrong, in either direction. The stable branch of
 * buildPoolSim already refused to guess ("never guess a fee on a small-edge strategy"); this makes that the
 * rule rather than the exception. A missing fee is enrichment work, not something to paper over.
 */
export function resolveFeePpm(feePpm: number | null | undefined): number | null {
  return feePpm != null && feePpm > 0 && feePpm < 1_000_000 ? feePpm : null;
}
