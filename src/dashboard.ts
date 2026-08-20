import { createServer } from "node:http";
import type { Logger } from "pino";
import type { Address } from "viem";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { BerachainClients } from "./chain.js";
import type { PositionService } from "./positions.js";
import { selfState, selfContext } from "./self.js";
import { readProblems } from "./problems.js";
import { computeGains } from "./gains.js";
import { SCARLET_STREAM } from "./scarlet/agent.js";

type Deps = { config: Config; db: Database; chain: BerachainClients; positions: PositionService; logger: Logger; primitives?: import("./primitives.js").Primitives; aggregator?: import("./aggregator.js").Aggregator };

/**
 * Read-only human dashboard (staged restyle). Right now: a lean wallet overview + an Explorer
 * page over the chain-native entity registry (every token/pool/dex the scanner discovered).
 * It never moves funds.
 */
export function startDashboard(deps: Deps): { close: () => void } | undefined {
  if (!deps.config.DASHBOARD_PORT) return undefined;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/state")) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(await buildState(deps), bigintReplacer));
        return;
      }
      if (url.pathname.startsWith("/api/entities")) {
        const kind = url.searchParams.get("kind") || undefined;
        const q = url.searchParams.get("q") || undefined;
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200);
        const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
        const data = await deps.db.entitiesExplorer(deps.config.CHAIN_ID, { kind: kind === "all" ? undefined : kind, q, limit, offset });
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({ ...data, chain: { name: deps.config.CHAIN_NAME, explorer: deps.config.EXPLORER_URL } }));
        return;
      }
      if (url.pathname.startsWith("/api/arb")) {
        const arb = await deps.db.latestMarketSnapshot<Record<string, unknown>>("arb", "recent").catch(() => undefined);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({ ...(arb ?? { note: "arb engine warming up", candidates: [] }), chain: { name: deps.config.CHAIN_NAME, explorer: deps.config.EXPLORER_URL } }));
        return;
      }
      if (url.pathname.startsWith("/api/liquidations")) {
        // READ-ONLY from the DB — no live RPC/API in the request path. The background ticks (monitor,
        // registry enumerate, scanLiquidations) keep these tables fresh at their own cadence; the
        // dashboard just reads them at its own. The DB is the single source of truth between the two.
        const [watchers, tiers, positions, events] = await Promise.all([
          deps.db.listAutoflash().catch(() => []),
          deps.db.lendingTierCounts(deps.config.CHAIN_ID).catch(() => ({})), deps.db.listLendingPositions(deps.config.CHAIN_ID, { limit: 150 }).catch(() => []),
          deps.db.listLiquidationEvents(deps.config.CHAIN_ID, undefined, 80).catch(() => [])
        ]);
        const armedCount = positions.filter((p) => p.tier === "watch" || p.tier === "profitable").length;
        const hitCount = events.filter((e) => e.kind === "hit").length;
        const missedCount = events.filter((e) => e.kind === "missed").length;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({
          // note is a presentational summary over the persisted rows above — NOT a live feed.
          note: `${(tiers as Record<string, number>).watch ?? 0} sul filo · ${armedCount} armate · ${hitCount} nostre · ${missedCount} perse — fonte DB`,
          tiers, positions: positions.map((p) => (
            // profitUsd is the registry's DECIDED loan-native profit (amountOut − debtRepaid). We show
            // it as-is — NEVER recompute from collateral_usd (the Morpho mirage). armed = the on-chain
            // monitor is watching it (ALL actionable positions — no cap) and fires the instant HF<1.
            { protocol: p.protocol, borrower: p.borrower, collateral: p.collateralSymbol, loan: p.loanSymbol, hf: p.hf, debtUsd: p.debtUsd, exitUsd: p.exitUsd, profitUsd: p.profitUsd, tier: p.tier, reason: p.reason, nextCheckAt: p.nextCheckAt, armed: p.tier === "watch" || p.tier === "profitable" }
          )),
          watchers: watchers.map((w) => ({ id: w.id, label: w.label, status: w.status, borrower: w.borrower, marketId: w.marketId, txHash: w.txHash, createdAt: w.createdAt, firedAt: w.firedAt })),
          events,
          chain: { name: deps.config.CHAIN_NAME, explorer: deps.config.EXPLORER_URL }
        }));
        return;
      }
      if (url.pathname.startsWith("/api/scarlet")) {
        // Scarlet's full timeline (trader-v2 journal): per CYCLE — start (why she woke) → the complete
        // blocks between: thoughts, emitted text, tool reads, and actions → rest (end). Read-only from DB.
        const rows = await deps.db.recentJournal(320, SCARLET_STREAM).catch(() => []);
        const byCycle = new Map<string, { cycle: string; at: string; reason: string | null; entries: Array<{ at: string; kind: string; content: string }> }>();
        const order: string[] = [];
        for (const r of rows) { const c = r.cycle ?? "—"; if (!byCycle.has(c)) { byCycle.set(c, { cycle: c, at: r.at, reason: null, entries: [] }); order.push(c); } const g = byCycle.get(c)!; if (r.kind === "cycle") g.reason = r.content; else g.entries.push({ at: r.at, kind: r.kind, content: r.content }); }
        // rows are newest-first → reverse entries to chronological; the cycle's `at` is its EARLIEST entry.
        const cycles = order.map((c) => { const g = byCycle.get(c)!; const entries = g.entries.slice().reverse(); return { cycle: g.cycle, at: entries[0]?.at ?? g.at, reason: g.reason, entries }; });
        // Operative-state machine: her current state + the recent transition log (with justifications).
        const [current, stateLog, nextNote] = await Promise.all([
          deps.db.latestScarletState().catch(() => undefined),
          deps.db.recentScarletStates(25).catch(() => []),
          deps.db.latestMarketSnapshot<{ text: string; at: string }>("scarlet", "nextNote").catch(() => undefined)
        ]);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({ enabled: deps.config.SCARLET_V2_ENABLED, cycles, currentState: current ?? null, stateLog, nextNote: nextNote ?? null, now: new Date().toISOString() }));
        return;
      }
      if (url.pathname.startsWith("/api/route-probe")) {
        // Route diagnostics using the LIVE system objects (real primitives + aggregator), NOT a separate
        // simulation: for a token, does the current V3-only path find buy/sell routes, and does the
        // cross-venue aggregator? Reveals exactly where the engine's narrow routing loses good tokens.
        const token = (url.searchParams.get("token") || "").toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(token) || !deps.primitives || !deps.aggregator) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "token non valido o probe non disponibile" })); return; }
        const weth = (deps.config.WBERA_ADDRESS as `0x${string}`);
        const t = token as `0x${string}`;
        const wethIn = 10n ** 15n; // ~0.001 WETH (~$2) buy probe
        const out = (r: unknown): string | null => { const d = (r as { detail?: { expectedOut?: string } })?.detail; return d?.expectedOut ?? null; };
        const check = await deps.primitives.checkToken(t).catch((e) => ({ error: String(e) }));
        const v3buy = await deps.primitives.swapV3(weth, t, wethIn, 8, false).catch((e) => ({ ok: false as const, reason: String(e) }));
        const aggBuy = await deps.aggregator.quoteResult(weth, t, wethIn).catch(() => ({ status: "error" as const, quote: null }));
        // Sell probe: size from whichever buy route produced tokens (round-trip realism).
        const v3buyOut = "ok" in v3buy && v3buy.ok ? out(v3buy) : null;
        const tokAmt = v3buyOut ? BigInt(v3buyOut) : (aggBuy.quote?.amountOut ?? 0n);
        const v3sell = tokAmt > 0n ? await deps.primitives.swapV3(t, weth, tokAmt, 8, false).catch((e) => ({ ok: false as const, reason: String(e) })) : null;
        const aggSell = tokAmt > 0n ? await deps.aggregator.quoteResult(t, weth, tokAmt).catch(() => ({ status: "error" as const, quote: null })) : null;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ token, check,
          v3: { buy: { ok: "ok" in v3buy && v3buy.ok, reason: (v3buy as { reason?: string }).reason ?? null, out: v3buyOut }, sell: v3sell ? { ok: "ok" in v3sell && v3sell.ok, reason: (v3sell as { reason?: string }).reason ?? null, out: out(v3sell) } : null },
          agg: { buy: { status: aggBuy.status, out: aggBuy.quote?.amountOut?.toString() ?? null }, sell: aggSell ? { status: aggSell.status, out: aggSell.quote?.amountOut?.toString() ?? null } : null } }));
        return;
      }
      if (url.pathname.startsWith("/api/positions")) {
        // Scarlet's positions: ACTIVE (with live P&L from the indexer price) + HISTORY (closed/cancelled).
        const chainId = deps.config.CHAIN_ID;
        const plans = await deps.db.listPositionPlans(chainId, 120).catch(() => []);
        const openTokens = plans.filter((p) => p.status === "open").map((p) => p.token);
        const prices = await deps.db.getTokenPrices(chainId, openTokens).catch(() => new Map<string, { priceUsd: number | null }>());
        const ACTIVE = new Set(["pending-entry", "entering", "open", "exiting"]);
        const active = plans.filter((p) => ACTIVE.has(p.status)).map((p) => {
          const cur = prices.get(p.token)?.priceUsd ?? null;
          const gainPct = p.filledPrice && cur ? (cur / p.filledPrice - 1) * 100 : null;
          const valueUsd = p.filledAmountToken && cur ? p.filledAmountToken * (p.remainingPct / 100) * cur : null;
          return { id: p.id, symbol: p.symbol, token: p.token, status: p.status, sizeUsd: p.entryAmountUsd, entryPrice: p.entryPrice, filledPrice: p.filledPrice, currentPrice: cur, gainPct, valueUsd, remainingPct: p.remainingPct, stopLossPct: p.stopLossPct, takeProfitPct: p.takeProfitPct, lastResult: p.lastResult, filledAt: p.filledAt };
        });
        const history = plans.filter((p) => p.status === "closed" || p.status === "cancelled").map((p) => (
          { id: p.id, symbol: p.symbol, token: p.token, status: p.status, sizeUsd: p.entryAmountUsd, filledPrice: p.filledPrice, remainingPct: p.remainingPct, stopLossPct: p.stopLossPct, takeProfitPct: p.takeProfitPct, lastResult: p.lastResult, filledAt: p.filledAt }
        ));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({ active, history, now: new Date().toISOString() }));
        return;
      }
      // OBSERVABILITY: the system's real state — what data is missing, what is stuck, what is failing.
      if (url.pathname.startsWith("/api/health")) {
        const snap = await deps.db.healthSnapshot(deps.config.CHAIN_ID).catch((e) => ({ error: String(e) }));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(snap, bigintReplacer));
        return;
      }
      // Problems ONLY (warn/error/fatal), deduplicated with counts — not a log stream.
      if (url.pathname.startsWith("/api/problems")) {
        const minLevel = Number(url.searchParams.get("min") ?? 40);
        const out = readProblems(process.env.LOG_DIR ?? "logs", { minLevel, limit: 150 });
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({ ...out, now: new Date().toISOString() }));
        return;
      }
      // What the enrichment is DOING (per pass), not just how much is left.
      if (url.pathname.startsWith("/api/enrichment")) {
        const act = await deps.db.enrichmentActivity(deps.config.CHAIN_ID, 25).catch((e) => ({ error: String(e) }));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(act, bigintReplacer));
        return;
      }
      if (url.pathname === "/health") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(HEALTH_PAGE); return; }
      if (url.pathname === "/scarlet") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(SCARLET_PAGE); return; }
      if (url.pathname === "/explorer") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(EXPLORER_PAGE);
        return;
      }
      if (url.pathname === "/arb") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(ARB_PAGE); return; }
      if (url.pathname === "/liquidations") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(LIQ_PAGE); return; }
      if (url.pathname === "/stats") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(STATS_PAGE);
        return;
      }
      if (url.pathname === "/wallet") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(WALLET_PAGE);
        return;
      }
      if (url.pathname === "/" || url.pathname.startsWith("/index")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "dashboard error" }));
    }
  });
  server.listen(deps.config.DASHBOARD_PORT, "0.0.0.0", () => deps.logger.info({ port: deps.config.DASHBOARD_PORT }, "Scarlet dashboard listening"));
  return { close: () => server.close() };
}

async function buildState({ config, db, chain, positions, logger }: Deps) {
  const owner = config.WALLET_ADDRESS as Address | undefined;
  // READ-ONLY from the DB — no live RPC/API in the request path. Background JOBs keep these fresh at
  // their own cadence; a momentary JOB failure leaves the LAST-KNOWN value here, so the view never
  // "resets to blank". (Portfolio/NAV ← WalletHoldings job; head ← the collector's network obs.)
  const settled = await Promise.allSettled([
    db.latestPortfolio(),
    db.activePositions(),
    db.latestMarketSnapshot<{ holdings: Array<{ token: string; symbol: string; balance: number; valueUsd: number; priceUsd: number }> }>("wallet", "holdings"),
    db.ledgerSummary(24), db.ledgerSummary(),
    db.latestNetworkObservation(),
    owner ? db.listWalletTransactions(config.CHAIN_ID, owner, 60) : Promise.resolve([])
  ]);
  const labels = ["portfolio", "positions", "holdings", "pnl24h", "pnlAll", "network", "transactions"];
  settled.forEach((r, i) => { if (r.status === "rejected") logger.warn({ section: labels[i], err: r.reason instanceof Error ? r.reason.message : String(r.reason) }, "dashboard query failed"); });
  const get = <T>(i: number, fb: T): T => settled[i].status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<T>).value : fb;

  const portfolio = get(0, undefined) as Awaited<ReturnType<Database["latestPortfolio"]>> | undefined;
  const positionsRaw = get(1, [] as Awaited<ReturnType<Database["activePositions"]>>);
  const holdingsSnap = get(2, undefined) as { holdings?: Array<{ token: string; symbol: string; balance: number; valueUsd: number; priceUsd: number }> } | undefined;
  const holdings = holdingsSnap?.holdings ?? [];
  const pnl24h = get(3, { netUsd: 0, gasUsd: 0 });
  const pnlAll = get(4, { netUsd: 0, gasUsd: 0 });
  const network = get(5, undefined) as Awaited<ReturnType<Database["latestNetworkObservation"]>> | undefined;
  const transactions = get(6, [] as Awaited<ReturnType<Database["listWalletTransactions"]>>);
  const head = network?.primaryBlock ?? 0n;

  const coreTokens = new Set([config.WBERA_ADDRESS, config.USDC_E_ADDRESS, config.HONEY_ADDRESS].map((a) => a.toLowerCase()));
  const trackedAssets = new Set(positionsRaw.map((p) => p.assetAddress.toLowerCase()));
  const untracked = holdings.filter((h) => !trackedAssets.has(h.token.toLowerCase()));
  const positionsValue = positionsRaw.reduce((s, p) => s + (p.kind === "token" && coreTokens.has(p.assetAddress.toLowerCase()) ? 0 : p.valueUsd), 0);
  const untrackedValue = untracked.reduce((s, h) => s + h.valueUsd, 0);
  const liveNav = portfolio ? portfolio.estimatedNavUsd + positionsValue + untrackedValue : 0;
  const livePortfolio = portfolio ? { ...portfolio, estimatedNavUsd: liveNav, lockedUsd: positionsValue + untrackedValue } : undefined;
  const self = livePortfolio ? selfContext(selfState(livePortfolio, config)) : null;
  const baseline = await db.latestSnapshotAt<{ navUsd: number }>("scarlet", "baseline").catch(() => undefined);
  const milestones = config.PROFIT_MILESTONES.split(",").map((m) => Number(m.trim())).filter((n) => n > 0);
  const gains = portfolio ? computeGains(liveNav, baseline?.payload?.navUsd ?? liveNav, pnlAll.netUsd, milestones) : null;

  const tokSym = (addr: string): string | undefined => config.network.tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase())?.symbol;
  // Real tokens in the wallet = native + wrapped + stables + every non-core holding, by value.
  const bera = portfolio?.bera ?? 0, beraUsd = portfolio?.beraUsd ?? 0;
  const core = portfolio ? [
    { symbol: config.network.nativeSymbol, token: "native", balance: bera, priceUsd: beraUsd, valueUsd: bera * beraUsd },
    { symbol: config.network.wrapped.symbol, token: config.WBERA_ADDRESS, balance: portfolio.wbera, priceUsd: beraUsd, valueUsd: portfolio.wbera * beraUsd },
    { symbol: tokSym(config.USDC_E_ADDRESS) ?? "USDC", token: config.USDC_E_ADDRESS, balance: portfolio.usdcE, priceUsd: 1, valueUsd: portfolio.usdcE },
    { symbol: tokSym(config.HONEY_ADDRESS) ?? "USDT", token: config.HONEY_ADDRESS, balance: portfolio.honey, priceUsd: 1, valueUsd: portfolio.honey }
  ] : [];
  const walletTokens = [...core, ...untracked.map((h) => ({ symbol: h.symbol, token: h.token, balance: h.balance, priceUsd: h.priceUsd, valueUsd: h.valueUsd }))]
    .filter((h) => h.balance > 0 || h.valueUsd > 0).sort((a, b) => b.valueUsd - a.valueUsd);

  return {
    now: new Date().toISOString(),
    executionEnabled: config.EXECUTION_ENABLED,
    chain: { name: config.CHAIN_NAME, id: config.CHAIN_ID, native: config.network.nativeSymbol, wrapped: config.network.wrapped.symbol, explorer: config.EXPLORER_URL },
    chainHead: head.toString(),
    gains,
    baselineAt: baseline?.observedAt ?? null,
    self,
    wallet: portfolio ? {
      address: portfolio.walletAddress, native: portfolio.bera, nativeSym: config.network.nativeSymbol, wrapped: portfolio.wbera, wrappedSym: config.network.wrapped.symbol,
      stable1: portfolio.usdcE, stable1Sym: tokSym(config.USDC_E_ADDRESS) ?? "USDC", stable2: portfolio.honey, stable2Sym: tokSym(config.HONEY_ADDRESS) ?? "USDT",
      navUsd: liveNav, nativeUsd: portfolio.beraUsd, positionsUsd: positionsValue, holdingsUsd: untrackedValue, tokenCount: walletTokens.length, dataHealthy: portfolio.dataHealthy
    } : null,
    holdings: walletTokens,
    transactions: transactions.map((t) => ({ txHash: t.txHash, block: t.blockNumber, token: t.token, symbol: t.symbol ?? "?", direction: t.direction, amount: t.decimals != null ? Number(BigInt(t.valueRaw)) / 10 ** t.decimals : null, from: t.from, to: t.to, at: t.observedAt })),
    pnl: { last24hNetUsd: pnl24h.netUsd, last24hGasUsd: pnl24h.gasUsd, allTimeNetUsd: pnlAll.netUsd, allTimeGasUsd: pnlAll.gasUsd },
    network: network ? { blockGap: network.blockGap.toString(), gasPriceWei: network.gasPriceWei.toString() } : null
  };
}

function bigintReplacer(_key: string, value: unknown): unknown { return typeof value === "bigint" ? value.toString() : value; }

const HEAD = String.raw`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = { darkMode: 'class', theme: { extend: { colors: {
  ink: '#0a0c11', panel: '#12161f', panel2: '#171c27', line: '#232b3a', txt: '#e7eaf1', dim: '#8b95a9',
  pos: '#3ddc97', neg: '#ff6b6b', warn: '#ffb454', stable: '#ffcf5c', energy: '#7db5ff', scarlet: '#ff3b5c'
}, fontFamily: { mono: ['ui-monospace','SFMono-Regular','Menlo','monospace'] } } } };
</script>
<style>::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#232b3a;border-radius:8px}[x-cloak]{display:none!important}
@keyframes pg{0%,100%{opacity:1}50%{opacity:.35}}.livedot{animation:pg 1.6s ease-in-out infinite}</style>`;

const PAGE = String.raw`<!doctype html><html lang="it" class="dark"><head><title>Scarlet</title>` + HEAD + `<script defer src="https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js"></script></head>
<body class="bg-ink text-txt" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div x-data="scarlet()" x-init="init()" x-cloak class="max-w-[1000px] mx-auto">

  <div class="flex items-center gap-2 px-5 pt-3 pb-1 text-dim text-[11px]">
    <span class="w-2 h-2 rounded-full bg-scarlet livedot"></span>
    <span class="font-semibold tracking-wide text-txt">SCARLET</span>
    <span class="px-2 py-0.5 rounded-full border border-energy/50 text-energy" x-text="s.chain?.name||'…'"></span>
    <span class="px-2 py-0.5 rounded-full border" :class="s.executionEnabled?'border-scarlet/60 text-scarlet':'border-energy/50 text-energy'" x-text="s.executionEnabled?'ESECUZIONE REALE':'OSSERVAZIONE'"></span>
    <div class="flex-1"></div>
    <span class="font-mono">blocco <span x-text="s.chainHead||'–'"></span> · <span x-text="clock"></span></span>
  </div>

  <!-- HEADER: NAV + P&L giornaliero + Livello/XP — click → statistiche -->
  <a href="/stats" class="block mx-5 mt-2 rounded-2xl bg-gradient-to-br from-panel to-panel2 border border-line p-5 hover:border-energy/50 transition">
    <div class="grid gap-5 items-end" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
      <div>
        <div class="text-[11px] uppercase tracking-widest text-dim">Patrimonio netto</div>
        <div class="text-4xl font-bold text-stable" x-text="usd(s.wallet?.navUsd)"></div>
      </div>
      <div>
        <div class="text-[11px] uppercase tracking-widest text-dim">P&amp;L ultimo giorno</div>
        <div class="text-2xl font-semibold" :class="(s.pnl?.last24hNetUsd||0)>=0?'text-pos':'text-neg'" x-text="money(s.pnl?.last24hNetUsd)"></div>
      </div>
      <div>
        <div class="flex items-baseline justify-between"><span class="text-[11px] uppercase tracking-widest text-dim">Livello</span><span class="text-2xl font-bold text-warn" x-text="s.gains?.level ?? 1"></span></div>
        <div class="h-2.5 rounded-full bg-ink overflow-hidden border border-line mt-1"><div class="h-full bg-gradient-to-r from-energy to-pos transition-all duration-700" :style="'width:'+Math.min(100,Math.round(s.gains?.progressToNextPct||0))+'%'"></div></div>
        <div class="text-[10px] text-dim mt-1" x-text="'XP '+fmt(s.gains?.progressToNextPct,0)+'% → L'+((s.gains?.level??1)+1)"></div>
      </div>
    </div>
    <div class="text-[11px] text-energy mt-3 text-right">vedi statistiche →</div>
  </a>

  <main class="px-5 py-4 grid gap-4" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
    <!-- CARD WALLET -->
    <a href="/wallet" class="block rounded-2xl bg-panel border border-line p-4 hover:border-energy/60 transition group">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-[11px] uppercase tracking-widest text-dim">💼 Wallet</h2>
        <span class="text-[11px] text-dim"><b class="text-txt" x-text="s.wallet?.tokenCount ?? 0"></b> token · <span class="text-energy group-hover:translate-x-0.5 inline-block transition">→</span></span>
      </div>
      <div class="text-sm space-y-1.5">
        <template x-if="!s.holdings?.length"><div class="text-dim py-2">nessun token nel wallet</div></template>
        <template x-for="(h,i) in (s.holdings||[]).slice(0,5)" :key="h.token">
          <div class="flex justify-between items-center">
            <span class="font-medium" x-text="h.symbol||'?'"></span>
            <span class="text-right"><span x-text="usd(h.valueUsd)"></span> <span class="text-dim text-xs" x-text="'· '+fmt(h.balance,4)"></span></span>
          </div>
        </template>
        <div x-show="(s.holdings?.length||0)>5" class="text-[11px] text-dim pt-1" x-text="'+ altri '+((s.holdings?.length||0)-5)+' token'"></div>
      </div>
    </a>

    <!-- CARD SALUTE — data completeness, stuck pipelines and real errors, at a glance -->
    <a href="/health" class="block rounded-2xl bg-panel border border-line p-4 hover:border-scarlet/60 transition group">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-[11px] uppercase tracking-widest text-dim">🩺 Salute &amp; diagnostica</h2>
        <span class="text-[11px] text-energy group-hover:translate-x-0.5 inline-block transition">→</span>
      </div>
      <div class="text-sm text-dim">
        Completezza dei dati, buffer di enrichment, certificazione tick, gap di copertura e <b class="text-txt">solo</b> i log di problema (raggruppati per causa).
      </div>
    </a>

    <!-- CARD EXPLORER -->
    <a href="/explorer" class="block rounded-2xl bg-panel border border-line p-4 hover:border-energy/60 transition group">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-[11px] uppercase tracking-widest text-dim">🔎 Explorer</h2>
        <span class="text-[11px] text-dim"><b class="text-txt" x-text="exTotal"></b> indirizzi · <span class="text-energy group-hover:translate-x-0.5 inline-block transition">→</span></span>
      </div>
      <div class="text-sm space-y-1.5">
        <template x-if="!recent.length"><div class="text-dim py-2">scanner in avvio…</div></template>
        <template x-for="e in recent" :key="e.kind+e.address">
          <div class="flex justify-between items-center">
            <span><span class="text-[10px] px-1.5 py-0.5 rounded border mr-1.5" :class="kindColor(e.kind)" x-text="e.kind"></span><span class="font-medium" x-text="e.symbol||short(e.address)"></span></span>
            <span class="font-mono text-dim text-xs" x-text="short(e.address)"></span>
          </div>
        </template>
      </div>
    </a>

    <!-- CARD ARBITRAGGI -->
    <a href="/arb" class="block rounded-2xl bg-panel border border-line p-4 hover:border-energy/60 transition group">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-[11px] uppercase tracking-widest text-dim">🔀 Arbitraggi</h2>
        <span class="text-[11px] text-dim"><b :class="(arb?.candidates?.length||0)>0?'text-pos':'text-txt'" x-text="arb?.candidates?.length||0"></b> profittevoli · <span class="text-energy group-hover:translate-x-0.5 inline-block transition">→</span></span>
      </div>
      <div class="text-sm space-y-1.5">
        <template x-if="!arb?.candidates?.length"><div class="text-dim py-2 text-[12.5px]" x-text="'mercato cross-venue efficiente ora'"></div></template>
        <template x-for="(c,i) in (arb?.candidates||[]).slice(0,4)" :key="i">
          <div class="flex justify-between items-center"><span class="font-medium" x-text="c.symbol"></span><span class="text-pos" x-text="money(c.netUsd)"></span></div>
        </template>
      </div>
    </a>

    <!-- CARD LIQUIDAZIONI -->
    <a href="/liquidations" class="block rounded-2xl bg-panel border border-line p-4 hover:border-energy/60 transition group">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-[11px] uppercase tracking-widest text-dim">🩸 Liquidazioni</h2>
        <span class="text-[11px] text-dim"><b class="text-warn" x-text="liq?.tiers?.watch||0"></b> sul filo · <b class="text-txt" x-text="(liq?.positions||[]).filter(p=>p.armed).length"></b> armate · <span class="text-energy group-hover:translate-x-0.5 inline-block transition">→</span></span>
      </div>
      <div class="text-sm space-y-1.5">
        <template x-if="!(liq?.positions||[]).some(p=>p.armed)"><div class="text-dim py-2 text-[12.5px]">nessuna posizione armata ora</div></template>
        <template x-for="(p,i) in (liq?.positions||[]).filter(p=>p.armed).slice(0,4)" :key="'a'+i">
          <div class="flex justify-between items-center"><span class="text-warn font-medium"><span x-text="p.collateral+'/'+p.loan"></span> <span class="text-[9px] text-warn">⚡</span></span><span class="text-dim text-xs" x-text="'hf '+fmt(p.hf,3)"></span></div>
        </template>
        <div class="flex justify-between items-center text-[11px] pt-1 border-t border-line/50"><span class="text-pos" x-text="'✓ '+((liq?.events||[]).filter(e=>e.kind==='hit').length)+' nostre'"></span><span class="text-neg" x-text="'✗ '+((liq?.events||[]).filter(e=>e.kind==='missed').length)+' perse'"></span></div>
      </div>
    </a>

    <!-- CARD SCARLET · RAGIONAMENTO -->
    <a href="/scarlet" class="block rounded-2xl bg-panel border border-line p-4 hover:border-energy/60 transition group md:col-span-2">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-[11px] uppercase tracking-widest text-dim">🧠 Ragionamento di Scarlet</h2>
        <span class="text-[11px] text-dim"><b class="text-txt" x-text="(scar?.cycles?.length||0)"></b> cicli · <span :class="scar?.enabled?'text-pos':'text-dim'" x-text="scar?.enabled?'v2 attivo':'v2 off'"></span> · <span class="text-energy group-hover:translate-x-0.5 inline-block transition">→</span></span>
      </div>
      <div class="text-[12.5px] text-dim leading-relaxed line-clamp-3" x-text="scarLast() || 'Scarlet non si è ancora attivata, o riposa.'"></div>
    </a>
  </main>
</div>
<script>
function scarlet(){return{
  s:{}, clock:'', recent:[], exTotal:0, arb:{}, liq:{}, scar:{},
  init(){ this.tick(); this.loadCards(); setInterval(()=>this.tick(),5000); setInterval(()=>this.loadCards(),15000); setInterval(()=>{this.clock=new Date().toLocaleTimeString()},1000); },
  async tick(){ try{ this.s=await (await fetch('/api/state')).json(); this.clock=new Date(this.s.now).toLocaleTimeString(); }catch(e){} },
  async loadCards(){
    try{ const d=await (await fetch('/api/entities?kind=all&limit=6')).json(); this.recent=d.rows||[]; this.exTotal=d.counts?Object.values(d.counts).reduce((a,b)=>a+b,0):0; }catch(e){}
    try{ this.arb=await (await fetch('/api/arb')).json(); }catch(e){}
    try{ this.liq=await (await fetch('/api/liquidations')).json(); }catch(e){}
    try{ this.scar=await (await fetch('/api/scarlet')).json(); }catch(e){}
  },
  scarLast(){ const c=(this.scar?.cycles||[])[0]; if(!c) return null; const e=c.entries||[]; const last=[...e].reverse().find(x=>x.kind==='rest'||x.kind==='thought'); return last?last.content:null; },
  fmt(n,d=2){ return (n==null||isNaN(n))?'–':Number(n).toLocaleString(undefined,{maximumFractionDigits:d}); },
  usd(n,d=2){ return (n==null||isNaN(n))?'–':'$'+this.fmt(n,d); },
  money(n){ return (n==null||isNaN(n))?'–':(n>=0?'+':'')+'$'+this.fmt(n,4); },
  short(a){ return a?a.slice(0,6)+'…'+a.slice(-4):'?'; },
  kindColor(k){ return ({token:'border-stable/50 text-stable',pool:'border-energy/50 text-energy',dex:'border-warn/50 text-warn',wallet:'border-pos/50 text-pos',contract:'border-line text-dim'})[k]||'border-line text-dim'; }
}}
</script>
</body></html>`;

const NAV_BACK = String.raw`<a href="/" class="text-energy text-lg">←</a>`;

const STATS_PAGE = String.raw`<!doctype html><html lang="it" class="dark"><head><title>Scarlet · Statistiche</title>` + HEAD + `<script defer src="https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js"></script></head>
<body class="bg-ink text-txt" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div x-data="stats()" x-init="init()" x-cloak class="max-w-[900px] mx-auto">
  <header class="sticky top-0 z-20 flex items-center gap-3 px-5 py-3 bg-ink/95 backdrop-blur border-b border-line">` + NAV_BACK + `<h1 class="text-lg font-semibold tracking-wide">Statistiche</h1></header>
  <main class="px-5 py-4 space-y-4">
    <section class="rounded-2xl bg-gradient-to-br from-panel to-panel2 border border-line p-5">
      <div class="text-[11px] uppercase tracking-widest text-dim">Patrimonio attuale</div>
      <div class="text-4xl font-bold text-stable" x-text="usd(g.currentNavUsd)"></div>
      <div class="text-sm mt-1" :class="(g.gainUsd||0)>=0?'text-pos':'text-neg'"><span x-text="money(g.gainUsd)"></span> <span x-text="'('+(g.gainPct>=0?'+':'')+fmt(g.gainPct,1)+'%)'"></span> <span class="text-dim">dal reset</span></div>
    </section>
    <section class="grid gap-4" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
      <div class="rounded-2xl bg-panel border border-line p-4 space-y-1.5 text-sm">
        <h2 class="text-[11px] uppercase tracking-widest text-dim mb-2">Reset / baseline</h2>
        <div class="flex justify-between"><span class="text-dim">Patrimonio al reset</span><span x-text="usd(g.baselineUsd)"></span></div>
        <div class="flex justify-between"><span class="text-dim">Ultimo reset</span><span x-text="baselineAt?new Date(baselineAt).toLocaleString():'–'"></span></div>
        <div class="flex justify-between"><span class="text-dim">P&amp;L da reset</span><span :class="(g.gainUsd||0)>=0?'text-pos':'text-neg'" x-text="money(g.gainUsd)"></span></div>
        <div class="flex justify-between"><span class="text-dim">Realizzato (trade)</span><span :class="(g.realizedPnlUsd||0)>=0?'text-pos':'text-neg'" x-text="money(g.realizedPnlUsd)"></span></div>
      </div>
      <div class="rounded-2xl bg-panel border border-line p-4 space-y-1.5 text-sm">
        <h2 class="text-[11px] uppercase tracking-widest text-dim mb-2">Livello</h2>
        <div class="flex justify-between"><span class="text-dim">Livello attuale</span><span class="text-warn font-bold" x-text="g.level ?? 1"></span></div>
        <div class="flex justify-between"><span class="text-dim">Soglia livello</span><span x-text="usd(g.lastMilestoneUsd)"></span></div>
        <div class="flex justify-between"><span class="text-dim">P&amp;L da livello</span><span :class="pnlSinceLevel()>=0?'text-pos':'text-neg'" x-text="money(pnlSinceLevel())"></span></div>
        <div class="flex justify-between"><span class="text-dim">Prossima milestone</span><span x-text="g.nextMilestoneUsd!=null?usd(g.nextMilestoneUsd):'—'"></span></div>
        <div class="pt-1"><div class="flex justify-between text-[11px] text-dim mb-1"><span x-text="'XP verso L'+((g.level??1)+1)"></span><span x-text="fmt(g.progressToNextPct,0)+'%'"></span></div><div class="h-2 rounded-full bg-ink overflow-hidden"><div class="h-full bg-gradient-to-r from-energy to-pos" :style="'width:'+Math.min(100,Math.round(g.progressToNextPct||0))+'%'"></div></div></div>
      </div>
      <div class="rounded-2xl bg-panel border border-line p-4 space-y-1.5 text-sm">
        <h2 class="text-[11px] uppercase tracking-widest text-dim mb-2">P&amp;L</h2>
        <div class="flex justify-between"><span class="text-dim">Netto 24h</span><span :class="(p.last24hNetUsd||0)>=0?'text-pos':'text-neg'" x-text="money(p.last24hNetUsd)"></span></div>
        <div class="flex justify-between"><span class="text-dim">Gas 24h</span><span class="text-neg" x-text="'-'+usd(p.last24hGasUsd,4)"></span></div>
        <div class="flex justify-between"><span class="text-dim">Netto totale</span><span :class="(p.allTimeNetUsd||0)>=0?'text-pos':'text-neg'" x-text="money(p.allTimeNetUsd)"></span></div>
        <div class="flex justify-between"><span class="text-dim">Gas totale</span><span class="text-neg" x-text="'-'+usd(p.allTimeGasUsd,4)"></span></div>
      </div>
    </section>
    <section class="rounded-2xl bg-panel border border-line p-4">
      <h2 class="text-[11px] uppercase tracking-widest text-dim mb-2">Milestone raggiunte</h2>
      <div class="flex gap-2 flex-wrap">
        <template x-if="!(g.milestonesHit&&g.milestonesHit.length)"><span class="text-dim text-sm">nessuna ancora</span></template>
        <template x-for="m in (g.milestonesHit||[])" :key="m"><span class="text-[12px] px-2 py-1 rounded border border-pos/50 text-pos" x-text="'$'+m"></span></template>
      </div>
    </section>
  </main>
</div>
<script>
function stats(){return{
  g:{}, p:{}, baselineAt:null,
  init(){ this.load(); setInterval(()=>this.load(),5000); },
  async load(){ try{ const s=await (await fetch('/api/state')).json(); this.g=s.gains||{}; this.p=s.pnl||{}; this.baselineAt=s.baselineAt; }catch(e){} },
  pnlSinceLevel(){ return (this.g.level>1)?(this.g.currentNavUsd-this.g.lastMilestoneUsd):(this.g.gainUsd||0); },
  fmt(n,d=2){ return (n==null||isNaN(n))?'–':Number(n).toLocaleString(undefined,{maximumFractionDigits:d}); },
  usd(n,d=2){ return (n==null||isNaN(n))?'–':'$'+this.fmt(n,d); },
  money(n){ return (n==null||isNaN(n))?'–':(n>=0?'+':'')+'$'+this.fmt(n,4); }
}}
</script>
</body></html>`;

const WALLET_PAGE = String.raw`<!doctype html><html lang="it" class="dark"><head><title>Scarlet · Wallet</title>` + HEAD + `<script defer src="https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js"></script></head>
<body class="bg-ink text-txt" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div x-data="wallet()" x-init="init()" x-cloak class="max-w-[1100px] mx-auto">
  <header class="sticky top-0 z-20 flex items-center gap-3 flex-wrap px-5 py-3 bg-ink/95 backdrop-blur border-b border-line">` + NAV_BACK + `<h1 class="text-lg font-semibold tracking-wide">Wallet</h1>
    <span class="text-[11px] text-dim"><b class="text-txt" x-text="s.wallet?.tokenCount ?? 0"></b> token · <span x-text="usd(s.wallet?.navUsd)"></span> NAV</span>
    <div class="flex-1"></div>
    <a class="font-mono text-energy text-xs" :href="s.chain?.explorer+'/address/'+s.wallet?.address" target="_blank" x-text="short(s.wallet?.address)"></a>
  </header>
  <main class="px-5 py-4 space-y-4">
    <section class="grid gap-4" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
      <div class="rounded-2xl bg-panel border border-line p-4"><div class="text-[11px] uppercase tracking-widest text-dim">Patrimonio</div><div class="text-2xl font-bold text-stable" x-text="usd(s.wallet?.navUsd)"></div></div>
      <div class="rounded-2xl bg-panel border border-line p-4"><div class="text-[11px] uppercase tracking-widest text-dim" x-text="(s.wallet?.nativeSym||'')+' (gas)'"></div><div class="text-xl font-semibold" x-text="fmt(s.wallet?.native,5)"></div><div class="text-dim text-xs" x-text="usd((s.wallet?.native||0)*(s.wallet?.nativeUsd||0))"></div></div>
      <div class="rounded-2xl bg-panel border border-line p-4"><div class="text-[11px] uppercase tracking-widest text-dim">In posizioni</div><div class="text-xl font-semibold" x-text="usd(s.wallet?.positionsUsd)"></div></div>
      <div class="rounded-2xl bg-panel border border-line p-4"><div class="text-[11px] uppercase tracking-widest text-dim">In token</div><div class="text-xl font-semibold" x-text="usd(s.wallet?.holdingsUsd)"></div></div>
    </section>
    <section class="rounded-2xl bg-panel border border-line overflow-hidden">
      <div class="overflow-x-auto"><table class="w-full text-[13px]">
        <thead class="bg-panel2 text-dim text-[10px] uppercase"><tr><th class="text-left font-medium py-2 px-3">Token</th><th class="text-right font-medium px-3">Saldo</th><th class="text-right font-medium px-3">Prezzo</th><th class="text-right font-medium px-3">Valore</th><th class="text-right font-medium px-3">% NAV</th><th class="text-left font-medium px-3">Indirizzo</th></tr></thead>
        <tbody>
          <template x-if="!s.holdings?.length"><tr><td colspan="6" class="text-dim py-6 px-3 text-center">nessun token nel wallet</td></tr></template>
          <template x-for="h in (s.holdings||[])" :key="h.token">
            <tr class="border-t border-line hover:bg-panel2">
              <td class="py-2 px-3 font-semibold" x-text="h.symbol||'?'"></td>
              <td class="px-3 text-right" x-text="fmt(h.balance,6)"></td>
              <td class="px-3 text-right text-dim" x-text="h.priceUsd?usd(h.priceUsd, h.priceUsd<1?6:2):'–'"></td>
              <td class="px-3 text-right font-medium" x-text="usd(h.valueUsd)"></td>
              <td class="px-3 text-right text-dim" x-text="s.wallet?.navUsd?fmt(h.valueUsd/s.wallet.navUsd*100,1)+'%':'–'"></td>
              <td class="px-3"><template x-if="h.token.startsWith('0x')"><a class="font-mono text-energy" :href="s.chain?.explorer+'/token/'+h.token" target="_blank" x-text="short(h.token)"></a></template><span x-show="!h.token.startsWith('0x')" class="text-dim">nativo</span></td>
            </tr>
          </template>
        </tbody>
      </table></div>
    </section>
    <section class="rounded-2xl bg-panel border border-line overflow-hidden">
      <div class="px-3 py-2 text-[11px] uppercase tracking-widest text-dim border-b border-line">Movimenti (dal DB)</div>
      <div class="overflow-x-auto"><table class="w-full text-[13px]">
        <thead class="bg-panel2 text-dim text-[10px] uppercase"><tr><th class="text-left font-medium py-2 px-3">Dir</th><th class="text-left font-medium px-3">Token</th><th class="text-right font-medium px-3">Quantità</th><th class="text-right font-medium px-3">Blocco</th><th class="text-left font-medium px-3">Tx</th><th class="text-left font-medium px-3">Quando</th></tr></thead>
        <tbody>
          <template x-if="!s.transactions?.length"><tr><td colspan="6" class="text-dim py-6 px-3 text-center">nessun movimento</td></tr></template>
          <template x-for="t in (s.transactions||[])" :key="t.txHash+t.token+t.block">
            <tr class="border-t border-line hover:bg-panel2">
              <td class="py-2 px-3"><span :class="t.direction==='in'?'text-stable':t.direction==='out'?'text-loss':'text-dim'" x-text="t.direction==='in'?'▼ IN':t.direction==='out'?'▲ OUT':'↔'"></span></td>
              <td class="px-3 font-semibold" x-text="t.symbol||'?'"></td>
              <td class="px-3 text-right" x-text="t.amount!=null?fmt(t.amount,6):'–'"></td>
              <td class="px-3 text-right text-dim" x-text="t.block"></td>
              <td class="px-3"><a class="font-mono text-energy" :href="s.chain?.explorer+'/tx/'+t.txHash" target="_blank" x-text="short(t.txHash)"></a></td>
              <td class="px-3 text-dim text-[11px]" x-text="t.at?new Date(t.at).toLocaleString('it-IT'):''"></td>
            </tr>
          </template>
        </tbody>
      </table></div>
    </section>
  </main>
</div>
<script>
function wallet(){return{
  s:{},
  init(){ this.load(); setInterval(()=>this.load(),5000); },
  async load(){ try{ this.s=await (await fetch('/api/state')).json(); }catch(e){} },
  fmt(n,d=2){ return (n==null||isNaN(n))?'–':Number(n).toLocaleString(undefined,{maximumFractionDigits:d}); },
  usd(n,d=2){ return (n==null||isNaN(n))?'–':'$'+this.fmt(n,d); },
  short(a){ return a?a.slice(0,6)+'…'+a.slice(-4):'?'; }
}}
</script>
</body></html>`;

const ARB_PAGE = String.raw`<!doctype html><html lang="it" class="dark"><head><title>Scarlet · Arbitraggi</title>` + HEAD + `<script defer src="https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js"></script></head>
<body class="bg-ink text-txt" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div x-data="arb()" x-init="init()" x-cloak class="max-w-[1100px] mx-auto">
  <header class="sticky top-0 z-20 flex items-center gap-3 flex-wrap px-5 py-3 bg-ink/95 backdrop-blur border-b border-line">` + NAV_BACK + `<h1 class="text-lg font-semibold tracking-wide">Arbitraggi</h1>
    <span class="text-[11px] text-dim"><b class="text-txt" x-text="(d.candidates?.length||0)"></b> cicli profittevoli · <span x-text="(d.candidatesScanned||0)"></span> token scansionati</span></header>
  <main class="px-5 py-4 space-y-3">
    <div class="rounded-2xl bg-panel border border-line p-4 text-[13px] text-dim" x-text="d.note||'motore arb in avvio…'"></div>
    <div class="text-[11px] text-dim italic px-1" x-show="d.scope" x-text="'scope: '+d.scope"></div>
    <div class="rounded-2xl bg-panel border border-line overflow-hidden">
      <div class="overflow-x-auto"><table class="w-full text-[13px]">
        <thead class="bg-panel2 text-dim text-[10px] uppercase"><tr><th class="text-left font-medium py-2 px-3">Ciclo</th><th class="text-left font-medium px-3">Tipo</th><th class="text-right font-medium px-3">Size</th><th class="text-right font-medium px-3">Gas</th><th class="text-right font-medium px-3">Net mid</th><th class="text-right font-medium px-3">Net floor</th></tr></thead>
        <tbody>
          <template x-if="!d.candidates?.length"><tr><td colspan="6" class="text-dim py-6 px-3 text-center">nessun ciclo supera floor+gas ora — mercato cross-venue efficiente</td></tr></template>
          <template x-for="(c,i) in (d.candidates||[])" :key="i"><tr class="border-t border-line hover:bg-panel2">
            <td class="py-2 px-3"><a class="font-semibold hover:text-energy" :href="d.chain?.explorer+'/token/'+c.token" target="_blank" x-text="c.symbol"></a></td>
            <td class="px-3"><span class="text-[10px] px-1.5 py-0.5 rounded border border-line text-dim" x-text="c.kind"></span></td>
            <td class="px-3 text-right text-dim" x-text="usd(c.bestSizeUsd,0)"></td>
            <td class="px-3 text-right text-neg" x-text="'-'+usd(c.gasUsd,3)"></td>
            <td class="px-3 text-right text-dim" x-text="money(c.netMidUsd)"></td>
            <td class="px-3 text-right font-semibold" :class="c.netUsd>=0?'text-pos':'text-neg'" x-text="money(c.netUsd)"></td>
          </tr></template>
        </tbody>
      </table></div>
    </div>
    <section class="rounded-2xl bg-panel border border-line overflow-hidden">
      <h2 class="text-[11px] uppercase tracking-widest text-dim px-4 pt-3 flex justify-between"><span>Watchlist — prezzo per venue</span><span class="normal-case tracking-normal text-dim" x-text="d.observedAt?('aggiornato '+new Date(d.observedAt).toLocaleTimeString()):''"></span></h2>
      <div class="overflow-x-auto"><table class="w-full text-[13px]">
        <thead class="bg-panel2 text-dim text-[10px] uppercase"><tr><th class="text-left font-medium py-2 px-3">Token</th><th class="text-right font-medium px-3">Spread display</th><th class="text-right font-medium px-3">Net eseguibile</th><th class="text-left font-medium px-3">Prezzi per pool / venue</th></tr></thead>
        <tbody>
          <template x-if="!d.watchlist?.length"><tr><td colspan="4" class="text-dim py-6 px-3 text-center">watchlist in caricamento…</td></tr></template>
          <template x-for="(t,i) in (d.watchlist||[])" :key="i"><tr class="border-t border-line align-top">
            <td class="py-2 px-3"><a class="font-semibold hover:text-energy" :href="d.chain?.explorer+'/token/'+t.token" target="_blank" x-text="t.symbol"></a><div class="text-[10px] text-dim" x-text="t.venues+' venue'"></div></td>
            <td class="px-3 text-right" :class="t.spreadPct>=0.3?'text-warn':'text-dim'" x-text="fmt(t.spreadPct,3)+'%'"></td>
            <td class="px-3 text-right font-semibold" :class="t.execNetUsd==null?'text-dim':t.execNetUsd>=0?'text-pos':'text-neg'" x-text="t.execNetUsd==null?'–':money(t.execNetUsd)+' @$'+fmt(t.execSizeUsd,0)"></td>
            <td class="px-3"><div class="flex flex-wrap gap-1.5">
              <template x-for="(p,j) in t.pools" :key="j"><span class="text-[11px] px-1.5 py-0.5 rounded border border-line"><span class="text-dim" x-text="p.dex"></span> <span class="font-mono" x-text="'$'+prc(p.priceUsd)"></span></span></template>
            </div></td>
          </tr></template>
        </tbody>
      </table></div>
    </section>
    <div class="text-[11px] text-dim px-1"><b>Spread display</b> = prezzi-per-pool indicizzati (GeckoTerminal): spesso stantii/su pool sottili → NON eseguibili. <b>Net eseguibile</b> = round-trip reale a size su tutti i venue (dexOut), floor + gas atomico: è ciò che conta. Uno spread display alto con net eseguibile negativo = artefatto di prezzo, non arbitraggio. Il net è size-swept fino a taglia flashloan ($5k) — il gas è fisso, quindi uno spread reale ma minuscolo profitta a scala (flashloan 0-fee); ma uno spread che non batte le fee resta in perdita a ogni taglia. Firing atomico in validazione.</div>
  </main>
</div>
<script>
function arb(){return{ d:{},
  init(){ this.load(); setInterval(()=>this.load(),8000); },
  async load(){ try{ this.d=await (await fetch('/api/arb')).json(); }catch(e){} },
  fmt(n,x=2){ return (n==null||isNaN(n))?'–':Number(n).toLocaleString(undefined,{maximumFractionDigits:x}); },
  usd(n,x=2){ return (n==null||isNaN(n))?'–':'$'+this.fmt(n,x); },
  money(n){ return (n==null||isNaN(n))?'–':(n>=0?'+':'')+'$'+this.fmt(n,4); },
  prc(n){ if(n==null||isNaN(n)) return '–'; n=Number(n); return n>=1?n.toLocaleString(undefined,{maximumFractionDigits:4}):n.toPrecision(4); }
}}
</script></body></html>`;

const LIQ_PAGE = String.raw`<!doctype html><html lang="it" class="dark"><head><title>Scarlet · Liquidazioni</title>` + HEAD + `<script defer src="https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js"></script></head>
<body class="bg-ink text-txt" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div x-data="liq()" x-init="init()" x-cloak class="max-w-[1100px] mx-auto">
  <header class="sticky top-0 z-20 flex items-center gap-3 flex-wrap px-5 py-3 bg-ink/95 backdrop-blur border-b border-line">` + NAV_BACK + `<h1 class="text-lg font-semibold tracking-wide">Liquidazioni</h1>
    <span class="text-[11px] text-dim"><b class="text-warn" x-text="d.tiers?.watch||0"></b> sul filo · <b class="text-txt" x-text="(d.positions||[]).filter(p=>p.armed).length"></b> armate · <b class="text-pos" x-text="(d.events||[]).filter(e=>e.kind==='hit').length"></b> nostre · <b class="text-neg" x-text="(d.events||[]).filter(e=>e.kind==='missed').length"></b> perse</span></header>
  <main class="px-5 py-4 space-y-4">
    <div class="rounded-2xl bg-panel border border-line p-4 text-[13px] text-dim" x-text="d.note||'feed liquidazioni…'"></div>

    <!-- Registro posizioni per fascia (enumerazione completa, vecchie incluse) -->
    <section class="rounded-2xl bg-panel border border-line overflow-hidden">
      <div class="flex items-center gap-2 flex-wrap px-4 pt-3">
        <h2 class="text-[11px] uppercase tracking-widest text-dim">Registro posizioni</h2>
        <template x-for="t in ['all','watch','profitable','low_collateral','blacklist']" :key="t">
          <button @click="tf=t" class="text-[11px] px-2.5 py-1 rounded-full border transition" :class="tf===t?tierColor(t)+' bg-panel2':'border-line text-dim'"><span x-text="tierLabel(t)"></span> <span class="opacity-60" x-text="'('+(t==='all'?(d.positions?.length||0):(d.tiers?.[t]||0))+')'"></span></button>
        </template>
      </div>
      <div class="overflow-x-auto"><table class="w-full text-[13px]">
        <thead class="bg-panel2 text-dim text-[10px] uppercase"><tr><th class="text-left font-medium py-2 px-3">Fascia</th><th class="text-left font-medium px-3">Mercato</th><th class="text-right font-medium px-3">HF</th><th class="text-right font-medium px-3">Debito</th><th class="text-right font-medium px-3">Profitto liq.</th><th class="text-left font-medium px-3">Motivo</th></tr></thead>
        <tbody>
          <template x-if="!fp().length"><tr><td colspan="6" class="text-dim py-6 px-3 text-center">registro in popolamento (enumerazione Morpho ogni 3min)…</td></tr></template>
          <template x-for="(p,i) in fp()" :key="'p'+i"><tr class="border-t border-line hover:bg-panel2">
            <td class="py-2 px-3"><span class="text-[10px] px-1.5 py-0.5 rounded border" :class="tierColor(p.tier)" x-text="tierLabel(p.tier)"></span></td>
            <td class="px-3"><span x-text="(p.collateral||'?')+'/'+(p.loan||'?')"></span><template x-if="p.armed"><span class="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-warn/15 text-warn border border-warn/40 font-semibold" title="flash-kill pre-armato — scatta appena HF&lt;1">⚡ ARMATA</span></template></td>
            <td class="px-3 text-right" :class="p.hf<1?'text-scarlet':p.hf<=1.05?'text-warn':'text-txt'" x-text="p.hf!=null?fmt(p.hf,4):'–'"></td>
            <td class="px-3 text-right" x-text="usd(p.debtUsd)"></td>
            <td class="px-3 text-right font-semibold" :class="p.profitUsd==null?'text-dim':p.profitUsd>0?'text-pos':'text-neg'" x-text="p.profitUsd!=null?money(p.profitUsd):'–'"></td>
            <td class="px-3 text-dim italic max-w-[380px] truncate" x-text="p.reason"></td>
          </tr></template>
        </tbody>
      </table></div>
    </section>

    <!-- STORICO: eventi liquidazione (hit=nostre, missed=perse ad altri bot, found=trovate/armate) -->
    <section class="rounded-2xl bg-panel border border-line overflow-hidden">
      <div class="flex items-center gap-2 flex-wrap px-4 pt-3">
        <h2 class="text-[11px] uppercase tracking-widest text-dim">Storico liquidazioni</h2>
        <template x-for="k in ['all','hit','missed','found']" :key="k">
          <button @click="ef=k" class="text-[11px] px-2.5 py-1 rounded-full border transition" :class="ef===k?evColor(k)+' bg-panel2':'border-line text-dim'"><span x-text="evLabel(k)"></span> <span class="opacity-60" x-text="'('+(k==='all'?(d.events?.length||0):(d.events||[]).filter(e=>e.kind===k).length)+')'"></span></button>
        </template>
      </div>
      <div class="overflow-x-auto"><table class="w-full text-[13px]">
        <thead class="bg-panel2 text-dim text-[10px] uppercase"><tr><th class="text-left font-medium py-2 px-3">Esito</th><th class="text-left font-medium px-3">Mercato</th><th class="text-right font-medium px-3">Debito</th><th class="text-right font-medium px-3">Profitto</th><th class="text-left font-medium px-3">Liquidatore</th><th class="text-left font-medium px-3">Tx</th><th class="text-left font-medium px-3">Quando</th></tr></thead>
        <tbody>
          <template x-if="!fe().length"><tr><td colspan="7" class="text-dim py-6 px-3 text-center">nessun evento registrato ancora</td></tr></template>
          <template x-for="(e,i) in fe()" :key="'ev'+i"><tr class="border-t border-line hover:bg-panel2">
            <td class="py-2 px-3"><span class="text-[10px] px-1.5 py-0.5 rounded border font-semibold" :class="evColor(e.kind)" x-text="evLabel(e.kind)"></span></td>
            <td class="px-3" x-text="(e.collateralSymbol||'?')+'/'+(e.loanSymbol||'?')"></td>
            <td class="px-3 text-right" x-text="e.debtUsd!=null?usd(e.debtUsd):'–'"></td>
            <td class="px-3 text-right" :class="e.profitUsd>0?'text-pos':'text-dim'" x-text="e.profitUsd!=null?money(e.profitUsd):'–'"></td>
            <td class="px-3 font-mono text-dim"><template x-if="e.liquidator"><a class="text-energy" :href="d.chain?.explorer+'/address/'+e.liquidator" target="_blank" x-text="short(e.liquidator)"></a></template></td>
            <td class="px-3 font-mono"><template x-if="e.txHash"><a class="text-energy" :href="d.chain?.explorer+'/tx/'+e.txHash" target="_blank" x-text="short(e.txHash)"></a></template></td>
            <td class="px-3 text-dim text-[11px]" x-text="e.observedAt?new Date(e.observedAt).toLocaleString('it-IT'):''"></td>
          </tr></template>
        </tbody>
      </table></div>
    </section>

    <section class="rounded-2xl bg-panel border border-line overflow-hidden">
      <h2 class="text-[11px] uppercase tracking-widest text-dim px-4 pt-3">Flash-kill armati / eseguiti</h2>
      <div class="overflow-x-auto"><table class="w-full text-[13px]">
        <thead class="bg-panel2 text-dim text-[10px] uppercase"><tr><th class="text-left font-medium py-2 px-3">Watcher</th><th class="text-left font-medium px-3">Stato</th><th class="text-left font-medium px-3">Borrower</th><th class="text-left font-medium px-3">Tx</th></tr></thead>
        <tbody>
          <template x-if="!d.watchers?.length"><tr><td colspan="4" class="text-dim py-6 px-3 text-center">nessun flash-kill armato — il sistema li arma sulle prede sul filo</td></tr></template>
          <template x-for="w in (d.watchers||[])" :key="w.id"><tr class="border-t border-line">
            <td class="py-2 px-3">#<span x-text="w.id"></span> <b x-text="w.label||''"></b></td>
            <td class="px-3"><span class="text-[10px] px-1.5 py-0.5 rounded border" :class="w.status==='fired'?'border-pos/50 text-pos':w.status==='failed'?'border-neg/50 text-neg':'border-warn/50 text-warn'" x-text="w.status"></span></td>
            <td class="px-3 font-mono text-dim" x-text="short(w.borrower)"></td>
            <td class="px-3 font-mono"><template x-if="w.txHash"><a class="text-energy" :href="d.chain?.explorer+'/tx/'+w.txHash" target="_blank" x-text="short(w.txHash)"></a></template><span x-show="!w.txHash" class="text-dim">in ascolto</span></td>
          </tr></template>
        </tbody>
      </table></div>
    </section>
    <div class="text-[11px] text-dim px-1">Il sistema auto-arma un flash-kill sulle posizioni sul filo (capital-free via organo, self-verifying con require(minProfit)); scatta l'istante in cui hf&lt;1 se il netto è positivo, e ti notifica.</div>
  </main>
</div>
<script>
function liq(){return{ d:{}, tf:'all', ef:'all',
  init(){ this.load(); setInterval(()=>this.load(),8000); },
  async load(){ try{ this.d=await (await fetch('/api/liquidations')).json(); }catch(e){} },
  fp(){ const p=this.d.positions||[]; return this.tf==='all'?p:p.filter(x=>x.tier===this.tf); },
  fe(){ const e=this.d.events||[]; return this.ef==='all'?e:e.filter(x=>x.kind===this.ef); },
  evLabel(k){ return ({all:'Tutti',hit:'✓ Nostre',missed:'✗ Perse',found:'Trovate'})[k]||k; },
  evColor(k){ return ({hit:'border-pos/60 text-pos',missed:'border-neg/60 text-neg',found:'border-warn/50 text-warn'})[k]||'border-energy/50 text-energy'; },
  tierLabel(t){ return ({all:'Tutte',watch:'Osservazione',profitable:'Profittevoli',low_collateral:'Low-collateral',blacklist:'Blacklist'})[t]||t; },
  tierColor(t){ return ({watch:'border-warn/60 text-warn',profitable:'border-pos/60 text-pos',low_collateral:'border-neg/50 text-neg',blacklist:'border-line text-dim'})[t]||'border-energy/50 text-energy'; },
  fmt(n,x=2){ return (n==null||isNaN(n))?'–':Number(n).toLocaleString(undefined,{maximumFractionDigits:x}); },
  usd(n,x=2){ return (n==null||isNaN(n))?'–':'$'+this.fmt(n,x); },
  money(n){ return (n==null||isNaN(n))?'–':(n>=0?'+':'')+'$'+this.fmt(n,2); },
  short(a){ return a?a.slice(0,6)+'…'+a.slice(-4):'?'; }
}}
</script></body></html>`;

const SCARLET_PAGE = String.raw`<!doctype html><html lang="it" class="dark"><head><title>Scarlet</title>` + HEAD + `<script defer src="https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js"></script></head>
<body class="bg-ink text-txt" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div x-data="scar()" x-init="init()" x-cloak class="max-w-[1040px] mx-auto">
  <header class="sticky top-0 z-20 flex items-center gap-3 flex-wrap px-5 py-3 bg-ink/95 backdrop-blur border-b border-line">` + NAV_BACK + `<h1 class="text-lg font-semibold tracking-wide">Scarlet</h1>
    <div class="flex gap-1.5 ml-2">
      <button @click="tab='reason'" class="text-[12px] px-3 py-1 rounded-full border transition" :class="tab==='reason'?'border-energy text-energy bg-energy/10':'border-line text-dim hover:text-txt'">Ragionamento <span class="opacity-60" x-text="'('+(d.cycles?.length||0)+')'"></span></button>
      <button @click="tab='active'" class="text-[12px] px-3 py-1 rounded-full border transition" :class="tab==='active'?'border-energy text-energy bg-energy/10':'border-line text-dim hover:text-txt'">Posizioni attive <span class="opacity-60" x-text="'('+(pos.active?.length||0)+')'"></span></button>
      <button @click="tab='history'" class="text-[12px] px-3 py-1 rounded-full border transition" :class="tab==='history'?'border-energy text-energy bg-energy/10':'border-line text-dim hover:text-txt'">Storico <span class="opacity-60" x-text="'('+(pos.history?.length||0)+')'"></span></button>
    </div>
    <div class="flex-1"></div>
    <span class="text-[11px]" :class="d.enabled?'text-pos':'text-dim'" x-text="d.enabled?'core v2 attivo':'core v2 non attivo'"></span></header>
  <main class="px-5 py-4 space-y-3">

    <!-- RAGIONAMENTO -->
    <template x-if="tab==='reason'">
      <div class="space-y-3">
        <div class="rounded-2xl bg-panel border border-line p-4 text-[12px] text-dim">Timeline di Scarlet, ciclo per ciclo: <b class="text-txt">inizio</b> (perché si è svegliata) → i blocchi tra i due estremi (pensiero, strumenti, azioni) → <b class="text-txt">fine</b>. Solo lettura, si aggiorna da solo.</div>
        <!-- STATO OPERATIVO -->
        <section class="rounded-2xl bg-panel border border-line p-4">
          <div class="flex items-center gap-3 flex-wrap">
            <span class="text-[11px] uppercase tracking-widest text-dim">Stato operativo</span>
            <span class="text-[13px] font-semibold px-2.5 py-0.5 rounded-full border border-energy text-energy bg-energy/10" x-text="d.currentState?.state || '—'"></span>
            <span class="text-[11px] text-dim" x-show="d.currentState" x-text="d.currentState? new Date(d.currentState.at).toLocaleString():''"></span>
          </div>
          <div class="text-[12px] text-dim mt-1.5" x-show="d.currentState?.justification"><span class="text-txt">motivo:</span> <span x-text="d.currentState?.justification"></span></div>
          <div class="text-[12px] mt-2 rounded-lg bg-panel2 border border-line p-2" x-show="d.nextNote"><span class="text-energy">nota per il prossimo turno:</span> <span class="text-dim" x-text="d.nextNote?.text"></span></div>
          <template x-if="d.stateLog?.length>1">
            <div class="mt-2.5 flex flex-wrap gap-1.5">
              <template x-for="(s,i) in d.stateLog.slice(0,12)" :key="i">
                <span class="text-[10px] px-2 py-0.5 rounded-full border border-line text-dim" :title="(s.justification||'')+' — '+new Date(s.at).toLocaleString()" x-text="s.state"></span>
              </template>
            </div>
          </template>
        </section>
        <template x-if="!d.cycles?.length"><div class="rounded-2xl bg-panel border border-line p-6 text-dim text-center">Nessun ragionamento ancora — Scarlet non si è ancora attivata, o riposa.</div></template>
        <template x-for="(c,i) in (d.cycles||[])" :key="c.cycle">
          <section class="rounded-2xl bg-panel border border-line overflow-hidden">
            <div class="px-4 py-2 bg-panel2 border-b border-line">
              <div class="flex justify-between items-center text-[11px]"><span class="font-mono text-energy">▶ inizio ciclo</span><span class="text-dim" x-text="new Date(c.at).toLocaleString()"></span></div>
              <div class="text-[12px] text-dim mt-0.5" x-show="c.reason"><span class="text-txt">perché:</span> <span x-text="c.reason"></span></div>
            </div>
            <div class="p-4 space-y-2.5">
              <template x-for="(e,j) in c.entries" :key="j">
                <div class="text-[13px] leading-relaxed border-l-2 pl-3" :class="bar(e.kind)">
                  <div class="flex items-center gap-2 mb-0.5">
                    <span class="text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border" :class="cls(e.kind)" x-text="lbl(e.kind)"></span>
                    <span class="text-[10px] text-dim font-mono" x-text="new Date(e.at).toLocaleTimeString()"></span>
                  </div>
                  <div class="whitespace-pre-wrap" :class="e.kind==='rest'?'text-dim italic':(e.kind==='action'?'text-txt font-medium':'text-txt')" x-text="e.content"></div>
                </div>
              </template>
              <div class="text-[10px] text-dim font-mono pt-1 border-t border-line/60">■ fine ciclo</div>
            </div>
          </section>
        </template>
      </div>
    </template>

    <!-- POSIZIONI ATTIVE -->
    <template x-if="tab==='active'">
      <div class="space-y-3">
        <template x-if="!pos.active?.length"><div class="rounded-2xl bg-panel border border-line p-6 text-dim text-center">Nessuna posizione attiva. Quando Scarlet apre una posizione compare qui con il P&L live.</div></template>
        <template x-for="p in (pos.active||[])" :key="p.id">
          <section class="rounded-2xl bg-panel border border-line p-4">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-[10px] text-dim">#<span x-text="p.id"></span></span>
              <span class="font-semibold text-txt" x-text="p.symbol||short(p.token)"></span>
              <span class="text-[10px] px-2 py-0.5 rounded-full border" :class="statusCls(p.status)" x-text="p.status"></span>
              <div class="flex-1"></div>
              <span class="text-lg font-semibold" :class="p.gainPct>=0?'text-pos':'text-neg'" x-show="p.gainPct!=null" x-text="(p.gainPct>=0?'+':'')+fmt(p.gainPct,1)+'%'"></span>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-[12px]">
              <div><div class="text-dim">size</div><div class="text-txt" x-text="usd(p.sizeUsd)"></div></div>
              <div><div class="text-dim">entry</div><div class="text-txt" x-text="p.filledPrice!=null?('$'+fmt(p.filledPrice,6)):(p.entryPrice!=null?('limit $'+fmt(p.entryPrice,6)):'in attesa')"></div></div>
              <div><div class="text-dim">prezzo ora</div><div class="text-txt" x-text="p.currentPrice!=null?('$'+fmt(p.currentPrice,6)):'–'"></div></div>
              <div><div class="text-dim">valore ora</div><div class="text-txt" x-text="usd(p.valueUsd)"></div></div>
              <div><div class="text-dim">stop / target</div><div class="text-txt"><span x-text="p.stopLossPct!=null?('-'+p.stopLossPct+'%'):'—'"></span> / <span x-text="p.takeProfitPct!=null?('+'+p.takeProfitPct+'%'):'—'"></span></div></div>
              <div><div class="text-dim">rimane</div><div class="text-txt" x-text="fmt(p.remainingPct,0)+'%'"></div></div>
              <div class="col-span-2"><div class="text-dim">ultimo esito</div><div class="text-txt text-[11px]" x-text="p.lastResult||'—'"></div></div>
            </div>
          </section>
        </template>
      </div>
    </template>

    <!-- STORICO POSIZIONI -->
    <template x-if="tab==='history'">
      <div class="rounded-2xl bg-panel border border-line overflow-hidden">
        <template x-if="!pos.history?.length"><div class="p-6 text-dim text-center">Nessuna posizione chiusa ancora.</div></template>
        <table class="w-full text-[12px]" x-show="pos.history?.length">
          <thead class="text-dim text-[10px] uppercase tracking-wider bg-panel2"><tr>
            <th class="text-left px-3 py-2">#</th><th class="text-left px-3 py-2">token</th><th class="text-left px-3 py-2">stato</th>
            <th class="text-right px-3 py-2">size</th><th class="text-right px-3 py-2">entry</th><th class="text-right px-3 py-2">stop/tp</th><th class="text-left px-3 py-2">esito</th></tr></thead>
          <tbody>
            <template x-for="p in (pos.history||[])" :key="p.id">
              <tr class="border-t border-line/60">
                <td class="px-3 py-2 font-mono text-dim" x-text="p.id"></td>
                <td class="px-3 py-2 text-txt" x-text="p.symbol||short(p.token)"></td>
                <td class="px-3 py-2"><span class="text-[10px] px-2 py-0.5 rounded-full border" :class="statusCls(p.status)" x-text="p.status"></span></td>
                <td class="px-3 py-2 text-right" x-text="usd(p.sizeUsd)"></td>
                <td class="px-3 py-2 text-right" x-text="p.filledPrice!=null?('$'+fmt(p.filledPrice,6)):'–'"></td>
                <td class="px-3 py-2 text-right text-dim"><span x-text="p.stopLossPct!=null?('-'+p.stopLossPct+'%'):'—'"></span>/<span x-text="p.takeProfitPct!=null?('+'+p.takeProfitPct+'%'):'—'"></span></td>
                <td class="px-3 py-2 text-dim text-[11px]" x-text="p.lastResult||'—'"></td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>

  </main>
</div>
<script>
function scar(){return{ tab:'reason', d:{}, pos:{},
  init(){ this.load(); setInterval(()=>this.load(),6000); },
  async load(){ try{ this.d=await (await fetch('/api/scarlet')).json(); }catch(e){} try{ this.pos=await (await fetch('/api/positions')).json(); }catch(e){} },
  lbl(k){ return ({cycle:'inizio',thought:'pensiero',text:'testo',tool:'strumento',action:'azione',rest:'riposo',note:'nota',memory:'memoria'})[k]||k; },
  cls(k){ return ({thought:'text-dim border-line',tool:'text-energy border-energy/40',action:'text-pos border-pos/50',rest:'text-dim border-line',note:'text-warn border-warn/50'})[k]||'text-dim border-line'; },
  bar(k){ return ({tool:'border-energy/40',action:'border-pos/60',rest:'border-line'})[k]||'border-line/50'; },
  statusCls(s){ return ({open:'border-pos/60 text-pos','pending-entry':'border-warn/60 text-warn',entering:'border-warn/60 text-warn',closed:'border-line text-dim',cancelled:'border-neg/40 text-neg'})[s]||'border-line text-dim'; },
  fmt(n,x=2){ return (n==null||isNaN(n))?'–':Number(n).toLocaleString(undefined,{maximumFractionDigits:x}); },
  usd(n,x=2){ return (n==null||isNaN(n))?'–':'$'+this.fmt(n,x); },
  short(a){ return a?a.slice(0,6)+'…'+a.slice(-4):'?'; }
}}
</script></body></html>`;

const EXPLORER_PAGE = String.raw`<!doctype html><html lang="it" class="dark"><head><title>Scarlet · Explorer</title>` + HEAD + `<script defer src="https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js"></script></head>
<body class="bg-ink text-txt" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div x-data="explorer()" x-init="init()" x-cloak class="max-w-[1300px] mx-auto">

  <header class="sticky top-0 z-20 flex items-center gap-3 flex-wrap px-5 py-3 bg-ink/95 backdrop-blur border-b border-line">
    <a href="/" class="text-energy text-lg">←</a>
    <h1 class="text-lg font-semibold tracking-wide">Explorer indirizzi</h1>
    <span class="text-[11px] px-2 py-0.5 rounded-full border border-energy/50 text-energy" x-text="chain.name||'…'"></span>
    <span class="text-[11px] text-dim" x-text="total+' su questo filtro'"></span>
    <div class="flex-1"></div>
    <input x-model.debounce.400ms="q" @input="reset()" placeholder="cerca address / simbolo / nome…" class="bg-panel border border-line rounded-lg px-3 py-1.5 text-sm w-72 focus:border-energy outline-none">
  </header>

  <main class="px-5 py-4 space-y-3">
    <!-- Filtri kind con conteggi -->
    <div class="flex gap-2 flex-wrap">
      <template x-for="k in kinds" :key="k.id">
        <button @click="kind=k.id;reset()" class="text-[12px] px-3 py-1.5 rounded-full border transition" :class="kind===k.id?'border-energy text-energy bg-energy/10':'border-line text-dim hover:text-txt'">
          <span x-text="k.label"></span> <span class="opacity-60" x-text="'('+(k.id==='all'?totalAll():(counts[k.id]||0))+')'"></span>
        </button>
      </template>
    </div>

    <div class="rounded-2xl bg-panel border border-line overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-[12.5px]">
          <thead class="bg-panel2 text-dim text-[10px] uppercase">
            <tr>
              <th class="text-left font-medium py-2 px-3">Tipo</th>
              <th class="text-left font-medium px-3">Simbolo / Nome</th>
              <th class="text-left font-medium px-3">Indirizzo</th>
              <th class="text-left font-medium px-3">Dettagli</th>
              <th class="text-left font-medium px-3">Fonte</th>
              <th class="text-left font-medium px-3">Stato</th>
            </tr>
          </thead>
          <tbody>
            <template x-if="!rows.length"><tr><td colspan="6" class="text-dim py-6 px-3 text-center">nessun indirizzo per questo filtro</td></tr></template>
            <template x-for="e in rows" :key="e.kind+e.address">
              <tr class="border-t border-line hover:bg-panel2">
                <td class="py-2 px-3"><span class="text-[10px] px-1.5 py-0.5 rounded border" :class="kindColor(e.kind)" x-text="e.kind"></span></td>
                <td class="px-3"><div class="font-semibold" x-text="e.symbol||'—'"></div><div class="text-dim text-[11px]" x-text="e.name||''"></div></td>
                <td class="px-3"><a class="font-mono text-energy" :href="chain.explorer+'/address/'+e.address" target="_blank" x-text="short(e.address)"></a></td>
                <td class="px-3 text-dim" x-html="details(e)"></td>
                <td class="px-3 text-dim" x-text="e.source"></td>
                <td class="px-3"><span class="text-[11px]" :class="e.status==='blacklisted'?'text-neg':e.status==='active'?'text-pos':'text-dim'" x-text="e.status"></span></td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between px-3 py-2 border-t border-line text-[12px] text-dim">
        <button @click="prev()" :disabled="offset===0" class="px-3 py-1 rounded border border-line disabled:opacity-30" :class="offset>0?'hover:text-txt':''">← precedenti</button>
        <span x-text="'mostrati '+(rows.length?offset+1:0)+'–'+(offset+rows.length)+' di '+total"></span>
        <button @click="next()" :disabled="offset+rows.length>=total" class="px-3 py-1 rounded border border-line disabled:opacity-30" :class="offset+rows.length<total?'hover:text-txt':''">successivi →</button>
      </div>
    </div>
  </main>
</div>
<script>
function explorer(){return{
  rows:[], counts:{}, total:0, chain:{}, kind:'all', q:'', offset:0, limit:100,
  kinds:[{id:'all',label:'Tutti'},{id:'protocol',label:'Protocolli'},{id:'token',label:'Token'},{id:'pool',label:'Pool'},{id:'dex',label:'DEX'},{id:'wallet',label:'Wallet'},{id:'contract',label:'Contratti'}],
  init(){ this.load(); },
  async load(){ try{ const u='/api/entities?kind='+this.kind+'&q='+encodeURIComponent(this.q)+'&limit='+this.limit+'&offset='+this.offset; const d=await (await fetch(u)).json(); this.rows=d.rows||[]; this.counts=d.counts||{}; this.total=d.total||0; this.chain=d.chain||{}; }catch(e){} },
  reset(){ this.offset=0; this.load(); },
  next(){ if(this.offset+this.rows.length<this.total){ this.offset+=this.limit; this.load(); } },
  prev(){ if(this.offset>0){ this.offset=Math.max(0,this.offset-this.limit); this.load(); } },
  totalAll(){ return Object.values(this.counts).reduce((a,b)=>a+b,0); },
  short(a){ return a?a.slice(0,10)+'…'+a.slice(-6):'?'; },
  kindColor(k){ return ({protocol:'border-scarlet/50 text-scarlet',token:'border-stable/50 text-stable',pool:'border-energy/50 text-energy',dex:'border-warn/50 text-warn',wallet:'border-pos/50 text-pos',contract:'border-line text-dim'})[k]||'border-line text-dim'; },
  verif(m){ if(m.verifiedCheckedAt===undefined) return '';
    let v = m.verified ? ' <span class="text-pos">✓ verificato'+(m.contractName?(' · '+m.contractName):'')+'</span>' : ' <span class="text-neg">⚠ non verificato</span>';
    if(m.isProxy) v += ' <span class="text-warn">proxy</span>';
    return v; },
  details(e){ const m=e.meta||{};
    if(e.kind==='protocol') return '<span class="text-txt">'+(m.category||'?')+'</span>'+(m.family?(' · '+m.family):'')+(m.role?(' · '+m.role):'')+(m.tvlUsd?(' · TVL $'+(m.tvlUsd/1e6).toFixed(0)+'M'):'');
    if(e.kind==='token') return (e.decimals!=null?('dec '+e.decimals):'')+this.verif(m);
    if(e.kind==='pool'){ const a=m.archetype||'?'; const fee=m.fee!=null?(' · fee '+(m.fee/10000)+'%'):''; const t0=m.token0?this.short(m.token0):'?'; const t1=m.token1?this.short(m.token1):'?'; return '<span class="text-txt">'+a+'</span>'+fee+' · <span class="font-mono">'+t0+' / '+t1+'</span>'; }
    if(e.kind==='dex') return (m.role||'factory')+this.verif(m);
    return (e.note||'')+this.verif(m); }
}}
</script>
</body></html>`;

/**
 * HEALTH & DIAGNOSTICS — built from the failures this project actually hit, so a human can SEE them:
 *  · a buffer that reported 18 items while 10k entities were incomplete  → Completezza dati + Buffer
 *  · pools burned into enrich_failed by a flaky lane                      → Falliti, con motivo
 *  · 2.5% tick certification silently capping every executable claim      → Certificazione per protocollo
 *  · numbers shown without their trustworthiness                          → KG con exact/executable/preflight
 *  · a misleading error hiding the real cause                             → Problemi (dedup, con conteggi)
 * Traffic-light at the top = "is anything wrong right now"; tables below = "what and where".
 */
const HEALTH_PAGE = String.raw`<!doctype html><html lang="it" class="dark"><head><title>Scarlet · Salute</title>` + HEAD + `<script defer src="https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js"></script></head>
<body class="bg-ink text-txt" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div x-data="health()" x-init="init()" x-cloak class="max-w-[1200px] mx-auto pb-16">

  <div class="flex items-center gap-2 px-5 pt-3 pb-1 text-dim text-[11px]">
    <span class="w-2 h-2 rounded-full bg-scarlet livedot"></span>
    <a href="/" class="font-semibold tracking-wide text-txt hover:text-scarlet">SCARLET</a>
    <span class="text-dim">/ salute &amp; diagnostica</span>
    <span class="ml-auto" x-text="clock"></span>
    <button @click="load()" class="ml-2 px-2 py-0.5 rounded border border-line hover:border-energy text-dim hover:text-energy">aggiorna</button>
  </div>

  <!-- SEMAFORO: sta bene adesso? -->
  <div class="px-5 grid grid-cols-2 md:grid-cols-6 gap-2 mt-2">
    <template x-for="k in lights" :key="k.label">
      <div class="rounded-xl border p-3" :class="k.ok==='ok'?'border-pos/40 bg-pos/5':k.ok==='warn'?'border-warn/50 bg-warn/5':'border-neg/50 bg-neg/5'">
        <div class="text-[10px] uppercase tracking-wide text-dim" x-text="k.label"></div>
        <div class="text-lg font-mono" :class="k.ok==='ok'?'text-pos':k.ok==='warn'?'text-warn':'text-neg'" x-text="k.value"></div>
        <div class="text-[10px] text-dim" x-text="k.note"></div>
      </div>
    </template>
  </div>

  <!-- PROBLEMI -->
  <div class="px-5 mt-5">
    <div class="flex items-center gap-2 mb-2">
      <h2 class="text-sm font-semibold">Problemi rilevati</h2>
      <span class="text-[10px] text-dim">(solo warn/error/fatal, raggruppati per causa)</span>
      <select x-model="minLevel" @change="loadProblems()" class="ml-auto bg-panel border border-line rounded px-2 py-0.5 text-[11px]">
        <option value="40">warn e oltre</option><option value="50">solo error/fatal</option>
      </select>
    </div>
    <div class="rounded-xl border border-line bg-panel overflow-hidden">
      <template x-if="!problems.length"><div class="p-4 text-dim text-xs">Nessun problema nella finestra letta. ✓</div></template>
      <template x-for="p in problems" :key="p.level+p.message+p.detail">
        <div class="border-b border-line/60 last:border-0 p-3 hover:bg-panel2" :class="p.active?'':'opacity-50'">
          <div class="flex items-start gap-2">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0"
                  :class="p.active?(p.level==='fatal'?'bg-neg/20 text-neg':p.level==='error'?'bg-neg/15 text-neg':'bg-warn/15 text-warn'):'bg-line/40 text-dim'"
                  x-text="p.active?p.level:'cessato'"></span>
            <span class="text-[10px] text-dim font-mono shrink-0" x-text="p.component"></span>
            <span class="text-xs" x-text="p.message"></span>
            <span class="ml-auto text-[10px] font-mono shrink-0" :class="p.count>50?'text-neg':'text-dim'" x-text="'×'+p.count"></span>
          </div>
          <div class="text-[11px] text-dim font-mono mt-1 break-all" x-show="p.detail" x-text="p.detail"></div>
          <div class="text-[10px] text-dim mt-1" x-text="'dal '+fmt(p.firstSeen)+' · ultimo '+fmt(p.lastSeen)"></div>
        </div>
      </template>
    </div>
    <!-- Stati VOLUTI: non guasti. Separati perché si ripetono a ogni riavvio e annegherebbero il segnale. -->
    <div class="mt-2" x-show="(configStates||[]).length">
      <button @click="showCfg=!showCfg" class="text-[10px] text-dim hover:text-energy">
        <span x-text="showCfg?'▾':'▸'"></span> Stati di configurazione voluti (<span x-text="configStates.length"></span>) — non sono guasti
      </button>
      <div x-show="showCfg" class="mt-1 rounded-xl border border-line/60 bg-panel/60 p-2 space-y-1">
        <template x-for="c in configStates" :key="c.message">
          <div class="text-[11px] text-dim"><span class="font-mono text-[10px]" x-text="c.component"></span> · <span x-text="c.message.slice(0,150)"></span> <span class="font-mono" x-text="'×'+c.count"></span></div>
        </template>
      </div>
    </div>
  </div>

  <!-- COMPLETEZZA DATI -->
  <div class="px-5 mt-5">
    <h2 class="text-sm font-semibold mb-2">Completezza dati <span class="text-[10px] text-dim font-normal">— un dato mancante è lavoro per l'enrichment, mai un default</span></h2>
    <div class="rounded-xl border border-line bg-panel overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="text-dim text-[10px] uppercase"><tr class="border-b border-line">
          <th class="text-left p-2">Archetipo</th><th class="text-right p-2">Pool</th><th class="text-left p-2 w-40">Completi</th><th class="text-right p-2">no token0</th>
          <th class="text-right p-2">no fee</th><th class="text-right p-2">no tickSpacing</th><th class="text-right p-2">no factory</th>
          <th class="text-right p-2">in buffer</th><th class="text-right p-2">falliti</th></tr></thead>
        <tbody>
          <template x-for="r in h.completeness||[]" :key="r.archetype">
            <tr class="border-b border-line/40 hover:bg-panel2">
              <td class="p-2 font-mono" x-text="r.archetype"></td>
              <td class="p-2 text-right font-mono" x-text="Number(r.total).toLocaleString()"></td>
              <td class="p-2">
                <div class="flex items-center gap-1.5">
                  <div class="flex-1 h-1.5 rounded bg-line/60 overflow-hidden min-w-[54px]">
                    <div class="h-full rounded" :class="pctN(r.complete,r.total)>=99.5?'bg-pos':pctN(r.complete,r.total)>=90?'bg-stable':'bg-warn'" :style="'width:'+pctN(r.complete,r.total)+'%'"></div>
                  </div>
                  <span class="font-mono text-[10px] shrink-0" :class="pctN(r.complete,r.total)>=99.5?'text-pos':'text-dim'" x-text="pct(r.complete,r.total)"></span>
                </div>
                <div class="text-[9px] text-dim font-mono" x-text="Number(r.complete).toLocaleString()+' / '+Number(r.total).toLocaleString()"></div>
              </td>
              <td class="p-2 text-right font-mono" :class="r.missing_token0?'text-neg':'text-dim'" x-text="r.missing_token0"></td>
              <td class="p-2 text-right font-mono" :class="!r.fee_applies?'text-dim/50':(r.missing_fee?'text-warn':'text-pos')" x-text="r.fee_applies? r.missing_fee : 'n/a'" :title="r.fee_applies?'':'fee di protocollo, non per-pool'"></td>
              <td class="p-2 text-right font-mono" :class="!r.spacing_applies?'text-dim/50':(r.missing_spacing?'text-warn':'text-pos')" x-text="r.spacing_applies? r.missing_spacing : 'n/a'" :title="r.spacing_applies?'':'non è liquidità concentrata'"></td>
              <td class="p-2 text-right font-mono" :class="r.missing_factory?'text-warn':'text-dim'" x-text="r.missing_factory"></td>
              <td class="p-2 text-right font-mono text-energy" x-text="r.pending"></td>
              <td class="p-2 text-right font-mono" :class="r.failed?'text-neg':'text-dim'" x-text="r.failed"></td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <!-- PERCHÉ un dato manca. Un buco che la catena rifiuta è un fatto conoscibile e limitato — ma solo se ha
         un NOME. Come semplice conteggio "falliti" sembra un difetto della pipeline; nominato, è una proprietà
         di quei contratti su cui una persona può decidere. -->
    <div class="mt-2 rounded-xl border border-line bg-panel p-3" x-show="(h.blocked||[]).length">
      <div class="text-[10px] text-dim uppercase mb-1.5">Dati che la catena rifiuta <span class="normal-case text-dim/70">— la funzione non esiste sul contratto, non è un errore di rete</span></div>
      <table class="w-full text-xs">
        <thead class="text-dim text-[10px] uppercase"><tr class="border-b border-line">
          <th class="text-left p-1.5">Archetipo</th><th class="text-left p-1.5">Campi non esposti</th><th class="text-right p-1.5">Pool</th><th class="text-right p-1.5">Stato</th></tr></thead>
        <tbody>
          <template x-for="b in h.blocked||[]" :key="b.archetype+'/'+(b.fields||'')">
            <tr class="border-b border-line/40">
              <td class="p-1.5 font-mono" x-text="b.archetype"></td>
              <td class="p-1.5 font-mono text-warn" x-text="b.fields||'—'"></td>
              <td class="p-1.5 text-right font-mono" x-text="Number(b.pools).toLocaleString()"></td>
              <td class="p-1.5 text-right font-mono text-[10px]" :class="b.any_failed?'text-neg':'text-dim'" x-text="b.any_failed?'cap tentativi raggiunto':'in ritentativo'"></td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <div class="mt-2 rounded-xl border border-line bg-panel p-3">
      <div class="text-[10px] text-dim uppercase mb-1">Token — <span class="font-mono text-txt" x-text="Number(h.tokens?.total||0).toLocaleString()"></span> totali</div>
      <div class="grid grid-cols-2 gap-3">
        <template x-for="f in [{k:'decimals',have:h.tokens?.have_decimals,miss:h.tokens?.missing_decimals,crit:true},{k:'symbol',have:h.tokens?.have_symbol,miss:h.tokens?.missing_symbol,crit:false}]" :key="f.k">
          <div>
            <div class="flex justify-between text-[11px]">
              <span class="text-dim" x-text="f.k + (f.crit?' (critico per i prezzi)':' (leggibilità)')"></span>
              <span class="font-mono" :class="pctN(f.have,h.tokens?.total)>=99.5?'text-pos':(f.crit?'text-neg':'text-warn')" x-text="pct(f.have,h.tokens?.total)"></span>
            </div>
            <div class="h-1.5 rounded bg-line/60 overflow-hidden mt-1">
              <div class="h-full rounded" :class="pctN(f.have,h.tokens?.total)>=99.5?'bg-pos':(f.crit?'bg-neg':'bg-stable')" :style="'width:'+pctN(f.have,h.tokens?.total)+'%'"></div>
            </div>
            <div class="text-[9px] text-dim font-mono mt-0.5" x-text="Number(f.have||0).toLocaleString()+' completi · '+Number(f.miss||0).toLocaleString()+' da fare'"></div>
          </div>
        </template>
      </div>
    </div>
    <div class="text-[10px] text-dim mt-1">
      <span class="ml-2 text-dim">— "n/a" = non applicabile a quell'archetipo, non un buco</span>
    </div>
    <!-- Dove la fee VIVE davvero per i pool constant-product: sulla factory. -->
    <div class="mt-3" x-show="(h.protocolFees||[]).length">
      <h3 class="text-xs font-semibold mb-1">Fee di protocollo <span class="text-[10px] text-dim font-normal">— per i pool constant-product la fee sta sulla FACTORY, non sul pool</span></h3>
      <div class="rounded-xl border border-line bg-panel overflow-x-auto">
        <table class="w-full text-xs"><thead class="text-dim text-[10px] uppercase"><tr class="border-b border-line">
          <th class="text-left p-2">Factory</th><th class="text-left p-2">Archetipo</th><th class="text-right p-2">Pool</th><th class="text-right p-2">Fee</th><th class="text-left p-2">Fonte</th></tr></thead>
          <tbody><template x-for="f in h.protocolFees||[]" :key="f.factory+f.archetype">
            <tr class="border-b border-line/40 hover:bg-panel2">
              <td class="p-2 font-mono text-[10px]" x-text="f.factory.slice(0,14)"></td>
              <td class="p-2 font-mono text-[10px]" x-text="f.archetype"></td>
              <td class="p-2 text-right font-mono" x-text="f.pools"></td>
              <td class="p-2 text-right font-mono" :class="f.fee_ppm?'text-pos':'text-neg'" x-text="f.fee_ppm? (Number(f.fee_ppm)/10000)+'%' : 'MANCA'"></td>
              <td class="p-2 text-[10px]" :class="f.fee_source?'text-dim':'text-neg'" x-text="f.fee_source||'da risolvere'"></td>
            </tr></template></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- COPERTURA DI ESECUZIONE: la metrica che spiega perché il KG non può agire su un pool -->
  <div class="px-5 mt-5">
    <h2 class="text-sm font-semibold mb-2">Copertura di esecuzione
      <span class="text-[10px] text-dim font-normal">— una factory senza router rende NON eseguibili tutti i suoi pool (è ciò che limita routeEncodable)</span>
    </h2>
    <div class="rounded-xl border border-line bg-panel p-3">
      <div class="flex items-baseline gap-3 mb-2">
        <span class="text-2xl font-mono" :class="execPct>=50?'text-pos':execPct>=20?'text-warn':'text-neg'" x-text="execPct.toFixed(1)+'%'"></span>
        <span class="text-[11px] text-dim">dei pool indicizzati è dietro una factory con router
          (<span class="font-mono" x-text="Number(execPools).toLocaleString()"></span> / <span class="font-mono" x-text="Number(execTotal).toLocaleString()"></span>)</span>
      </div>
      <div class="h-2 rounded bg-line/60 overflow-hidden mb-2"><div class="h-full rounded" :class="execPct>=50?'bg-pos':'bg-warn'" :style="'width:'+execPct+'%'"></div></div>
      <div class="max-h-56 overflow-y-auto">
        <table class="w-full text-xs"><thead class="text-dim text-[10px] uppercase"><tr class="border-b border-line">
          <th class="text-left p-1">Factory</th><th class="text-left p-1">Nome</th><th class="text-left p-1">Tipo</th><th class="text-right p-1">Pool</th><th class="text-center p-1">Router</th></tr></thead>
          <tbody><template x-for="d in h.execCoverage||[]" :key="d.factory">
            <tr class="border-b border-line/40 hover:bg-panel2" :class="d.hasRouter?'':'opacity-70'">
              <td class="p-1 font-mono text-[10px]" x-text="(d.factory||'').slice(0,12)"></td>
              <td class="p-1 text-[11px]" :class="d.name?'':'text-dim'" x-text="d.name||'anonima'"></td>
              <td class="p-1 text-[10px] font-mono" :class="d.type?'text-dim':'text-warn'" x-text="d.type||'—'"></td>
              <td class="p-1 text-right font-mono" x-text="Number(d.pools).toLocaleString()"></td>
              <td class="p-1 text-center" x-text="d.hasRouter?'✓':'✗'" :class="d.hasRouter?'text-pos':'text-neg'"></td>
            </tr></template></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- BUFFER + CERTIFICAZIONE -->
  <div class="px-5 mt-5 grid md:grid-cols-2 gap-4">
    <div>
      <h2 class="text-sm font-semibold mb-2">Buffer enrichment</h2>
      <div class="rounded-xl border border-line bg-panel p-3 text-xs space-y-1">
        <div class="flex justify-between"><span class="text-dim">da completare (in coda)</span><span class="font-mono text-energy" x-text="h.buffer?.in_buffer"></span></div>
        <div class="flex justify-between"><span class="text-dim">di cui resync (blocca il gate d'avvio)</span><span class="font-mono" x-text="h.buffer?.resync_outstanding"></span></div>
        <div class="flex justify-between"><span class="text-dim">falliti (fuori dal buffer)</span><span class="font-mono" :class="h.buffer?.failed?'text-neg':'text-pos'" x-text="h.buffer?.failed"></span></div>
        <div class="flex justify-between"><span class="text-dim">con tentativi &gt; 0</span><span class="font-mono" x-text="h.buffer?.with_attempts"></span></div>
        <div class="flex justify-between"><span class="text-dim">scritture ultimi 2 min</span><span class="font-mono" :class="h.buffer?.written_last_2min?'text-pos':'text-warn'" x-text="h.buffer?.written_last_2min"></span></div>
        <div class="text-[10px] text-dim pt-1 border-t border-line/50">Se "in coda" è alto ma le scritture sono 0, l'enrichment è fermo — non lento.</div>
      </div>
      <!-- ATTIVITÀ: cosa sta facendo, per pass. Distingue "sta lavorando" da "è bloccato". -->
      <div class="mt-2 rounded-xl border border-line bg-panel p-3">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-[10px] text-dim uppercase">Attività enrichment</span>
          <span class="text-[10px] text-dim">ultimi 60 min</span>
          <span class="ml-auto text-[10px]" :class="(en.rateLimitedCycles||0)>0?'text-warn':'text-dim'" x-text="(en.rateLimitedCycles||0)+' cicli rate-limited'"></span>
        </div>
        <div class="flex flex-wrap gap-1 mb-2">
          <template x-if="!Object.keys(en.totals||{}).length"><span class="text-[11px] text-dim">nessun completamento nell'ultima ora</span></template>
          <template x-for="[k,v] in Object.entries(en.totals||{})" :key="k">
            <span class="px-1.5 py-0.5 rounded bg-pos/10 border border-pos/30 text-[10px] font-mono text-pos" x-text="k+': '+v"></span>
          </template>
        </div>
        <div class="max-h-52 overflow-y-auto space-y-0.5">
          <template x-for="(r,i) in en.recent||[]" :key="i">
            <div class="text-[10px] font-mono flex gap-2" :class="r.note&&!Object.keys(r.passes||{}).length?'text-warn':'text-dim'">
              <span class="shrink-0" x-text="r.at"></span>
              <span class="shrink-0 text-dim/70" x-text="'blk '+(r.block||'—')"></span>
              <span x-text="Object.keys(r.passes||{}).length ? Object.entries(r.passes).map(([k,v])=>k+'×'+v).join(' · ') : (r.note||'—')"></span>
              <span x-show="r.rate_limited" class="text-warn shrink-0">⏳</span>
            </div>
          </template>
          <template x-if="!(en.recent||[]).length"><div class="text-[11px] text-dim">nessuna attività registrata (buffer vuoto = tutto completo)</div></template>
        </div>
      </div>
    </div>
    <div>
      <h2 class="text-sm font-semibold mb-2">Certificazione tick <span class="text-[10px] text-dim font-normal">— governa ogni numero "a size"</span></h2>
      <div class="rounded-xl border border-line bg-panel overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-dim text-[10px] uppercase"><tr class="border-b border-line"><th class="text-left p-2">Factory</th><th class="text-right p-2">Pool</th><th class="text-right p-2">Certificati</th><th class="text-right p-2">Falliti</th></tr></thead>
          <tbody>
            <template x-for="r in h.ticks||[]" :key="r.factory">
              <tr class="border-b border-line/40 hover:bg-panel2">
                <td class="p-2 font-mono text-[10px]" x-text="r.factory.slice(0,14)"></td>
                <td class="p-2 text-right font-mono" x-text="r.pools"></td>
                <td class="p-2 text-right font-mono" :class="r.certified? 'text-pos':'text-neg'" x-text="r.certified+' ('+pct(r.certified,r.pools)+')'"></td>
                <td class="p-2 text-right font-mono" :class="r.failed?'text-warn':'text-dim'" x-text="r.failed"></td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div class="mt-2 rounded-xl border border-line bg-panel p-2 text-[11px]" x-show="(h.tickErrors||[]).length">
        <div class="text-dim text-[10px] uppercase mb-1">Motivi di fallimento</div>
        <template x-for="e in h.tickErrors||[]" :key="e.reason">
          <div class="flex gap-2"><span class="font-mono text-warn shrink-0" x-text="e.n"></span><span class="text-dim break-all" x-text="e.reason"></span></div>
        </template>
      </div>
    </div>
  </div>

  <!-- PIPELINE + KG -->
  <div class="px-5 mt-5 grid md:grid-cols-2 gap-4">
    <div>
      <h2 class="text-sm font-semibold mb-2">Pipeline dati</h2>
      <div class="rounded-xl border border-line bg-panel p-3 text-xs space-y-1">
        <div class="flex justify-between"><span class="text-dim">indexer block</span><span class="font-mono" x-text="h.chain?.indexed_block"></span></div>
        <div class="flex justify-between"><span class="text-dim">lag / synced</span><span class="font-mono" :class="h.chain?.synced?'text-pos':'text-neg'" x-text="(h.chain?.lag_blocks??'—')+' blk · '+(h.chain?.synced?'sync':'DE-SYNC')"></span></div>
        <div class="flex justify-between"><span class="text-dim">copertura continua da</span><span class="font-mono" x-text="h.coverage?.coverage_start||'—'"></span></div>
        <div class="flex justify-between"><span class="text-dim">generazione copertura</span><span class="font-mono" x-text="h.coverage?.generation??'—'"></span></div>
        <div class="flex justify-between"><span class="text-dim">gas (età)</span><span class="font-mono" :class="Number(h.gas?.age_ms||9e9)<120000?'text-pos':'text-warn'" x-text="h.gas?(fmtAge(h.gas.age_ms)):'assente'"></span></div>
        <div class="flex justify-between"><span class="text-dim">pool_state freschi (5 min)</span><span class="font-mono" x-text="(h.poolState?.fresh_5min??'—')+' / '+(h.poolState?.total??'—')"></span></div>
        <template x-if="(h.gaps||[]).length">
          <div class="pt-1 border-t border-line/50">
            <div class="text-[10px] text-dim uppercase">Gap di copertura</div>
            <template x-for="g in h.gaps" :key="g.from_block">
              <div class="font-mono text-[10px]" :class="g.repaired_at?'text-dim':'text-neg'" x-text="g.from_block+'→'+g.to_block+' · '+(g.reason||'')+(g.repaired_at?' (riparato)':' (APERTO)')"></div>
            </template>
          </div>
        </template>
      </div>
    </div>
    <div>
      <h2 class="text-sm font-semibold mb-2">Knowledge Graph <span class="text-[10px] text-dim font-normal">— ogni numero con la sua affidabilità</span></h2>
      <div class="rounded-xl border border-line bg-panel p-3 text-xs space-y-1">
        <div class="flex justify-between"><span class="text-dim">candidati osservati</span><span class="font-mono" x-text="h.kg?.candidates??'—'"></span></div>
        <div class="flex justify-between"><span class="text-dim">di cui simulazione EXACT</span><span class="font-mono" :class="h.kg?.exact?'text-pos':'text-warn'" x-text="h.kg?.exact??'—'"></span></div>
        <div class="flex justify-between"><span class="text-dim">di cui executable</span><span class="font-mono" x-text="h.kg?.executable??'—'"></span></div>
        <div class="flex justify-between"><span class="text-dim">preflight passati (reali on-chain)</span><span class="font-mono" :class="h.kg?.preflight_pass?'text-pos':'text-dim'" x-text="h.kg?.preflight_pass??'—'"></span></div>
        <div class="flex justify-between"><span class="text-dim">signal execution_gap</span><span class="font-mono" x-text="h.kg?.signals??'—'"></span></div>
        <div class="flex justify-between"><span class="text-dim">cicli observer / surface</span><span class="font-mono" x-text="(h.kg?.observer_runs??'—')+' / '+(h.kg?.surface_runs??'—')"></span></div>
        <div class="pt-1 border-t border-line/50 text-[10px] text-dim" x-show="h.lastRun?.block">
          ultimo ciclo: blocco <span class="font-mono" x-text="h.lastRun?.block"></span> ·
          <span class="font-mono" x-text="Math.round((h.lastRun?.duration_ms||0)/1000)+'s'"></span> ·
          <span class="font-mono" x-text="fmtAge(h.lastRun?.age_ms)+' fa'"></span>
        </div>
      </div>
      <div class="mt-2 rounded-xl border border-line bg-panel p-3 text-xs" x-show="(h.lending||[]).length">
        <div class="text-[10px] text-dim uppercase mb-1">Posizioni lending</div>
        <template x-for="l in h.lending||[]" :key="l.tier">
          <div class="flex justify-between"><span class="text-dim font-mono" x-text="l.tier"></span><span class="font-mono" x-text="l.n+' · $'+(Number(l.debt_usd||0)).toLocaleString()"></span></div>
        </template>
      </div>
    </div>
  </div>

  <div class="px-5 mt-4 text-[10px] text-dim">
    Vedi anche: <a href="/explorer" class="text-energy hover:underline">Explorer entità</a> ·
    <a href="/liquidations" class="text-energy hover:underline">Liquidazioni</a> ·
    <a href="/arb" class="text-energy hover:underline">Arbitraggi</a>
  </div>
</div>
<script>
function health(){ return {
  h:{}, en:{}, problems:[], configStates:[], showCfg:false, clock:"", minLevel:"40",
  async init(){ await this.load(); setInterval(()=>this.load(), 15000); },
  async load(){ await Promise.all([this.loadHealth(), this.loadProblems(), this.loadEnrich()]); this.clock=new Date().toLocaleTimeString(); },
  async loadHealth(){ try{ this.h = await (await fetch('/api/health')).json(); }catch(e){} },
  async loadEnrich(){ try{ this.en = await (await fetch('/api/enrichment')).json(); }catch(e){} },
  async loadProblems(){ try{ const d=await (await fetch('/api/problems?min='+this.minLevel)).json(); this.problems=d.problems||[]; this.configStates=d.configStates||[]; }catch(e){} },
  miss(r,f){ const conc=['v3','slipstream','algebra'].includes(r.archetype); return conc && (f==='fee'? r.missing_fee : r.missing_spacing) > 0; },
  pct(a,b){ if(!b) return '—'; const p=100*Number(a||0)/Number(b); const s=(p>=99 && p<100)? p.toFixed(1) : String(Math.round(p)); return s+'%'; },
  pctN(a,b){ return b? Math.min(100, 100*Number(a||0)/Number(b)) : 0; },
  get execTotal(){ return (this.h.execCoverage||[]).reduce(function(s,d){ return s+Number(d.pools||0); },0); },
  get execPools(){ return (this.h.execCoverage||[]).filter(function(d){ return d.hasRouter; }).reduce(function(s,d){ return s+Number(d.pools||0); },0); },
  get execPct(){ var t=this.execTotal; return t? 100*this.execPools/t : 0; },
  fmt(t){ try{ return new Date(t).toLocaleString(); }catch(e){ return t; } },
  fmtAge(ms){ const s=Math.round(Number(ms||0)/1000); if(s<60) return s+'s'; if(s<3600) return Math.round(s/60)+'m'; return Math.round(s/3600)+'h'; },
  get lights(){ const h=this.h, L=[];
    const lag=Number(h.chain?.lag_blocks??999), synced=h.chain?.synced;
    L.push({label:'Indexer', value:(synced?'sync':'DE-SYNC')+' · '+lag+'blk', ok:(synced&&lag<=3)?'ok':(synced?'warn':'bad'), note:'blocco '+(h.chain?.indexed_block||'—')});
    const buf=Number(h.buffer?.in_buffer??0), wrote=Number(h.buffer?.written_last_2min??0);
    L.push({label:'Buffer enrichment', value:buf.toLocaleString(), ok: buf===0?'ok':(wrote>0?'warn':'bad'), note: buf===0?'completo':(wrote>0?'in lavorazione':'FERMO (0 scritture/2min)')});
    const fail=Number(h.buffer?.failed??0);
    L.push({label:'Entità fallite', value:fail.toLocaleString(), ok: fail===0?'ok':(fail<50?'warn':'bad'), note: fail?'dati mancanti a valle':'nessuna'});
    const gasAge=Number(h.gas?.age_ms??9e9);
    L.push({label:'Gas', value:h.gas?fmtAgeS(gasAge):'assente', ok: gasAge<120000?'ok':'bad', note:'serve per il net PnL'});
    const tp=(h.ticks||[]).reduce((a,r)=>({c:a.c+Number(r.certified),p:a.p+Number(r.pools)}),{c:0,p:0});
    L.push({label:'Tick certificati', value:this.pct(tp.c,tp.p), ok: tp.p&&tp.c/tp.p>0.5?'ok':(tp.c?'warn':'bad'), note:tp.c+'/'+tp.p+' pool concentrated'});
    const act=this.problems.filter(p=>p.active); const err=act.filter(p=>p.level!=='warn').reduce((a,p)=>a+p.count,0);
    L.push({label:'Errori', value:String(err), ok: err===0?'ok':(err<20?'warn':'bad'), note:act.length+' attivi · '+this.problems.length+' totali'});
    return L; },
} }
function fmtAgeS(ms){ const s=Math.round(Number(ms||0)/1000); if(s<60) return s+'s'; if(s<3600) return Math.round(s/60)+'m'; return Math.round(s/3600)+'h'; }
</script>
</body></html>`;
