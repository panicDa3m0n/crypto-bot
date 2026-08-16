import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { PriceOracle } from "./price-oracle.js";
import type { Aggregator } from "./aggregator.js";
import type { Blockscout } from "./blockscout.js";

// Morpho Blue Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, ...):
// topic1 = marketId, topic2 = borrower (onBehalf). The keyless event-discovery path.
const MORPHO_BORROW_TOPIC = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
// Morpho Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, ...):
// topic1 = marketId, topic2 = liquidator (caller), topic3 = borrower. Observability: who took the prey.
const MORPHO_LIQUIDATE_TOPIC = "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41";

// Per-cycle quote memo: the exit RATE of a (collateral,loan) pair is ~constant across a cycle's
// positions — only size differs. We quote each pair ONCE and scale to each position's seized size,
// instead of one HTTP quote per position (measured: 375 positions but only 17 distinct pairs). Keyed
// `collateral:loan` (lowercased). Only stable verdicts are cached — never a transient error.
type QuoteMemo = Map<string, { seizableRef: bigint; amountOutRef: bigint; status: "ok" | "no-route" }>;

/**
 * PositionRegistry — the COMPLETE, tiered registry of lending positions.
 *
 * Enumeration brings ALL borrowers (old static ones included — a forward-only scan misses exactly
 * those, and they're the dangerous dormant positions a price move liquidates). Each position is
 * classified into a tier and polled ADAPTIVELY:
 *   watch          — near the HF threshold; re-checked fast; the flash-kill is armed on these
 *   profitable      — healthy HF but a profitable liquidation IF it ever drops; checked rarely
 *                     (rarer the higher the HF)
 *   low_collateral  — exit value ≤ debt (bad debt / unprofitable); parked, re-checked slowly; if
 *                     it comes back alive it's promoted
 *   blacklist       — scam collateral (unverified/test); parked, re-evaluated periodically; if it
 *                     turns out legit it's promoted
 *   closed          — debt repaid; archived
 *
 * Two prices, as established: liquidatability uses the protocol's HF (its oracle — what the
 * contract checks); PROFIT uses OUR executable oracle (exit value of the seized collateral).
 *
 * This first version enumerates Morpho (family=morpho) via its API (which maintains full state,
 * so old positions are included). Other families (aave-v3, compound) plug into the same registry.
 */
type MorphoPos = { healthFactor: number; user: string; marketId: string; lltv: number; lltvRaw: string; collateral: { symbol: string; address: string; decimals: number }; loan: { symbol: string; address: string; decimals: number }; oracle: string; irm: string; collateralRaw: string; debtRaw: string; debtUsd: number; collateralUsd: number };

export class PositionRegistry {
  private enumTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private enumerating = false;
  private ticking = false;
  private readonly verifiedCache = new Map<string, boolean | null>();

  constructor(
    private readonly config: Config,
    private readonly chain: BerachainClients,
    private readonly db: Database,
    private readonly oracle: PriceOracle,
    private readonly aggregator: Aggregator,
    private readonly blockscout: Blockscout,
    private readonly logger: Logger,
    private readonly wake: (key: string, reason: string) => void
  ) {}

  /**
   * OUR executable exit of a liquidation, decided in LOAN-TOKEN units — NO USD in the decision.
   * A Morpho liquidation seizes min(collateral, debt·LIF worth) and repays min(debt, collateral/LIF);
   * we price ONLY that seized slice (pricing the full 23M-USDe stack crushes the pool and reports a
   * garbage exit). Both quantities are native loan-token raw:
   *   amountOutRaw  — loan tokens we RECEIVE selling the seized slice;
   *   debtRepaidRaw — loan tokens we REPAY to seize it.
   * Profit is simply amountOutRaw − debtRepaidRaw — no oracle price, no decimals, no fallback can
   * corrupt the sign. The quote is the AGGREGATOR (KyberSwap, all venues), which is authoritative:
   * it prices the trade across ticks and venues. We deliberately do NOT use our own single-tick
   * oracle here — that model is exact for small sizes but under/over-states a large seize that
   * crosses ticks (e.g. it valued a real +4.7-WETH weETH liquidation as a loss), which would create
   * both missed opportunities and mirages. The oracle stays for prices/display, not this decision.
   * Status distinguishes the outcomes the caller must not conflate:
   *   "ok"       → a real executable quote;
   *   "no-route" → the aggregator answered: genuinely unsellable at this size;
   *   "error"    → the CALL failed (rate-limit/network) → UNKNOWN, the caller must not judge.
   * The USD figures are computed LATER, for display only, from a cached price.
   */
  private async exitValue(collateralToken: string, collateralRaw: string, collateralUsd: number, debtRaw: string, debtUsd: number, lltv: number, loanToken: string, memo?: QuoteMemo): Promise<{ status: "ok" | "no-route" | "error"; amountOutRaw: bigint; debtRepaidRaw: bigint; source: string }> {
    const lif = this.lif(lltv);
    const seizeFraction = collateralUsd > 0 ? Math.min(1, (debtUsd * lif) / collateralUsd) : 1;   // slice of collateral seized
    const repaidFraction = debtUsd > 0 ? Math.min(1, (collateralUsd / lif) / debtUsd) : 1;         // slice of debt we can repay
    const frac6 = (x: number) => BigInt(Math.max(0, Math.round(x * 1_000_000)));
    const seizableRaw = BigInt(collateralRaw || "0") * frac6(seizeFraction) / 1_000_000n;
    const debtRepaidRaw = BigInt(debtRaw || "0") * frac6(repaidFraction) / 1_000_000n;
    if (seizableRaw <= 0n) return { status: "no-route", amountOutRaw: 0n, debtRepaidRaw, source: "none" };
    // DEDUP by pair: reuse this cycle's quote for the same (collateral,loan), scaling the amountOut
    // linearly to THIS position's seized size. Exact for deep pairs; for thin ones it's a screening
    // estimate that the fire path re-verifies at exact size. Only 'ok'/'no-route' are cached (stable);
    // a transient 'error' is never cached, so it doesn't poison the pair's other positions.
    const key = `${collateralToken.toLowerCase()}:${loanToken.toLowerCase()}`;
    const cached = memo?.get(key);
    if (cached) {
      if (cached.status === "no-route") return { status: "no-route", amountOutRaw: 0n, debtRepaidRaw, source: "memo" };
      return { status: "ok", amountOutRaw: cached.amountOutRef * seizableRaw / cached.seizableRef, debtRepaidRaw, source: "aggregator-memo" };
    }
    const res = await this.aggregator.quoteResult(collateralToken as `0x${string}`, loanToken as `0x${string}`, seizableRaw);
    if (res.status === "ok" && res.quote && res.quote.amountOut > 0n) {
      memo?.set(key, { seizableRef: seizableRaw, amountOutRef: res.quote.amountOut, status: "ok" });
      return { status: "ok", amountOutRaw: res.quote.amountOut, debtRepaidRaw, source: "aggregator" };
    }
    if (res.status !== "error") memo?.set(key, { seizableRef: seizableRaw, amountOutRef: 0n, status: "no-route" });
    return { status: res.status === "error" ? "error" : "no-route", amountOutRaw: 0n, debtRepaidRaw, source: "none" };
  }

  /** Loan-token raw → USD, for DISPLAY ONLY, using the loan decimals (from Morpho) and a cached
   * price (never a fresh read on the decision path). null when the price isn't known. */
  private async loanRawToUsd(amountRaw: bigint, loanToken: string, loanDecimals: number): Promise<number | null> {
    const { usd } = await this.oracle.usdPriceWithAge(loanToken).catch(() => ({ usd: null as number | null }));
    if (usd == null || !(usd > 0)) return null;
    return (Number(amountRaw) / 10 ** loanDecimals) * usd;
  }

  start(): void {
    void this.enumerate();
    this.enumTimer = setInterval(() => void this.enumerate().catch((e) => this.logger.error({ err: e }, "position enumerate failed")), this.config.LIQ_ENUM_INTERVAL_MS);
    this.tickTimer = setInterval(() => void this.tick().catch((e) => this.logger.error({ err: e }, "position tick failed")), this.config.LIQ_TICK_INTERVAL_MS);
  }
  stop(): void { if (this.enumTimer) clearInterval(this.enumTimer); if (this.tickTimer) clearInterval(this.tickTimer); }

  // --- enumeration: Morpho API → all positions (old + new) → upsert + classify -------------
  private async enumerate(): Promise<void> {
    if (this.enumerating || !this.config.LIQ_REGISTRY_ENABLED) return;
    this.enumerating = true;
    try {
      const all = await this.fetchMorpho().catch(() => []);
      let scanned = 0;
      const enumerated = new Set<string>();
      const classify: Record<string, number> = {}; // per-cycle outcome tally (watch/profitable/candidate/noRoute/unprofitable/quoteError/baddebt/blacklist) — surfaces the exit-quote failure rate
      const memo: QuoteMemo = new Map(); // dedup aggregator quotes by (collateral,loan) pair for THIS cycle
      for (const p of all) {
        enumerated.add(`${p.marketId}:${p.user}`);
        if (!(p.debtUsd >= this.config.LIQ_MIN_DEBT_USD)) continue;
        await this.db.upsertLendingPosition({
          chainId: this.config.CHAIN_ID, protocol: "morpho", marketId: p.marketId, borrower: p.user,
          collateralToken: p.collateral.address, collateralSymbol: p.collateral.symbol, loanToken: p.loan.address, loanSymbol: p.loan.symbol, lltv: p.lltv,
          meta: { oracle: p.oracle, irm: p.irm, lltv: p.lltvRaw, collateralDecimals: p.collateral.decimals, collateralRaw: p.collateralRaw, debtRaw: p.debtRaw, loanDecimals: p.loan.decimals }
        }).catch(() => undefined);
        // PROXIMITY-GATED classification: the costly part is exitValue (an aggregator quote). Run the
        // full classify only for the near band (HF ≤ LIQ_EXIT_HF); the farther pipeline is stored as a
        // lightweight "candidate" (known + HF-tracked, no quote). Each enumerate re-bands by fresh HF,
        // so a candidate that drops into the near band gets fully classified — and monitored — next cycle.
        const outcome = p.healthFactor <= this.config.LIQ_EXIT_HF ? await this.classifyAndStore(p, memo) : await this.storeCandidate(p);
        classify[outcome] = (classify[outcome] ?? 0) + 1;
        scanned += 1;
      }
      // Age out orphans: actionable positions this (and the prior ~1.5) enumerate no longer returned —
      // their market left scope (e.g. no longer marketListed). Otherwise they'd freeze in watch/profitable
      // and the monitor would keep reading them. Threshold = 2.5× the enumerate interval (tolerates a miss).
      const aged = await this.db.demoteStaleActionable(this.config.CHAIN_ID, (this.config.LIQ_ENUM_INTERVAL_MS / 1000) * 2.5).catch(() => 0);
      const counts = await this.db.lendingTierCounts(this.config.CHAIN_ID).catch(() => ({}));
      this.logger.info({ scanned, aged, fetched: all.length, classify, tiers: counts }, "position registry enumerated");
      if ((classify.quoteError ?? 0) > scanned * 0.2 && scanned > 20) this.logger.warn({ quoteError: classify.quoteError, scanned }, "HIGH exit-quote failure rate — aggregator likely rate-limited; classify incomplete this cycle (positions kept prior tier)");
      await this.crossCheckViaEvents(enumerated, all.length).catch((e) => this.logger.debug({ err: e }, "morpho event cross-check failed"));
      await this.scanLiquidations().catch((e) => this.logger.debug({ err: e }, "liquidation event scan failed"));
    } finally { this.enumerating = false; }
  }

  /**
   * Independent COMPLETENESS + RESILIENCE check: pull recent Morpho `Borrow` events from Blockscout
   * (keyless, wide-range, not bound by the RPC 10-block cap) and compare the active borrowers they
   * reveal against what the Morpho GraphQL enumerated. Surfaces two failure modes the API alone
   * hides: (1) borrowers the API MISSED (completeness gap), (2) the API returning empty while events
   * show live activity (the API is down → we'd otherwise go blind). It doesn't reclassify here — it
   * ensures we KNOW, and gives the on-chain fallback its borrower set. Base = 8453 only (Morpho core).
   */
  private async crossCheckViaEvents(enumerated: Set<string>, apiCount: number): Promise<void> {
    if (!this.blockscout.available || !this.config.MORPHO_CORE) return;
    const head = Number(await this.chain.primary.getBlockNumber().catch(() => 0n));
    const fromBlock = head > 0 ? Math.max(0, head - this.config.LIQ_EVENT_RANGE) : 0;
    const logs = await this.blockscout.contractLogs(this.config.MORPHO_CORE, { topic0: MORPHO_BORROW_TOPIC, fromBlock, toBlock: "latest" }).catch(() => null);
    if (!logs || !logs.length) return;
    const eventKeys = new Set<string>();
    for (const l of logs) {
      if ((l.topics[0] ?? "").toLowerCase() !== MORPHO_BORROW_TOPIC) continue;
      const marketId = l.topics[1]; const borrowerTopic = l.topics[2];
      if (!marketId || !borrowerTopic || borrowerTopic.length < 42) continue;
      const borrower = ("0x" + borrowerTopic.slice(-40)).toLowerCase(); // address = last 20 bytes of the topic
      eventKeys.add(`${marketId.toLowerCase()}:${borrower}`);
    }
    const missed = [...eventKeys].filter((k) => !enumerated.has(k));
    await this.db.saveMarketSnapshot("liq", "event-crosscheck", { observedAt: new Date().toISOString(), source: "blockscout", borrowEvents: logs.length, activeBorrowers: eventKeys.size, apiPositions: apiCount, missedByApi: missed.length }).catch(() => undefined);
    if (apiCount === 0 && eventKeys.size > 0) this.logger.warn({ activeBorrowers: eventKeys.size }, "Morpho API returned 0 but Borrow events show live borrowers — API likely DOWN, not a quiet market");
    else if (missed.length > 0) this.logger.info({ missedByApi: missed.length, activeBorrowers: eventKeys.size }, "Morpho event cross-check: borrowers seen on-chain but absent from the API enumeration");
    else this.logger.debug({ activeBorrowers: eventKeys.size }, "Morpho event cross-check: API complete vs recent events");
  }

  /** OBSERVABILITY: scan recent Morpho `Liquidate` events → record who took each prey. If the
   * liquidator was us (wallet/organ) it's a HIT; otherwise a MISS (prey we lost to another bot).
   * Dedup by tx. This is how we SEE what we missed and why, historized for analysis. */
  private async scanLiquidations(): Promise<void> {
    if (!this.blockscout.available || !this.config.MORPHO_CORE) return;
    const head = Number(await this.chain.primary.getBlockNumber().catch(() => 0n));
    const fromBlock = head > 0 ? Math.max(0, head - this.config.LIQ_EVENT_RANGE) : 0;
    const logs = await this.blockscout.contractLogs(this.config.MORPHO_CORE, { topic0: MORPHO_LIQUIDATE_TOPIC, fromBlock, toBlock: "latest" }).catch(() => null);
    if (!logs || !logs.length) return;
    const organ = (await this.db.getOrgan("atomic-executor").catch(() => undefined))?.address?.toLowerCase();
    const ours = new Set([this.config.WALLET_ADDRESS?.toLowerCase(), organ].filter(Boolean) as string[]);
    let missed = 0, hit = 0;
    for (const l of logs) {
      if ((l.topics[0] ?? "").toLowerCase() !== MORPHO_LIQUIDATE_TOPIC || l.topics.length < 4) continue;
      const marketId = (l.topics[1] ?? "").toLowerCase();
      const liquidator = ("0x" + (l.topics[2] ?? "").slice(-40)).toLowerCase();
      const borrower = ("0x" + (l.topics[3] ?? "").slice(-40)).toLowerCase();
      const isOurs = ours.has(liquidator);
      const pos = (await this.db.listLendingPositions(this.config.CHAIN_ID, { limit: 300 }).catch(() => [])).find((p) => p.marketId.toLowerCase() === marketId && p.borrower.toLowerCase() === borrower);
      // A "miss" is a prey WE FOUND AS ACTIONABLE (watch/profitable — we WANTED it) that another bot
      // took when it crossed. A liquidation of a position we never tracked, or that we'd judged
      // unprofitable (low_collateral/blacklist), is NOT a miss — record only our HITs + true misses.
      // The position was LIQUIDATED — retire it so the monitor stops watching a taken prey. If it was
      // only partially liquidated (still active), the next enumerate re-classifies it (overrides closed).
      if (pos) await this.db.closeLendingPosition(this.config.CHAIN_ID, "morpho", marketId, borrower, `liquidated ${isOurs ? "by us" : "by another bot"} (Liquidate event)`).catch(() => undefined);
      const actionable = pos && (pos.tier === "watch" || pos.tier === "profitable");
      if (!isOurs && !actionable) continue; // not our prey → not a miss, skip
      await this.db.recordLiquidationEvent({
        chainId: this.config.CHAIN_ID, kind: isOurs ? "hit" : "missed", protocol: "morpho", marketId, borrower,
        collateralSymbol: pos?.collateralSymbol ?? undefined, loanSymbol: pos?.loanSymbol ?? undefined, debtUsd: pos?.debtUsd ?? undefined, profitUsd: pos?.profitUsd ?? undefined,
        txHash: l.txHash, liquidator, note: isOurs ? "liquidated by us" : "found-actionable prey lost to another liquidator", meta: { blockNumber: l.blockNumber, tier: pos?.tier }
      }).catch(() => undefined);
      if (isOurs) hit += 1; else missed += 1;
    }
    if (missed || hit) this.logger.info({ missed, hit, scanned: logs.length }, "liquidation events recorded (missed=lost to others, hit=ours)");
  }

  /** Classify a position: scam → bad-debt (cheap, Morpho oracle) → for the survivors near the
   * threshold, CONFIRM with our SIZED executable exit value. Reschedule by tier. */
  private async classifyAndStore(p: MorphoPos, memo?: QuoteMemo): Promise<string> {
    const scam = await this.isScam(p.collateral.address, p.collateral.symbol);
    let tier: string, reason: string, outcome: string; let exitUsd: number | null = null; let profitUsd: number | null = null;
    if (scam) { tier = "blacklist"; outcome = "blacklist"; reason = `scam/unverified collateral (${p.collateral.symbol})`; }
    else if (!(p.collateralUsd > p.debtUsd)) { tier = "low_collateral"; outcome = "baddebt"; reason = `bad debt — collateral $${p.collateralUsd.toFixed(0)} ≤ debt $${p.debtUsd.toFixed(0)} (Morpho oracle)`; }
    else {
      // Morpho says collateral covers debt — but is that REAL? Confirm with the executable exit
      // (our oracle → aggregator, all venues, sized). Profit = min(exit, debt·LIF) − debt. This is
      // what unmasks oracle mirages (e.g. wbCOIN: Morpho oracle $478 but the DEX exit ~$210 < debt).
      const exit = await this.exitValue(p.collateral.address, p.collateralRaw, p.collateralUsd, p.debtRaw, p.debtUsd, p.lltv, p.loan.address, memo);
      // Transient failure — we simply don't know the exit. Do NOT judge sellability (that's how a
      // liquid token gets falsely junked); leave the prior tier and re-check next cycle. Counted +
      // surfaced in the enumerate aggregate (this is the exit-quote failure rate we watch).
      if (exit.status === "error") { this.logger.debug({ borrower: p.user, collateral: p.collateral.symbol }, "exit unknown (transient) — keeping prior tier"); return "quoteError"; }
      // THE DECISION, in loan-token raw units: profitable ⇔ we receive more loan tokens than we repay.
      const profitRaw = exit.amountOutRaw - exit.debtRepaidRaw;
      const profitable = exit.status === "ok" && profitRaw > 0n;
      // USD is computed here ONLY for display (cached price); it never drives the decision above.
      profitUsd = exit.status === "ok" ? await this.loanRawToUsd(profitRaw, p.loan.address, p.loan.decimals) : null;
      exitUsd = exit.status === "ok" ? await this.loanRawToUsd(exit.amountOutRaw, p.loan.address, p.loan.decimals) : null;
      const pu = profitUsd != null ? `~$${profitUsd.toFixed(0)}` : `${(Number(profitRaw) / 10 ** p.loan.decimals).toFixed(4)} ${p.loan.symbol}`;
      if (exit.status === "no-route") { tier = "low_collateral"; outcome = "noRoute"; reason = `NO verifiable DEX exit — ${p.collateral.symbol} not routable on any venue at seized size; can't confirm sellable`; }
      else if (!profitable) { tier = "low_collateral"; outcome = "unprofitable"; reason = `no liquidation profit — seized exit ${(Number(exit.amountOutRaw) / 10 ** p.loan.decimals).toFixed(2)} ${p.loan.symbol} ≤ debt repaid ${(Number(exit.debtRepaidRaw) / 10 ** p.loan.decimals).toFixed(2)} (${exit.source})`; }
      else if (p.healthFactor <= this.config.LIQ_WATCH_HF) { tier = "watch"; outcome = "watch"; reason = `HF ${p.healthFactor.toFixed(3)} — armed; liq profit ${pu} (exit ${exit.source})`; }
      else { tier = "profitable"; outcome = "profitable"; reason = `HF ${p.healthFactor.toFixed(3)} healthy; would net ${pu} if hf<1 (exit ${exit.source})`; }
    }
    await this.db.setLendingTier(this.config.CHAIN_ID, "morpho", p.marketId, p.user, {
      tier, reason, hf: p.healthFactor, debtUsd: p.debtUsd, collateralUsd: p.collateralUsd, exitUsd, profitUsd, nextCheckSec: this.nextCheckSec(tier, p.healthFactor)
    }).catch(() => undefined);
    if (tier === "watch" && p.healthFactor < 1) {
      this.wake(`liq:${p.user}:${p.marketId}`, `LIQUIDATABLE + profitable: ${p.collateral.symbol}/${p.loan.symbol} borrower ${p.user.slice(0, 10)}… HF ${p.healthFactor.toFixed(3)}, exit ${exitUsd != null ? "$" + exitUsd.toFixed(0) : "covers"} > debt $${p.debtUsd.toFixed(0)}. Arm/fire the flash-kill.`);
    }
    return outcome;
  }

  /** Lightweight store for the FAR pipeline (HF > LIQ_EXIT_HF): record it exists + its HF/size, but do
   * NOT spend an aggregator quote on it yet. `candidate` = collateral covers debt per Morpho, not yet
   * exit-verified; a far husk (collateral ≤ debt) is parked as low_collateral. The next enumerate that
   * finds it in the near band runs the full classify (and the monitor then covers it). */
  private async storeCandidate(p: MorphoPos): Promise<string> {
    const solid = p.collateralUsd > p.debtUsd;
    const tier = solid ? "candidate" : "low_collateral";
    const reason = solid
      ? `HF ${p.healthFactor.toFixed(3)} — pipeline; exit unquoted until HF ≤ ${this.config.LIQ_EXIT_HF}`
      : `bad debt — collateral $${p.collateralUsd.toFixed(0)} ≤ debt $${p.debtUsd.toFixed(0)} (Morpho oracle)`;
    await this.db.setLendingTier(this.config.CHAIN_ID, "morpho", p.marketId, p.user, {
      tier, reason, hf: p.healthFactor, debtUsd: p.debtUsd, collateralUsd: p.collateralUsd, exitUsd: null, profitUsd: null, nextCheckSec: this.nextCheckSec(tier, p.healthFactor)
    }).catch(() => undefined);
    return solid ? "candidate" : "baddebt";
  }

  /** Morpho liquidation incentive factor from LLTV: LIF = min(1.15, 1/(1 − 0.3·(1−LLTV))). */
  private lif(lltv: number): number { return lltv > 0 && lltv < 1 ? Math.min(1.15, 1 / (1 - 0.3 * (1 - lltv))) : 1.05; }

  /** Adaptive re-check interval: watch fast; profitable rarer the safer; parked slow. */
  private nextCheckSec(tier: string, hf: number): number {
    switch (tier) {
      case "watch": return 20;
      case "profitable": return Math.min(3600, Math.max(120, Math.round(120 * hf))); // HF 1.1→132s, HF 3→360s, HF 5→600s (capped 1h)
      case "candidate": return 600; // far pipeline — enumerate re-bands it every cycle; tick doesn't quote it
      case "pending": return 300;   // not yet classified — enumerate will classify it with a fresh HF
      case "low_collateral": return 1800;
      case "blacklist": return 7200;
      default: return 3600;
    }
  }

  /** Scam gate: collateral token unverified in the registry, blacklisted, or a *TEST* market. */
  private async isScam(token: string, symbol: string): Promise<boolean> {
    if (/TEST|MOCK/i.test(symbol)) return true;
    const k = token.toLowerCase();
    if (this.verifiedCache.has(k)) { const v = this.verifiedCache.get(k); return v === false; }
    const e = await this.db.getEntity(this.config.CHAIN_ID, k).catch(() => []);
    const tokenRow = e.find((x) => x.kind === "token");
    const verified = tokenRow?.meta && typeof tokenRow.meta === "object" ? (tokenRow.meta as Record<string, unknown>).verified : undefined;
    const v = verified === undefined ? null : Boolean(verified);
    this.verifiedCache.set(k, v);
    return v === false; // only demote when we've POSITIVELY found it unverified
  }

  // --- adaptive tick: process due positions (fast-lane for watch) --------------------------
  private async tick(): Promise<void> {
    if (this.ticking || !this.config.LIQ_REGISTRY_ENABLED) return;
    this.ticking = true;
    try {
      const due = await this.db.dueLendingPositions(this.config.CHAIN_ID, 60).catch(() => []);
      if (!due.length) return;
      // Re-evaluate the profit gate with a FRESH oracle exit value + reschedule per tier. HF is
      // refreshed by enumerate (Morpho oracle); the exit value (ours) is re-checked here fast.
      const memo: QuoteMemo = new Map(); // dedup aggregator quotes by pair across this due-batch
      for (const pos of due) {
        const hf = pos.hf ?? 2; const debt = pos.debtUsd ?? 0;
        // Candidates (far pipeline) and pending (not yet classified) are never quoted by the tick — the
        // enumerate classifies/promotes them with a fresh HF. Blacklist/bad-debt are likewise rescheduled.
        if (pos.tier === "blacklist" || pos.tier === "candidate" || pos.tier === "pending" || (pos.collateralUsd ?? 0) <= debt) { await this.reschedule(pos.protocol, pos.marketId, pos.borrower, pos.tier, hf); continue; }
        // Re-confirm the profit gate with a FRESH SIZED exit value (our oracle), reschedule per tier.
        const meta = (pos.meta ?? {}) as Record<string, unknown>;
        const collRaw = String(meta.collateralRaw ?? "0");
        const debtRaw = String(meta.debtRaw ?? "0");
        const loanDec = Number(meta.loanDecimals ?? 18);
        if (!(pos.collateralToken && pos.loanToken && BigInt(collRaw) > 0n)) { await this.reschedule(pos.protocol, pos.marketId, pos.borrower, pos.tier, hf); continue; }
        const exit = await this.exitValue(pos.collateralToken, collRaw, pos.collateralUsd ?? 0, debtRaw, debt, pos.lltv ?? 0.9, pos.loanToken, memo);
        if (exit.status === "error") { await this.reschedule(pos.protocol, pos.marketId, pos.borrower, pos.tier, hf); continue; } // transient — keep prior tier
        const profitRaw = exit.amountOutRaw - exit.debtRepaidRaw;              // THE DECISION: loan-token native
        const profitable = exit.status === "ok" && profitRaw > 0n;
        const profitUsd = exit.status === "ok" ? await this.loanRawToUsd(profitRaw, pos.loanToken, loanDec) : null; // display only
        const exitUsd = exit.status === "ok" ? await this.loanRawToUsd(exit.amountOutRaw, pos.loanToken, loanDec) : null;
        const noExit = exit.status === "no-route";
        const tier = noExit || !profitable ? "low_collateral" : hf <= this.config.LIQ_WATCH_HF ? "watch" : "profitable";
        const pu = profitUsd != null ? `~$${profitUsd.toFixed(0)}` : `${(Number(profitRaw) / 10 ** loanDec).toFixed(4)} ${pos.loanSymbol}`;
        const reason = noExit ? `NO verifiable DEX exit — ${pos.collateralSymbol} not routable at seized size; can't confirm sellable`
          : !profitable ? `no liquidation profit — seized exit ${(Number(exit.amountOutRaw) / 10 ** loanDec).toFixed(2)} ${pos.loanSymbol} ≤ debt repaid ${(Number(exit.debtRepaidRaw) / 10 ** loanDec).toFixed(2)}`
          : `HF ${hf.toFixed(3)} — liq profit ${pu} (exit ${exit.source})`;
        await this.db.setLendingTier(this.config.CHAIN_ID, pos.protocol, pos.marketId, pos.borrower, { tier, reason, hf, debtUsd: pos.debtUsd, collateralUsd: pos.collateralUsd, exitUsd, profitUsd, nextCheckSec: this.nextCheckSec(tier, hf) }).catch(() => undefined);
        if (tier === "watch" && hf < 1 && profitable) this.wake(`liq:${pos.borrower}:${pos.marketId}`, `LIQUIDATABLE + profitable: ${pos.collateralSymbol}/${pos.loanSymbol} HF ${hf.toFixed(3)}, liq profit ${pu}. Fire the flash-kill.`);
      }
    } finally { this.ticking = false; }
  }

  private async reschedule(protocol: string, marketId: string, borrower: string, tier: string, hf: number): Promise<void> {
    await this.db.setLendingTier(this.config.CHAIN_ID, protocol, marketId, borrower, { tier, nextCheckSec: this.nextCheckSec(tier, hf) }).catch(() => undefined);
  }

  // --- Morpho enumeration (paginated; maintains full state incl. old positions) ------------
  private async fetchMorpho(): Promise<MorphoPos[]> {
    const out: MorphoPos[] = [];
    const q = `query($c:[Int!],$hf:Float!,$ml:Boolean,$skip:Int){ marketPositions(first:100, skip:$skip, orderBy:HealthFactor, orderDirection:Asc, where:{chainId_in:$c, marketListed:$ml, healthFactor_lte:$hf}){ items { healthFactor user{address} market{ marketId lltv irmAddress oracle{address} collateralAsset{symbol address decimals} loanAsset{symbol address decimals} } state{ borrowAssets borrowAssetsUsd collateralUsd collateral } } } }`;
    const ml = this.config.LIQ_MARKET_LISTED_ONLY ? true : null; // null = don't filter; true = curated markets only (drops junk-market husks at the source)
    for (let skip = 0; skip < this.config.LIQ_ENUM_MAX_PAGES * 100; skip += 100) {
      const j = await this.gql<{ marketPositions: { items: RawMPos[] } }>(q, { c: [this.config.CHAIN_ID], hf: this.config.LIQ_HF_CEIL, ml, skip }).catch(() => undefined);
      const items = j?.marketPositions?.items ?? [];
      for (const it of items) {
        const m = it.market; if (!m?.collateralAsset || !m.loanAsset) continue;
        out.push({
          healthFactor: Number(it.healthFactor ?? 0), user: (it.user?.address ?? "").toLowerCase(), marketId: m.marketId ?? "",
          lltv: Number(m.lltv ?? 0) / 1e18, lltvRaw: String(m.lltv ?? "0"), collateral: { symbol: m.collateralAsset.symbol ?? "?", address: (m.collateralAsset.address ?? "").toLowerCase(), decimals: Number(m.collateralAsset.decimals ?? 18) },
          loan: { symbol: m.loanAsset.symbol ?? "?", address: (m.loanAsset.address ?? "").toLowerCase(), decimals: Number(m.loanAsset.decimals ?? 18) }, oracle: (m.oracle?.address ?? "").toLowerCase(), irm: (m.irmAddress ?? "").toLowerCase(),
          collateralRaw: String(it.state?.collateral ?? "0"), debtRaw: String(it.state?.borrowAssets ?? "0"), debtUsd: Number(it.state?.borrowAssetsUsd ?? 0), collateralUsd: Number(it.state?.collateralUsd ?? 0)
        });
      }
      if (items.length < 100) break; // last page
    }
    return out;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const r = await fetch(this.config.MORPHO_API_URL.replace("api.morpho.org", "blue-api.morpho.org"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000) });
    const j = await r.json() as { data?: T };
    if (!j.data) throw new Error("morpho gql: no data");
    return j.data;
  }
}
type RawMPos = { healthFactor?: number; user?: { address?: string }; market?: { marketId?: string; lltv?: string; oracle?: { address?: string }; irmAddress?: string; collateralAsset?: { symbol?: string; address?: string; decimals?: number }; loanAsset?: { symbol?: string; address?: string; decimals?: number } }; state?: { borrowAssets?: string; borrowAssetsUsd?: number; collateralUsd?: number; collateral?: string } };
