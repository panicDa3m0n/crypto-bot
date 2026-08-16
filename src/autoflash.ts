import type { Logger } from "pino";
import type { Address } from "viem";
import type { Database } from "./db.js";
import type { Primitives } from "./primitives.js";

/**
 * The auto-flash watcher. Scarlet arms a liquidation on a position that is on the
 * edge; this service simulates that exact liquidation every tick. While the position
 * is still healthy (or her funds aren't ready) the simulation reverts and nothing
 * happens. The instant the simulation PASSES — the position crossed hf<1 and the
 * liquidation would succeed — it fires the real transaction, records it, and wakes
 * Scarlet with the result. The simulation IS the trigger, so it never sends a tx
 * that would fail, and it reuses her simulate-then-execute safety path.
 */
export class AutoflashService {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly primitives: Primitives,
    private readonly logger: Logger,
    private readonly wake: (key: string, reason: string) => void,
    private readonly chainId: number
  ) {}

  start(intervalMs = 4_000): void {
    this.timer = setInterval(() => void this.tick().catch((error) => this.logger.error({ err: error }, "auto-flash tick failed")), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    if (this.running) return; // never overlap a slow tick (a fire can take seconds)
    this.running = true;
    try {
      const armed = await this.db.activeAutoflash();
      for (const w of armed) {
        await this.db.touchAutoflash(w.id).catch(() => undefined);
        // Simulate the liquidation. Reverts while healthy / funds not ready → skip.
        const sim = await this.primitives.callContract(w.target as Address, w.signature, w.args as unknown[], 0n, false).catch((e) => ({ ok: false as const, primitive: "call_contract", stage: "build" as const, reason: e instanceof Error ? e.message : String(e) }));
        if (!(sim.ok && sim.mode === "simulated")) continue; // not liquidatable yet
        // It passed → the position is liquidatable NOW. Fire the real transaction.
        this.logger.warn({ autoflash: w.id, label: w.label }, "auto-flash trigger passed — firing liquidation");
        const exec = await this.primitives.callContract(w.target as Address, w.signature, w.args as unknown[], 0n, true).catch((e) => ({ ok: false as const, primitive: "call_contract", stage: "execute" as const, reason: e instanceof Error ? e.message : String(e) }));
        if (exec.ok && exec.mode === "executed") {
          await this.db.settleAutoflash(w.id, "fired", { txHash: exec.txHash, result: exec.detail });
          await this.db.addJournal("action", `AUTO-FLASH #${w.id} SCATTATO (${w.label ?? "liquidazione"}): liquidazione eseguita — tx ${exec.txHash}`, { autoflash: w.id, txHash: exec.txHash }, "autoflash").catch(() => undefined);
          this.wake("autoflash-fired", `auto-flash #${w.id} (${w.label ?? "liquidazione"}) SCATTATO: liquidazione eseguita, tx ${exec.txHash}. Verifica il collaterale sequestrato + bonus e decidi il prossimo passo.`);
        } else {
          const reason = "reason" in exec ? exec.reason : "unknown";
          await this.db.settleAutoflash(w.id, "failed", { result: exec });
          // OBSERVABILITY: an armed watcher that FIRED but reverted — the position was liquidatable and
          // we tried, but our tx failed (stale swap calldata, lost the race, etc.). This is what we
          // need to SEE to fix the fire path (→ re-fetch-at-fire).
          await this.db.recordLiquidationEvent({ chainId: this.chainId, kind: "armed_fail", protocol: "morpho", borrower: w.borrower ?? undefined, marketId: w.marketId ?? undefined, note: `fire reverted: ${String(reason).slice(0, 180)}`, meta: { autoflash: w.id, label: w.label } }).catch(() => undefined);
          await this.db.addJournal("action", `AUTO-FLASH #${w.id} FALLITO (${w.label ?? ""}): ${reason}`, { autoflash: w.id }, "autoflash").catch(() => undefined);
          this.wake("autoflash-failed", `auto-flash #${w.id} (${w.label ?? ""}) è scattato ma l'esecuzione è FALLITA: ${reason}. Rivedi la posizione.`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** The Morpho liquidate signature and arg builder — kept here so the tool and the
 * watcher agree on the exact encoding. seizedAssets XOR repaidShares (one is 0). */
export const LIQUIDATE_SIG = "liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)";
export function buildLiquidateArgs(params: { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string; borrower: string; seizedAssets: string; repaidShares: string }): unknown[] {
  return [
    [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
    params.borrower, params.seizedAssets, params.repaidShares, "0x"
  ];
}
