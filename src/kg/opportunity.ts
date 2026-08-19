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
  execMinProfitBps: number;                   // on-chain minProfit floor as a fraction of predicted gross (e.g. 7000 = keep ≥70%)
  lag: number;                                // indexer head vs chain tip (blocks behind)
  maxLagBlocks: number;                       // HARD freshness gate: reject if lag exceeds this
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
  /** The on-chain safety floor for the EXECUTION calldata (numéraire wei). NOT 0 — set so an adverse
   * state move between sim and inclusion reverts the tx instead of executing a degraded/unprofitable
   * trade. = max(predicted gross × execMinProfitBps, gas+safety in numéraire) → guarantees net-positive
   * if it lands. eth_call validity checks still use minProfit=0; execution uses THIS. */
  minProfitNumeraire: bigint;
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

  // On-chain minProfit floor for the EXECUTION calldata: keep ≥ execMinProfitBps of predicted gross, but
  // never below (gas + safety) valued in the numéraire — so if it lands, net is still positive.
  let minProfitNumeraire = 0n;
  if (numUsd != null && numUsd > 0) {
    const toNumWei = (usd: number) => BigInt(Math.ceil((usd / numUsd) * 10 ** dec));
    const keep = (sized.realizedPnl * BigInt(Math.max(0, Math.min(10_000, Math.round(ctx.execMinProfitBps))))) / 10_000n;
    const floor = toNumWei(gasCostUsd + flashCostUsd + ctx.safetyUsd);
    minProfitNumeraire = keep > floor ? keep : floor;
  }

  // Gates (order = most fundamental first). economicEdge is already true (sizeCycle only returns >0 gross).
  let executable = true, rejectionReason: string | undefined;
  if (!sized.simulationExact) { executable = false; rejectionReason = `simulation not exact: ${sized.inexactReason ?? "partial tick coverage"} — economicCandidate only`; } // Item 3 fail-closed
  else if (ctx.lag > ctx.maxLagBlocks) { executable = false; rejectionReason = `indexer lag ${ctx.lag} > ${ctx.maxLagBlocks} blocks (stale mirror)`; }
  else if (!ctx.flashFundable.has(num)) { executable = false; rejectionReason = "numéraire not flash-fundable"; }
  else if (numUsd == null || grossPnlUsd == null) { executable = false; rejectionReason = "numéraire unpriceable (no exit valuation)"; }
  else if (netPnlUsd == null || netPnlUsd <= ctx.minNetUsd) { executable = false; rejectionReason = `net $${(netPnlUsd ?? 0).toFixed(4)} ≤ threshold $${ctx.minNetUsd}`; }

  return { numeraire: num, amountIn: sized.amountIn, grossPnl: sized.realizedPnl, grossPnlUsd, flashCostUsd, gasUnits: sized.gasUnits, gasCostUsd, netPnlUsd, minProfitNumeraire, economicEdge: sized.realizedPnl > 0n, executable, rejectionReason, sized };
}
