import type { SelfState } from "./self.js";
import { selfContext } from "./self.js";
import type { Database } from "./db.js";
import type { Sensorium } from "./sensorium.js";
import { worldContext } from "./sensorium.js";
import type { BerachainClients } from "./chain.js";
import type { MonadSignals } from "./monad-signals.js";
import type { PositionService } from "./positions.js";
import type { Address } from "viem";
import { computeGains } from "./gains.js";
import type { Config } from "./config.js";

/**
 * Scarlet's exploratory briefing. It is deliberately NOT a menu of verdicts: it
 * gives her terrain, changes, anomalies and a rotating frontier so she is provoked
 * to investigate — and to look where she has not looked before — rather than grind
 * the same familiar trades. She confirms anything worth acting on by simulating it.
 */
export type Briefing = {
  gains: unknown;
  self: unknown;
  temperament: SelfState["temperament"];
  chainHead: string;
  /** A digest of the MATERIAL state (opportunities/positions/holdings) — unchanged
   * across idle cycles, so the loop can back off; flips the instant something real
   * changes. Not sent to the model; used only to pace the thinking cadence. */
  fingerprint: string;
  positions: unknown;
  autoflash?: unknown;
  world: unknown;
  signals: unknown;
  graduation: unknown;
  flow: unknown;
  whales: unknown;
  frontier: unknown;
  registry: unknown;
  managed: unknown;
  memory: unknown;
  map: unknown;
  guidance: string;
};

export class Perception {
  constructor(
    private readonly sensorium: Sensorium,
    private readonly db: Database,
    private readonly chain: BerachainClients,
    private readonly monadSignals: MonadSignals,
    private readonly positionsSvc: PositionService,
    private readonly config: Config
  ) {}

  async brief(self: SelfState): Promise<Briefing> {
    // The SYSTEM computes every deterministic fact and hands it to Scarlet pre-digested,
    // so her cognition is spent on profit strategy, not on indexing. Live chain head +
    // Morpho liquidation surface are fetched fresh here; the sensorium world-model too.
    // Chain head from the PERSISTED network observation (the collector polls + persists it), not a live
    // getBlockNumber — keeps the thinking path DB-read (no shared-RPC contention). Sensorium hydrates
    // from the DB too. ~seconds-stale is fine for the model's context ("confirm each by simulation").
    const [netObs] = await Promise.all([
      this.db.latestNetworkObservation().catch(() => undefined),
      this.sensorium.hydrate()
    ]);
    const chainHead = netObs?.primaryBlock ?? 0n;
    const morpho = await this.monadSignals.fetch().catch(() => undefined);

    // Ready-made opportunities the system found for her — not chores to enumerate.
    const signals = morpho
      ? { note: "The system found these for you — decide which to exploit, do not re-enumerate. Confirm each by simulation at chainHead. liquidatableNow/onTheEdge are REAL prey only (seized collateral has a verified DEX exit on-chain). 'secondary' are demoted (no exit route / likely test) — occasional-check only; if you confirm one is junk, blacklist(add,...) it so it stops cluttering your feed.", liquidatableNow: morpho.liquidatableNow, onTheEdge: morpho.onTheEdge, secondary: morpho.secondary, excludedJunk: morpho.excludedCount, morphoMarkets: morpho.topMarkets, howTo: morpho.note, pegArb: "If USDC or USDT0 quotes off ~$1 on a DEX beyond fee+gas, that is a peg arbitrage." }
      : { note: "Morpho signal feed unavailable this cycle — fall back to world.arbHints and read Morpho state directly if needed." };

    // Live confirmed-flow: where the rest of the chain is trading RIGHT NOW (one block
    // late — Monad exposes no mempool). Hot pools = momentum; active wallets = smart-money
    // to study/follow; big swaps = whale moves to co-trade/backrun on the next block.
    const flowSnap = await this.db.latestMarketSnapshot<{ topByVolume: unknown[]; trending: unknown[]; allVenues: unknown[]; crossVenueArb: unknown[]; hotPools: unknown[]; activeWallets: unknown[]; bigSwaps: unknown[]; note: string }>("flow", "recent").catch(() => undefined);
    const flow = flowSnap
      ? { note: flowSnap.note, crossVenueArb: flowSnap.crossVenueArb, allVenues: flowSnap.allVenues, topByVolume: flowSnap.topByVolume, trending: flowSnap.trending, hotPoolsOnchain: flowSnap.hotPools, smartMoneyCandidates: flowSnap.activeWallets, bigSwaps: flowSnap.bigSwaps, howTo: "crossVenueArb = the SAME token priced differently across venues (buy cheap dex, sell dear) — the classic edge; verify both legs on-chain + net fees/gas, then execute atomically via your organ (flash_execute). allVenues = full radar of every DEX/CLOB. topByVolume = where the money moves; market_data(ohlcv/token) to read the chart. Kuru is an orderbook (CLOB) reachable via call_contract after resolve_abi. Study an active wallet via tokentx and follow it." }
      : { note: "Flow sensor warming up — no flow digest yet this cycle." };

    // GRADUATION ARB — your PRIMARY strategy on Base. Fresh tokens with a real cross-venue price
    // gap: buy the cheap venue, sell the dear, exit fast. This is where your fast profit lives.
    const gradSnap = await this.db.latestMarketSnapshot<{ momentum: unknown[]; arbs: unknown[]; note: string }>("graduation", "recent").catch(() => undefined);
    const hasGrad = gradSnap && ((Array.isArray(gradSnap.momentum) && gradSnap.momentum.length) || (Array.isArray(gradSnap.arbs) && gradSnap.arbs.length));
    const graduation = hasGrad
      ? { note: gradSnap!.note, arbs: gradSnap!.arbs, momentum: gradSnap!.momentum, howTo: "PRIMARY PLAY on Base. If `arbs` has a real cross-venue gap → that's market-neutral: buy cheap venue, sell dear, exit. Otherwise `momentum` = fresh single-venue snipes: pick one with rising chg5m and real liq, check_token(token) FIRST (can-you-sell — skip honeypots), simulate a small buy, and if it's clean buy TINY ($3-8) EARLY, ride briefly, SELL fast — never hold (they dump). This is variance: cut losers instantly, let a winner run a little, preserve capital." }
      : { note: "No alive fresh tokens this cycle (all DOA / no liquidity). They appear in bursts — keep watching, and meanwhile there is nothing to force." };

    // Whale & smart-money intelligence: who is moving size and accumulating what — so you can
    // create opportunities, not just wait for them.
    const whaleSnap = await this.db.latestMarketSnapshot<{ accumulatingNow: unknown[]; profiles: unknown[]; note: string }>("whale", "recent").catch(() => undefined);
    const whales = whaleSnap
      ? { note: whaleSnap.note, accumulatingNow: whaleSnap.accumulatingNow, walletProfiles: whaleSnap.profiles, howTo: "CREATE the opportunity, don't just wait: (1) when 2+ tracked wallets accumulate a token (accumulatingNow), check_token it and consider taking a position AHEAD of the crowd; (2) a whale's big buy dislocates one venue — backrun it by arbing that venue vs another (crossVenueArb) in the same/next block; (3) be their counterparty — rest a Kuru limit order where whales trade and earn their flow. Follow a specific wallet deeper with the read tools (its tokentx / balances)." }
      : { note: "Whale intel warming up — no smart-money snapshot yet." };

    // Frontier: fresh launches (real-time new-pool sensor) + ground to extend into.
    const freshLaunches = await this.db.recentDiscoveredPools(180, 12).catch(() => []);
    const frontier = {
      note: "Fresh launches (pools created in the last hours, real-time). On a growth chain this is where small capital compounds — but 99% are traps: check_token EVERY one (deepest-pool honeypot gate), size tiny, exit fast. Then open_position with a thesis and set a stop.",
      freshLaunches: freshLaunches.length ? freshLaunches.map((p) => ({ symbol: p.newSymbol, token: p.newToken, dex: p.dex, feeBps: p.fee, liquidityUsd: p.liquidityUsd, pool: p.pool, at: p.discoveredAt })) : "none in the recent window",
      extend: "Add a readable DEX with add_venue for more arbHints; use market_data(new_pools/trending) for wider discovery; probe pre-TGE incentive programs (market_data yields with apyReward)."
    };

    // Her open positions travel with her every cycle so she always knows what she
    // holds and can manage or exit it — they never silently vanish from her view.
    const positionsRaw = await this.db.activePositions();
    // Full dynamic wallet awareness: non-core tokens actually held (via the explorer),
    // flagged tracked/untracked so nothing she holds is ever invisible to her.
    const holdings = self.wallet ? await this.positionsSvc.walletHoldings(self.wallet as Address).catch(() => []) : [];
    const trackedAssets = new Set(positionsRaw.map((p) => p.assetAddress.toLowerCase()));
    const untrackedHoldings = holdings.filter((h) => !trackedAssets.has(h.token.toLowerCase())).map((h) => ({ token: h.token, symbol: h.symbol, balance: round4(h.balance), valueUsd: round2(h.valueUsd), note: "held but not tracked — open_position on it (with a thesis) if it matters, or sell it" }));
    const positions = {
      note: positionsRaw.length
        ? "Your tracked positions with live P&L (current value vs entry, reconciled on-chain — you cannot alter the values, only the note). A negative pnl means you are losing on it. Manage them: annotate_position(id,note) to update your reasoning, close_position(id) when you have exited on-chain."
        : "You hold no tracked positions. When you open one (a snipe, a vault deposit, seized liquidation collateral), call open_position with a thesis note so future-you remembers WHY.",
      held: positionsRaw.map((p) => ({ id: p.id, kind: p.kind, label: p.label, note: p.thesisNote, asset: p.assetAddress, protocol: p.protocolId, entryUsd: round2(p.entryValueUsd), valueUsd: round2(p.valueUsd), pnlUsd: round4(p.pnlUsd), pnlPct: round2(p.pnlPct), openedAt: p.openedAt, openedCycle: p.openedCycle })),
      ...(untrackedHoldings.length ? { untrackedHoldings } : {})
    };
    const autoflashRaw = await this.db.listAutoflash(["armed", "fired", "failed"]).catch(() => []);
    const autoflash = autoflashRaw.length
      ? { note: "Your auto-flash liquidation watchers. 'armed' = simulating every few seconds, fires the instant the position crosses hf<1 AND your funds are ready. Manage with list_autoflash / kill_autoflash.", watchers: autoflashRaw.map((w) => ({ id: w.id, label: w.label, status: w.status, borrower: w.borrower, txHash: w.txHash, firedAt: w.firedAt })) }
      : undefined;

    const recentDec = (await this.db.recentDecisions(5)).map((decision) => ({ action: (decision as { decision?: { action?: string } }).decision?.action, strategy: (decision as { decision?: { strategyId?: string } }).decision?.strategyId, status: (decision as { status?: string }).status }));
    const notebook = await this.db.memoryIndex(80);
    const memory = {
      recentDecisions: recentDec,
      notebook: notebook.length
        ? { note: "Your saved notes — open any with recall(key); save or update with remember(key, content, category).", index: notebook.map((m) => ({ key: m.key, category: m.category })) }
        : "Your notebook is empty. Use remember(key, content) to save tokens, addresses, routes, ideas and theses you want to find again."
    };

    const organ = await this.db.getOrgan("atomic-executor").catch(() => undefined);
    const map = {
      note: "Your operable profit surfaces live in the venue registry (list_venues); the sensorium reads every enabled venue into `world`. Use market_data for off-chain market/discovery data, and add_venue to grow the registry.",
      organ: organ ? { address: organ.address, note: "Your ATOMIC ORGAN is deployed — drive it with flash_execute (atomic arb/liquidations). You operate at flash-loan scale." } : "No atomic organ yet. deploy_organ ONCE (gas only) to unlock capital-free atomic strategies."
    };
    // Your address-keyed KNOWLEDGE BASE for this chain (tokens/dexes/dapps/wallets you know).
    const known = await this.db.listEntities(this.config.CHAIN_ID, { status: "active", limit: 60 }).catch(() => []);
    const registry = {
      note: "Your chain registry — what you already KNOW (address-keyed). Don't re-discover these; build on them. `registry(inspect, address)` resolves any NEW address deterministically (contract + realtime price); `registry(add, address, kind, note)` keeps it with your note. This is your organized memory of the chain.",
      count: known.length,
      entities: known.map((e) => ({ address: e.address, kind: e.kind, symbol: e.symbol, note: e.note }))
    };
    // Managed intents: what the SYSTEM is running FOR you so you don't have to remember or watch.
    const [followList, followActivity, plans, arbSnap] = await Promise.all([
      this.db.activeFollows(this.config.CHAIN_ID).catch(() => []),
      this.db.recentFollowActivity(this.config.CHAIN_ID, 120).catch(() => []),
      this.db.activePositionPlans(this.config.CHAIN_ID).catch(() => []),
      this.db.latestMarketSnapshot<{ note: string; probeSizeUsd: number; candidates: Array<{ symbol: string; kind: string; netUsd: number; sizeUsd: number }> }>("arb", "recent").catch(() => undefined)
    ]);
    const managed = {
      note: "The system runs these FOR you autonomously — you plan, it executes. `follow(add/history)` picks smart-money the system then tracks + notifies you about. `position(plan)` sets entry+stop-loss+take-profit+partials the system fires at the live price so you never miss an exit. `arb` cycles are hunted+verified for you across ALL venues. Don't manually babysit these; check status and re-plan.",
      follows: { note: followActivity.length ? "Followed wallets that MOVED recently — study with follow(history, wallet)." : "Your followed smart-money (idle recently).", list: followList.map((f) => ({ wallet: f.wallet, note: f.note })), recentlyMoved: followActivity },
      positions: { note: plans.length ? "Your programmed positions the system is auto-managing." : "No programmed positions. Use position(plan) so the system handles entries/exits.", plans: plans.map((p) => ({ id: p.id, symbol: p.symbol, status: p.status, entryKind: p.entryKind, entryPrice: p.entryPrice, amountUsd: p.entryAmountUsd, filledPrice: p.filledPrice, remainingPct: p.remainingPct, stopLossPct: p.stopLossPct, takeProfitPct: p.takeProfitPct, lastResult: p.lastResult })) },
      arbs: { note: arbSnap?.note ?? "Arb engine warming up — it round-trips cross-venue/triangular cycles at real size via the aggregator (all venues) and surfaces only gas-adjusted-profitable ones.", verified: (arbSnap?.candidates ?? []).map((c) => ({ symbol: c.symbol, kind: c.kind, netUsd: c.netUsd, sizeUsd: c.sizeUsd })) }
    };

    const guidance = self.temperament === "exploit"
      ? "You are hungry (net worth low). Confirm and take the surest positive-net actions to rebuild it. Spend little energy on the frontier."
      : self.temperament === "explore"
        ? "Net worth is comfortable. Spend some energy probing the frontier and anomalies for novel edges, not only the familiar cycle."
        : "Balanced. Pursue solid profit and still probe at least one unfamiliar signal each cycle. Never fossilise on the same trade.";

    // Material-state fingerprint: liquidatable set, on-edge markets, ACTIONABLE arb
    // (spread clearly above fees), positions, non-core holdings, armed auto-flashes.
    // Price wobble and "still 0 liquidatable" do NOT change it → the loop can back off.
    const arbActionable = (this.sensorium.latest?.arbHints ?? []).filter((a) => a.spreadPct > 1.1).map((a) => a.pair).sort();
    const fingerprint = JSON.stringify({
      liq: (morpho?.liquidatableNow ?? []).map((p) => `${p.marketId}:${p.user}`).sort(),
      edge: (morpho?.onTheEdge ?? []).map((p) => p.marketId).sort(),
      arb: arbActionable,
      pos: positionsRaw.map((p) => p.id).sort(),
      hold: untrackedHoldings.map((h) => h.token).sort(),
      af: autoflashRaw.filter((w) => w.status === "armed").length
    });
    // GAINS FIRST: baseline (captured once), current net worth, and progress to the
    // next milestone — the forward drive that shapes every cycle.
    const currentNavUsd = self.netWorthHoney;
    let baseline = await this.db.latestMarketSnapshot<{ navUsd: number }>("scarlet", "baseline").catch(() => undefined);
    if (!baseline || !(baseline.navUsd > 0)) { baseline = { navUsd: currentNavUsd }; await this.db.saveMarketSnapshot("scarlet", "baseline", baseline).catch(() => undefined); }
    const ledger = await this.db.ledgerSummary().catch(() => ({ netUsd: 0, gasUsd: 0 }));
    const milestones = this.config.PROFIT_MILESTONES.split(",").map((m) => Number(m.trim())).filter((n) => n > 0);
    const gains = computeGains(currentNavUsd, baseline.navUsd, ledger.netUsd, milestones);

    return { gains, self: selfContext(self), temperament: self.temperament, chainHead: chainHead.toString(), fingerprint, positions, ...(autoflash ? { autoflash } : {}), world: worldContext(this.sensorium.latest), signals, graduation, flow, whales, frontier, memory, map, registry, managed, guidance };
  }
}

/**
 * Deterministic rotation without a clock: pick a window whose offset advances with
 * the pool of items, so successive briefings surface different frontier slices.
 */
function round2(v: number): number { return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }
function round4(v: number): number { return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0; }

function rotateSample<T>(items: T[], size: number): T[] {
  if (items.length <= size) return items;
  const offset = items.length % Math.max(1, items.length - size + 1);
  return items.slice(offset, offset + size);
}
