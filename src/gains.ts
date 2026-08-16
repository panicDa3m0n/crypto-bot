/**
 * Gains & milestones — the system's forward drive. Scarlet is measured by how much
 * she has GROWN toward the next objective, not by how much she might lose. Every
 * briefing leads with: where she started, what she's up, and how close the next
 * milestone is. The mission is to climb the ladder.
 */
export type Gains = {
  level: number;            // milestone band reached (Level 1 = below the first)
  baselineUsd: number;
  currentNavUsd: number;
  gainUsd: number;          // net worth change since baseline (earned + market)
  gainPct: number;
  realizedPnlUsd: number;   // realized from executed actions (ledger, gas-adjusted)
  nextMilestoneUsd: number | null;
  lastMilestoneUsd: number; // the floor of the current rung (or baseline)
  progressToNextPct: number;
  milestonesHit: number[];
  note: string;
};

export function computeGains(currentNavUsd: number, baselineUsd: number, realizedPnlUsd: number, milestones: number[]): Gains {
  const ladder = [...milestones].filter((m) => m > 0).sort((a, b) => a - b);
  const hit = ladder.filter((m) => currentNavUsd >= m);
  const nextMilestoneUsd = ladder.find((m) => currentNavUsd < m) ?? null;
  const lastMilestoneUsd = hit.length ? hit[hit.length - 1] : 0; // first rung: progress = nav / firstMilestone
  const gainUsd = currentNavUsd - baselineUsd;
  const gainPct = baselineUsd > 0 ? (gainUsd / baselineUsd) * 100 : 0;
  const span = nextMilestoneUsd != null ? nextMilestoneUsd - lastMilestoneUsd : 0;
  const progressToNextPct = span > 0 ? Math.max(0, Math.min(100, ((currentNavUsd - lastMilestoneUsd) / span) * 100)) : 100;
  const level = hit.length + 1;
  const note = nextMilestoneUsd != null
    ? `LEVEL ${level}. XP to LEVEL ${level + 1}: ${round1(progressToNextPct)}% — reach $${nextMilestoneUsd} to level up ($${round(nextMilestoneUsd - currentNavUsd)} to go). You started at $${round(baselineUsd)}, now $${round(currentNavUsd)} (${gainUsd >= 0 ? "+" : ""}${round(gainUsd)}, ${gainPct >= 0 ? "+" : ""}${round1(gainPct)}%). Levelling up is the objective; profit is the XP. Every action should earn XP — a passive cycle is XP lost.`
    : `LEVEL ${level} — you cleared the whole milestone ladder ($${round(gainUsd)} gained). Set higher targets and keep compounding.`;
  return { level: hit.length + 1, baselineUsd: round(baselineUsd), currentNavUsd: round(currentNavUsd), gainUsd: round(gainUsd), gainPct: round1(gainPct), realizedPnlUsd: round4(realizedPnlUsd), nextMilestoneUsd, lastMilestoneUsd, progressToNextPct: round1(progressToNextPct), milestonesHit: hit, note };
}

function round(v: number): number { return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }
function round1(v: number): number { return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0; }
function round4(v: number): number { return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0; }
