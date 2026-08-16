import type { Config } from "./config.js";
import type { PortfolioSnapshot } from "./domain.js";

/**
 * Scarlet's self-model, framed around LEVELLING UP. Her level is the milestone band
 * she has reached; her XP toward the next level is her profit progress toward the next
 * milestone. Native (MON) is her gas/energy — a floor must survive so she keeps acting.
 * Hunger is the drive to close the gap to the next milestone and level up (not a
 * survival runway). The whole model pushes forward: grow to level up, explore to grow.
 */
export type Temperament = "exploit" | "balanced" | "explore";

export type SelfState = {
  wallet?: string;
  energy: {
    /** Wrapped WBERA immediately usable for swaps. */
    wbera: number;
    /** Native BERA (also the gas fuel). */
    nativeBera: number;
    /** Native + wrapped minus the gas-survival floor: what she may actually spend. */
    spendableWbera: number;
    gasReserveBera: number;
    /** True while enough native BERA remains to pay for actions. */
    healthy: boolean;
  };
  reserve: {
    honey: number;
    usdcE: number;
    positionsHoneyEquivalent: number;
    /** HONEY-denominated store of value currently held as stables/HONEY. */
    totalHoney: number;
  };
  /**
   * Total net worth measured in HONEY units (energy + reserve + positions). This
   * is her true wealth: converting WBERA into HONEY does not raise it (it pays
   * fees), only earning does. Hunger is measured against THIS, not the HONEY pocket.
   */
  netWorthHoney: number;
  /** Drive to LEVEL UP: 0 = about to reach the next milestone, 1 = far from it.
   * Tied to the milestone ladder, not a survival runway. */
  hunger: number;
  runwayTargetHoney: number;
  /** Current level = the milestone band reached (Level 1 = below the first milestone). */
  level: number;
  /** The next milestone (USD) to reach to LEVEL UP; null once the ladder is cleared. */
  nextMilestoneUsd: number | null;
  /** XP toward the next level = profit progress toward the next milestone (0-100%). */
  xpToNextPct: number;
  temperament: Temperament;
  lossBudget: { spentTodayHoney: number; remainingHoney: number };
  dataHealthy: boolean;
  /** Chain-neutral display symbols for the self-model strings (e.g. MON / WMON). */
  nativeSymbol: string;
  wrappedSymbol: string;
};

/**
 * Derives Scarlet's self-model from a real portfolio snapshot. Deterministic and
 * numéraire-native: no USD is used as her unit, only WBERA energy and HONEY reserve.
 */
export function selfState(portfolio: PortfolioSnapshot, config: Config): SelfState {
  const gasReserveBera = config.MIN_BERA_RESERVE;
  const spendableWbera = Math.max(0, portfolio.bera - gasReserveBera) + portfolio.wbera;
  const positionsHoneyEquivalent = honeyEquivalent(portfolio.lockedUsd, portfolio.honeyUsd);
  const totalHoney = portfolio.honey + portfolio.usdcE + positionsHoneyEquivalent;
  // Her true wealth is total net worth, priced in HONEY units — not the HONEY
  // token balance. Hunger is measured against this so she is never pushed to
  // convert energy into HONEY (which only pays fees) to feel less hungry.
  const honeyPrice = Number.isFinite(portfolio.honeyUsd) && portfolio.honeyUsd > 0 ? portfolio.honeyUsd : 1;
  const netWorthHoney = portfolio.estimatedNavUsd / honeyPrice;
  // LEVELING: level = milestone band reached; XP = profit progress toward the next
  // milestone; hunger = the drive to close that gap and level up (milestone-based,
  // not a survival runway). This is the forward push of the whole system.
  const nav = portfolio.estimatedNavUsd;
  const milestones = config.PROFIT_MILESTONES.split(",").map((m) => Number(m.trim())).filter((n) => n > 0).sort((a, b) => a - b);
  const hitCount = milestones.filter((m) => nav >= m).length;
  const level = hitCount + 1;
  const nextMilestoneUsd = milestones.find((m) => nav < m) ?? null;
  const lastRung = hitCount ? milestones[hitCount - 1] : 0;
  const xpToNextPct = nextMilestoneUsd != null && nextMilestoneUsd > lastRung ? clamp01((nav - lastRung) / (nextMilestoneUsd - lastRung)) * 100 : 100;
  const hunger = nextMilestoneUsd != null ? clamp01(1 - xpToNextPct / 100) : 0;
  const effectiveLoss = Math.min(config.DAILY_LOSS_LIMIT_USD, portfolio.estimatedNavUsd * 0.25);
  return {
    wallet: portfolio.walletAddress,
    energy: { wbera: portfolio.wbera, nativeBera: portfolio.bera, spendableWbera, gasReserveBera, healthy: portfolio.bera >= gasReserveBera },
    reserve: { honey: portfolio.honey, usdcE: portfolio.usdcE, positionsHoneyEquivalent, totalHoney },
    netWorthHoney,
    hunger,
    runwayTargetHoney: config.HONEY_RUNWAY_TARGET,
    level,
    nextMilestoneUsd,
    xpToNextPct,
    temperament: temperamentFor(hunger),
    lossBudget: { spentTodayHoney: portfolio.dailyLossUsd, remainingHoney: Math.max(0, effectiveLoss - portfolio.dailyLossUsd) },
    dataHealthy: portfolio.dataHealthy,
    nativeSymbol: config.NATIVE_SYMBOL,
    wrappedSymbol: config.WRAPPED_SYMBOL
  };
}

/**
 * Prompt-safe self statement. Scarlet reads this to know who and where she is,
 * and how hungry — the single fact that most shapes how boldly she should act.
 */
export function selfContext(self: SelfState): unknown {
  const spendable = round(self.energy.spendableWbera);
  const nat = self.nativeSymbol; const wrp = self.wrappedSymbol;
  return {
    netWorthUsd: round(self.netWorthHoney),
    [`native${nat}Held`]: round(self.energy.nativeBera),
    [`${wrp}Held`]: round(self.energy.wbera),
    [`gasReserve${nat}`]: self.energy.gasReserveBera,
    spendableEnergy: spendable,
    energyHealthy: self.energy.healthy,
    stableHeldUsd: round(self.reserve.totalHoney),
    level: self.level,
    nextMilestoneUsd: self.nextMilestoneUsd,
    xpToNextPct: round(self.xpToNextPct),
    hunger: round(self.hunger),
    temperament: self.temperament,
    lossBudgetRemainingUsd: round(self.lossBudget.remainingHoney),
    dataHealthy: self.dataHealthy,
    energyNote: `You hold ${round(self.energy.nativeBera)} native ${nat} and ${round(self.energy.wbera)} ${wrp}. ${spendable} ${nat}-equivalent is SPENDABLE above your ${self.energy.gasReserveBera} ${nat} gas reserve — deployable capital, NOT untouchable. Swap in ONE call with the swap tool (auto best-tier + minOut + approve); wrap native ${nat} into ${wrp} first if needed.`,
    mission: self.nextMilestoneUsd != null
      ? `You are LEVEL ${self.level}. XP to LEVEL ${self.level + 1}: ${round(self.xpToNextPct)}% — earn your way to $${self.nextMilestoneUsd} to level up. XP = profit toward the milestone; every $ of net worth you add is XP. Levelling up IS the objective; profit is how you level.`
      : `You are LEVEL ${self.level} and have cleared the milestone ladder — set higher targets and keep compounding.`,
    instruction: `Your PRIMARY drive is to LEVEL UP. If a positive-net action exists RIGHT NOW, take it (swap/snipe/liquidate/farm). If nothing is obviously profitable, do NOT sit and wait — a passive cycle is XP lost. EXPLORE the full menu to find the next gain: snipe a fresh launch (check_token first), deposit into an incentivized pool (market_data yields.incentivized), try a stablecoin peg-arb, add a readable DEX to make arbHints appear, spy smart-money, arm a watcher to fire on a condition. The ONLY limits: keep the ${nat} gas reserve and don't get rugged. Explore aggressively — hunt every possibility until you find profit.`
  };
}

function temperamentFor(hunger: number): Temperament {
  if (hunger >= 0.66) return "exploit";
  if (hunger <= 0.33) return "explore";
  return "balanced";
}
function honeyEquivalent(lockedUsd: number, honeyUsd: number): number {
  if (!Number.isFinite(lockedUsd) || lockedUsd <= 0) return 0;
  const price = Number.isFinite(honeyUsd) && honeyUsd > 0 ? honeyUsd : 1;
  return lockedUsd / price;
}
function clamp01(value: number): number { return !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value)); }
function round(value: number): number { return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0; }
