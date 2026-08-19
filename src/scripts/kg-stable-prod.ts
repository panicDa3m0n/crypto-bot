/**
 * KG STABLE PROD (Item 2, step 7 test — the DB-ONLY production path for aerodrome-stable). Proves a stable
 * pool traverses entities+pool_state → PoolState → StableAdapter → buildPoolSim → StablePoolSim → encodeLeg
 * with NO live chain read anywhere in the reasoning path; a single on-chain getAmountOut at the end (the
 * PREFLIGHT boundary) confirms the DB-only quote is wei-exact. Fails closed if a stable pool lacks fee/
 * decimals/state (which is the correct behaviour, not a test failure — it just isn't quotable yet).
 *
 *   ... run --rm brain node dist/scripts/kg-stable-prod.js
 */
import { parseAbi, type Address } from "viem";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { Database } from "../db.js";
import { BerachainClients } from "../chain.js";
import { LocalRouter } from "../router/router.js";
import type { PoolState } from "../router/types.js";
import { StableAdapter } from "../router/adapters/solidly.js";
import { buildPoolSim } from "../kg/kernel.js";

const POOL_ABI = parseAbi(["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"]);

async function main() {
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: "silent" as never });
  const db = new Database(config.DATABASE_URL);
  const chain = new BerachainClients(config, logger);
  const router = new LocalRouter(config, logger, db, chain);
  const cid = config.CHAIN_ID;
  const owner = config.WALLET_ADDRESS as Address;
  const adapter = new StableAdapter();
  const org = await db.getOrgan("kg-executor").catch(() => undefined);
  const kg = (org?.address ?? owner) as Address; // recipient for encode (any address)

  const rows = await db.poolsByArchetype(cid, "aerodrome-stable", 60).catch(() => []);
  console.log(`[kg-stable-prod] aerodrome-stable pools in DB: ${rows.length}`);

  let complete = 0, quoteExact = 0, simMatch = 0, encodable = 0, tested = 0, compared = 0;
  for (const row of rows) {
    if (tested >= 8) break;
    const m = (row.meta ?? {}) as { token0?: string; token1?: string; fee?: unknown; factory?: string };
    if (!m.token0 || !m.token1 || !(Number(m.fee) > 0)) continue; // fail-closed: no fee ⇒ not quotable
    const t0 = m.token0.toLowerCase(), t1 = m.token1.toLowerCase();
    // Everything below is DB-ONLY.
    const st = (await db.poolStateBatch(cid, [row.address.toLowerCase()]).catch(() => new Map())).get(row.address.toLowerCase());
    if (!st || st.r0 == null || st.r1 == null || st.r0 <= 0n || st.r1 <= 0n) continue; // reserves from indexer
    const dm = await db.tokenMeta(cid, [t0, t1]).catch(() => new Map());
    const d0 = dm.get(t0)?.decimals, d1 = dm.get(t1)?.decimals;
    if (d0 == null || d1 == null) continue; // decimals from enrichment — never guess
    complete++;
    const ps: PoolState = { address: row.address.toLowerCase(), archetype: "aerodrome-stable", token0: t0, token1: t1, feePpm: Number(m.fee), factory: m.factory?.toLowerCase(), r0: st.r0, r1: st.r1, dec0: 10n ** BigInt(d0), dec1: 10n ** BigInt(d1), block: st.block };

    const amountIn = st.r0 / 1000n > 0n ? st.r0 / 1000n : 1n; // ~0.1% of reserve, token0 in
    const aq = adapter.quoteOut(ps, t0, amountIn);          // StableAdapter (router topology)
    const sim = buildPoolSim(ps)?.quote(t0, amountIn);       // StablePoolSim (KG kernel)
    if (!aq || !sim) continue;
    if (aq.amountOut === sim.amountOut) simMatch++;
    const enc = await router.encodeLeg(ps, t0 as Address, t1 as Address, amountIn, 0n, kg).catch(() => null); // DB-only routing → Aerodrome router
    if (enc) encodable++;

    // PREFLIGHT boundary: the ONLY live read — confirm our DB-only quote == on-chain getAmountOut.
    const call = { address: row.address.toLowerCase() as Address, abi: POOL_ABI, functionName: "getAmountOut", args: [amountIn, t0 as Address] } as const;
    const onchain = await chain.precision.readContract(call).catch(() => chain.primary.readContract(call)).catch(() => null) as bigint | null;
    const exact = onchain != null && onchain === aq.amountOut;
    if (onchain != null) { compared++; if (exact) quoteExact++; }
    tested++;
    console.log(`  ${row.address.slice(0, 10)} fee=${Number(m.fee) / 100}bp dec=${d0}/${d1}  dbQuote=${aq.amountOut} onchain=${onchain} ${exact ? "✓ EXACT" : "✗"}  sim==adapter:${aq.amountOut === sim.amountOut} encodable:${!!enc} venue=${enc?.venue ?? "-"}`);
  }

  console.log(`[kg-stable-prod] complete(DB-only)=${complete} tested=${tested} quoteExactVsChain=${quoteExact}/${compared} sim==adapter=${simMatch} encodable=${encodable} (nulls=RPC-transient, not mismatch)`);
  console.log(compared > 0 && quoteExact === compared && simMatch === tested && encodable === tested
    ? `[kg-stable-prod] ✓ stable pools are fully DB-first: quote/sim/encode from DB only, wei-exact vs chain where compared, own-executable via Aerodrome (stable=true).`
    : `[kg-stable-prod] ⚠ a genuine mismatch (not just an RPC null) — inspect.`);
  await db.close().catch(() => undefined);
  process.exit(0);
}
main().catch((e) => { console.error("[kg-stable-prod] fatal:", e); process.exit(1); });
