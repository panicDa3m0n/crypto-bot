# Scarlet MiniMax foundation

Prima base, volutamente minimale, del nuovo sviluppo. Contiene solo:

- client ufficiale OpenAI-compatible per MiniMax M2.7;
- system prompt esterno in `prompts/wallet-brain.md`;
- comando reale richiesta → risposta;
- cicli MiniMax persistenti con ID, memoria compatta ed esplorazione del record completo;
- strumenti Berachain reali per blocchi, transazioni, saldo nativo e `eth_call`, senza write;
- registro dell'ecosistema multi-protocollo (BEX, Bend, Beraborrow, Dolomite, Bulla, Kodiak, Infrared e Origami), con fonti e verifica bytecode da due RPC;
- configurazione tramite secret injection, mai tramite file del progetto.

```sh
MINIMAX_API_KEY_FILE=/percorso/privato/minimax.key \
npm run ask -- "Spiega in una frase il tuo ruolo in questa fase."
```

Non sono impostati limiti applicativi di token o completion. L'output conserva modello, hash del prompt e usage restituito dal provider per poter dimostrare quale prompt ha generato una risposta.

La raccolta tool ha un limite di round configurabile (`SCARLET_MAX_TOOL_ROUNDS`, default 12): non è un limite token, ma impedisce che una sessione ripeta esplorazioni senza nuova evidenza. Al raggiungimento del limite Scarlet deve produrre il riepilogo del ciclo con le incertezze rimaste.

## Ciclo di prova

Il file di input è esterno al progetto e contiene solo dati dichiarati dall'operatore; il saldo BERA viene sempre letto dall'RPC in tempo reale.

```json
{
  "trigger": "manual-test",
  "walletAddress": "0x790D8b807E0C883213b997441512A90490822103",
  "declaredCapital": { "note": "capital supplied by the operator" },
  "openPositions": [],
  "notes": "First real read-only cognitive cycle."
}
```

```sh
MINIMAX_API_KEY_FILE=/percorso/privato/minimax.key \
npm run cycle -- --input /percorso/privato/cycle-input.json
npm run show-cycle -- cycle_<id>
```

Per un input non persistito su disco il comando accetta anche `--stdin`.
La consultazione di un ciclo non contatta MiniMax e non richiede una API key.

## Registro protocolli reale

Il collector non deduce indirizzi da nomi, tweet o altre reti. Parte da fonti
ufficiali/protocol-owned, legge `eth_getCode` su entrambi gli RPC e considera un
contratto verificato solo se il bytecode non vuoto è identico. BEX, Bulla e
Origami restano esplicitamente incompleti finché non esiste un anchor pubblicato
e verificabile: questo evita di rendere Scarlet cieca senza trasformare un
indirizzo ipotizzato in una fonte di verità.

```sh
SCARLET_DATA_DIRECTORY=/percorso/privato/scarlet-data \
BERACHAIN_RPC_URL=https://rpc.berachain.com \
BERACHAIN_SECONDARY_RPC_URL=https://berachain.drpc.org \
npm run registry-scan
```

Lo snapshot completo viene conservato in `protocol-registry/snapshots/`; quello
più recente è aggiunto al contesto di ogni ciclo e può essere interrogato con
`get_protocol_registry` o `get_protocol`. Il registro è discovery/read-only:
non autorizza swap, approval, deposito o altra scrittura.

## Snapshot portfolio reale

Il collector blocca le letture a un numero di blocco comune fra due RPC e
riconcilia BERA, nonce, token anchor verificati e allowance verso gli spender
anchor verificati. Le posizioni di protocollo, i token non presenti nel registro
e i valori USD sono dichiarati esplicitamente come non coperti finché non
esistono adapter e fonti prezzo verificati.

```sh
SCARLET_DATA_DIRECTORY=/percorso/privato/scarlet-data \
npm run portfolio-scan -- --address 0x790D8b807E0C883213b997441512A90490822103
```

Ogni snapshot è storicizzato sotto `portfolio/<address>/snapshots/`; il più
recente viene incluso nel ciclo e resta interrogabile con `get_wallet_portfolio`.

## Posizioni Bend

L'adapter Bend legge le sei market ID pubblicate, risolve parametri e stato di
ciascun mercato dal core Morpho e calcola la posizione diretta del wallet da
share on-chain. Non attribuisce un valore USD né un health factor fino al
rilascio dell'adapter oracle.

```sh
SCARLET_DATA_DIRECTORY=/percorso/privato/scarlet-data \
npm run bend-scan -- --address 0x790D8b807E0C883213b997441512A90490822103
```

## Account Dolomite

L'adapter legge l'account Dolomite `0`, i relativi saldi Wei/Par, lo stato e i
valori normalizzati dal protocollo. Mostra il requisito di margine e il confronto
adjusted; non dichiara però che l'account `0` sia l'unico account del wallet.

```sh
SCARLET_DATA_DIRECTORY=/percorso/privato/scarlet-data \
npm run dolomite-scan -- --address 0x790D8b807E0C883213b997441512A90490822103 --account 0
```

## Mercati BEX

Il collector BEX usa l'API ufficiale solo per discovery e metriche indicizzate;
per ogni pool BEX V2 nel limite di scansione verifica bytecode, `getPoolTokens`
del Vault e saldo BPT wallet su due RPC. Non considera una metrica API come
preventivo eseguibile.

```sh
SCARLET_DATA_DIRECTORY=/percorso/privato/scarlet-data \
npm run bex-scan -- --address 0x790D8b807E0C883213b997441512A90490822103 --limit 50
```

### Quote BEX verificata

La quote exact-input usa lo Smart Order Router dell'API BEX ufficiale, ma accetta
il percorso soltanto se tutti i pool V2 erano già verificati dallo snapshot BEX
locale. Poi simula la stessa route, allo stesso blocco, sui due RPC. La risposta
salva importo input/output raw, hop, fee e differenza fra RPC; non produce
approval, calldata di swap, firma o transazione.

```sh
SCARLET_DATA_DIRECTORY=/percorso/privato/scarlet-data \
npm run bex-quote -- --address 0x790D8b807E0C883213b997441512A90490822103 \
  --token-in 0x... --token-out 0x... --amount-in-raw 1000000000000000
```

Le quote sono informazioni lorde e puntuali: gas, allowance, slippage al momento
della trasmissione, rischio token e P&L netto saranno inclusi soltanto nel futuro
motore di decisione e validazione. Le route BEX V3 sono bloccate finché il loro
adapter di stato non avrà la stessa verifica indipendente.

## Posizioni Kodiak V3

Lo scan del Position Manager V3 riconcilia il numero di NFT posseduti dal wallet
su due RPC. Un conteggio zero dimostra l'assenza di posizioni in quel manager;
un conteggio non zero resta esplicitamente non enumerato finché non esiste un
indice ownership basato su eventi. LP V2, Islands e reward sono fuori da questo
perimetro.

```sh
SCARLET_DATA_DIRECTORY=/percorso/privato/scarlet-data \
npm run kodiak-scan -- --address 0x790D8b807E0C883213b997441512A90490822103
```

## DecisionRecord

Ogni ciclo terminale MiniMax deve ora produrre una decisione tipizzata. Il
record viene salvato per ciclo con azione, evidenze, confidenza, rischio e
capitale proposto; un output che non rispetta lo schema viene marcato
`rejected`, mai interpretato come approvazione. In questa fase il campo
esecutivo è irrevocabilmente `read-only/not-submitted`: i record costruiscono
audit e continuità, non inviano ordini.

## Policy di rischio e validazione write

Il validatore permanente usa unità intere in micro-dollari e chiude il gate se
manca qualsiasi input economico. La policy iniziale richiede: chain `80094`,
riserva nativa di almeno `1 BERA`, NAV almeno `$15`, perdita rolling più perdita
worst-case non superiore a `$5` in 24 ore, quote entro 60 secondi e preflight
positivo dello stesso calldata. L'allowance ERC-20 infinita è vietata e un
approval non può eccedere il capitale del DecisionRecord. Il validatore attuale
non può mai autorizzare un broadcast.
