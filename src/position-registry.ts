import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { PriceOracle } from "./price-oracle.js";
import type { Aggregator } from "./aggregator.js";
import type { Blockscout } from "./blockscout.js";
import { liquidationIncentiveFactor } from "./morpho.js";

// Morpho Blue Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, ...):
// topic1 = marketId, topic2 = borrower (onBehalf). The keyless event-discovery path.
const MORPHO_BORROW_TOPIC = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
// Morpho Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, ...):
// topic1 = marketId, topic2 = liquidator (caller), topic3 = borrower. Observability: who took the prey.
const MORPHO_LIQUIDATE_TOPIC = "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41";
// Reading a borrower's size straight from Morpho: position() gives collateral + borrow SHARES, market()
// the totals that turn shares into assets. Same pair the liquidation monitor uses — one shape, one meaning.
const MORPHO_POS_ABI = parseAbi([
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)"
]);
const ORACLE_PRICE_ABI = parseAbi(["function price() view returns (uint256)"]);
// Below this share of spot value, an exit quote is suspicious enough to be re-read before it is believed.
const EXIT_SANITY_RATIO = 0.85;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

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
   * Swallow a DB write failure WITHOUT making it invisible.
   *
   * These writes are deliberately non-fatal — one failed upsert must not kill a drain cycle. But
   * `.catch(() => undefined)` also erases the evidence, and that is how half the defects in this system
   * survived: a tier that never changed, an attempt counter that never incremented, a reschedule that did
   * nothing. Failures are counted and reported on a throttle, so the pipeline still tolerates them while a
   * persistent problem becomes something you can see rather than something you have to infer.
   */
  private writeFailures = 0;
  private lastWriteFailAt = 0;
  private readonly swallowWrite = (e: unknown): undefined => {
    this.writeFailures += 1;
    if (Date.now() - this.lastWriteFailAt > 60_000) {
      this.lastWriteFailAt = Date.now();
      this.logger.warn({ failures: this.writeFailures, last: e instanceof Error ? e.message.slice(0, 140) : String(e).slice(0, 140) }, "DB writes are failing and being swallowed — investigate");
    }
    return undefined;
  };

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
      // SANITY-CHECK THE QUOTE AGAINST WHAT WE ALREADY KNOW.
      //
      // A degraded quote sails through as "ok" and becomes a VERDICT: we recorded an exit implying $1.2208
      // for cbXRP while our own fresh price feed, the collateral valuation and the aggregator itself all said
      // $1.48. On that number we rejected a liquidation as unprofitable — and another liquidator took it for
      // +$198. The three-way status already says a failed CALL must not be judged; a quote that contradicts
      // our own data deserves the same treatment.
      //
      // Illiquidity is REAL though: some collateral genuinely sells far below its quoted price, and refusing
      // to believe that would be the opposite error. So the discriminator is measurement, not a threshold —
      // re-quote once, and only distrust the number if the second read disagrees with the first.
      const verdict = await this.plausibleExit(collateralToken, loanToken, seizableRaw, res.quote.amountOut);
      if (verdict === "unreliable") return { status: "error", amountOutRaw: 0n, debtRepaidRaw, source: "quote-inconsistent" };
      memo?.set(key, { seizableRef: seizableRaw, amountOutRef: res.quote.amountOut, status: "ok" });
      return { status: "ok", amountOutRaw: res.quote.amountOut, debtRepaidRaw, source: "aggregator" };
    }
    if (res.status !== "error") memo?.set(key, { seizableRef: seizableRaw, amountOutRef: 0n, status: "no-route" });
    return { status: res.status === "error" ? "error" : "no-route", amountOutRaw: 0n, debtRepaidRaw, source: "none" };
  }


  /**
   * Is this exit quote consistent with what we already know? Returns "unreliable" only when a SECOND read
   * disagrees with the first — a stable low number means the collateral really is illiquid, which is a fact
   * we must keep believing.
   */
  private async plausibleExit(collateralToken: string, loanToken: string, seizableRaw: bigint, amountOut: bigint): Promise<"plausible" | "unreliable"> {
    const [cPx, lPx] = await Promise.all([
      this.oracle.usdPrice(collateralToken).catch(() => null),
      this.oracle.usdPrice(loanToken).catch(() => null),
    ]);
    if (cPx == null || lPx == null || !(cPx > 0) || !(lPx > 0)) return "plausible"; // nothing to compare against
    const cDec = await this.tokenDecimals(collateralToken), lDec = await this.tokenDecimals(loanToken);
    if (cDec == null || lDec == null) return "plausible";
    const soldUsd = (Number(seizableRaw) / 10 ** cDec) * cPx;
    const gotUsd = (Number(amountOut) / 10 ** lDec) * lPx;
    if (!(soldUsd > 0)) return "plausible";
    const ratio = gotUsd / soldUsd;
    if (ratio >= EXIT_SANITY_RATIO) return "plausible";
    // Suspicious: ask again. A transient bad route will not reproduce; genuine illiquidity will.
    const second = await this.aggregator.quoteResult(collateralToken as `0x${string}`, loanToken as `0x${string}`, seizableRaw);
    if (second.status !== "ok" || !second.quote || second.quote.amountOut <= 0n) return "unreliable";
    const gotUsd2 = (Number(second.quote.amountOut) / 10 ** lDec) * lPx;
    const agree = Math.abs(gotUsd2 - gotUsd) / Math.max(gotUsd, 1) < 0.05;
    if (!agree) {
      this.logger.warn({ collateral: collateralToken.slice(0, 12), first: Math.round(gotUsd), second: Math.round(gotUsd2), expected: Math.round(soldUsd) },
        "exit quotes disagree with each other — treating as UNKNOWN rather than judging the position unprofitable");
      return "unreliable";
    }
    this.logger.debug({ collateral: collateralToken.slice(0, 12), ratio: Number(ratio.toFixed(3)) }, "exit well below spot but reproducible — real illiquidity");
    return "plausible";
  }

  /** Token decimals from the registry (never guessed — an unknown one makes the comparison meaningless). */
  private async tokenDecimals(token: string): Promise<number | null> {
    const m = await this.db.tokenMeta(this.config.CHAIN_ID, [token.toLowerCase()]).catch(() => new Map());
    const d = m.get(token.toLowerCase())?.decimals;
    return typeof d === "number" ? d : null;
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
        }).catch(this.swallowWrite);
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
      const aged = await this.retireConfirmedEmpty((this.config.LIQ_ENUM_INTERVAL_MS / 1000) * 2.5).catch((e) => { this.logger.warn({ err: e }, "stale-actionable confirmation failed — nothing retired (correct: never retire on an unread)"); return 0; });
      const counts = await this.db.lendingTierCounts(this.config.CHAIN_ID).catch(() => ({}));
      this.logger.info({ scanned, aged, fetched: all.length, classify, tiers: counts }, "position registry enumerated");
      if ((classify.quoteError ?? 0) > scanned * 0.2 && scanned > 20) this.logger.warn({ quoteError: classify.quoteError, scanned }, "HIGH exit-quote failure rate — aggregator likely rate-limited; classify incomplete this cycle (positions kept prior tier)");
      await this.crossCheckViaEvents(enumerated, all.length).catch((e) => this.logger.debug({ err: e }, "morpho event cross-check failed"));
      await this.scanLiquidations().catch((e) => this.logger.debug({ err: e }, "liquidation event scan failed"));
    } finally { this.enumerating = false; }
  }

  /**
   * Retire ONLY the positions the CHAIN says are empty.
   *
   * The Morpho API is a discovery source. It is not, and has never been, an authority on whether a debt
   * exists — it filters by `marketListed`, by a health-factor ceiling and by pagination, so a live position
   * can leave the result set for half a dozen reasons that have nothing to do with the borrower repaying.
   * We nonetheless treated its silence as proof and archived 10,712 positions on it.
   *
   * So the question goes where the answer lives: one batched `position()` read on the bulk lane. Empty
   * (no borrow shares) → genuinely gone, retire it. Still borrowing → it stays exactly where it was, and we
   * record that the API stopped naming it, which is a fact worth having about the API. A read that FAILS
   * retires nothing — an unread must never be stronger evidence than an unanswered API.
   */
  private async retireConfirmedEmpty(olderThanSec: number): Promise<number> {
    const morpho = this.config.MORPHO_CORE as Address | undefined;
    const stale = await this.db.staleActionableCandidates(this.config.CHAIN_ID, olderThanSec).catch(() => []);
    if (!stale.length) return 0;
    if (!morpho) { this.logger.warn({ stale: stale.length }, "cannot confirm stale positions on-chain (no MORPHO_CORE) — keeping them ALL rather than archiving unread"); return 0; }
    const { results, laneFailed } = await this.chain.bulkRead(
      stale.map((p) => ({ address: morpho, abi: MORPHO_POS_ABI, functionName: "position" as const, args: [p.marketId as `0x${string}`, p.borrower as Address] })),
      { label: "morpho-confirm-stale" }
    );
    if (laneFailed) { this.logger.warn({ stale: stale.length }, "stale-position confirmation could not read the chain — nothing retired"); return 0; }
    let retired = 0, alive = 0, unread = 0;
    for (let i = 0; i < stale.length; i++) {
      const p = stale[i], r = results[i];
      if (r?.status !== "success" || !Array.isArray(r.result)) { unread += 1; continue; } // unknown ⇒ untouched
      const borrowShares = (r.result as bigint[])[1];
      if (borrowShares === 0n) {
        await this.db.closeLendingPosition(this.config.CHAIN_ID, p.protocol, p.marketId, p.borrower, "debt repaid — confirmed empty on-chain").catch(this.swallowWrite);
        retired += 1;
      } else {
        await this.db.markUnenumerated(this.config.CHAIN_ID, p.protocol, p.marketId, p.borrower, this.nextCheckSec(p.tier, p.hf ?? 1.05)).catch(this.swallowWrite);
        alive += 1;
      }
    }
    if (alive || unread) this.logger.info({ retired, aliveButUnenumerated: alive, unread, checked: stale.length }, "stale-position confirmation: the API stopped naming these, the chain says otherwise");
    return retired;
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
    await this.db.saveMarketSnapshot("liq", "event-crosscheck", { observedAt: new Date().toISOString(), source: "blockscout", borrowEvents: logs.length, activeBorrowers: eventKeys.size, apiPositions: apiCount, missedByApi: missed.length }).catch(this.swallowWrite);
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
    const organ = (await this.db.getOrgan("atomic-executor").catch(this.swallowWrite))?.address?.toLowerCase();
    const ours = new Set([this.config.WALLET_ADDRESS?.toLowerCase(), organ].filter(Boolean) as string[]);
    let missed = 0, hit = 0;
    const byCause: Record<string, number> = {}; // WHY each one got away — the number that was missing
    for (const l of logs) {
      if ((l.topics[0] ?? "").toLowerCase() !== MORPHO_LIQUIDATE_TOPIC || l.topics.length < 4) continue;
      const marketId = (l.topics[1] ?? "").toLowerCase();
      const liquidator = ("0x" + (l.topics[2] ?? "").slice(-40)).toLowerCase();
      const borrower = ("0x" + (l.topics[3] ?? "").slice(-40)).toLowerCase();
      const isOurs = ours.has(liquidator);
      // ANY tier, `closed` included, and looked up directly instead of scanning the actionable list once per
      // log. The old lookup could not see an archived position, so a liquidation of one we had wrongly closed
      // was indistinguishable from a liquidation of a stranger — and both were silently dropped.
      const pos = await this.db.lendingPositionAnyTier(this.config.CHAIN_ID, "morpho", marketId, borrower).catch(() => undefined);
      // The position was LIQUIDATED — retire it so the monitor stops watching a taken prey. If it was
      // only partially liquidated (still active), the next enumerate re-classifies it (overrides closed).
      if (pos) await this.db.closeLendingPosition(this.config.CHAIN_ID, "morpho", marketId, borrower, `liquidated ${isOurs ? "by us" : "by another bot"} (Liquidate event)`).catch(this.swallowWrite);
      // RECORD EVERY LIQUIDATION, and let the DATA say what kind of loss it was.
      //
      // This used to record a miss only for prey we held in watch/profitable, on the reasoning that anything
      // else was not "ours to lose". That reasoning is what made every OTHER failure mode invisible: a
      // position we archived on a silent API, one we discarded on a single bad quote, one we never
      // discovered — all indistinguishable from a liquidation that was none of our business. Measured over
      // 72h: the chain performed 83 Morpho liquidations and this counter reported 3.
      //
      // A liquidation we did not take is a lost opportunity until proven otherwise, so it is recorded with
      // the reason we did not act. `lostBecause` is the analysis that was missing.
      const tier = pos?.tier ?? null;
      const lostBecause = isOurs ? null
        : !pos ? "never-discovered"
        : tier === "watch" || tier === "profitable" ? "watched-but-lost"
        : tier === "closed" && /aged out/.test(pos.reason ?? "") ? "archived-on-api-silence"
        : tier === "low_collateral" ? "judged-unprofitable"
        : tier === "blacklist" ? "judged-scam"
        : tier === "candidate" ? "not-yet-quoted"
        : `tier:${tier}`;
      await this.db.recordLiquidationEvent({
        chainId: this.config.CHAIN_ID, kind: isOurs ? "hit" : "missed", protocol: "morpho", marketId, borrower,
        collateralSymbol: pos?.collateralSymbol ?? undefined, loanSymbol: pos?.loanSymbol ?? undefined, debtUsd: pos?.debtUsd ?? undefined, profitUsd: pos?.profitUsd ?? undefined,
        txHash: l.txHash, liquidator, note: isOurs ? "liquidated by us" : `lost to another liquidator — ${lostBecause}`,
        meta: { blockNumber: l.blockNumber, tier, lostBecause, exitUsd: pos?.exitUsd ?? null, reasonAtLoss: (pos?.reason ?? "").slice(0, 160) }
      }).catch(this.swallowWrite);
      if (isOurs) hit += 1; else { missed += 1; byCause[lostBecause!] = (byCause[lostBecause!] ?? 0) + 1; }
    }
    if (missed || hit) this.logger.info({ missed, hit, scanned: logs.length, byCause }, "liquidation events recorded (missed=lost to others, hit=ours)");
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
    }).catch(this.swallowWrite);
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
    }).catch(this.swallowWrite);
    return solid ? "candidate" : "baddebt";
  }

  /**
   * RESOLVE the positions the INDEXER discovered.
   *
   * There are two discovery sources — the Morpho API (enumerate) and the indexer's Borrow events — but only
   * one classification path, and it was tied to the API. A position the API never returns therefore entered
   * tier `pending` and stayed there for ever: enumerate never saw it, and the tick explicitly skipped it
   * "because enumerate will classify it". 8,624 positions sat in that hole for days, unvalued.
   *
   * What they lack is size and health, and both are ON-CHAIN — so we read them rather than wait: position()
   * for the borrower's collateral and borrow shares, market() to turn shares into assets, and the market's
   * oracle for the price. Bounded per tick and on the BULK lane, never the monitor's precision lane: this is
   * background completion work and must not contend with the per-block liquidation watch.
   */
  private async resolvePending(rows: Array<{ marketId: string; borrower: string; loanToken: string | null; collateralToken: string | null; lltv: number | null; meta: unknown }>): Promise<number> {
    const morpho = this.config.MORPHO_CORE as Address | undefined;
    if (!morpho || !rows.length) return 0;
    const markets = [...new Set(rows.map((r) => r.marketId.toLowerCase()))];
    const oracles = [...new Set(rows.map((r) => String(((r.meta ?? {}) as Record<string, unknown>).oracle ?? "").toLowerCase()).filter((o) => o && o !== "0x"))];
    const contracts = [
      ...rows.map((r) => ({ address: morpho, abi: MORPHO_POS_ABI, functionName: "position" as const, args: [r.marketId as `0x${string}`, r.borrower as Address] })),
      ...markets.map((id) => ({ address: morpho, abi: MORPHO_POS_ABI, functionName: "market" as const, args: [id as `0x${string}`] })),
      ...oracles.map((o) => ({ address: o as Address, abi: ORACLE_PRICE_ABI, functionName: "price" as const })),
    ];
    // Governed batch: this read is wide (positions + markets + oracles) and an all-empty answer must be read
    // as "we could not ask", never as "these positions are gone" — see chain.bulkRead.
    const { results: res } = await this.chain.bulkRead(contracts, { label: "morpho-resolve-pending" })
      .catch(() => ({ results: [] as Array<{ status: string; result?: unknown }>, laneFailed: true }));
    if (!res.length) return 0;
    const totals = new Map<string, { tba: bigint; tbs: bigint }>();
    markets.forEach((id, i) => { const r = res[rows.length + i]; if (r?.status === "success" && Array.isArray(r.result)) totals.set(id, { tba: (r.result as bigint[])[2], tbs: (r.result as bigint[])[3] }); });
    const priceByOracle = new Map<string, bigint>();
    oracles.forEach((o, i) => { const r = res[rows.length + markets.length + i]; if (r?.status === "success" && typeof r.result === "bigint") priceByOracle.set(o, r.result); });

    let resolved = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], r = res[i];
      if (r?.status !== "success" || !Array.isArray(r.result)) continue; // read failed → stays pending, retried
      const meta = (row.meta ?? {}) as Record<string, unknown>;
      const mt = totals.get(row.marketId.toLowerCase());
      const oracle = String(meta.oracle ?? "").toLowerCase();
      const price = priceByOracle.get(oracle);
      const borrowShares = (r.result as bigint[])[1], collateral = (r.result as bigint[])[2];
      // Debt REPAID is what the borrower owes in assets: shares → assets via the market totals, rounded up
      // the way Morpho itself rounds it. No totals ⇒ we cannot state the debt, so we do not guess one.
      if (!mt || price == null) continue;
      const borrowAssets = mt.tbs === 0n || borrowShares === 0n ? 0n : (borrowShares * mt.tba + mt.tbs - 1n) / mt.tbs;
      const lltvRaw = BigInt(String(meta.lltv ?? "0"));
      if (borrowAssets === 0n) { // no debt left → the position is closed, which is a FACT, not an omission
        await this.db.setLendingTier(this.config.CHAIN_ID, "morpho", row.marketId, row.borrower, { tier: "closed", reason: "no borrow shares on chain — debt repaid", hf: null, debtUsd: 0, collateralUsd: null, exitUsd: null, profitUsd: null, nextCheckSec: 86_400 }).catch(this.swallowWrite);
        resolved++; continue;
      }
      // Morpho's own health test: maxBorrow = collateral · price / 1e36 · lltv / 1e18, HF = maxBorrow / debt.
      const maxBorrow = (collateral * price) / 10n ** 36n * lltvRaw / 10n ** 18n;
      const hf = borrowAssets > 0n ? Number(maxBorrow) / Number(borrowAssets) : Number.POSITIVE_INFINITY;
      const [cUsd, dUsd] = await Promise.all([
        this.usdOf(row.collateralToken, collateral, Number(meta.collateralDecimals ?? NaN)),
        this.usdOf(row.loanToken, borrowAssets, Number(meta.loanDecimals ?? NaN)),
      ]);
      await this.db.mergeLendingMeta(this.config.CHAIN_ID, "morpho", row.marketId, row.borrower, { collateralRaw: collateral.toString(), debtRaw: borrowAssets.toString(), resolvedBy: "chain" }).catch(this.swallowWrite);
      // Band it, but NEVER straight into `watch`: that is the ARMED tier the monitor fires on, and entry to it
      // requires a sized exit quote proving the liquidation actually profits. This pass establishes size and
      // health, not profitability — so the best it can claim is `candidate` (known, tracked, unarmed), exactly
      // what the API path claims before it has quoted. Promotion stays behind the one profit gate there is.
      const solid = cUsd != null && dUsd != null ? cUsd > dUsd : true;
      const tier = !solid ? "low_collateral" : "candidate";
      await this.db.setLendingTier(this.config.CHAIN_ID, "morpho", row.marketId, row.borrower, {
        tier, reason: `resolved on chain — HF ${Number.isFinite(hf) ? hf.toFixed(3) : "∞"}${solid ? " (size+health known; exit not yet quoted)" : " (collateral ≤ debt)"}`,
        hf: Number.isFinite(hf) ? hf : null, debtUsd: dUsd, collateralUsd: cUsd, exitUsd: null, profitUsd: null,
        nextCheckSec: this.nextCheckSec(tier, Number.isFinite(hf) ? hf : 99),
      }).catch(this.swallowWrite);
      resolved++;
    }
    return resolved;
  }

  /** USD value of a raw amount, DB-first. Returns null when either datum is unknown — an unpriced position
   * must read as "not valued", never as $0, which would look like bad debt and park it wrongly. */
  private async usdOf(token: string | null, raw: bigint, decimals: number): Promise<number | null> {
    if (!token || !Number.isFinite(decimals)) return null;
    const px = await this.oracle.usdPrice(token).catch(() => null);
    if (px == null || !(px > 0)) return null;
    return (Number(raw) / 10 ** decimals) * px;
  }

  private lif(lltv: number): number { return liquidationIncentiveFactor(lltv); }

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
      // The indexer's Borrow events discover positions the Morpho API never returns. They arrive as `pending`
      // and used to be skipped here, deferring to an enumerate that would never see them. Resolve them from
      // the chain instead — bounded per tick, so a large backlog drains steadily without a burst.
      const pending = due.filter((p) => p.tier === "pending");
      if (pending.length) {
        const n = await this.resolvePending(pending.slice(0, 40)).catch((e) => { this.logger.debug({ err: e }, "pending resolve failed"); return 0; });
        if (n) this.logger.info({ resolved: n, ofDue: pending.length }, "lending positions resolved from chain (indexer-discovered, never in the API)");
      }
      // Re-evaluate the profit gate with a FRESH oracle exit value + reschedule per tier. HF is
      // refreshed by enumerate (Morpho oracle); the exit value (ours) is re-checked here fast.
      const memo: QuoteMemo = new Map(); // dedup aggregator quotes by pair across this due-batch
      for (const pos of due) {
        const hf = pos.hf ?? 2; const debt = pos.debtUsd ?? 0;
        // Candidates (far pipeline) and pending (not yet classified) are never quoted by the tick — the
        // enumerate classifies/promotes them with a fresh HF. Blacklist/bad-debt are likewise rescheduled.
        if (pos.tier === "blacklist" || pos.tier === "candidate" || pos.tier === "pending" /* resolved above */ || (pos.collateralUsd ?? 0) <= debt) { await this.reschedule(pos.protocol, pos.marketId, pos.borrower, pos.tier, hf); continue; }
        // Re-confirm the profit gate with a FRESH SIZED exit value (our oracle), reschedule per tier.
        const meta = (pos.meta ?? {}) as Record<string, unknown>;
        const collRaw = String(meta.collateralRaw ?? "0");
        const debtRaw = String(meta.debtRaw ?? "0");
        // Decimals scale the profit figure. A 6-decimal loan token read as 18 misstates it by 10^12, so an
        // unknown one means we cannot judge this position — we reschedule it instead of deciding on a guess.
        const loanDec = Number(meta.loanDecimals);
        if (!Number.isFinite(loanDec)) { await this.reschedule(pos.protocol, pos.marketId, pos.borrower, pos.tier, hf); continue; }
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
        await this.db.setLendingTier(this.config.CHAIN_ID, pos.protocol, pos.marketId, pos.borrower, { tier, reason, hf, debtUsd: pos.debtUsd, collateralUsd: pos.collateralUsd, exitUsd, profitUsd, nextCheckSec: this.nextCheckSec(tier, hf) }).catch(this.swallowWrite);
        if (tier === "watch" && hf < 1 && profitable) this.wake(`liq:${pos.borrower}:${pos.marketId}`, `LIQUIDATABLE + profitable: ${pos.collateralSymbol}/${pos.loanSymbol} HF ${hf.toFixed(3)}, liq profit ${pu}. Fire the flash-kill.`);
      }
    } finally { this.ticking = false; }
  }

  /** Postpone a position without re-asserting what it is. `tier` is READ here (it sets the cadence) and never
   * written back — writing it would clobber a classification made since this batch's snapshot was taken. */
  private async reschedule(protocol: string, marketId: string, borrower: string, tier: string, hf: number): Promise<void> {
    await this.db.rescheduleLendingPosition(this.config.CHAIN_ID, protocol, marketId, borrower, this.nextCheckSec(tier, hf))
      .catch((e) => this.logger.warn({ err: e, marketId, borrower }, "lending reschedule failed"));
  }

  // --- Morpho enumeration (paginated; maintains full state incl. old positions) ------------
  private async fetchMorpho(): Promise<MorphoPos[]> {
    const out: MorphoPos[] = [];
    const q = `query($c:[Int!],$hf:Float!,$ml:Boolean,$skip:Int){ marketPositions(first:100, skip:$skip, orderBy:HealthFactor, orderDirection:Asc, where:{chainId_in:$c, marketListed:$ml, healthFactor_lte:$hf}){ items { healthFactor user{address} market{ marketId lltv irmAddress oracle{address} collateralAsset{symbol address decimals} loanAsset{symbol address decimals} } state{ borrowAssets borrowAssetsUsd collateralUsd collateral } } } }`;
    const ml = this.config.LIQ_MARKET_LISTED_ONLY ? true : null; // null = don't filter; true = curated markets only (drops junk-market husks at the source)
    for (let skip = 0; skip < this.config.LIQ_ENUM_MAX_PAGES * 100; skip += 100) {
      const j = await this.gql<{ marketPositions: { items: RawMPos[] } }>(q, { c: [this.config.CHAIN_ID], hf: this.config.LIQ_HF_CEIL, ml, skip }).catch(this.swallowWrite);
      const items = j?.marketPositions?.items ?? [];
      for (const it of items) {
        const m = it.market; if (!m?.collateralAsset || !m.loanAsset) continue;
        // The API is a SOURCE, not an authority: if it omits a decimals field we do not substitute 18 — a
        // position we cannot size correctly is one we skip, and it stays discoverable via the indexer path.
        const cDec = Number(m.collateralAsset?.decimals), lDec = Number(m.loanAsset?.decimals);
        if (!Number.isFinite(cDec) || !Number.isFinite(lDec)) continue;
        out.push({
          healthFactor: Number(it.healthFactor ?? 0), user: (it.user?.address ?? "").toLowerCase(), marketId: m.marketId ?? "",
          lltv: Number(m.lltv ?? 0) / 1e18, lltvRaw: String(m.lltv ?? "0"), collateral: { symbol: m.collateralAsset.symbol ?? "?", address: (m.collateralAsset.address ?? "").toLowerCase(), decimals: cDec },
          loan: { symbol: m.loanAsset.symbol ?? "?", address: (m.loanAsset.address ?? "").toLowerCase(), decimals: lDec }, oracle: (m.oracle?.address ?? "").toLowerCase(), irm: (m.irmAddress ?? "").toLowerCase(),
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
