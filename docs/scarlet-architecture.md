# Scarlet — a living on-chain profit agent (architecture)

Scarlet is not a bot with an LLM veto. She is a digital individual that lives *inside*
the Berachain network and operates it for profit. The code is her **body** (senses,
hands, reflexes); the LLM is her **mind** (strategy, initiative, composition).

## Inversion of control

- **Bot (old):** code enumerates a fixed menu of actions, the LLM approves one.
- **Scarlet (new):** the LLM perceives, forms theses, and *drives* — it proposes the
  next concrete action; the code builds the calldata from trusted adapters, enforces
  invariants, simulates it on-chain, and only then signs. The mind is free to compose
  any sequence; the body guarantees it can never violate a hard bound.

## Two fluids (numéraire from the inside)

There is no "USD" and no scalar "price" on-chain. Scarlet thinks in tokens:

- **WBERA = energy.** Native asset and gas. Every action burns it. Prices and costs
  are expressed in WBERA, obtained by *simulating the swap on-chain* (`eth_call` /
  `queryBatchSwap`) at the current block — the price as it will actually be realized,
  never a human dashboard number.
- **HONEY = reserve (wealth).** Where realized profit is stored. "Profit" = growing
  the HONEY reserve without draining WBERA energy below the gas-survival floor.
- **Hunger** = HONEY reserve below its runway target. Hunger tilts her from exploring
  to exploiting; satiety frees her to explore. Overall temperament is aggressive.

Perceiving and acting share one organ: to perceive the executable price of an action
she *simulates that action*. Perception ⊂ simulation.

## Perception — an exploratory briefing, not a menu of verdicts

Every activation she receives a compact briefing designed to *provoke exploration*,
never to hand her a pre-chosen trade:

1. **Self** (vital, exact): WBERA energy, HONEY reserve, open positions, loss budget
   left, gas/RPC health, hunger.
2. **Deltas**: what changed since last wake (new pools, liquidity/APY swings, health
   factors dropping, new rewards, price moves). Change = fresh inefficiency.
3. **Anomalies**: same-pair price divergence across pools, outlier APYs, health factors
   on the edge, opened spreads. The *scent* of opportunity — a question, not an answer.
4. **Frontier**: a rotating sample of pools/protocols she has *not* examined recently.
   A forced exploration quota; the anti-fossilization mechanism.
5. **Memory echoes**: where edges recurred (exploit) and falsified theses whose
   conditions have now changed (revisit).
6. **Map + tools**: the universe she may explore and the reminder she can simulate
   anything exactly.

Discovery is cheap and may be stale (it says *where to look*); confirmation is exact
and same-block via simulation (it says *what will happen*). Cheap-and-wide to discover,
exact-and-fresh to act.

## Hands — real, intent-level action primitives

Each primitive is intent → trusted-adapter calldata → invariant validation → on-chain
simulation → sign & broadcast. Scarlet never supplies raw calldata; she states intent
("acquire X with Y, max slippage 0.5%") and the body realizes it safely.

- `wrap` / `unwrap` (BERA ↔ WBERA)
- `approve_exact` (finite allowance to a verified spender)
- `acquire` (swap exact-in, single/multi-hop, cyclic arbitrage)
- `lend` / `redeem` (ERC-4626)
- `stake` / `claim` (reward vaults / PoL)
- later: `borrow`/`repay`, `provide_liquidity`, `liquidate` (flash-loan + atomic router)

## Reflexes — invariants the body enforces on *any* action

Safety no longer comes from a fixed menu; it comes from bounds checked on every
proposed action regardless of who proposed it:

- WBERA energy floor (gas survival) preserved.
- Daily realized-loss budget not exceeded (in HONEY terms).
- Only dual-RPC-verified / allowlisted contracts.
- Mandatory on-chain simulation must pass and show an acceptable outcome.
- No unlimited approvals; exact finite allowances only.
- No manipulation, sandwiching, front-running, or exploits.

## Activation — the nervous system

She does not run continuously. She is woken by a **heartbeat** (timer) and by
**reflexes** (material events that carry the triggering datum: a liquidatable position,
a qualified spread, a pool unpausing). She may also **schedule her own** next check.

## Reuse

The prior work is her substrate: adapters (calldata), chain (reads/preflight/send),
Postgres (memory), registry/valuation (senses), risk engine (the invariant core),
capital-band and arbitrage encoding (primitive internals). The restyle inverts control
and gives her real hands, real senses, and a real self.
