import type { SizedCycle } from "./kernel.js";
import type { AssetId } from "./state.js";

/**
 * EXECUTABILITY GATE — turns an ECONOMICALLY profitable sized cycle (the kernel's verdict) into an
 * EXECUTABLE decision. These are two different concepts, kept separate on purpose:
 *   - economicEdge  = "the loop returns more numéraire than it costs in swap fees + impact" (kernel).
 *   - executable    = "we can actually fund it, close it, and clear net-of-gas profit above threshold".
 * A cycle can be a real economic edge yet non-executable today (exotic numéraire we can't flash-fund or
 * value) — we DON'T discard it; it stays as a non-actionable edge that a future exit route or flash
 * provider could unlock, and that the planner can reason about.
 *
 * The kernel is oracle-free (returns gasUnits, not USD); THIS layer does valuation:
 *   gasUnits × gasPrice = ETH → × ETH/USD ref = gas USD;  netUsd = grossUsd − flashFee − gasUsd − safety.
 */

export interface GateContext {
  flashFundable: Set<string>;                 // tokens Morpho can flash-loan (lowercased)
  gasPriceWei: bigint;
  ethUsd: number;
  numeraireUsd: (token: AssetId) => number | null; // USD per 1 whole token; null if unpriceable
  decimalsOf: (token: AssetId) => number;
  minNetUsd: number;                          // executability threshold
  safetyUsd: number;                          // margin subtracted (adverse selection / slippage buffer)
  flashFeeBps: number;                        // provider fee (Morpho = 0)
}

export interface ExecutableOpportunity {
  numeraire: AssetId;
  amountIn: bigint;
  grossPnl: bigint;        // numéraire wei (kernel, gross of gas/flash)
  grossPnlUsd: number | null;
  flashCostUsd: number;
  gasUnits: bigint;
  gasCostUsd: number;
  netPnlUsd: number | null;
  economicEdge: boolean;   // kernel said profitable
  executable: boolean;     // passes all executability gates
  rejectionReason?: string;
  sized: SizedCycle;
}

export function evaluateExecutable(sized: SizedCycle, ctx: GateContext): ExecutableOpportunity {
  const num = sized.numeraire.toLowerCase();
  const dec = ctx.decimalsOf(num);
  const numUsd = ctx.numeraireUsd(num);
  const grossHuman = Number(sized.realizedPnl) / 10 ** dec;
  const amountHuman = Number(sized.amountIn) / 10 ** dec;
  const grossPnlUsd = numUsd != null ? grossHuman * numUsd : null;

  const gasEth = Number(sized.gasUnits * ctx.gasPriceWei) / 1e18;
  const gasCostUsd = gasEth * ctx.ethUsd;
  const flashCostUsd = numUsd != null ? amountHuman * numUsd * (ctx.flashFeeBps / 10_000) : 0;
  const netPnlUsd = grossPnlUsd != null ? grossPnlUsd - gasCostUsd - flashCostUsd - ctx.safetyUsd : null;

  // Gates (order = most fundamental first). economicEdge is already true (sizeCycle only returns >0 gross).
  let executable = true, rejectionReason: string | undefined;
  if (!ctx.flashFundable.has(num)) { executable = false; rejectionReason = "numéraire not flash-fundable"; }
  else if (numUsd == null || grossPnlUsd == null) { executable = false; rejectionReason = "numéraire unpriceable (no exit valuation)"; }
  else if (netPnlUsd == null || netPnlUsd <= ctx.minNetUsd) { executable = false; rejectionReason = `net $${(netPnlUsd ?? 0).toFixed(4)} ≤ threshold $${ctx.minNetUsd}`; }

  return { numeraire: num, amountIn: sized.amountIn, grossPnl: sized.realizedPnl, grossPnlUsd, flashCostUsd, gasUnits: sized.gasUnits, gasCostUsd, netPnlUsd, economicEdge: sized.realizedPnl > 0n, executable, rejectionReason, sized };
}
