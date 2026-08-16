import type { Logger } from "pino";
import { parseAbi, type Address } from "viem";
import type { Config } from "./config.js";
import type { BerachainClients } from "./chain.js";
import type { Database } from "./db.js";

/**
 * PriceOracle — WE compute the price the way the DEX does: not from an aggregator or a third-party
 * index, but from the pool's on-chain STATE via the archetype's invariant. Deterministic (same
 * block → same price), atomic (all reads at ONE block → zero timing noise), exact (the AMM math
 * itself), and coherent (each archetype with its own formula). Every downstream calc — arbitrage,
 * liquidation exit value, holdings valuation — inherits this precision.
 *
 *   constant-product (V2 / Solidly-volatile):  out = in·(1−f)·Rout / (Rin + in·(1−f))
 *   concentrated (V3 / Slipstream):             within the current tick the pool is a constant
 *                                               product on the VIRTUAL reserves x=L·2⁹⁶/√P,
 *                                               y=L·√P/2⁹⁶ — so the same closed form applies,
 *                                               fork-agnostic, no quoter contract needed.
 *
 * The V3 single-tick model is exact for trades that don't cross a tick (arb sizes); it slightly
 * UNDER-states output when a large trade crosses into deeper liquidity — a conservative bias.
 */
const V2POOL = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"]);
const V3POOL = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)", "function liquidity() view returns (uint128)", "function token0() view returns (address)"]);
const DEC = parseAbi(["function decimals() view returns (uint8)"]);
// Solidly (Aerodrome/Velodrome) pools expose their OWN exact pricing via getAmountOut — it applies
// the correct invariant (stable x³y+xy³=k OR volatile x·y=k) and the pool's real fee. We call it
// rather than reimplement Newton's method for the stable curve: a stable pool holds imbalanced
// reserves at ~1:1, so constant-product on its reserve ratio fabricates a huge phantom spread.
const SOLIDLY = parseAbi(["function getAmountOut(uint256,address) view returns (uint256)"]);
const Q96 = 2n ** 96n;

export type PoolRef = { address: string; archetype: string; token0: string; token1: string; fee?: number };

export class PriceOracle {
  private readonly dec = new Map<string, number>();
  private readonly resCache = new Map<string, { r0: bigint; r1: bigint } | null>(); // pool@block → reserves (exact, block-pinned)
  private readonly resLatest = new Map<string, { val: { r0: bigint; r1: bigint } | null; at: number }>(); // pool → latest reserves (short TTL)
  private readonly LATEST_TTL_MS = 4_000; // ~2 Base blocks: within a classify burst the same pool is read once, not N times
  private readonly usdCache = new Map<string, { usd: number; at: number }>(); // token → usd (short TTL)
  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly logger: Logger) {
    // Pre-seed authoritative decimals from the network profile (USDC=6, cbBTC=8, WETH=18…). These
    // never depend on a flaky RPC read — decisive for the USD conversion of loan-token proceeds.
    for (const t of config.network.tokens) if (t.decimals != null && Number.isFinite(t.decimals)) this.dec.set(t.address.toLowerCase(), t.decimals);
  }

  /**
   * Token decimals — an IMMUTABLE fact, resolved from the SYSTEM first and never guessed.
   * Order: in-memory cache → config seed → entities registry (scanner-persisted). Only if the
   * system has never seen this token do we read it ONCE on the precision lane, then PERSIST it to
   * the registry so it becomes system data forever. If it truly cannot be read, we THROW — there is
   * no "default 18": a system this precise must skip a token it can't identify, never price it on a
   * guess (an 18-vs-6 guess silently zeroes every downstream USD figure).
   */
  private async decimals(token: Address): Promise<number> {
    const k = token.toLowerCase();
    const c = this.dec.get(k); if (c !== undefined) return c;
    const ent = await this.db.getEntity(this.config.CHAIN_ID, k).catch(() => [] as Array<{ decimals: number | null }>);
    const ed = ent[0]?.decimals;
    if (ed != null && Number.isFinite(ed)) { this.dec.set(k, ed); return ed; }
    const d = await this.chain.precisionRead((c2) => c2.readContract({ address: token, abi: DEC, functionName: "decimals" }), "decimals").then(Number).catch(() => undefined);
    if (d !== undefined && Number.isFinite(d) && d >= 0 && d <= 36) {
      this.dec.set(k, d);
      await this.db.upsertEntity({ chainId: this.config.CHAIN_ID, address: k, kind: "token", decimals: d, source: "oracle-read" }).catch(() => undefined);
      return d;
    }
    throw new Error(`unknown decimals for ${k}: not in system and RPC read failed — token skipped (no guess)`);
  }

  private feePpm(pool: PoolRef): bigint {
    if (pool.fee != null && pool.fee > 0) return BigInt(pool.fee); // V3 fee is already ppm (500/3000/10000)
    return 3000n; // v2/solidly default 0.3% (scanner doesn't capture v2 fee — conservative)
  }

  /** getAmountOut on constant-product reserves (in raw wei), with the pool's fee. */
  private cpOut(amountIn: bigint, rIn: bigint, rOut: bigint, feePpm: bigint): bigint {
    if (rIn <= 0n || rOut <= 0n || amountIn <= 0n) return 0n;
    const inWithFee = amountIn * (1_000_000n - feePpm);
    return (inWithFee * rOut) / (rIn * 1_000_000n + inWithFee);
  }

  /** The pool's (reserveOfToken0, reserveOfToken1) in raw wei at `atBlock`. V3 → virtual reserves.
   * Cached per (pool,block) so a size-sweep on one block is pure arithmetic after a single read. */
  private async reserves(pool: PoolRef, atBlock?: bigint): Promise<{ r0: bigint; r1: bigint } | null> {
    const address = pool.address as Address;
    // Latest (unpinned): reserves barely move within a block, so a short-TTL cache collapses the
    // repeated reads a classify burst does on shared pools (the WETH/USDC anchor, popular collateral
    // pairs) from N RPC calls to one — the single biggest cut to precision-lane load.
    if (atBlock == null) {
      const k = address.toLowerCase();
      const c = this.resLatest.get(k);
      if (c && Date.now() - c.at < this.LATEST_TTL_MS) return c.val;
      const val = await this.readReserves(pool);
      if (this.resLatest.size > 6000) this.resLatest.clear();
      this.resLatest.set(k, { val, at: Date.now() });
      return val;
    }
    const ck = `${address.toLowerCase()}@${atBlock}`;
    if (this.resCache.has(ck)) return this.resCache.get(ck)!;
    const val = await this.readReserves(pool, atBlock);
    if (this.resCache.size > 4000) this.resCache.clear(); this.resCache.set(ck, val);
    return val;
  }

  private async readReserves(pool: PoolRef, atBlock?: bigint): Promise<{ r0: bigint; r1: bigint } | null> {
    const address = pool.address as Address;
    const opts = atBlock != null ? { blockNumber: atBlock } : {};
    try {
      // Precision lane, off the sensor firehose; the two V3 reads are auto-batched (one HTTP call)
      // and self-heal to the fallback RPC on a rate-limit, so a burst never starves these reads.
      if (pool.archetype === "v3") {
        const [slot0, liq] = await this.chain.precisionRead((c) => Promise.all([
          c.readContract({ address, abi: V3POOL, functionName: "slot0", ...opts }) as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
          c.readContract({ address, abi: V3POOL, functionName: "liquidity", ...opts }) as Promise<bigint>
        ]), "v3-reserves");
        const sqrtP = slot0[0], L = liq;
        if (sqrtP <= 0n || L <= 0n) return null;
        return { r0: (L * Q96) / sqrtP, r1: (L * sqrtP) / Q96 }; // virtual reserves
      }
      const res = await this.chain.precisionRead((c) => c.readContract({ address, abi: V2POOL, functionName: "getReserves", ...opts }), "v2-reserves") as readonly [bigint, bigint, number];
      return { r0: res[0], r1: res[1] };
    } catch (error) { this.logger.debug({ err: error, pool: pool.address }, "oracle reserves read failed"); return null; }
  }

  /** EXACT executable output for swapping `amountIn` of `tokenIn` through this pool, at a block. */
  async amountOut(pool: PoolRef, tokenIn: string, amountIn: bigint, atBlock?: bigint): Promise<bigint | null> {
    if (pool.archetype === "solidly") return this.solidlyAmountOut(pool, tokenIn, amountIn, atBlock);
    const r = await this.reserves(pool, atBlock);
    if (!r) return null;
    const inIs0 = tokenIn.toLowerCase() === pool.token0.toLowerCase();
    const [rIn, rOut] = inIs0 ? [r.r0, r.r1] : [r.r1, r.r0];
    const out = this.cpOut(amountIn, rIn, rOut, this.feePpm(pool));
    return out > 0n ? out : null;
  }

  /** Solidly pools: ask the pool for its own exact output (correct stable/volatile invariant + fee). */
  private async solidlyAmountOut(pool: PoolRef, tokenIn: string, amountIn: bigint, atBlock?: bigint): Promise<bigint | null> {
    if (amountIn <= 0n) return null;
    const opts = atBlock != null ? { blockNumber: atBlock } : {};
    try {
      const out = await this.chain.precisionRead((c) => c.readContract({ address: pool.address as Address, abi: SOLIDLY, functionName: "getAmountOut", args: [amountIn, tokenIn as Address], ...opts }), "solidly-getAmountOut") as bigint;
      return out > 0n ? out : null;
    } catch (error) { this.logger.debug({ err: error instanceof Error ? error.message : String(error), pool: pool.address }, "solidly getAmountOut failed"); return null; }
  }

  /** Spot (marginal) price of `token` denominated in the pool's OTHER token, human units. */
  async spot(pool: PoolRef, token: string, atBlock?: bigint): Promise<number | null> {
    let d0: number, d1: number;
    try { [d0, d1] = await Promise.all([this.decimals(pool.token0 as Address), this.decimals(pool.token1 as Address)]); }
    catch (error) { this.logger.warn({ err: error instanceof Error ? error.message : String(error), pool: pool.address }, "spot skipped — unknown token decimals (not guessing)"); return null; }
    // Solidly: the reserve ratio is NOT the price for a stable pool — derive marginal price from the
    // pool's own invariant (sell 1 token, read the rate). Fixes phantom stable-pair spreads.
    if (pool.archetype === "solidly") {
      const other = pool.token0.toLowerCase() === token.toLowerCase() ? pool.token1 : pool.token0;
      const dIn = token.toLowerCase() === pool.token0.toLowerCase() ? d0 : d1;
      const dOut = other.toLowerCase() === pool.token0.toLowerCase() ? d0 : d1;
      const ref = 10n ** BigInt(dIn); // 1 token — small vs pool, ~marginal, exact via getAmountOut
      const out = await this.solidlyAmountOut(pool, token, ref, atBlock);
      return out != null && out > 0n ? (Number(out) / 10 ** dOut) : null;
    }
    const r = await this.reserves(pool, atBlock);
    if (!r || r.r0 <= 0n || r.r1 <= 0n) return null;
    const p1per0 = (Number(r.r1) / Number(r.r0)) * 10 ** (d0 - d1); // token1 per token0
    return token.toLowerCase() === pool.token0.toLowerCase() ? p1per0 : (p1per0 > 0 ? 1 / p1per0 : null);
  }

  registryPools(token: string): Promise<Array<{ address: string; meta: unknown }>> { return this.db.poolsForToken(this.config.CHAIN_ID, token.toLowerCase()).catch(() => []); }

  private toRef(p: { address: string; meta: unknown }): PoolRef {
    const m = (p.meta ?? {}) as Record<string, unknown>;
    return { address: p.address, archetype: String(m.archetype ?? "v3"), token0: String(m.token0 ?? ""), token1: String(m.token1 ?? ""), fee: Number(m.fee) || undefined };
  }

  /** The registry pool descriptors for a token (both sides), ready for amountOut/spot. */
  async poolRefs(token: string): Promise<PoolRef[]> {
    return (await this.registryPools(token)).map((p) => this.toRef(p)).filter((r) => r.token0 && r.token1);
  }
  decimalsOf(token: string): Promise<number> { return this.decimals(token as Address); }

  /** SIZED executable exit value in USD of selling `amountWei` of `token` — the real proceeds
   * across its pools (not spot × amount, which overstates on thin pools). null if unpriceable. */
  async sellValueUsd(token: string, amountWei: bigint, atBlock?: bigint): Promise<number | null> {
    if (amountWei <= 0n) return 0;
    const weth = this.config.WBERA_ADDRESS.toLowerCase();
    const stables = new Set([this.config.USDC_E_ADDRESS.toLowerCase(), this.config.HONEY_ADDRESS.toLowerCase()]);
    const refs = await this.poolRefs(token);
    let best: number | null = null;
    for (const ref of refs) {
      const q = ref.token0.toLowerCase() === token.toLowerCase() ? ref.token1.toLowerCase() : ref.token0.toLowerCase();
      const qUsd = stables.has(q) ? 1 : q === weth ? ((await this.usdPrice(weth, atBlock)) ?? 0) : 0;
      if (!(qUsd > 0)) continue;
      const out = await this.amountOut(ref, token, amountWei, atBlock);
      if (out == null) continue;
      let qDec: number;
      try { qDec = await this.decimals(q as Address); } catch { continue; } // unknown decimals → skip this pool, never guess
      const usd = (Number(out) / 10 ** qDec) * qUsd;
      if (best == null || usd > best) best = usd;
    }
    return best;
  }

  /** Executable output of selling `amountRaw` of `tokenIn` for `tokenOut`, across our registry pools
   * that pair them DIRECTLY — returned in tokenOut RAW units. Loan-native: no USD anchor, so it's
   * the exact quantity a liquidation-exit decision needs. null if we have no direct pool for the pair. */
  async sellToToken(tokenIn: string, tokenOut: string, amountRaw: bigint, atBlock?: bigint): Promise<bigint | null> {
    if (amountRaw <= 0n) return 0n;
    const outTok = tokenOut.toLowerCase();
    let best: bigint | null = null;
    for (const ref of await this.poolRefs(tokenIn)) {
      const other = ref.token0.toLowerCase() === tokenIn.toLowerCase() ? ref.token1.toLowerCase() : ref.token0.toLowerCase();
      if (other !== outTok) continue; // only pools that pair tokenIn directly with tokenOut
      const out = await this.amountOut(ref, tokenIn, amountRaw, atBlock);
      if (out != null && (best == null || out > best)) best = out;
    }
    return best;
  }

  /** Spot USD price of `token` in one pool = its price in the other token × that token's USD. */
  async spotUsd(pool: PoolRef, token: string, atBlock?: bigint): Promise<number | null> {
    const p = await this.spot(pool, token, atBlock); if (p == null || p <= 0) return null;
    const other = pool.token0.toLowerCase() === token.toLowerCase() ? pool.token1 : pool.token0;
    const ou = await this.usdPrice(other, atBlock); if (ou == null || ou <= 0) return null;
    return p * ou;
  }

  /** USD price for DISPLAY ONLY, with the age of the value, served from the short-TTL cache so UI
   * conversions never add read load. Decisions must NOT use this — they run in token-native units. */
  async usdPriceWithAge(token: string, ttlMs = 60_000): Promise<{ usd: number | null; at: number }> {
    const t = token.toLowerCase();
    const cached = this.usdCache.get(t);
    if (cached && Date.now() - cached.at < ttlMs) return { usd: cached.usd || null, at: cached.at };
    const usd = await this.usdPrice(t).catch(() => null);
    return { usd, at: this.usdCache.get(t)?.at ?? Date.now() };
  }

  /** USD price of a token from its DEEPEST registry pool against a stable (=$1) or WETH (×WETH-USD,
   * itself anchored to a WETH/stable pool). null if no readable USD-anchored pool → caller falls
   * back to the API. Same on-chain math as the DEX, at `atBlock`. */
  async usdPrice(token: string, atBlock?: bigint): Promise<number | null> {
    const t = token.toLowerCase();
    const weth = this.config.WBERA_ADDRESS.toLowerCase();
    const stables = new Set([this.config.USDC_E_ADDRESS.toLowerCase(), this.config.HONEY_ADDRESS.toLowerCase()]);
    if (stables.has(t)) return 1;
    // Without a specific block, serve from a short TTL cache so system-wide tokenPrice() calls
    // don't re-read pools on every invocation.
    if (atBlock == null) { const c = this.usdCache.get(t); if (c && Date.now() - c.at < 15_000) return c.usd || null; }
    const refs = (await this.registryPools(t)).map((p) => this.toRef(p)).filter((r) => r.token0 && r.token1);
    if (!refs.length) { if (atBlock == null) this.usdCache.set(t, { usd: 0, at: Date.now() }); return null; }
    let wethUsdCache: number | null | undefined;
    const quoteUsd = async (q: string): Promise<number | null> => {
      if (stables.has(q)) return 1;
      if (q === weth && t !== weth) { if (wethUsdCache === undefined) wethUsdCache = await this.usdPrice(weth, atBlock); return wethUsdCache; }
      return null; // quote we can't anchor to USD → skip this pool
    };
    let best: { usd: number; depth: bigint } | null = null;
    for (const ref of refs) {
      const q = ref.token0.toLowerCase() === t ? ref.token1.toLowerCase() : ref.token0.toLowerCase();
      const qUsd = await quoteUsd(q);
      if (qUsd == null || qUsd <= 0) continue;
      const priceInQ = await this.spot(ref, t, atBlock);
      if (priceInQ == null || priceInQ <= 0) continue;
      const r = await this.reserves(ref, atBlock); if (!r) continue;
      const depth = ref.token0.toLowerCase() === q ? r.r0 : r.r1; // reserve of the quote ~ pool depth
      const usd = priceInQ * qUsd;
      if (usd > 0 && (!best || depth > best.depth)) best = { usd, depth };
    }
    if (atBlock == null) this.usdCache.set(t, { usd: best?.usd ?? 0, at: Date.now() });
    return best?.usd ?? null;
  }
}
