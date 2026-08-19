# Local Router / Quote Engine — Phased Plan

**Goal:** stop being a consumer of an external aggregator API (KyberSwap) and become our own
routing/quoting engine — a **domain light-node**: we mirror the AMM state of the pools we care
about and answer *"what's the price / what comes out of this swap"* ourselves, from our own DB,
with **zero external quote calls**. We supplant the aggregator (own route-finding, best-route,
eventually split routing), and build the substrate that future **arbitrage** and **liquidations**
reuse.

## Why this attacks the real problem
The pain is **rate-limit (400/429)**, and it comes from the **quote firehose**: every sellability
check, every exit sim, every valuation hits the external API. The fix is not "better RPC/rates" —
it's to **stop asking**. Move quoting local → the firehose drops to zero external calls. Execution
keeps only **1–2 RPC calls per real trade** (`send` + preflight `eth_call`), an entirely different
load profile. Safety boundary stays the on-chain `minAmountOut` (revert only when the market truly
moved past tolerance — the loss we *wanted* to avoid).

## What already exists (grounding — verified in code)
- **`pool_state`** table (`src/db.ts:425`): raw per-pool AMM state — V2/Aero `r0/r1`, V3
  `sqrt_price + liquidity`, as NUMERIC (wei), one latest row per pool, **with `block_number` +
  `updated_at`**. Written by `upsertPoolState` (`src/db.ts:1231`, newer-block-wins guard); read by
  **`poolStateBatch`** (`src/db.ts:1432`, returns `{archetype,r0,r1,sqrtPrice,liquidity,block,ageMs}`).
- **`price-oracle.ts:114`** already derives quotes from `pool_state` (V3 virtual reserves
  `r0=(L·Q96)/sqrtP`, `r1=(L·sqrtP)/Q96`); RPC only for pinned `atBlock` sims or never-seen pools.
- Token↔pool topology in **`entities`** (`src/db.ts:375`): `meta.token0/token1/archetype/fee`;
  read via `poolInfoBatch` (`src/db.ts:1217`) / `poolsForToken` (`src/db.ts:793`).
- Pricing math already exported: `priceV3FromSqrt`/`priceV2FromReserves`/`priceV3`/`priceV2`
  (`src/block-indexer.ts:506-528`).
- **The insertion seam** — the `Aggregator` (`src/aggregator.ts`) exposes exactly two methods the
  rest of the system consumes:
  - `quoteResult(tokenIn, tokenOut, amountIn) → {status:"ok"|"no-route"|"error", quote:{amountOut, routeSummary}}`
  - `swapCalldata(tokenIn, tokenOut, amountIn, recipient, slippageBps) → BuiltSwap{router, calldata, amountIn, amountOut, value}`
  Injected in `index.ts:86` → `Primitives` (`:91`), `LiquidationMonitor` (`:129`), `MonadSignals`
  (`:89`), `AutoArmReconciler` (`:128`). Replace those two methods and callers don't change.
- Execution today: `swapBest` (`src/primitives.ts:481`) → `swapViaAggregator` (`:497`, sends
  `built.router`+`built.calldata`+`built.value` via `chain.send` after single-lane
  `chain.preflight`) with `swapV3` (`:437`, on-chain Quoter + `exactInputSingle`) as build-stage
  fallback for non-native pairs.
- Preflight `eth_call` already exists: `chain.preflight` (`src/chain.ts:271`) + dual-RPC
  `preflightSecondary`/`GuardedExecutor`. Swap paths self-send after a **single-lane** preflight.
- RPC lanes (`src/chain.ts`): `primary, indexer, enrichment, tools, secondary, precision,
  fallback, wallet(execution), heads(WS)`. Only `wallet` broadcasts.
- **Confirmed gap:** no `Mint`/`Burn` ingestion, no per-tick liquidity map, no `tick` column →
  V3 local quote is exact only near the current tick.

## Architecture — 3 layers + cross-cutting freshness

**Layer 1 — Venue adapters** (`src/router/adapters/`): one module per AMM family, common interface,
so adding V4/Kuru doesn't touch the rest.
```
interface VenueAdapter {
  archetype: "v2" | "aerodrome" | "v3" | "v4" | ...
  quoteOut(pool, tokenIn, tokenOut, amountIn) → { amountOut, feeBps, limitHit } | null  // exact local AMM math
  spot(pool, base, quote) → number                                                       // mid price
  encodeSwap(leg, recipient, minOut) → { to, calldata, value }                           // execute on venue router
}
```
`V2Adapter` + `AerodromeAdapter` (constant-product, exact from reserves today); `V3Adapter`
(concentrated-liq); V4/Kuru later.

**Layer 2 — Local route-finder** (`src/router/router.ts`, `LocalRouter`): builds the graph
(tokens=nodes, pools=edges) from `entities` + `poolStateBatch`, 1–2 hop pathfinding through hub
tokens (WETH/USDC), best net-out. **Exposes the same two methods as `Aggregator`** → drop-in.

**Layer 3 — Own execution** (`encodeSwap` per adapter): **Universal Router** (commands + Permit2)
for the Uniswap family, **Aerodrome Router** for Aero. Downstream unchanged: `chain.send` after
`chain.preflight`.

**Cross-cutting — Freshness (block-of-last-update on every datum):** every quote/route carries
`asOfBlock` (min block across legs), `blocksBehind` (head − asOfBlock), `maxAgeMs`, **logged on
every quote/route/trade**. Gate `ROUTE_MAX_BLOCKS_BEHIND`: a too-stale leg → targeted `eth_call`
refresh or skip. Generalize the block stamp to `token_prices` (today only `updated_at`).

## Precision without the whole network
We don't need network state — only the **complete state of the pools on the route** (a small,
bounded set). V2/Aero: complete from reserves → **exact at any size, today**. V3: needs
sqrtPrice + tick + per-tick liquidity → exact after Mint/Burn ingestion (Phase 4); until then, exact
via the on-chain **Quoter** `eth_call` for size that crosses ticks. No approximation on the critical
path. "Completes, not reverts" = exact pool math + preflight `eth_call` fixing the exact
`minAmountOut` + volatility-sized buffer; a *correct* revert only fires when the market genuinely
moved past tolerance.

---

## Phases (ordered by value/risk). Each phase is fully implemented + verified before the next.

### Phase 0 — Freshness substrate (foundational, zero risk)
- Block-stamp every data update: add `block_number` to `token_prices`; stamp it from the indexer.
- `freshness()` helper + structured logging `{asOfBlock, blocksBehind, maxAgeMs}`; head from
  indexer cursor / `chain.heads`.
- Config `ROUTE_MAX_BLOCKS_BEHIND` (+ surface block/age where `pool_state` is read today).
- **Verify:** build+tests green; logs show block/age on pool-state reads; `token_prices` rows carry
  the block; a stale pool is visibly flagged.

### Phase 1 — Venue adapter interface + V2/Aerodrome exact local quoting
- `src/router/types.ts` (`PoolState`, `Leg`, `Route`, `VenueAdapter`); `V2Adapter` +
  `AerodromeAdapter` (constant-product; Aerodrome volatile = same; stable = own invariant or skip).
- **Verify:** unit tests — local `quoteOut` matches on-chain `getAmountOut` for known Base pools at
  several sizes (bit-exact for V2/Aero).

### Phase 2 — Local route-finder → replaces the quote firehose
- `LocalRouter` graph + 1–2 hop pathfinding; `quoteResult` goes live **for all quote reads**
  (`checkToken`, entry/exit sims) in place of the aggregator. **Execution still via aggregator/V3.**
- V3 legs: local sqrtPrice quote for small size; on-chain Quoter `eth_call` for size that crosses
  ticks (bounded, until Phase 4).
- **→ Kills the 400/429 storm** (quote reads = 0 external calls). Aggregator kept behind a flag.
- **Verify:** aggregator quote-call count → ~0 in logs; local quotes agree with a spot aggregator
  check within tolerance; `checkToken`/sims still behave; no execution change.

### Phase 3 — Own execution (Universal Router + Aerodrome Router)
- `encodeSwap` per adapter; `swapCalldata` returns our calldata; `minAmountOut` = local quote ×
  (1 − measured-volatility buffer), confirmed/tightened by preflight `eth_call`. One-time MAX
  approvals to the new routers (Permit2 for UR). Aggregator → optional fallback for exotic only.
- **Verify:** a real small buy+sell round-trip completes (not reverts) on both a Uniswap-family and
  an Aerodrome token; revert rate ~0 on calm pools; freshness gate observed.

### Phase 4 — V3 tick map (Mint/Burn) → fully-local V3-at-size
- Index `Mint`/`Burn`/`Collect`; store per-tick liquidity + current `tick` in `pool_state`;
  `V3Adapter` runs the exact tick-crossing sim locally; drop the Quoter `eth_call`.
- **Verify:** local V3 quote matches the on-chain Quoter across sizes that cross multiple ticks.

### Phase 5 — Split routing + custom atomic executor (advanced; unlocks arb/liquidations)
- Split amounts across parallel pools; a custom on-chain executor contract for atomic
  multi-venue/split routes — **the same substrate reused for arb cycles + flash-liquidation swap
  legs**. V4/Kuru adapters as needed.
- **Verify:** split route beats single-pool on a deep pair; atomic multi-leg executes or reverts as
  one; arb/liquidation swap legs route through it.

## Coverage / honesty
- Auto-route only indexed venues (V2/V3/Aero). Curve/V4/Kuru → aggregator-fallback or a dedicated
  ingestion cantiere, never on the critical path.
- Absence of a venue does **not** corrupt computed prices (a venue price is a real executable
  price); it costs *visibility* of exclusive tokens and occasional *best-route* optimality, bounded
  by cross-venue arbitrage.
