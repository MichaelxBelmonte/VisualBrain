# Revisione indipendente: worker di indicizzazione, API, motore nativo, pacchetto Trial

Revisore: sessione 3f0ce0bf (incarichi 4bc257f9 e riesami). Data: 2026-10-14.

## Esito finale: APPROVATO

Pacchetto di prova finale: `release-trial/Visual-Brain-0.2.0-mac-universal-indexer-trial.zip` (rigenerato alle 17:09 dopo le misure finali)

- **sha256:** `c5672d378adcbbacfc53c81ef8445af37db4ba18eac6897fd4f815569ee7d9c4`, uguale al file `.sha256` e a `build.json`. Tutti i checksum precedenti (f1eede63, 6e824135, 33fdafa2, cc614afa) sono **obsoleti**.
- **Identità:** `Visual Brain Trial.app`, bundle id `com.jethr.visualbrain.trial`, con profilo `~/Library/Application Support/Visual Brain Trial`. La variabile d'ambiente per un percorso diverso è solo `VISUAL_BRAIN_TRIAL_DATA_DIR`, presente nel binario. Porta casuale.
- **Architetture:** eseguibile universale x86_64 + arm64; `runtime/bin/vb-indexer-arm64` (arm64) e `vb-indexer-x64` (x86_64, protocol 1); motore predefinito `auto`.
- **Coerenza con i sorgenti:** `src/server`, `src/shared` e `src/cli.ts` del runtime sono identici a `src/` (diff -rq). Contengono tutte le correzioni della revisione, compreso il determinismo del grafo (`graph.ts` sha256 c86780c1…).
- **Firma:** `codesign --verify --deep --strict` ok.
- **Esecuzione:** motore nativo avviato dal runtime impacchettato su una cartella di prova, con `node-arm64` (arm64) e con `node-x64` sotto Rosetta: 3 voci in entrambi i casi.
- **Rilievi:** tutti risolti e verificati con riproduzioni rieseguite:
  - concorrenza e ripiego: B1, B2, M1, M2, M3, N1, N3, N4, N5;
  - determinismo: D1, D3.
- **Test verdi:** `test-graph-determinism` 48, `test-index-concurrency` 14, `test-index-quality` 29 (P/R 1.000), `test-api-write` 8, `test-native-indexer`, `tsc --noEmit`.

### Limiti noti

- **Intel solo sotto Rosetta.** Il binario x86_64 e il runtime `node-x64` sono stati eseguiti sotto Rosetta su un Mac Apple Silicon, non su un Mac Intel reale.
- **App non avviata.** Il revisore non ha aperto né installato l'app: ha verificato lo zip ed eseguito il motore dal runtime impacchettato.
- **Firma.** Firma ad-hoc e app non notarizzata: Gatekeeper chiederà conferma all'apertura. È atteso per un pacchetto di prova.
- **N2.** Dopo una scansione parziale, `child_count` delle cartelle antenate conta solo i nodi: differenza cosmetica rispetto a un indice completo.
- **D2.** Nella UI gli archi non orientati (`similar`, `shared_id`, `duplicate`) mostrano frecce →/←. È un limite preesistente, fuori ambito.
- **Fase non portata in Rust.** Il motore Rust copre solo la scansione delle cartelle. Estrazione e ranking restano in TypeScript per scelta, a tutela della precisione.

### Revisione del determinismo del grafo (incarico 097fe903): APPROVATA

**Esito del riesame (graph.ts delle 16:54):** D1 e D3 risolti, D2 documentato come limite preesistente (fuori ambito: nessuna modifica alla UI).

- **D1, ranking dipendente dagli id: risolto.** `similar` e `shared_id` sono ora orientati per percorso. Pesi e `rank.ts` sono invariati.
  - Con lo stesso albero indicizzato in tre ordini di id (nativo, nativo con fratelli rovesciati, TS):
    - archi identici (3 `duplicate`, 8 `shared_id`, 55 `similar`);
    - stesse confidenze ed evidenze;
    - stessa direzione;
    - **0 nodi** con `importance`/`pagerank`/gradi diversi.
- **D3, `hidden` sovrascritto: risolto.** `existing` viene letto dentro la `tx`. La riproduzione deterministica (commit di `hidden = 1` da una seconda connessione prima del lock) ora dà `hidden = 1`.
- **Migrazione dei vecchi indici.** Il matching simmetrico conserva id e `hidden` anche quando l'orientamento cambia. Verificato per `duplicate`: da `aa → bb` a `bb → aa`, id 1, `hidden = 1`.
- **Test:** `test-graph-determinism` 48 ok, `test-index-concurrency` 14 ok, `test-index-quality` 29 ok (P/R 1.000, ts↔native 22 archi identici), `tsc --noEmit` ok.
- **Pacchetto:** rigenerato dopo le misure (sha256 c5672d37…) e verificato: vedi l'esito finale in testa.

Dettaglio della prima verifica (storico):

Il pacchetto `cc614afa…` era stato verificato, ma è **superato**. Il sorgente di `graph.ts` è cambiato per la correzione del determinismo, quindi lo zip va rigenerato dopo l'approvazione e le misure.

Ho verificato in modo indipendente il codice attuale (`graph.ts` delle 16:52 e `scripts/test-graph-determinism.mjs`).

- **Metodo.** Ho preso lo stesso albero e l'ho indicizzato da zero tre volte:
  - motore nativo;
  - motore nativo con un helper che rovescia l'ordine dei fratelli (stesse voci, id assegnati in ordine inverso: dup 4,6,8,10 → 117,115,113,111);
  - motore TS.

  La fixture contiene casi che producono pareggi:
  - 4 duplicati con percorsi della stessa lunghezza;
  - lo stesso identificatore in 9 file (stella con più di 6 file);
  - 8 testi quasi identici (più di 5 candidati con lo stesso punteggio);
  - 70 file di riempimento.
- **Archi: risolto.** Insiemi identici in tutte e tre le esecuzioni: 3 `duplicate`, 8 `shared_id` e 55 `similar`, con le stesse confidenze ed evidenze. I pareggi ora si risolvono per percorso. Ho confrontato il `graph.ts` precedente, estratto dallo zip cc614afa, con quello attuale: soglie e pesi invariati (0.3, ≥3 termini condivisi, top 5, gruppi da 2 a 25, al massimo 40 duplicati, dimensione >64 byte, maxDf 15%, al massimo 400 posting, confidenze 0.45/0.6/+0.1).
- **D1 (risolto, vedi sopra): il ranking dipendeva ancora dagli id.**
  - Causa:
    - gli archi `similar` e `shared_id` sono simmetrici, ma vengono salvati come min-id → max-id;
    - `rank.ts` calcola PageRank in direzione src→dst e `indeg`/`outdeg` su tutti gli archi.
  - Effetto: con lo stesso albero e gli stessi archi non orientati, **21 nodi** hanno `importance`/`pagerank`/gradi diversi tra i due ordini di id. Esempio: `/dup/aa/same.md` ha importance 0.85 contro 0.841 e pagerank 0.1023 contro 0.0791. Lo stesso succede tra nativo e TS.
  - Conseguenza: cambiano l'ordinamento per importanza, la ricerca e la dimensione dei nodi nella UI.
  - `test-graph-determinism.mjs` (38 controlli) confronta gli archi ma non il ranking.
  - Correzione:
    - in `rank.ts`, trattare i tipi simmetrici (`similar`, `shared_id`, `duplicate` se considerato non orientato) come due archi a metà peso, oppure orientarli per percorso in fase di scrittura (`keyOf` simmetrico in `writeEdges` conserva già id e `hidden`);
    - aggiungere al test un confronto di `importance`/`pagerank` per percorso.
- **D3 (risolto, vedi sopra; era una regressione di concorrenza): `writeEdges` legge `existing` e `hidden` fuori dalla transazione.**
  - La lettura avviene prima di `db.tx`, poi `UPDATE … hidden = ?` riscrive il valore dello snapshot.
  - Se nel frattempo l'API nasconde l'arco (`PATCH /api/edges/:id` o `DELETE` su un arco `scan`), il worker annulla l'azione dell'utente.
  - Riproduzione deterministica (seconda connessione che fa commit di `hidden = 1` tra lo snapshot e `BEGIN IMMEDIATE`): dopo `writeEdges` resta `hidden = 0`, mentre era atteso 1.
  - Correzione: spostare il ciclo di lettura di `existing` dentro `db.tx`. Gli statement preparati e `keyOf` possono restare fuori.
- **Migrazione dei duplicati (verificata):**
  - indice creato con il `graph.ts` precedente e id in ordine inverso, con hub scelto per id (`aa → bb`);
  - l'utente nasconde l'arco;
  - il codice nuovo sullo stesso DB inverte l'arco nell'orientamento per percorso (`bb → aa`), **mantenendo id 1 e `hidden = 1`**. `duplicate` ora è in `SYMMETRIC` solo per la riconciliazione.
- **D2 (minore, preesistente, documentato come limite):** `panel.ts` e `terminal.ts` mostrano frecce →/← anche per gli archi non orientati (`UNDIRECTED` in `state.ts`), quindi la direzione mostrata dipende dagli id.
- **Nota:** `cmpPath` confronta stringhe JS (unità UTF-16), mentre `ORDER BY path` di SQLite confronta byte UTF-8. Le due regole sono entrambe deterministiche ma diverse per caratteri fuori dal BMP: nessun effetto sul determinismo.

## Cronologia della revisione

I paragrafi seguenti registrano i rilievi nell'ordine in cui sono emersi. Gli esiti intermedi sono superati dall'esito finale qui sopra.

File letti nella prima revisione: `src/server/{api.ts, api-write.ts, index-worker.ts, index-runner.ts, server.ts, native-indexer.ts, scan.ts}`, `db.ts`, `graph.ts`, `app/src-tauri/src/main.rs`, `scripts/{package-mac,prepare-runtime}.mjs`.

### Esito della prima revisione (superato)

**Allora non approvato finché non si correggono B1 e B2.** Sono due blocker con correzioni piccole. Va corretto anche M3, che riguarda la precisione. Il resto è solido.

### Blocker

#### B1. Il worker usa transazioni `BEGIN` differite: un'operazione dell'API durante l'indicizzazione fa fallire la passata e i percorsi in coda vanno persi

- `db.tx()` apre una transazione con `BEGIN` (differita).
  - Nel worker, le transazioni che prima leggono e poi scrivono passano a scrittura dopo la lettura.
  - Esempio: in `scan()`, la transazione delle rimozioni fa prima `SELECT id … gen < ?` e poi `UPDATE deleted = 1`.
- Se nel frattempo il thread del server fa commit tramite `apiWrite`, SQLite restituisce `SQLITE_BUSY_SNAPSHOT` (517).
  - In questo caso `busy_timeout = 30000` **non** ritenta.
  - Il worker manda `error`, `runIndex` si interrompe e la UI riceve `index:error`.
  - Ora il server resta reattivo durante l'indice, quindi note e archi salvati mentre l'indice gira rendono il caso realistico.
- Conseguenza: le scritture si annullano con il rollback, quindi nessuna perdita di dati.
  - Però `startIndex` aveva già svuotato `pendingPaths`, e nel `.catch` i `paths` della passata fallita non vengono rimessi in coda.
  - Le modifiche del watcher restano quindi non indicizzate fino al prossimo evento sugli stessi file o al prossimo indice completo.
- Riproduzione (due connessioni `node:sqlite`, WAL, busy_timeout 30000): `BEGIN; SELECT…`, poi commit dall'altra connessione, poi `UPDATE` → `errcode 517 database is locked`. Con `BEGIN IMMEDIATE` lo stesso schema passa.
- Correzione proposta:
  - aprire con `BEGIN IMMEDIATE` le transazioni del worker; basta un `db.tx` con opzione `immediate`, o il default per le connessioni con busy_timeout. Il lock viene preso all'inizio, quindi `busy_timeout` attende;
  - nel `.catch` di `startIndex` rimettere in `pendingPaths` i `paths` (oppure `rerun = true` per una passata completa).

#### B2. L'adapter nativo accetta un flusso vuoto: uno scan completo segnerebbe come cancellato l'intero indice

- `nativeWalk` controlla che `end.count` corrisponda alle voci ricevute, ma non controlla che ogni radice richiesta e non esclusa sia presente come voce `dir`.
  - Il walk TS emette sempre la voce della radice, anche quando `readdir` fallisce.
- Riproduzione: un helper finto in `VB_NATIVE_INDEXER` che legge stdin e scrive solo `{"t":"end","count":0}`.
  - `walk()` restituisce 0 voci sia con `engine=auto` sia con `engine=native`, senza alcun ripiego.
  - In `scan()` completo questo significa `deleted = 1` per tutti i nodi file/dir/symlink, con cancellazione di archi `scan`, refs e identifiers.
  - L'indice si ricostruisce alla passata successiva, ma con una riestrazione completa, e intanto la UI resta vuota.
- Correzione (`native-indexer.ts`): dopo `end`, per ogni radice in `roots` che non è in `excludePaths` e il cui basename non è in `excludeNames`, pretendere una voce `kind: 'dir'` con `path === root`. Altrimenti trattarlo come errore: ripiego in `auto`, errore in `native`.

### Da correggere (non bloccanti)

#### M3. Cache di estrazione obsoleta quando una cartella antenata passa da dump/vendor/media a cartella normale, o viceversa

- `extractAll` decide `wantText`/`wantHash` in base a `inDump(parent)`.
  - Nello scan, il controllo «invariato» confronta solo kind/size/mtime/inode/cls/ext/lang del file, non la classe degli antenati.
  - Un file già estratto resta quindi `extracted = 1` anche quando una cartella sopra di lui cambia ruolo.
- Riproduzione (indici temporanei, `runIndex` inline, motore TS):
  - cartella `exports/` con 120 csv e `meta.json`, quindi classificata `dump`: `meta.json` ha terms null e 0 refs;
  - si cancellano 115 csv e la cartella diventa `folder`;
  - indice incrementale: `meta.json` resta con terms null e 0 refs;
  - **indice nuovo** sullo stesso albero: 7 terms e 1 ref.
- In senso opposto (folder→dump) restano refs e terms che un indice nuovo non avrebbe.
- L'incrementale diverge quindi in modo permanente da un indice completo, finché il file non cambia o non si esegue `reextract`.
- Correzione:
  - in `scan()`, quando lo stato «dump-like» (`dump|vendor|media`) di una cartella cambia tra `prev.cls` e il nuovo `cls`, rimettere `extracted = 0` e cancellare refs e identifiers dei file discendenti non cancellati (`underClause`);
  - fare lo stesso in `refreshAncestors` quando `setCls` cambia lo stato;
  - in alternativa, salvare per ogni file il contesto dump usato all'estrazione e confrontarlo in `extractAll`.
- Owner: `scan.ts` (fba41427); per l'alternativa, `index.ts` (32c4e00d).


#### M1. Un nodo `external` creato dall'API durante il walk fa fallire l'intera transazione di scrittura dello scan

- `scan()` legge `existing` **prima** della transazione.
- Se nel frattempo `POST /api/edges` con `srcPath`/`dstPath` crea un nodo `external` per un percorso dentro le radici (`getOrCreateExternal`), può succedere questo:
  - il walk vede quel file appena comparso;
  - `INSERT` va in conflitto con `UNIQUE(path)` (riprodotto: `errcode 2067`);
  - tutta la scrittura dello scan si annulla.
- Alla passata successiva l'`external` viene promosso al suo posto, quindi il problema si risolve da solo. Prima però va corretto B1, altrimenti i percorsi di questa passata vanno persi.
- Correzione: leggere `existing` dentro la transazione `BEGIN IMMEDIATE` di scrittura, che dopo il walk costa poco, oppure `INSERT … ON CONFLICT(path) DO NOTHING` seguito da riselezione e ramo «promuovi».

#### M2. Il ripiego inline del worker può ripetere una passata già iniziata

- `runIndexOffThread` indicizza inline quando arriva `error` prima del primo messaggio (`started = false`).
- Ma il worker può aver già fatto commit della pulizia iniziale degli `external` prima del primo `progress`. Il primo progress dello scan arriva solo dopo 2000 voci o a walk finito.
- Gli errori di `runIndex` passano come messaggio, quindi il caso riguarda solo le eccezioni non catturate. La ripetizione è idempotente: rischio basso.
- Correzione: inviare un messaggio `ready` all'avvio del worker, prima di aprire il DB, e usare quello come `started`.

### Note minori

- **N1 `native-indexer.ts`.** `nativeTimeoutMs` è un timeout totale, non di inattività come dice il commento.
  - Su alberi molto grandi o volumi lenti, oltre 5 minuti:
    - in `auto` si ripiega su TS, che è più lento;
    - in `native` si fallisce.
  - Correzione: azzerare il timer a ogni riga, oppure correggere il commento.
- **N2 `refreshAncestors`.** `child_count` conta solo i nodi. Il walk completo conta anche i nomi senza nodo: fifo, socket, file con `lstat` fallito.
  - Dopo un parziale, il valore può scendere rispetto a un indice completo.
  - È solo cosmetico: non influisce su classi né estrazione.
- **N3 Trial `main.rs`.** `data_dir()` dà la precedenza a `VISUAL_BRAIN_DATA_DIR`, per entrambe le build.
  - Se la variabile è nell'ambiente di lancio (avvio da terminale con env esportato), la Trial usa il profilo indicato invece di `Visual Brain Trial`.
  - Con l'avvio dal Finder la variabile non c'è, quindi va bene.
  - Correzione: per `TRIAL` ignorarla o usare `VISUAL_BRAIN_TRIAL_DATA_DIR`.
- **N4 `apiWrite`.** Se `ROLLBACK` stesso lancia un errore, l'errore originale viene mascherato. Correzione: avvolgere `ROLLBACK` in try/catch.

### Verificato e corretto

- **`apiWrite`.**
  - Ritenta solo l'acquisizione: `BEGIN IMMEDIATE` con `busy_timeout = 0`, attesa asincrona fino a 20 ms, scadenza 30 s.
  - La callback viene eseguita una sola volta, il busy_timeout precedente viene ripristinato, rollback in caso di errore.
  - Tutte le scritture dal thread HTTP in `api.ts` passano da qui: archi POST/PATCH/DELETE, note POST/DELETE.
  - Analisi e indice si alternano (`state` + `drain`); nessun'altra scrittura dal thread server durante l'indice.
- **Worker.**
  - Ha una connessione propria con busy_timeout 30 s.
  - Errori, crash ed exit senza `done` vengono rifiutati una sola volta (`settled`), e `finally` libera sempre `state.indexing`.
  - La cache viene ricaricata solo a `done`.
- **Adapter nativo.**
  - Valida ogni voce: percorso assoluto dentro le radici, esclusioni per percorso e per nome, duplicati, kind, numeri, depth, parent prima dei figli, stats solo per le cartelle, linkTarget solo per i symlink.
  - Controlla anche `end.count`, la lunghezza massima di riga, JSON non validi e dati dopo `end`.
  - In `auto` ripiega su TS, in `native` lancia l'errore.
  - Il percorso del binario impacchettato (`PROJECT_ROOT/../bin/vb-indexer-<arch>`) si risolve correttamente.
- **Symlink, parziali ed esclusioni.**
  - `planSubtrees` scarta i nomi e i percorsi esclusi.
  - Risale sopra le cartelle vendor e aggregate.
  - Fa `stat` dei file singoli, i percorsi spariti diventano tombstone, quelli annidati vengono deduplicati.
  - `underClause` evita i caratteri jolly di LIKE.
  - Il marker `.git` viene ricontrollato su disco.
  - Gli `external` con lo stesso percorso vengono promossi al loro posto, mantenendo l'id.
- **Parità Rust↔TS.** `node scripts/test-native-indexer.mjs` sullo `scan.ts` attuale:
  - fixture a 1/4/16 thread, sottoalberi, radici escluse o mancanti, errore di protocollo: tutto ✓.
  - La parità su 105k voci del Desktop reale era già stata misurata (vedi incarico c1b5cba1).
- **Pacchetto Trial** (zip estratto in una cartella temporanea):
  - bundle id `com.jethr.visualbrain.trial`, nome `Visual Brain Trial`, eseguibile universale `x86_64 arm64`;
  - nel binario c'è la stringa del profilo Trial, porta preferita 0 (casuale), `instance.json` nel proprio profilo;
  - `runtime/bin/vb-indexer-{arm64,x64}` (lipo corretto), `engine.default.json = auto`, `index-worker.ts`/`index-runner.ts` presenti;
  - `codesign --verify --deep --strict` ok (firma ad hoc, non notarizzato: atteso per una prova).
- **Esecuzione dal runtime impacchettato** (`engine=native`, piccola fixture):
  - `node-arm64` → `bin/vb-indexer-arm64`, 6 voci, `protocol 1`;
  - `node-x64` sotto Rosetta → `bin/vb-indexer-x64`, 6 voci, `protocol 1`.
- **Profilo separato.**
  - Dati in `~/Library/Application Support/Visual Brain Trial`.
  - Bundle id diverso, quindi storage WebKit separato.
  - Target di build separato (`.build/trial-target`) e output in `release-trial/`: la build normale non viene toccata.

### Riesame intermedio (zip sha256 33fdafa2…, superato)

| Rilievo | Stato | Verifica |
|---|---|---|
| B1 tx differite nel worker | **risolto** | `index-worker.ts` sostituisce `db.tx` con `BEGIN IMMEDIATE`, con ROLLBACK protetto; `startIndex` rimette in coda paths/rerun (al massimo 2 tentativi consecutivi). Stress fba41427: 746/746 note durante un indice pesante, nessun `index:error` |
| M1 existing letto prima della tx | **risolto** | `loadExisting()` viene chiamato dentro `db.tx` in `scan()` |
| M2 ripiego inline dopo commit | **risolto** | messaggio `ready` prima dell'indice; ripiego inline solo per error/exit precedenti a `ready` |
| N1 timeout nativo totale | **risolto** | `rearm()` riarma il timer a ogni dato: timeout di inattività |
| N3 Trial e `VISUAL_BRAIN_DATA_DIR` | **risolto** | la Trial legge solo `VISUAL_BRAIN_TRIAL_DATA_DIR` |
| N4 ROLLBACK in apiWrite | **risolto** (secondo b1344973) | — |
| N2 child_count dei parziali | lasciato com'è, documentato | cosmetico |
| **B2 flusso nativo vuoto accettato** | **APERTO** | riprova con helper finto `end count 0`: `walk()` restituisce 0 voci in `auto` e in `native` |
| **M3 cache di estrazione dopo cambio dump↔folder** | **APERTO** | riprova: dopo il passaggio a folder l'incrementale ha `terms` null e 0 refs, l'indice nuovo ha terms e 1 ref: **DIVERSI** |
| N5 (nuova) `rebuildFts` non atomico | aperto, minore | DELETE e INSERT in autocommit separati: una ricerca durante l'indice può vedere FTS vuoto. Correzione: `db.tx(() => …)` |

**Esito di quel riesame (superato): non ancora approvato.** B2 resta bloccante. M3 non blocca il funzionamento, ma blocca la precisione dichiarata, perché l'incrementale non equivale a un indice nuovo. Approverò dopo la correzione di B2 e M3 rieseguendo le stesse due riproduzioni.

### Riesame finale (codice dopo il task 3e0ac7d7, prima del rebuild dello zip)

| Rilievo | Stato | Verifica eseguita |
|---|---|---|
| B2 flusso nativo vuoto | **risolto** | helper finto `end count 0`: in `auto` ripiego su TS (3 voci, radice inclusa); in `native` errore «manca la voce della radice». Con il binario reale, `engine=native`: radice → 3 voci, radice mancante → 1 (come TS), radice esclusa per percorso o per nome → 0 senza errore, radici miste → 3 |
| M3 cache di estrazione su cambio di ruolo | **risolto** | dump→folder: incrementale = indice nuovo (terms e 1 ref). folder→dump: incrementale = indice nuovo (niente terms e refs). Parziale (watcher su 115 csv cancellati, `meta.json` in una sottocartella non toccata): incrementale = indice nuovo |
| N5 `rebuildFts` | **risolto** | DELETE e INSERT nella stessa `tx` |
| B1 | **risolto** | ora `db.tx` usa `BEGIN IMMEDIATE` per tutte le connessioni. Le tx del thread server avvengono solo all'avvio o durante l'analisi, che è esclusiva rispetto all'indice; le scritture HTTP passano da `apiWrite` |
| Test | **verdi** | `test-index-concurrency` 14 ok, `test-native-indexer` (parità a 1/4/16 thread, sottoalberi, radici, protocollo) ok, `tsc --noEmit` ok |

**Esito allora (superato dallo zip c5672d37…): approvato.** Avevo verificato lo zip `release-trial/Visual-Brain-0.2.0-mac-universal-indexer-trial.zip` (sha256 cc614afa…, uguale al file `.sha256`): bundle id `com.jethr.visualbrain.trial`, eseguibile universale x86_64+arm64, `VISUAL_BRAIN_TRIAL_DATA_DIR` presente, `vb-indexer` arm64 e x86_64 con protocol 1, `engine.default.json = auto`, `src/server` e `src/shared` del runtime identici a `src/` (diff -rq), `codesign --verify --deep --strict` ok. Il motore nativo gira dal runtime impacchettato con node-arm64 e con node-x64 sotto Rosetta (3 voci su fixture).
