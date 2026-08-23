/**
 * RECOVER THE POSITIONS WE ARCHIVED ON A SILENT API.
 *
 *   docker compose -p bera-bot run -d --rm brain node dist/scripts/liq-recover.js [--apply]
 *
 * `demoteStaleActionable` used to set tier='closed' whenever the Morpho API stopped naming a position, with
 * no on-chain check. That is a fact about the API being read as a fact about the debt, and it archived 10,712
 * positions — 320 of them profitable by our own last computation. Eleven were liquidated by other bots inside
 * 72 hours while we had them filed as gone.
 *
 * The code no longer does this (only a confirmed-empty on-chain read retires a position), but the damage is
 * already in the table: those rows are invisible to every reader, because they all exclude tier='closed'.
 * This asks the chain about each one and puts the living back.
 *
 * Dry by default — it prints what it would do. `--apply` writes.
 *
 * Restored positions come back as `pending`, never straight to an actionable tier: what we hold for them is
 * stale, and `pending` is precisely the state that means "known, not yet judged". The tick's resolvePending
 * reads their real size and health from the chain and classifies them properly. Guessing a tier here would
 * repeat the original sin in the opposite direction.
 */
import { parseAbi, type Address } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";

const MORPHO_ABI = parseAbi([
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)"
]);
const BATCH = 400;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const config = loadConfig();
  const logger = createLogger(config);
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const morpho = config.MORPHO_CORE as Address | undefined;
  if (!morpho) { logger.error("MORPHO_CORE not configured — cannot ask the chain anything"); await db.close(); return; }

  const rows = await db.positionsArchivedOnApiSilence(config.CHAIN_ID);
  logger.info({ archived: rows.length, mode: apply ? "APPLY" : "dry-run" }, "positions archived on API silence — asking the chain which are still alive");
  if (!rows.length) { await db.close(); return; }

  let alive = 0, empty = 0, unread = 0, restored = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { results, laneFailed } = await chain.bulkRead(
      slice.map((p) => ({ address: morpho, abi: MORPHO_ABI, functionName: "position" as const, args: [p.marketId as `0x${string}`, p.borrower as Address] })),
      { label: "liq-recover" }
    );
    if (laneFailed) { logger.warn({ from: i, size: slice.length }, "batch unreadable — skipped (an unread is never a verdict)"); unread += slice.length; continue; }
    for (let j = 0; j < slice.length; j++) {
      const p = slice[j], r = results[j];
      if (r?.status !== "success" || !Array.isArray(r.result)) { unread += 1; continue; }
      const borrowShares = (r.result as bigint[])[1];
      const collateral = (r.result as bigint[])[2];
      if (borrowShares === 0n) { empty += 1; continue; }   // genuinely repaid — the archive was right by luck
      alive += 1;
      if (apply) {
        await db.reopenLendingPosition(config.CHAIN_ID, p.protocol, p.marketId, p.borrower, collateral.toString(), borrowShares.toString())
          .then(() => { restored += 1; })
          .catch((e) => logger.warn({ err: e, borrower: p.borrower }, "reopen failed"));
      }
    }
    logger.info({ done: Math.min(i + BATCH, rows.length), of: rows.length, alive, empty, unread }, "…");
  }

  logger.warn({ archived: rows.length, stillBorrowing: alive, genuinelyRepaid: empty, unread, restored, applied: apply },
    apply ? "RECOVERY COMPLETE — living positions returned to the registry as `pending` for on-chain classification"
          : "DRY RUN — re-run with --apply to restore the living positions");
  await db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
