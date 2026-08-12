# Berachain Wallet Brain

Mainnet-only foundation for an autonomous Berachain portfolio agent powered by `MiniMax-M2.7`. It launches BERA-first and is intentionally **observation-only by default**: no transaction can be sent until a dedicated wallet, secrets, an allowlisted protocol adapter, and the relevant effectiveness gate are present.

## What is implemented

- Dual-RPC Berachain collector every two seconds, persisted in PostgreSQL.
- Mainnet health checks, gas tracking, wallet balances and Bera API token prices.
- On-chain verification of discovered Reward Vault and Bend Vault bytecode/state, persisted with the verification block.
- Incremental Bend event backfill and live Morpho position/oracle health-factor scanner, rate-limited against the independent RPC.
- PostgreSQL ledger, liquid/locked portfolio snapshots, decision records and rolling 24-hour loss accounting.
- MiniMax Wallet Brain with strict structured decisions; without an API key it issues only `HOLD`.
- MiniMax portfolio review every five minutes plus immediate reviews on material network, protocol and opportunity events.
- Tool-calling MiniMax Wallet Brain, with complete tool/result trace stored together with each decision.
- Guarded executor with mainnet `eth_call` preflight, one-block freshness, deadline, selector allowlist, quote/slippage, gas ×3 profit floor and loss/NAV/BERA checks.
- BEX Vault dual-RPC bytecode verification, real SOR quotes and a six-hour protocol-specific observation gate.
- Adapter layer for WBERA wrap/unwrap, finite ERC-20 approvals, BEX routes, ERC-4626 (Bend) and Reward Vault calls; adapters only prepare calldata and do not bypass the executor.
- Position registry valued from current ERC-4626 `previewRedeem`, with bytecode-bound dynamic protocol onboarding and receipt reconciliation.
- Same-block BEX opportunity scanner: it records both qualified and rejected routes, and keeps the atomic module disabled until 20 genuinely qualified candidates are observed over 14 days.
- Telegram audit code is read-only and intentionally unconfigured until strategy/execution autonomy has stabilised. MiniMax token use is observable but not accounted as a per-request cost.
- Docker Compose services for PostgreSQL 16, Redis 7, an `observer` without signer and a `brain` with the signer.

The remaining gated additions are real micro-capital receipts, seven-day Bend experiment evidence, and only then the atomic executor contract. The document watcher tracks official Berachain, BEX, Bend and Reward Vault documentation; a document/API result is discovery evidence only, while execution facts come from two RPCs and `eth_call`.

`observer` owns RPC/WebSocket collection, research, BEX/Bend scans, opportunity discovery and document watching. `brain` reads the persisted evidence, calls MiniMax, reconciles accounting and is the only service with the wallet secret. The brain review interval is configurable through `AGENT_REVIEW_INTERVAL_MS` (default five minutes).

## Run locally in mainnet observation mode

```bash
npm install
cp .env.example .env
docker compose up -d postgres redis
npm run dev
```

The sample environment uses the public RPC for both endpoints only to make read-only development easy. Before any continuous execution, replace them with independent dedicated HTTP/WSS endpoints.

## Required server secrets, supplied only at their milestone

Inject these through the server secret manager; never commit or send them in chat:

- `MINIMAX_API_KEY`
- `WALLET_ADDRESS` and a programmatic signer for the dedicated BERA wallet
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID`
- independent RPC endpoint credentials

`EXECUTION_ENABLED` is not a trading permission by itself. The executor remains unable to submit a transaction until the network/protocol gate, finite-allowance policy, code-hash binding, dual preflight, loss budget and a MiniMax decision all pass.

### VPS signer secret

For the isolated VPS deployment, save the **derived EOA private key** (not a mnemonic phrase) as the only contents of `/opt/bera-bot/secrets/wallet_private_key`, owned by root with permissions `0600`. Then deploy with:

```bash
docker compose -p bera-bot -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

The override mounts that file at `/run/secrets/wallet_private_key`. The bot reads it at startup and never logs it. Do not place the key in `.env`, a shell command, Telegram, or this chat.

For a local-to-VPS handoff, the private workspace location is `.secrets/wallet_private_key`; it is ignored by Git. It must contain only the derived `0x…` EOA private key and have permission `0600`. It will be copied directly into the VPS secret location without being printed or committed.

## Financial defaults

- Mainnet: chain ID `80094`; initial base asset: `BERA`
- Daily realized-loss ceiling: the lower of `$5` or 25% of current NAV
- NAV floor: `$0.10` for the BERA-only bootstrap, with the independent `1 BERA` gas reserve still enforced
- BERA gas reserve: `1 BERA`
- Minimum candidate net profit: `$0.03`, with preflight no older than one block
- First write for every protocol adapter: maximum `$0.05`
- Promoted active allocation: at most 50% of NAV, only after a successful real onboarding deposit/withdrawal and only if its 30-day net-yield thesis exceeds gas-adjusted costs and `$0.03`
- Bootstrap gate: 20 minutes of live dual-RPC coverage, at least 95% successful RPC samples, a strictly healthy five-sample tail (heads no more than one block apart), and no sampling gap above 15 seconds. Brief historical head races are recorded but do not make an otherwise available RPC unhealthy; the stricter same-block check is repeated immediately before every transaction.
- Protocol gate: six hours of the same quality evidence plus stable, dual-RPC-verified protocol bytecode before BEX/Bend writes. The executor then repeats `eth_call`, gas and block checks through both RPCs immediately before broadcast.

The bootstrap is an operational proof, not a yield strategy. With the currently observed wallet balance of about 3 BERA (roughly $0.46) and a retained 1 BERA gas reserve, passive yield cannot economically recover even a few setup transactions in a reasonable period. The agent must therefore keep `HOLD` unless a real positive-net opportunity appears; larger BERA, HONEY or USDC.e capital is needed before lending/LP compounding can be economically meaningful.

The Bend scanner prefers its archive RPC for historical logs, uses smaller bounded backfill ranges, avoids overlapping scans, and falls back through the two execution RPCs if the archive provider rate-limits. A market with no successful RPC path is excluded rather than guessed.

These controls are automated safety checks, not manual strategy approval. MiniMax remains the authority that produces every financial decision record.

## Commands

```bash
npm run check
npm test
npm run build
```
