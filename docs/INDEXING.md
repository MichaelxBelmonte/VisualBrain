# Indicizzazione / Indexing

## Italiano

Visual Brain mantiene due walker selezionabili. Entrambi alimentano lo stesso indice SQLite e lo stesso estrattore di riferimenti TypeScript; il linguaggio del walker non determina la precisione dei collegamenti.

| Selettore | Comportamento |
|---|---|
| `ts` | Walker TypeScript di riferimento, senza necessità di Rust. |
| `native` | Walker Rust obbligatorio; un binario assente o un errore interrompono la scansione. Utile per verificare che il benchmark misuri davvero Rust. |
| `auto` | Prova Rust e, in caso di errore, ripete il walk con TypeScript prima di aggiornare l'indice. |

Si sceglie con `--engine`, la variabile `VB_ENGINE` o `engine` nel file di configurazione. Il checkout usa `ts` come predefinito; la Trial e il pacchetto standard dalla versione 0.2.1 usano `auto`. Per il binario di sviluppo si può impostare `VB_NATIVE_INDEXER`. `VB_INDEXER_THREADS` controlla i thread del walker Rust: predefiniti 4, limitati a 1–32. Il protocollo subprocess è locale: richiesta JSON su stdin, progressi e risultati NDJSON su stdout, errori su stderr. Il motore non modifica i file indicizzati e non segue i link simbolici durante la visita.

Gli aggiornamenti parziali raggruppano percorsi sovrapposti, distinguono file, cartelle e cancellazioni e aggiornano i totali degli antenati. Il watcher conserva gli eventi arrivati durante una scansione. I file riscritti sul posto vengono indicizzati subito; i percorsi nuovi, spariti o spostati, che rendono la passata completa, aspettano 20 secondi di quiete e partono al massimo una volta ogni 3 minuti (mai oltre 5 minuti di attesa), perché gli agenti creano file di continuo. Un file comparso e sparito prima del controllo (la copia temporanea di un editor) non costa nulla. Le cartelle `.worktrees`, copie temporanee di un repository già indicizzato, sono escluse. Una passata parziale che trova solo file riscritti sul posto (nessun percorso nuovo, sparito o cambiato di tipo) ricostruisce soltanto i riferimenti e i gruppi di duplicati di quei file, salta progetti e ricerca full-text e rimanda ranking e similarità finché l’ultimo calcolo non ha almeno 10 minuti: il risultato coincide con quello di una passata completa (`scripts/test-index-narrow.mjs`). Archi e pesi che tornano identici non vengono riscritti. Nelle passate complete il ranking lavora su array per posizione del nodo e la similarità su termini numerati, con le somme nello stesso ordine di prima (`scripts/test-rank.mjs` confronta il ranking con l’implementazione di riferimento); ogni destinazione relativa alla radice (per esempio un import Python) viene confrontata una volta sola con i percorsi noti, così le cartelle in cui non può trovarsi vengono saltate. Dopo ogni passata il server ricarica la mappa a blocchi, senza fermare terminali e API; all’avvio apre subito la porta e le richieste che leggono la mappa la attendono. Gli artefatti di build di questo checkout sono esclusi senza cancellarli; le altre cartelle vendor restano rappresentate dai loro totali.

Il server esegue la pipeline in un worker con una connessione SQLite propria, lasciando liberi HTTP, WebSocket e terminali. Le scritture API di note e archi aspettano il lock SQLite con retry asincrono: non tengono fermo il thread del server e vengono applicate una sola volta. L'estrazione dei contenuti gira su più worker (`VB_EXTRACT_WORKERS`, predefinito: core meno uno, al massimo 4; `0` o `1` la tengono sul thread dell'indice, così come gli alberi sotto i 200 file): i worker leggono ed estraggono, le scritture restano in un solo thread e nello stesso ordine, quindi l'indice è identico a quello sequenziale. Il comando CLI continua a funzionare direttamente; `VB_INDEX_INLINE=1` permette il confronto diagnostico con l'esecuzione precedente. Le fasi globali leggono le tabelle grandi (nodi, riferimenti, archi, termini) una riga alla volta invece di caricarle intere, e la mappa del server, ricaricata dopo ogni passata, riusa gli oggetti dei nodi e degli archi rimasti uguali: su un indice di 1,1 milioni di nodi la memoria viva della risoluzione dei riferimenti scende da circa 2 GB a meno di 1 GB e il picco della ricarica della mappa da 1,7 GB a 0,9 GB, con gli stessi archi e gli stessi pesi.

### Prove riproducibili

Le prove seguenti creano file inventati e indici temporanei. Non richiedono un provider AI. Node 24 è necessario; Rust serve solo per costruire l'helper di sviluppo. Dopo la build del helper, `npm run test:index` esegue la suite di indicizzazione; i comandi singoli permettono di isolare le verifiche.

```sh
node scripts/build-indexer.mjs --test
node scripts/test-native-indexer.mjs
node scripts/test-index-integration.mjs
node scripts/test-index-review.mjs --engine=ts
node scripts/test-index-review.mjs --engine=native
node scripts/test-index-quality.mjs
node scripts/test-graph-determinism.mjs
node scripts/test-index-concurrency.mjs
node scripts/test-api-write.mjs
node scripts/test-index-watch.mjs
node scripts/test-index-responsive.mjs
node scripts/smoke-api.mjs
node scripts/test-i18n.mjs
npm run typecheck
```

Il test di revisione verifica identità dei nodi, note, archi nascosti, promozione di riferimenti esterni a file reali, confini dei sottoalberi con `_` e `%`, cancellazioni, classificazione degli antenati e nuove regole per i segreti. La suite di qualità verifica i collegamenti attesi; la parità fra walker da sola non dimostra che un collegamento sia corretto.

Il test di determinismo inserisce gli stessi file con ID e ordini diversi e confronta i collegamenti euristici, anche dopo una nuova indicizzazione. Verifica inoltre che la riconciliazione degli archi conservi identità e scelte di visibilità precedenti. I pareggi fra candidati vengono risolti tramite il percorso del file.

I risultati misurati e i comandi del benchmark sono in [INDEXING-BENCHMARK.md](INDEXING-BENCHMARK.md). I risultati grezzi sono in `tests/indexing/results/`. Un indice inizialmente vuoto non implica una cache del filesystem vuota; i risultati dipendono da albero, contenuti, hardware e carico. Il tempo della scansione include l'avvio del helper e la lettura dei suoi risultati. La memoria del processo Node e quella del helper vanno considerate separatamente.

### Pacchetto di prova

```sh
node scripts/package-mac.mjs --arch=universal --trial
```

Il pacchetto viene scritto in `release-trial/`, separatamente dalle release precedenti. L'app si chiama **Visual Brain Trial**, ha un identificativo diverso, sceglie una porta libera e usa `~/Library/Application Support/Visual Brain Trial/`. Non si collega all'istanza installata. Al primo avvio sceglie l'utente quali cartelle indicizzare. La Trial ignora `VISUAL_BRAIN_DATA_DIR`; per un diverso profilo di prova usa `VISUAL_BRAIN_TRIAL_DATA_DIR`.

Contiene Node, dipendenze terminale e walker per Apple Silicon e Intel, con checksum SHA-256. Le verifiche sul runtime usano `scripts/test-desktop.mjs` con profili temporanei. Non occorre installare Rust sul Mac di chi prova il pacchetto. La firma interna è ad hoc; il pacchetto non è notarizzato.

La [revisione indipendente](INDEXING-REVIEW.md) riporta il checksum del pacchetto verificato e i limiti delle prove: il runtime Intel è stato eseguito sotto Rosetta su Apple Silicon, non su hardware Intel. Dopo una scansione parziale, il conteggio dei figli degli antenati può differire dalla scansione completa per socket, FIFO o voci non leggibili; non cambia i collegamenti attesi.

Per ripristinare il walker precedente basta `VB_ENGINE=ts` oppure `"engine": "ts"` nelle preferenze del profilo di prova. Non servono conversioni del database.

**Primo avvio.** Al primo passaggio completo (nessuna scansione precedente) il server pubblica la mappa appena finiscono scansione e rilevamento dei progetti (evento `index:map`, dopo una prima classifica senza archi); estrazione, archi e ricerca testuale proseguono in background e `index:done` aggiorna la mappa con gli archi. I passaggi successivi non inviano `index:map`. Test: `scripts/test-first-map.mjs`.

## English

The `ts`, `native` and `auto` selectors choose the filesystem walker. Both engines feed the same SQLite index and TypeScript reference extraction, edge resolution and ranking. `native` fails explicitly if the helper cannot run; `auto` falls back to TypeScript before updating the index. Use `--engine`, `VB_ENGINE`, or the `engine` configuration field. The source checkout defaults to `ts`; the Trial and standard packages (from version 0.2.1) default to `auto`. `VB_INDEXER_THREADS` defaults to 4 and is bounded to 1–32. Indexing makes no AI calls and does not modify source files.

Partial updates coalesce overlapping paths, handle individual files and deleted subtrees, and refresh ancestor totals. Watcher events arriving during indexing are retained. Files rewritten in place are indexed at once; new, vanished or moved paths, which make the pass a full one, wait for 20 seconds of quiet and run at most once every 3 minutes (never waiting more than 5), because agents create files all the time. A file that appeared and vanished before the check (an editor's temporary copy) costs nothing. `.worktrees` folders, temporary copies of a repository that is already indexed, are excluded. A partial pass that finds only files rewritten in place (no path added, removed or changed kind) rebuilds just their references and duplicate groups, skips projects and full-text search, and defers rank and similarity until their last run is at least 10 minutes old; the result matches a full pass (`scripts/test-index-narrow.mjs`). Edges and weights that come back unchanged are not rewritten. On full passes ranking runs on arrays indexed by node position and similarity on numbered terms, summing in the same order as before (`scripts/test-rank.mjs` checks ranking against the reference implementation); each root-relative target (a Python import, for instance) is matched once against the known paths, so folders it cannot be under are skipped. After each pass the server reloads the map in slices without stalling terminals or the API; at startup it opens the port at once and map requests wait for the map. Local build artifacts are excluded without deleting them. Tests use invented files and temporary databases; the commands above cover native parity, expected relationships, annotation preservation, API behavior and both interface languages.

Heuristic ties use file paths. A dedicated determinism test varies node IDs and insertion order, compares inferred relationships, and checks edge identity and visibility during reconciliation.

The server runs indexing in a worker with its own SQLite connection. HTTP, WebSockets and terminals remain on the main thread. API writes retry database locks asynchronously and apply each mutation once. Content extraction runs on worker threads (`VB_EXTRACT_WORKERS`, default cores minus one, at most 4; `0` or `1`, or a tree under 200 files, keeps it on the index thread); writes stay on one thread in the same order, so the index is identical to the sequential one. The CLI retains inline execution; `VB_INDEX_INLINE=1` is available for diagnostic comparisons. The global phases read the large tables (nodes, references, edges, terms) one row at a time instead of loading them whole, and the server map, reloaded after every pass, keeps the objects of unchanged nodes and edges: on a 1.1 million node index the live memory of reference resolution drops from about 2 GB to under 1 GB and the peak of a map reload from 1.7 GB to 0.9 GB, with the same edges and weights.

See [INDEXING-BENCHMARK.md](INDEXING-BENCHMARK.md) for measured results, methodology and limitations. Engine parity is separate from precision against expected relationships. An empty index does not imply a cold filesystem cache; Node memory and helper memory are reported separately.

Build the self-contained Intel/Apple Silicon trial with `node scripts/package-mac.mjs --arch=universal --trial`. Its archive and checksum are placed in `release-trial/`. **Visual Brain Trial** uses its own app identifier, free port and `~/Library/Application Support/Visual Brain Trial/` profile. The user selects folders on first launch. Rust is not required on the recipient's Mac. The internal package uses an ad hoc signature and is not notarized. Select `ts` to return to the previous walker without a database conversion.

The [independent review](INDEXING-REVIEW.md) records the verified archive checksum. Intel runtime checks used Rosetta on Apple Silicon, not physical Intel hardware. After a partial scan, ancestor child counts may differ from a full scan for sockets, FIFOs or unreadable entries.

**First start.** On the first full pass (no previous scan) the server publishes the map as soon as the scan and project detection finish (`index:map` event, after a first ranking without edges); extraction, edges and full-text search continue in the background and `index:done` refreshes the map with the edges. Later passes do not send `index:map`. Test: `scripts/test-first-map.mjs`.
