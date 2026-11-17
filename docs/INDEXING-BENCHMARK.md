# Indicizzazione: misure prima/dopo e qualità

Misure del 14/10/2026 su Apple M5 Pro (15 core, 24 GB, arm64), Node 24.21. Gli indici sono tutti temporanei: il
database vivo non è mai toccato. L'app installata era aperta in background (non è stata chiusa né sostituita) e la
cache del filesystem non è stata svuotata: la macchina non era isolata.

Codice misurato:
- **prima**: `tests/indexing/baseline-engine/src`, cioè i sorgenti del bundle di release delle 15:51 con la sola
  strumentazione per fase;
- **dopo**: i sorgenti congelati (ultima modifica `src/server/graph.ts` alle 16:54:44), identici ai 28 sorgenti
  runtime del pacchetto finale SHA-256 `c5672d378adcbbacfc53c81ef8445af37db4ba18eac6897fd4f815569ee7d9c4`.
  Il precedente ZIP `cc614afa` non conteneva ancora le ultime correzioni del grafo.

| File (`tests/indexing/results/`) | Codice | Ora | Contenuto | Uso |
|---|---|---|---|---|
| `baseline.json` | prima | 16:47 | sintetico 20k, repo, Desktop; 3 ripetizioni, 4 modalità | **prima** |
| `dopo-native-desktop-3rip.json` | dopo (avvio 16:57, dopo il freeze delle 16:54:44) | 16:57 | nativo: sintetico, repo, Desktop; 3 ripetizioni | **dopo, nativo** |
| `parita-ts.json`, `parita-native.json` | dopo | 17:02 | sintetico 20k e repo, cold (TS 3 ripetizioni, nativo 1) | **parità e dopo TS** |
| Desktop TS e nativo, cold+warm | dopo | 17:02–17:04 | n=1 per motore | **confronto diretto finale sul Desktop** (JSON cancellato per errore, numeri sotto) |
| `diagnostico-*.json` | dopo | 17:06–17:09 | sintetico, repo, Desktop | solo diagnostica: sovrapposte a `test-index-responsive` e alla build dello ZIP |
| `baseline-20k.json` | misto | 16:17 | preliminare | solo storico: `scan.ts` è cambiato durante la run |

Sono state scartate le serie delle 16:27–16:42 (sovrapposte alle build e con un probe HTTP difettoso) e la `dopo-ts`
delle 16:52 (a cavallo del cambio di `graph.ts`). I file `parita-desktop-ts.json` e `parita-desktop-native.json` delle
17:02–17:04 sono stati cancellati per errore durante il riordino dei risultati. I loro valori, riportati più sotto,
vengono dall'output della console e dalla bacheca (b1344973, messaggio 121).

## Aggiornamento: primo avvio (0.2.11 e successive)

Misure sul Desktop reale (circa 106k nodi), primo avvio con profilo nuovo; le sezioni seguenti restano la base del
"prima".

- **0.2.11** — estrazione dei contenuti su worker (`src/server/extract-pool.ts`, `VB_EXTRACT_WORKERS`, 4 di default;
  scritture nello stesso ordine, indice identico), hotspot di `extract.ts` e `graph.ts` ottimizzati a output identico,
  mappa pubblicata subito dopo scansione e progetti (evento `index:map`):
  - mappa visibile da 33,5 s a **2,1–2,7 s**; indice completo da 33,5 s a **9,3–10,8 s**;
  - `extract` da 25,75 a 4,97 s; `edges` da 4,35 a 1,24 s.
- **Dopo la 0.2.12** — niente classificazione anticipata nel database: finché il database non è classificato la cache
  ordina i nodi in memoria con lo stesso calcolo (`computeRank` in `rank.ts`), e carica le righe come array. Tra la fine
  dei progetti e `index:map` da 1,67 s a **0,74 s** (−57%, 3 coppie A/B alternate, sistema sotto carico); `index:done`
  circa 1 s prima. `scripts/test-first-map.mjs` verifica che l'ordinamento in memoria coincida con quello salvato.

Il collo di bottiglia su `extract` descritto qui sotto è stato affrontato nella 0.2.11 con i worker.

## In breve

- **Il motore nativo (walker Rust) dimezza il riaggiornamento senza cambi del Desktop reale: da 14,3 s a 7,2 s**
  (mediane di 3, prima e dopo). Nel confronto diretto finale TS→nativo (n=1): da 14,6 s a 6,9 s. Sul primo indice e sulla riestrazione il guadagno è del 17%, perché lì domina l'estrazione dei
  contenuti (25 s), che resta in TypeScript. La scansione del Desktop passa da 9,0 s a 1,7 s.
- Memoria: il picco di Node scende da 950–985 MB a 790–920 MB; il processo `vb-indexer` aggiunge circa 107 MB, solo
  durante la scansione.
- **Precisione**: TS e nativo producono archi identici su tutti i tipi, compresi `similar`, `shared_id` e `duplicate`,
  sul corpus sintetico statico e sul repository. Ogni motore dà lo stesso risultato su 3 ripetizioni. Sul Desktop vivo
  le differenze sono di pochi archi, dovute ai file cambiati fra una run e l'altra. Sul corpus scritto a mano precisione e richiamo sono esattamente
  1,000 con `ts`, `native` e `auto`.
- Prima, l'indice non era deterministico: con lo stesso input, due run TS differivano del 7% sugli archi `similar`,
  perché `graph.ts` risolveva i pari merito per id del nodo e gli id seguono l'ordine del walk asincrono. Ora i pari
  merito e il verso delle relazioni simmetriche seguono il percorso.
- **Collo di bottiglia rimasto: `extract`, cioè la CPU dentro `extract()`** (22,8 di 24,8 s; lettura, hash e scrittura
  insieme sotto 1,7 s), su un solo thread. Nessun file è lento da solo (il più lento richiede 172 ms): i blocchi del
  loop di circa 3 s vengono dai lotti di 400 file estratti uno dopo l'altro. Prossimo passo consigliato: eseguire lo
  stesso `extract()` TS su più worker, verificando nuovamente la parità dei risultati; in alternativa cedere il loop
  dentro il lotto. Non fa parte di questa implementazione.

## Come riprodurre

```sh
node scripts/bench-index.mjs --files 20000 --repo --root ~/Desktop --repeat 3 --label baseline \
  --src tests/indexing/baseline-engine/src --out /private/tmp/vb-bench
node scripts/bench-index.mjs --files 20000 --repo --repeat 3 --engine ts --label dopo-ts --out /private/tmp/vb-bench
node scripts/bench-index.mjs --files 20000 --repo --root ~/Desktop --repeat 3 --engine native --label dopo-native --out /private/tmp/vb-bench
node scripts/bench-index.mjs --compare /private/tmp/vb-bench/dopo-ts.json /private/tmp/vb-bench/dopo-native.json
node scripts/test-index-quality.mjs --engine=ts        # anche native | auto
```

Scrivete i risultati fuori dal repository (`--out /private/tmp/...`): l'app aperta osserva la Scrivania e i file
scritti nel repository possono far partire il suo watcher.

Ogni run gira in un processo separato sullo stesso DB temporaneo, così la memoria di ogni run è solo sua. Con
`--repeat` il report usa la run mediana per tempo totale e tiene tutte le run grezze in `raw`.

| Run | Cosa fa |
|---|---|
| `cold` | primo indice su DB vuoto |
| `warm` | nuova indicizzazione senza alcun cambio |
| `incremental` | **modifica dell'1% dei file (60% modificati, 25% aggiunti, 15% cancellati) + scansione completa**; non è l'aggiornamento mirato del watcher |
| `reextract` | `--reextract`: rilegge tutti i contenuti |

Input (tutti i motori usano le stesse esclusioni: quelle predefinite, la cartella dati del repository e il profilo
temporaneo):
- `sintetico-20000`: Desktop deterministico (seed 1) di `tests/indexing/corpus.mjs`, 20.200 file (342 MB) più 3.600
  file nei vendor. La distribuzione per classe ricalca il Desktop reale (dati 36%, archivi 24%, documenti 20%, fogli
  11%, codice 6%) e include progetti TS/Python con import, testi IT/EN con link, wiki-link e menzioni, dump, duplicati,
  segreti e symlink. **È il confronto autorevole**, perché non cambia.
- `repo`: questo repository (esclusi `data`, `dist`, `release`, `app`, `tests/indexing/baseline-engine`). È cambiato
  fra la serie "prima" e quelle "dopo": gli archi del "prima" non sono confrontabili.
- `reale-Desktop`: `~/Desktop` in sola lettura (105k voci, 90,6k file, 23,5k testi per 426 MB). È un albero vivo.

## Tempi (mediane; ms)

### Desktop reale

| Run | prima (3 rip., 16:47) | dopo, nativo (3 rip., 16:57) | nativo vs prima |
|---|---:|---:|---:|
| cold | 39.523 | **32.813** | −17% |
| warm (nessun cambio) | 14.277 | **7.188** | **−50%** |
| reextract | 38.338 | **32.039** | −16% |

Confronto diretto finale sulla stessa Scrivania viva, TS e poi nativo (17:02–17:04, n=1 ciascuno): cold da 40.096 a 33.664 ms,
warm da 14.626 a 6.893 ms; scan nel warm da 9.149 a 1.426 ms.

Fasi del Desktop: prima / dopo nativo, dalla run con tempo totale mediano fra le tre ripetizioni. Le singole fasi
non sono mediane calcolate separatamente.

| Fase | cold | warm |
|---|---|---|
| scan | 8.993 / **1.687** | 9.058 / **1.520** |
| extract | 25.269 / 25.636 | 28 / 32 |
| edges (sincrona) | 4.166 / 4.369 | 4.005 / 4.417 |
| rank (sincrona) | 862 / 864 | 755 / 821 |
| fts | 134 / 126 | 317 / 276 |

`edges` comprende `refs` (circa 1,4 s) e `similar` (circa 2,4–2,7 s; dettaglio nelle voci `edges:*` dei JSON). Dentro
`extract` (cold) il tempo si divide così: CPU di `extract()` 22,8 s, hash 0,09 s, scrittura DB 0,8 s; il resto è
lettura. Le run diagnostiche delle 17:07–17:09 (nativo: cold 36,1 s, warm 9,2 s, `edges` 5,6–5,8 s) mostrano quanto
pesi un carico concorrente: per questo non sono usate.

### Sintetico 20k e repository

| Input | Run | prima (3 rip.) | dopo, TS (3 rip., 17:02) | dopo, nativo (3 rip., 16:57) | nativo vs prima |
|---|---|---:|---:|---:|---:|
| sintetico-20000 | cold | 1.365 | 1.328 | 1.158 | −15% |
| | warm | 768 | — | 614 | −20% |
| | incremental (1% + scan completa) | 757 | — | 654 | −14% |
| | reextract | 1.284 | — | 1.140 | −11% |
| | scan (cold) | 353 | 356 | 204 | −42% |
| repo | cold | 241 | 246 | 176 | −27% |
| | warm | 134 | — | 64 | −52% |

Il TS "dopo" è stato misurato in modo pulito solo nella run cold; nelle altre modalità le run diagnostiche lo danno
allineato al "prima" (entro il 3%).

`processMs` (dall'avvio del processo all'uscita: avvio di Node, moduli, apertura del DB) aggiunge circa 220–380 ms a
ogni run. Fra le ripetizioni la differenza tra la run più lenta e quella più veloce arriva al 6% sul Desktop e al 20%
sulle run brevi (`wallMsAll`).

## Memoria

- `nodePeakMb`: picco RSS del processo Node, da `getrusage`, esatto.
- `treePeakSampledMb` e `nativePeakSampledMb`: Node più figli, e il solo `vb-indexer`, campionati con `ps` ogni 100 ms.

| Desktop reale, picco Node | prima | dopo, nativo |
|---|---:|---:|
| cold | 954 MB | 862 MB |
| warm | 985 MB | 920 MB |
| reextract | 948 MB | 792 MB |
| `vb-indexer` (figlio) | — | 105–107 MB |

Il picco di Node è inferiore in queste prove; l'adapter continua però a costruire oggetti JavaScript dai risultati
JSON del helper. Le misure non isolano la causa della riduzione e non garantiscono lo stesso risultato su altri
alberi. Il figlio vive solo durante la scansione: sommare i due picchi separati non dà il picco simultaneo. Inoltre
il picco del figlio è campionato e può perdere punte brevi, quindi quella somma non è un limite superiore garantito.

| Desktop reale, picco simultaneo campionato di Node + figli | prima | dopo, nativo |
|---|---:|---:|
| cold | 953 MB | 861 MB |
| warm | 985 MB | 920 MB |
| reextract | 946 MB | 792 MB |

Sul sintetico (cold) i picchi di Node sono 463 (prima), 426 (dopo, TS) e 377 MB (dopo, nativo), con un figlio
campionato a circa 20 MB. Questi dati riguardano la pipeline CLI del benchmark, non il consumo complessivo della GUI.

## Reattività

Le due misure sono diverse e vanno tenute distinte:

1. **Pipeline inline**, misurata con `bench-index.mjs`: il processo che indicizza risponde anche via HTTP e il padre
   lo interroga ogni 50 ms. Rappresenta la CLI o un server senza worker. Latenza massima sul Desktop: 4,9–7,0 s con
   tutti i motori, pari a `edges` + `rank` + `fts`, che sono sincrone. Durante `extract` le pause arrivano fino a circa
   3 s per ogni lotto di 400 file. Il nativo non riduce queste pause, perché accelera solo la scansione, che era già
   asincrona. `stallMs` per fase riporta lo stesso dato misurato dall'interno; per le fasi sincrone coincide con la
   loro durata.
2. **Server con worker**, misurato da fba41427 con `test-index-responsive --files 6000` sul codice finale (17:08):
   - con il worker: ciclo pesante 12.618 ms, `/api/health` al peggio 13 ms, pausa massima dell'heartbeat PTY 43 ms,
     712 note concorrenti su 712 accettate;
   - inline: `/api/health` al peggio 3.626 ms, pausa PTY 3.646 ms, 118 note su 118.

   È questa la reattività che conta per l'app.

## Precisione

### Corpus scritto a mano: `scripts/test-index-quality.mjs`

`tests/indexing/fixture.mjs` contiene 22 archi attesi: import TS, CSS e shell, import relativi Python, link Markdown
con `%20` e accenti, wiki-link, percorsi fra backtick, menzioni, un riferimento esterno `~/Downloads`, un duplicato
e un symlink. Con `ts`, `native` e `auto`: **precisione 1,000 e richiamo 1,000**, 29 controlli superati. Il test
verifica anche:
- `excludePaths` e `.private` assenti dall'indice;
- `.env` e `credentials.json` classificati come segreti, senza hash, termini né riferimenti;
- `node_modules` e `dist` aggregati senza figli, con totale dei file corretto;
- il symlink rotto indicizzato ma senza arco;
- i nomi italiani con accento e spazio;
- il progetto riconosciuto;
- una nuova indicizzazione senza cambi non riestrae nulla e mantiene gli stessi id;
- cancellazione, aggiunta e modifica: 18 archi attesi, precisione e richiamo 1,0, nodo marcato come cancellato,
  identità esterna rimossa;
- parità di tutti gli archi fra `ts` e `native`;
- il cambio di motore sullo stesso indice non riestrae nulla.

`scripts/test-graph-determinism.mjs` aggiunge 48 controlli su ID e ordini di inserimento diversi: archi, ranking,
gradi, confidenze ed evidenze coincidono; i pareggi usano i percorsi. La migrazione conserva ID e visibilità degli
archi esistenti, anche quando cambia il verso. `scripts/test-api-write.mjs` include una riproduzione del salvataggio
concorrente di `hidden`, oltre agli altri controlli API (8 test).

### Parità sui corpus misurati

Le fingerprint (sha1 per tipo, percorsi relativi alla radice, `similar` e `shared_id` senza verso) sono confrontate
da `--compare`:
- **sintetico e repo**: TS e nativo identici su tutti i tipi; ogni motore è identico su 3 ripetizioni
  (`fingerprintsStable: true`). Nella serie "prima" le ripetizioni TS non erano stabili.
- **Desktop reale** (TS e nativo uno dopo l'altro, 17:02–17:04): stessi conteggi per tutti i tipi deterministici;
  `refpath` ed `external` hanno lo stesso numero di archi ma una fingerprint diversa; `similar` +4 e `shared_id` +3.
  Le differenze sono compatibili con i file cambiati fra le run. **Non si dichiara una parità assoluta sul Desktop**, che è
  vivo.

### Prima e dopo, stesso input

Sul sintetico gli archi deterministici e i conteggi di `similar` (2.996, poi 3.186 dopo la mutazione) sono identici
prima e dopo. Sul Desktop `similar` passa da circa 29.300 a circa 28.100 (−4%) e `shared_id` da circa 1.390 a circa
1.350. La
causa è la nuova regola dei pari merito per percorso in `graph.ts`, non il motore: prima il risultato dipendeva
dall'ordine del walk, e due run TS uguali differivano di circa 2.000 archi `similar`. Gli altri tipi differiscono di
pochi archi, per i file modificati nei 20 minuti fra le serie.

## Dove va il tempo di `extract()` (Desktop reale)

Profilo per file in sola lettura, su 23.200 testi per 23,0 s di CPU. Il tempo si divide per estensione così: `txt` 9,5 s,
`js` 6,7 s, `py` 2,2 s, `html` 2,0 s, `md` 1,6 s. Il tempo è distribuito su molti file: i 15 file più lenti, tutti
`.txt` di debug da 100–860 KB (per esempio `ToolMike/.tmp/debug_uniemens_*`), sommano 1,6 s. Il guadagno grosso viene
dal parallelismo, non dall'escludere singoli file.

## Limiti

- La cache del filesystem non è stata svuotata; l'app reale era aperta in background. Alcuni test della squadra
  si sono sovrapposti alla serie di riferimento delle 16:47–16:52. Le serie finali native delle 16:57 e di parità
  delle 17:02–17:04 sono successive alle correzioni; quelle delle 17:06–17:09 sono escluse dai confronti di velocità
  perché sovrapposte a test e build. La macchina non era isolata: anche le mediane sono misure indicative su questa
  macchina, non una garanzia di prestazioni. Il confronto Desktop con n=1 ha inoltre solo il riepilogo conservato.
- Desktop e repository cambiano durante le misure. Per la parità fa fede il corpus sintetico.
- È stata misurata una sola macchina, arm64. Il nativo x86_64 è stato verificato funzionalmente sotto Rosetta
  (3f0ce0bf), ma non misurato.
- La memoria dei figli è campionata ogni 100 ms.
- `incremental` è una scansione completa dopo l'1% di modifiche. Gli aggiornamenti mirati del watcher sono coperti da
  `test-index-integration` e `test-index-concurrency` (fba41427).
- La latenza HTTP di un probe è attribuita alla fase in cui è partito; un probe che resta in coda attraversa più fasi
  sincrone. Un probe interrotto all'uscita del processo conta come limite inferiore.

## Strumenti

- `src/server/metrics.ts` e `runIndex()` in `src/server/index.ts`: `IndexSummary.phases` riporta, per ogni fase,
  tempo, RSS, heap, picco RSS, blocco del loop, timestamp di fine e contatori (per `extract`: lettura, hash, CPU e
  scrittura). La modifica è additiva e viene salvata anche in `meta.indexPhases`.
- `scripts/bench-index.mjs`: opzioni `--files`, `--repo`, `--root`, `--src`, `--engine`, `--repeat`, `--runs`, `--keep`
  (conserva DB e archi in TSV per il diff), `--out` e `--compare`.
- `tests/indexing/corpus.mjs`: generatore del corpus sintetico e mutazione dell'1%.
- `tests/indexing/fixture.mjs` e `scripts/test-index-quality.mjs`: archi attesi e controlli.
- `tests/indexing/baseline-engine/`: motore di riferimento per il "prima".
- `tests/indexing/results/*.json`: risultati grezzi.
