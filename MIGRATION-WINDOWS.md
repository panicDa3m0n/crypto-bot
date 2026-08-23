# Migrating Scarlet from the VPS to the dedicated Windows machine

The VPS (`honeylabs.cloud`) has one cpu core shared with three other projects. Everything awkward about the
current deployment — compiling off-box, cpu weights, a 0.5-core ceiling on the KG observer — exists only
because of that core. On a dedicated machine all of it goes away, and the deploy becomes the ordinary one:
build the image, bring it up.

**What actually has to move is the database.** The code is in git and the secrets are three small files;
the 1.3 GB Postgres volume is the part that took days to build — 25k pools, the certified tick maps, the
enriched token registry, the whole lending-position registry. Losing it is not a config problem, it is a
week of re-indexing.

Run the whole thing with the VPS still live. Nothing here stops it, so if a step fails you have lost nothing
and Scarlet keeps watching.

---

## 1. Prerequisites on the Windows machine

- Docker Desktop with the WSL 2 backend (Hyper-V works, WSL 2 is faster for bind mounts).
- Git, and Node 20+ if you want to run tests outside Docker.
- Put the project somewhere **inside the WSL filesystem** (e.g. `\\wsl$\Ubuntu\home\you\crypto-bot`) rather
  than under `C:\Users\...`. Postgres and Docker on a Windows-mounted path are dramatically slower — this is
  the one Windows-specific trap that matters.

```bash
git clone https://github.com/panicDa3m0n/crypto-bot.git
cd crypto-bot
```

## 2. Bring the secrets across (do this by hand)

Three files, never in git, never in the image:

```
secrets/wallet_private_key      # the signing key — this is real money
secrets/minimax_api_key
secrets/etherscan_api_key
```

Copy them from the VPS `/opt/bera-bot/secrets/` **directly to the new machine**, not through an intermediate
paste buffer or a chat window. From the Windows box:

```bash
mkdir -p secrets
scp -i ~/.ssh/scarlet_codex_vps_ed25519 root@honeylabs.cloud:/opt/bera-bot/secrets/'*' ./secrets/
chmod 600 secrets/*
```

`secrets/` is already gitignored. Verify with `git status` before you commit anything.

## 3. Bring the environment across

The `.env` holds the RPC lane assignments and the feature flags. Secrets are file-mounted, never in the
environment, so regenerating it from the running container is safe:

```bash
ssh -i ~/.ssh/scarlet_codex_vps_ed25519 root@honeylabs.cloud \
  "docker exec bera-bot-brain-1 env | grep -vE '^(HOSTNAME|PATH|PWD|HOME|SERVICE_ROLE|NODE_VERSION|YARN_VERSION)=' | grep -vE '_FILE='" > .env
```

Then check `.env` by eye. In particular `SERVICE_ROLE` must NOT be there (compose sets it per service), and
no line should contain a private key.

## 4. Move the database

On the VPS — a compressed custom-format dump (~15 min, safe while running):

```bash
ssh -i ~/.ssh/scarlet_codex_vps_ed25519 root@honeylabs.cloud \
  "docker exec bera-bot-postgres-1 pg_dump -U bot -d berabot -Fc -Z6 -f /tmp/berabot.dump && ls -lh /tmp/berabot.dump"
ssh -i ~/.ssh/scarlet_codex_vps_ed25519 root@honeylabs.cloud "docker cp bera-bot-postgres-1:/tmp/berabot.dump /tmp/berabot.dump"
```

Pull it to the Windows machine and restore into a fresh volume:

```bash
scp -i ~/.ssh/scarlet_codex_vps_ed25519 root@honeylabs.cloud:/tmp/berabot.dump .
docker compose -p bera-bot -f docker-compose.yml -f docker-compose.windows.yml up -d postgres
docker cp berabot.dump bera-bot-postgres-1:/tmp/berabot.dump
docker exec bera-bot-postgres-1 pg_restore -U bot -d berabot --clean --if-exists -j 4 /tmp/berabot.dump
```

`-j 4` parallelises the restore — worth using here and impossible on the old box. Expect index rebuilds to
dominate the time.

**Verify before trusting it.** These four numbers should match the VPS:

```sql
SELECT count(*) FROM entities WHERE chain_id=8453 AND kind='pool';
SELECT count(*) FROM lending_positions WHERE chain_id=8453;
SELECT indexed_block FROM chain_status WHERE chain_id=8453;
SELECT count(*) FROM pool_ticks;
```

## 5. Start it

```bash
docker compose -p bera-bot -f docker-compose.yml -f docker-compose.windows.yml up -d --build
```

The indexer resumes from `chain_status.indexed_block`, so it will catch up from wherever the dump was taken.
Watch it close the gap:

```bash
docker compose -p bera-bot logs -f brain | grep -E "block-indexer|chain_status|liquidation monitor heartbeat"
```

## 6. Stop the VPS — but only after the new one is proven

Both instances running at once is not merely wasteful, it is **dangerous**: two liquidation monitors sharing
one wallet will both try to fire at the same position, and the loser pays gas for a reverted transaction.

Decide with evidence, not with elapsed time. The new machine is ready when:

- `chain_status.lag_blocks` is small and stable (single digits),
- the liquidation monitor logs `oraclesMissing: 0` with a real `nearestHf`,
- `detectMs` is comfortably under the block time,
- the dashboard on `http://localhost:8899` shows the panels populated.

Then, on the VPS:

```bash
ssh -i ~/.ssh/scarlet_codex_vps_ed25519 root@honeylabs.cloud \
  "cd /opt/bera-bot/app && docker compose -p bera-bot stop brain observer kg-observer"
```

Leave its Postgres running for a few days as a fallback. Storage is cheap; a rebuilt index is not.

---

## What to re-examine once the cpu is no longer the constraint

Several decisions in this repo are answers to "one shared core" and are now worth revisiting **with a
measurement**, not by assumption:

- **`kg-observer` cpu ceiling.** Gone in the Windows override. The observatory was capped at half a core
  because it took the whole one and pushed the indexer into de-sync. Give it room and re-measure the cycle.
- **Indexer throughput.** Measured ceiling on the VPS was ~2.12 blocks/s against a chain producing 0.5/s —
  the limit was `getBlockReceipts` latency, not cpu, so more cores may change less here than expected. Worth
  confirming rather than assuming.
- **The liquidation monitor's `near` set.** It re-reads size on-chain for every position within
  `LIQ_NEAR_MARGIN` of its liquidation price — currently ~240 positions, every block. That is the dominant
  cost of a tick and it is an RPC cost, not a cpu one.
- **`PRECISION_CONCURRENCY` / `PRECISION_MIN_INTERVAL_MS`.** Set to protect a public RPC from a burst. If a
  paid endpoint comes with the new setup, these are the knobs that let it be used.
