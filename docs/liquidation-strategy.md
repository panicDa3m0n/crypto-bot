# Scarlet — Strategia di Liquidazione (documento progettuale)

> Stato: **vivo** — aggiornare a ogni cambiamento strutturale. Ultimo allineamento: 2026-08.
> Chain di riferimento: **Base (8453)**, protocollo **Morpho Blue**. L'architettura è per-archetipo e portabile.

---

## 0. In una frase

Osserviamo **tutte** le posizioni di prestito a rischio, ne calcoliamo il profitto di liquidazione in modo **esatto ed eseguibile** (non da oracolo di protocollo), le teniamo sotto sorveglianza **on-chain per-blocco** (HF senza API), e **al primo istante** in cui una crossa HF<1 costruiamo e spariamo la liquidazione **fresca** (flashloan 0-fee, atomica, auto-verificante).

---

## 1. Principi fondanti

1. **Correttezza prima della velocità.** Una liquidazione sbagliata perde capitale; una lenta perde solo l'occasione. Ogni fire passa da una simulazione atomica che è essa stessa la garanzia.
2. **Niente fallback silenziosi.** Un dato ignoto resta ignoto (skip + log), mai "indovinato". I fallback-spazzatura (decimals=18, price=$1) hanno prodotto solo miraggi.
3. **Misurare, non cablare.** Volatilità, prezzi eseguibili, HF: tutto misurato dai dati reali (pool/oracoli/campioni), zero liste hardcoded.
4. **Due velocità.** Scoperta/classificazione = lenta (API, 180s). Sorveglianza HF + fire = veloce (on-chain, ~3s). I due layer non si mescolano.
5. **Il prezzo eseguibile è la verità.** Il valore di uscita del collaterale = quanto lo vendiamo *davvero* (aggregatore multi-venue, size reale), non il valore-oracolo di Morpho (che sopravaluta e crea miraggi).
6. **La decisione è in unità loan-token, non USD.** Profitto = `amountOut − debtRepaid` (entrambi in loan token) — nessun prezzo USD può corromperne il segno; l'USD è solo display.
7. **NON RUBARE.** Estraiamo profitto solo dallo stato di mercato PUBBLICO (incentivo di liquidazione), mai da bug dei contratti.

---

## 2. Realtà onesta (perimetro dell'edge)

Le liquidazioni sono una **gara di latenza** contro bot professionali co-locati. Su Base (sequencer centralizzato Coinbase) **non esiste mempool pubblico** sfruttabile: chi arriva primo al sequencer con priority fee vince. Realisticamente:
- Perdiamo gli **USDe/USDC grossi** che tutti presidiano.
- Vinciamo le prede **meno contese**: mercati piccoli, collaterali oscuri, token nuovi, orari morti.
- L'EV reale è **sui margini**. L'osservabilità (missed/hit) serve a capire *dove* possiamo davvero vincere.

---

## 3. Architettura a due velocità

```
        LENTA (scoperta + classificazione)                VELOCE (sorveglianza + fire)
        ───────────────────────────────────              ──────────────────────────────
  Morpho GraphQL API ──► registro posizioni  ──► [DB] ──► LiquidationMonitor (~3s)
     (180s, HF≤5, cap 500)   (tier + profitto             ├─ oracle.price() on-chain (multicall)
  Blockscout getLogs         + liq_price)                 ├─ confronto vs liq_price (HF=1)
     (cross-check + missed/hit, 180s)                     └─ CROSS ► re-fetch-at-fire ► sim ► send
  Aggregatore KyberSwap
     (exit/profitto, tick 20s)
```

Il DB (`lending_positions`) è la **fonte di verità** che i due layer condividono: la slow lo scrive, la fast lo legge.

---

## 4. La pipeline end-to-end

### 4.1 Scoperta — `position-registry.ts :: fetchMorpho`
- **Fonte:** Morpho GraphQL (`blue-api.morpho.org`, query `marketPositions`), `healthFactor_lte = LIQ_HF_CEIL (5)`, ordinate per HF crescente.
- **Cap:** 500 posizioni (5 pagine × 100). Prendiamo le 500 a HF più basso (le più a rischio).
- **Cadenza:** ogni `LIQ_ENUM_INTERVAL_MS` = **180s**.
- Enumera anche le posizioni **vecchie/dormienti** (l'API è stateful) — uno scan forward-only le mancherebbe.

### 4.2 Classificazione — `classifyAndStore`
Per ogni posizione, in ordine di costo crescente:
1. **scam/unverified** → `blacklist`.
2. **bad debt** (collateralUsd ≤ debtUsd, oracolo Morpho) → `low_collateral`.
3. **Conferma col profitto ESEGUIBILE** (loan-native): quota la porzione *sequestrata* (`min(collaterale, debito·LIF)`), non l'intero stack.
   - `no-route` (aggregatore: invendibile a quella size) → `low_collateral`.
   - `error` (chiamata fallita, transitorio) → **non giudicare**, mantieni il tier precedente.
   - `profit = amountOut − debtRepaid ≤ 0` → `low_collateral`.
   - `profit > 0 & HF ≤ LIQ_WATCH_HF (1.05)` → **`watch`** (azionabile, sotto sorveglianza).
   - `profit > 0 & HF > 1.05` → **`profitable`** (sana, profitterebbe se scendesse).
- Salva `profit_usd` (deciso, loan-native) — la dashboard lo mostra così com'è, **mai** ricalcolato dal collaterale-miraggio.

### 4.3 Tick di ri-verifica — `tick` (ogni `LIQ_TICK_INTERVAL_MS` = 20s)
Ri-controlla le posizioni *due* (fast-lane per il tier watch) col valore d'uscita fresco dell'aggregatore. Aggiorna tier/profitto. **Non** aggiorna la *size* on-chain (solo l'enumerate lo fa).

### 4.4 Sorveglianza + fire — `liquidation-monitor.ts`
- **Fonte HF:** `oracle.price()` on-chain per ogni mercato distinto (una `multicall`, corsia precision), confrontato col **liq_price** precalcolato di ogni posizione.
- **Cadenza:** **per-blocco** via heads-WS (`chain.watchHeads`, ~2s su Base) + fallback poll `LIQ_MONITOR_INTERVAL_MS` (3s). Il `running`-guard rende no-op i trigger sovrapposti → gira alla massima velocità di un tick. **Nessun tetto** — osserva *tutte* le watch+profitable (verificato: 104 vs il vecchio pre-arm cap 15).
- **Timing:** ogni fire logga `detect→read→swap→sim→send` (ms) + `trigger` (block/poll), salvati nel meta dell'evento — per diagnosticare latenza vs altro.
- **Cooldown = precisione:** il cooldown di 60s per (borrower,market) è impostato **solo quando trasmettiamo davvero una tx** (dentro `buildAndFire`, subito prima del send), non alla detection. Una **sim-revert** (block-skew ci ha resi mezzo blocco in anticipo, o route mossa) **non** è un fire: viene ritentata al blocco successivo. Così una posizione genuinamente sul cross non ci sfugge per 60s. La **sim atomica** (Morpho HF + `require(minProfit)`) resta l'autorità finale: se siamo in anticipo la sim protegge, e ritentiamo — catturando il cross nell'istante preciso in cui Morpho concorda.
- **Priority fee = inclusione:** le liquidazioni sono winner-take-all, quindi bidiamo una **priority fee EIP-1559 scalata al profitto in gioco** (misurata: `budget = LIQ_PRIORITY_PROFIT_FRACTION·profitUsd`, convertita in wei via `nativeUsd` letto dal portfolio DB, spalmata su `LIQ_GAS_UNITS`, clampata a `[MIN,MAX]` gwei). `maxFeePerGas = 2·baseFee + priority`. Su Base il gas costa ~$0.05: una liquidazione da $200 può surclassare i concorrenti e restare a ~$150 netti. Solo il path liquidazioni bidda aggressivo; wrap/approve restano legacy.
- **Rete anti-perdita (on-chain):** `minProfitWei` dell'organ è impostato = **costo max gas+priority** in unità loan-token (prezzo/decimali dal cache display, cap di sanità al 5% del debito). Se il profitto reale non copre il nostro bid, la tx **reverta on-chain** (costa solo gas base) invece di atterrare net-negativa. Il bid può usare il profitto stimato senza rischio: la `require` è il confine.
- **Cross** = `price ≤ liq_price` (HF ≤ 1) → `buildAndFire`:
  1. **re-fetch-at-fire**: `readMorphoPosition` fresco → dimensiona il sequestro → **swap route fresca** dall'aggregatore.
  2. `buildFlashLiquidation` → **callStatic** (la sim è il trigger E la sicurezza).
  3. se passa → **send**. Registra `hit`; se reverta → `armed_fail`.
- **Cooldown** 60s per posizione. **Auto-guarigione**: se `readMorphoPosition` è vuota (già presa) → marca `closed`.

### 4.5 Osservabilità — `liquidation_events` + `scanLiquidations`
- `scanLiquidations` (in enumerate): legge gli eventi Morpho `Liquidate` via Blockscout → **hit** (liquidatore = noi) / **missed** (preda azionabile *che avevamo trovato* persa a un altro bot). Marca la posizione `closed`.
- Kind: `found` (trovata/azionabile) · `missed` (persa) · `hit` (nostra) · `armed_fail` (fire abortito/revertito).
- Dashboard `/liquidations`: badge **⚡ ARMATA** sulle posizioni monitorate + card **Storico** (filtri Nostre/Perse/Trovate).

---

## 5. La matematica (Morpho Blue)

- **LIF** (liquidation incentive factor): `min(1.15, 1/(1 − 0.3·(1 − LLTV)))`.
- **Profitto reale** (loan-native): sequestra `min(collaterale, debito·LIF worth)`, ripaga `min(debito, collaterale/LIF)`. `profit = amountOut(seized→loan) − debtRepaid`. (NON `exit − debt` sull'intero collaterale — quello sovrastima.)
- **HF sano** ⇔ `oracle.price ≥ liq_price`, dove **`liq_price = borrowAssets · 1e54 / (collateralRaw · lltvRaw)`** = il prezzo-oracolo (scala 1e36) a cui HF=1. È ciò che il monitor confronta ogni tick.
- **Miraggio-oracolo**: Morpho può valutare un collaterale più del prezzo DEX eseguibile (es. stEUR: oracolo 1.119 jEUR/stEUR, DEX 1.038 → perdita a qualsiasi size). L'exit aggregator-autorevole lo smaschera.

---

## 6. Prezzi & volatilità (misurati)

- **Prezzo eseguibile (quotazioni):** aggregatore KyberSwap (tutti i venue, size reale) — autorevole. L'oracolo single-tick nostro è esatto per size piccole ma sotto/sovra-stima attraversando i tick → **non** lo usiamo per la decisione d'exit.
- **Prezzi display (dashboard):** corsia separata (`token_prices`, batch DefiLlama, cache) — mai nel path decisionale.
- **Volatilità:** EWMA della varianza dei log-return a due half-life (`VOL_TAU_FAST_SEC` ~20min, `VOL_TAU_SLOW_SEC` ~24h), `σ = max(fast, slow)`. Aggiornata *atomicamente* nel price-JOB, zero chiamate extra. **Token sconosciuti** → prior alto (`AUTOARM_PRIOR_VOL`), poi apprende dai dati.
- **EV di priorità:** `EV = profitto × imminenza`, `imminenza = σ(T)/distanza`, `distanza = HF−1`. (Oggi usato per il ranking; col monitor senza-tetto la selezione è meno critica, ma resta per ordinare i fire quando più posizioni crossano insieme.)

---

## 7. Audit: fonti, cadenze, rate-limit, latenza

| Layer | Fonte | Cadenza | Latenza dato | Rate-limit |
|---|---|---|---|---|
| **Scoperta** | Morpho GraphQL API | 180s | ≤180s | basso volume, **fonte UNICA critica** |
| **Classificazione** | Aggregatore KyberSwap | 20s (due) | 20s (solo profitto) | **nessun governor** → throttle sotto carico |
| **Cross-check + missed/hit** | Blockscout getLogs | 180s | 180s | keyless, pacing nostro → basso |
| **Monitor HF (fire)** | RPC on-chain `oracle.price()` (multicall, corsia precision) | **per-blocco** (heads-WS ~2s) + fallback poll 3s | **~tempo-blocco (fresco)** | governata + fallback → basso |

**Corsie RPC** ([`chain.ts`]): `precision` (publicnode) fuori dal firehose sensori, con governor di concorrenza + pacing + reroute automatico al `fallback` (base.org) su 429/errore. Il monitor usa questa corsia.

---

## 8. Gap noti & roadmap

**G1 — La scoperta è il collo di bottiglia (priorità alta).**
API-only, **180s**, **cap 500**, single-source. Una posizione nuova che appare *e* crossa dentro i 180s la **perdiamo** (il monitor a 3s è a valle). Oltre 500 posizioni siamo ciechi. Se l'API cade, scoperta cieca (il cross-check Blockscout lo *rileva* ma non lo sostituisce).
→ **Fix: scoperta event-driven.** Gli eventi Borrow li scansioniamo *già* via Blockscout: invece di contarli, farli **alimentare** il set (nuovo borrower → `idToMarketParams` + `position()` on-chain → entra nel monitor in quasi-real-time). Toglie la dipendenza dai 180s e dal cap 500.

**G2 — Size stantia per il liq_price. [RISOLTO per le vicine — 2026-08]**
`collateralRaw/debtRaw` freschi solo ogni 180s (enumerate). Un cambio-size (borrow/withdraw) tra due enumerate poteva nascondere un cross reale (falso negativo). **Fix**: il monitor, per le posizioni entro `LIQ_NEAR_MARGIN` (5%) del cross, ri-legge `position()`+`market()` on-chain (una multicall bounded) e ricalcola il liq_price fresco. Le lontane restano a 180s (non crossano a breve). Così il modello HF è: **HF = liq_price(size) vs prezzo-oracolo, letto per-mercato on-chain; size fresca solo per le vicine** — costo per-mercato + poche letture per le vicine, rate-limit-safe.

**G3 — Aggregatore senza governor.**
KyberSwap (exit + fire build) non ha rate-governor → sotto burst può throttlare. → aggiungere una corsia pace/retry dedicata.

**G4 — Firing avanzato.**
Trigger su **heads WS** invece del poll 3s (latenza sub-blocco); **Flashblocks/priority-fee** per l'edge di sequencing; gestione nonce per fire concorrenti.

**G5 — Estensione protocolli.**
Adattatori Aave/Moonwell (famiglie già in [`base-protocol-map`]) sotto lo stesso schema (registro → HF on-chain → fire).

---

## 9. Configurazione (le manopole)

| Config | Default | Significato |
|---|---|---|
| `LIQ_ENUM_INTERVAL_MS` | 180000 | cadenza scoperta (Morpho API) |
| `LIQ_TICK_INTERVAL_MS` | 20000 | ri-verifica profitto posizioni due |
| `LIQ_HF_CEIL` | 5 | non enumerare posizioni più sicure di così |
| `LIQ_MIN_DEBT_USD` | 10 | soglia minima debito |
| `LIQ_WATCH_HF` | 1.05 | HF sotto cui una posizione è `watch` |
| `LIQ_MONITOR_ENABLED` | true | attiva la fast-lane on-chain |
| `LIQ_MONITOR_INTERVAL_MS` | 3000 | cadenza sorveglianza HF |
| `LIQ_MONITOR_MAX_FIRES` | 3 | max fire tentati per tick (sequenziali) |
| `LIQ_NEAR_MARGIN` | 0.05 | "vicina" = prezzo entro questo % del liq_price → refresh size on-chain |
| `VOL_TAU_FAST_SEC` / `_SLOW_SEC` | 1200 / 86400 | half-life EWMA volatilità |
| `AUTOARM_ENABLED` | **false** | vecchio pre-arm a tetto (soppiantato dal monitor) |

---

## 10. Sicurezza & invarianti

- **`require(minProfit)` nell'organo**: il `flashExecute` reverta se non finisce con `≥ flashAmount + minProfit` → un fire mal-dimensionato o non profittevole **costa solo gas**, non può perdere il capitale del flashloan.
- **Sim-gate**: si invia solo se la callStatic fresca passa. La sim è il trigger.
- **Organo atomico** (`AtomicExecutor`): flashLoan Morpho 0-fee → callback esegue liquidate + swap + repay → require. Capital-free.
- **Segreti**: chiave privata mai in log; in `.secrets/` (0600) e docker secrets sul VPS.
- **NON RUBARE**: solo stato di mercato pubblico.

---

## 11. File di riferimento

- `src/position-registry.ts` — scoperta, classificazione, tier, cross-check, scan Liquidate.
- `src/liquidation-monitor.ts` — sorveglianza HF on-chain + re-fetch-at-fire.
- `src/price-oracle.ts` — prezzi da stato-pool (V3 single-tick, solidly nativo).
- `src/aggregator.ts` — quotazioni eseguibili cross-venue + calldata swap.
- `src/primitives.ts` — `buildFlashLiquidation`, `readMorphoPosition`, organo.
- `src/display-prices.ts` — Lane A (prezzi display + volatilità EWMA).
- `src/chain.ts` — corsie RPC (precision/fallback, governor).
- DB: `lending_positions`, `token_prices`, `liquidation_events`, `autoflash`.
