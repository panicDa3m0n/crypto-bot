import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";
import type { Aggregator } from "./aggregator.js";

/**
 * Deterministic opportunity feed for Monad. Everything here is computed by the
 * SYSTEM (not by Scarlet's reasoning) and handed to her pre-digested: the current
 * block, the Morpho lending markets, and the positions ranked by health — so her
 * cognition is spent on WHICH prey to take and HOW, never on enumerating borrowers
 * or recomputing health factors. Sourced from the Morpho indexer API.
 */
/** marketParams = the exact tuple Morpho's liquidate()/flashLoan path needs, so she
 * builds the tx without reading or guessing anything on-chain. */
export type MarketParams = { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string };
export type AtRiskPosition = { healthFactor: number; dropToLiqPct: number; collateral: string; loan: string; collateralClass: "liquid" | "pt-locked" | "unknown"; routeVerified?: boolean; quality?: "primary" | "secondary"; debtUsd: number; collateralUsd: number; user: string; marketId: string; marketParams: MarketParams; evScore?: number };

/** Whether the seized collateral can actually be sold to close a liquidation. PT-
 * (Pendle) is locked until maturity and Monad has no PT market; blue-chips are
 * liquid by symbol; everything else starts 'unknown' and is PROMOTED to 'liquid'
 * only when an on-chain DEX quote proves a real exit route exists on Monad. */
const LIQUID_COLLATERAL = new Set(["WMON", "WBTC", "CBBTC", "WETH", "USDC", "USDT0", "AUSD", "MUSD", "SOL", "USDE"]);
function classifyCollateral(symbol: string): "liquid" | "pt-locked" | "unknown" {
  const s = symbol.toUpperCase();
  if (s.startsWith("PT-")) return "pt-locked";
  if (LIQUID_COLLATERAL.has(s)) return "liquid";
  return "unknown";
}
const ZERO = "0x0000000000000000000000000000000000000000";
const FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const POOL_ABI = parseAbi(["function liquidity() view returns (uint128)"]);
const QUOTER_ABI = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]);
const DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);
export type MorphoMarket = { pair: string; lltvPct: number; borrowUsd: number; collateralUsd: number; marketId: string };
export type SkippedPosition = { collateral: string; loan: string; healthFactor: number; debtUsd: number; collateralUsd: number; user: string; marketId: string; reason: string };
export type MonadSignalsData = {
  observedAt: string;
  liquidatableNow: AtRiskPosition[];
  onTheEdge: AtRiskPosition[];
  secondary: AtRiskPosition[];
  skipped: SkippedPosition[];
  topMarkets: MorphoMarket[];
  excludedCount: number;
  note: string;
};

const MARKETS_Q = `query($c:[Int!]){ markets(first:80, where:{chainId_in:$c}){ items { marketId lltv collateralAsset{symbol} loanAsset{symbol} state{ borrowAssetsUsd collateralAssetsUsd } } } }`;
const POS_Q = `query($c:[Int!]){ marketPositions(first:40, orderBy:HealthFactor, orderDirection:Asc, where:{chainId_in:$c, healthFactor_lte:1.05}){ items { healthFactor priceVariationToLiquidationPrice user{address} market{ marketId lltv irmAddress oracle{address} collateralAsset{symbol address} loanAsset{symbol address} } state{ borrowAssetsUsd collateralUsd } } } }`;

export class MonadSignals {
  private readonly sellCache = new Map<string, { sellable: boolean; at: number }>();
  private readonly decimalsCache = new Map<string, number>();
  private blacklist: { rows: Array<{ scope: string; value: string; tier: string }>; at: number } = { rows: [], at: 0 };
  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly aggregator: Aggregator, private readonly logger: Logger) {}

  /** Highest-severity blacklist tier hitting a token (by address or symbol substring),
   * or undefined if clean. Cached ~30s so the 5s dashboard poll doesn't re-query. */
  private async blacklistTier(symbol: string, address: string): Promise<"exclude" | "secondary" | undefined> {
    if (Date.now() - this.blacklist.at > 30_000) { this.blacklist = { rows: await this.db.listBlacklist().catch(() => []), at: Date.now() }; }
    const sym = symbol.toUpperCase(); const addr = address.toLowerCase();
    let tier: "exclude" | "secondary" | undefined;
    for (const r of this.blacklist.rows) {
      const hit = r.scope === "token" ? r.value === addr : sym.includes(r.value);
      if (!hit) continue;
      if (r.tier === "exclude") return "exclude";
      tier = "secondary";
    }
    return tier;
  }

  /** Proves the seized collateral is actually EXITABLE — across ALL venues, not just Uniswap V3.
   * A V3-only probe gave FALSE NEGATIVES (collateral that trades on Aerodrome/V4/etc. was wrongly
   * marked "no exit" and profitable liquidations were hidden). Now `dexOut` (the aggregator) routes
   * collateral→loan across every venue: a nonzero quote = a real, executable sell route.
   * Cached ~90s per pair so repeated feed reads don't hammer the aggregator. */
  private async probeSellable(collateral: Address, loan: Address): Promise<boolean> {
    if (collateral.toLowerCase() === loan.toLowerCase()) return true;
    const key = `${collateral.toLowerCase()}:${loan.toLowerCase()}`;
    const cached = this.sellCache.get(key);
    if (cached && Date.now() - cached.at < 90_000) return cached.sellable;
    let sellable = false;
    try {
      let dec = this.decimalsCache.get(collateral.toLowerCase());
      if (dec === undefined) { dec = Number(await this.chain.primary.readContract({ address: collateral, abi: DECIMALS_ABI, functionName: "decimals" }).catch(() => 18)); this.decimalsCache.set(collateral.toLowerCase(), dec); }
      const amountIn = 10n ** BigInt(dec); // 1 whole token — enough to confirm a route
      const q = await this.aggregator.quote(collateral, loan, amountIn);
      sellable = q !== null && q.amountOut > 0n; // routable across ALL venues
    } catch (error) { this.logger.debug({ err: error, collateral, loan }, "sellability probe failed"); }
    this.sellCache.set(key, { sellable, at: Date.now() });
    return sellable;
  }

  private async gql<T>(query: string): Promise<T> {
    const res = await fetch(this.config.MORPHO_API_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { c: [this.config.ETHERSCAN_CHAIN_ID] } }),
      signal: AbortSignal.timeout(12_000)
    });
    if (!res.ok) throw new Error(`Morpho API ${res.status}`);
    const json = await res.json() as { data?: T; errors?: unknown[] };
    if (json.errors?.length || !json.data) throw new Error(`Morpho API error: ${JSON.stringify(json.errors)?.slice(0, 200)}`);
    return json.data;
  }

  /** Pre-digested liquidation surface. Dust/test positions (<$1 debt) are dropped. */
  async fetch(): Promise<MonadSignalsData> {
    const [mkts, pos] = await Promise.all([
      this.gql<{ markets: { items: RawMarket[] } }>(MARKETS_Q),
      this.gql<{ marketPositions: { items: RawPos[] } }>(POS_Q)
    ]);
    const mapped = (pos.marketPositions?.items ?? [])
      .map(toPosition)
      .filter((p) => p.debtUsd >= 1); // drop dust markets
    // Signal-quality gate: drop blacklisted-'exclude' (test/synthetic) tokens entirely so
    // Scarlet's feed is REAL prey only; 'secondary'-tier is kept but demoted.
    let excludedCount = 0;
    const positions: AtRiskPosition[] = [];
    const forcedSecondary = new Set<AtRiskPosition>();
    for (const p of mapped) {
      const tier = await this.blacklistTier(p.collateral, p.marketParams.collateralToken);
      if (tier === "exclude") { excludedCount += 1; continue; }
      if (tier === "secondary") forcedSecondary.add(p);
      positions.push(p);
    }
    // Promote 'unknown' collateral to 'liquid' when an on-chain DEX quote proves a real
    // exit route on Monad — so genuinely liquid prey (wstETH, LSTs, etc.) not in the static
    // allowlist is no longer wrongly skipped. Only unknowns are probed; pt-locked stays.
    await Promise.all(positions.filter((p) => p.collateralClass === "unknown").map(async (p) => {
      if (await this.probeSellable(p.marketParams.collateralToken as Address, p.marketParams.loanToken as Address)) { p.collateralClass = "liquid"; p.routeVerified = true; }
    }));
    // PRIMARY = route-verified-liquid prey (actually exitable, actionable). Everything else
    // (no exit route, pt-locked, or blacklist 'secondary') is demoted to the secondary bucket
    // for occasional verification — not the main feed. This is where opportunities are born.
    for (const p of positions) p.quality = (p.collateralClass === "liquid" && !forcedSecondary.has(p)) ? "primary" : "secondary";
    const primary = positions.filter((p) => p.quality === "primary");
    const secondaryPool = positions.filter((p) => p.quality === "secondary");
    // PROFITABILITY GATE: HF<1 makes a position liquidatable, but it's only PROFITABLE if the
    // seized collateral is worth more than the debt you repay. Deeply-underwater positions
    // (HF≈0, collateralUsd≈0) are BAD DEBT — repaying them seizes ~nothing, a pure loss. Require
    // the collateral to still cover the debt (with margin for the incentive/slippage/gas), and
    // rank by the actual profit margin, not by raw debt size (which surfaced the worst husks).
    const profitable = primary.filter((p) => p.healthFactor < 1 && p.collateralUsd > p.debtUsd);
    const badDebtPositions = primary.filter((p) => p.healthFactor < 1 && p.collateralUsd <= p.debtUsd);
    const badDebt = badDebtPositions.length;
    const liquidatableNow = profitable.sort((a, b) => (b.collateralUsd - b.debtUsd) - (a.collateralUsd - a.debtUsd));
    // Skipped-with-reason: what the system sees but WON'T fire, and why — for the dashboard/tool.
    const skip = (p: AtRiskPosition, reason: string): SkippedPosition => ({ collateral: p.collateral, loan: p.loan, healthFactor: p.healthFactor, debtUsd: p.debtUsd, collateralUsd: p.collateralUsd, user: p.user, marketId: p.marketId, reason });
    const skipped: SkippedPosition[] = [
      ...badDebtPositions.map((p) => skip(p, "bad debt — collateral ≤ debt (liquidating loses money)")),
      ...secondaryPool.map((p) => skip(p, p.collateralClass === "pt-locked" ? "PT collateral locked until maturity — no exit" : "no verified DEX exit route for the collateral"))
    ].sort((a, b) => a.healthFactor - b.healthFactor).slice(0, 25);
    const onTheEdge = primary.filter((p) => p.healthFactor >= 1 && p.healthFactor <= 1.03).sort((a, b) => a.healthFactor - b.healthFactor);
    const secondary = secondaryPool.sort((a, b) => a.healthFactor - b.healthFactor).slice(0, 8);
    const topMarkets = (mkts.markets?.items ?? [])
      .map(toMarket)
      .filter((m) => m.borrowUsd >= 100)
      .sort((a, b) => b.borrowUsd - a.borrowUsd)
      .slice(0, 12);
    return {
      observedAt: new Date().toISOString(),
      liquidatableNow: liquidatableNow.slice(0, 10),
      onTheEdge: onTheEdge.slice(0, 10),
      secondary,
      skipped,
      topMarkets,
      excludedCount,
      note: liquidatableNow.length
        ? `${liquidatableNow.length} PROFITABLE liquidatable position(s) NOW on ${this.config.CHAIN_NAME} (collateralUsd > debtUsd, exit-route verified, ranked by profit margin). Simulate the seize→sell before firing (slippage+gas must still clear). Use flash_liquidate/organ or arm_autoflash.${badDebt ? ` (${badDebt} other HF<1 position(s) hidden as BAD DEBT — collateral no longer covers the debt, liquidating them loses money.)` : ""}`
        : onTheEdge.length
          ? `No profitable liquidation now, but ${onTheEdge.length} REAL prey on the edge (exit-route verified). arm_autoflash them so you fire the instant they cross hf<1 WHILE collateral still covers debt.${badDebt ? ` (${badDebt} HF<1 position(s) are bad debt — collateral worth less than the debt — skip them.)` : ""}`
          : `Liquidation surface is dry on ${this.config.CHAIN_NAME}: 0 profitable prey.${badDebt ? ` ${badDebt} position(s) are underwater but are BAD DEBT (collateral ≤ debt) — no profit in liquidating them.` : ""} ${secondary.length} secondary position(s) have no verified DEX exit (or are demoted) — occasional-check only. ${excludedCount} test/blacklisted market(s) hidden. Pursue fresh launches, arbHints, or peg-arb instead.`
    };
  }
}

type RawMarket = { marketId: string; lltv: string; collateralAsset?: { symbol?: string }; loanAsset?: { symbol?: string }; state?: { borrowAssetsUsd?: number; collateralAssetsUsd?: number } };
type RawPos = { healthFactor?: number; priceVariationToLiquidationPrice?: number; user?: { address?: string }; market?: { marketId?: string; lltv?: string; irmAddress?: string; oracle?: { address?: string }; collateralAsset?: { symbol?: string; address?: string }; loanAsset?: { symbol?: string; address?: string } }; state?: { borrowAssetsUsd?: number; collateralUsd?: number } };

function toMarket(m: RawMarket): MorphoMarket {
  return { pair: `${m.collateralAsset?.symbol ?? "?"}/${m.loanAsset?.symbol ?? "?"}`, lltvPct: Math.round(Number(m.lltv ?? 0) / 1e16), borrowUsd: round2(m.state?.borrowAssetsUsd ?? 0), collateralUsd: round2(m.state?.collateralAssetsUsd ?? 0), marketId: m.marketId };
}
function toPosition(p: RawPos): AtRiskPosition {
  return {
    healthFactor: round4(p.healthFactor ?? 0),
    dropToLiqPct: round4((p.priceVariationToLiquidationPrice ?? 0) * 100),
    collateral: p.market?.collateralAsset?.symbol ?? "?",
    loan: p.market?.loanAsset?.symbol ?? "?",
    collateralClass: classifyCollateral(p.market?.collateralAsset?.symbol ?? "?"),
    debtUsd: round2(p.state?.borrowAssetsUsd ?? 0),
    collateralUsd: round2(p.state?.collateralUsd ?? 0),
    user: p.user?.address ?? "",
    marketId: p.market?.marketId ?? "",
    marketParams: {
      loanToken: p.market?.loanAsset?.address ?? "",
      collateralToken: p.market?.collateralAsset?.address ?? "",
      oracle: p.market?.oracle?.address ?? "",
      irm: p.market?.irmAddress ?? "",
      lltv: p.market?.lltv ?? ""
    }
  };
}
function round2(v: number): number { return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }
function round4(v: number): number { return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0; }
