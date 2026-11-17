# Revisione integrazione Operativa

Revisione locale del 21 ottobre 2026.

Nessun rilievo bloccante nella revisione del riordino e della separazione dei promemoria. Il nuovo test `scripts/test-workspace-integration.mjs` esegue i metodi reali di `Terminals`, compilati in memoria con esbuild, usando stato e superfici DOM simulate. Non apre terminali, non invia richieste e non modifica dati dell'utente.

Verificato:

- Riordinare la seconda pagina di nove terminali conserva integralmente prima e terza pagina; un successivo riordino della prima pagina mantiene il precedente.
- Ordine salvato prima della paginazione e ripristinato al ricaricamento; sessioni scomparse rimosse e nuove sessioni aggiunte in fondo.
- Focus, oggetti terminale, WebSocket e pannelli restano gli stessi durante il riordino; le composizioni conservano la selezione.
- Freccia giù sulla maniglia sposta il terminale di due posizioni nella griglia; i badge del selettore corrispondono all'ordine manuale.
- Durante un trascinamento il polling non ricostruisce sidebar o griglia. Passare ai promemoria rimuove i listener di riordino della griglia.
- Il modulo dei promemoria usa le API dedicate e non dipende da sessioni o bacheca della squadra.

Due adeguamenti segnalati durante l'integrazione sono stati risolti: il selettore riceve `tileOrder` e il test statico della guardia di `syncSel` segue il nuovo ramo per le composizioni. La mappa ricalcola inoltre le dimensioni dopo variazioni del footer dei collegamenti.

Controlli superati: `test-workspace-integration.mjs`, `test-work-reorder.mjs`, `test-work-tiles.mjs` (219 controlli), `test-work-layout.mjs`, `test-work-connections.mjs` (14 controlli), TypeScript e `git diff --check`.

Limite: nessuna verifica visiva nel browser. L'accesso CUA a `http://127.0.0.1:4747/` è stato negato perché la richiesta di autorizzazione è stata annullata; il gate non è stato aggirato. I test DOM simulati verificano comportamento e stato, non geometria e resa grafica del browser.

## Sidebar modulare

Revisione focalizzata su sidebar, maniglie e larghezza: nessun rilievo bloccante.

- Le maniglie di nodi e sessioni sono separate dai pulsanti di apertura, chiusura e compattazione. Il trascinamento del nodo riordina il gruppo completo; le sessioni si muovono soltanto nel proprio nodo.
- L'ordine manuale dei nodi segue la scelta dell'utente anche in presenza di collegamenti. Il riordino con filtro conserva i nodi nascosti. Ordine di nodi e sessioni, densità e gruppi richiusi sono persistenti.
- La sidebar mantiene il DOM quando la firma del contenuto non cambia e ripristina il focus dei comandi dopo un aggiornamento. Le maniglie supportano Alt e frecce verticali.
- I selettori CSS dei pulsanti delle sessioni usano `data-session`, evitando che la nuova maniglia erediti gli stili del pulsante principale. Modalità compatta con righe da 23/24 px, alternativa più distesa e bordo arrotondato.
- Il ridimensionamento usa la variabile CSS `--work-rail-width`: default 220 px, intervallo ordinario 180–360 px. In finestre strette riserva 240 px al contenuto; il ritorno a una finestra più larga ripristina la preferenza. Frecce e Shift, Home e doppio clic, annullamento con Esc o perdita del focus e attributi ARIA sono verificati dai test.

Controlli superati dopo l'integrazione: `test-work-rail.mjs`, `test-workspace-integration.mjs` (inclusi riordino sidebar con filtro, persistenza e proprietà delle sessioni), `test-work-reorder.mjs`, `test-work-tiles.mjs` (219 controlli), TypeScript e `git diff --check`. Nessun browser usato per questa revisione; resta il limite sulla resa visiva già indicato sopra.

## Navigazione e collegamenti 0.2.19

- Rimossi marchio e nome del nodo dalla barra; il contesto selezionato è nella sidebar. Il pulsante di apertura/chiusura cambia freccia, etichetta e stato ARIA.
- Il pulsante agente di ciascun nodo passa un ID esplicito al launcher. Aprire e annullare il launcher non cambia il nodo o il terminale visualizzati.
- I collegamenti sono nella sidebar: nodi come endpoint dell’orchestratore, operatori/revisori con il proprio ID. Le scelte non duplicano gli orchestratori e non includono shell o sessioni terminate. Il pannello scompare se l’origine non è più disponibile. Scritture concorrenti bloccate, collegamenti inversi riconosciuti per lo scollegamento.
- Comando per collegare cartelle interno all’intestazione e sempre visibile; restano selezione in due passaggi, Esc, collegamenti persistenti e spostamento spaziale.
- Test dei metodi reali con HTTP simulato: azioni dalla riga corretta, contesto invariato prima del lancio, identità dei terminali, collegamento nodo/nodo e operatore/nodo, scollegamento inverso, guardia sulle scritture e chiusura del pannello con origine scaduta. Test responsive verifica anche frecce ed etichette della sidebar.
- Suite Operativa superata (test di stato con porta temporanea eseguito fuori sandbox), TypeScript e build UI superati. Nessun browser usato, come richiesto dall’utente; resa visiva da verificare nell’app.

## Comunicazione degli agenti 0.2.20

Riprodotto il 22 ottobre: la lettura della bacheca con curl nella sandbox fallisce immediatamente, mentre la medesima richiesta autorizzata fuori sandbox riesce. L’API health è attiva sulla 4747 e la bacheca di destinazione contiene il messaggio del collega: il canale non era interrotto.

Aggiunto ponte MCP stdio locale per i nuovi lanci Codex e Claude. L’endpoint deve essere HTTP loopback e quello del nodo della sessione; identità/token non arrivano dai parametri del tool. Operazioni limitate a bacheca, messaggi, stato, incarichi, riepilogo e spawn; resta l’autorizzazione dell’API. Non sono cambiate le impostazioni globali, le protezioni della shell o le sessioni già aperte.

Verifiche: suite Operativa completa (incluso nuovo test MCP con HTTP e sessioni fittizie), TypeScript, avvio CLI con PATH login e parsing delle opzioni MCP da parte del Codex installato. Provati handshake/discovery, messaggi bidirezionali, routing di tutte le operazioni, rifiuto di identità/host/percorsi arbitrari, limite payload e autenticazione scaduta. Nessuna chiamata ai modelli o messaggio di prova alle sessioni dell’utente. La verifica end-to-end con i modelli reali non è eseguita; lo strumento è disponibile solo nei nuovi lanci successivi all’aggiornamento.

Pacchetto 0.2.20: prove MCP eseguite anche con Node e ponte inclusi nei runtime arm64 e x64, con messaggi bidirezionali fittizi, tutte superate. Test desktop arm64/x64 con profili vuoti, avvio, addon terminale e persistenza superati. Il test MCP concede 20 secondi alla risposta, così l’avvio iniziale sotto Rosetta non viene confuso con un errore del protocollo (il timeout HTTP del ponte rimane 8 secondi). La build mantiene le stesse versioni di tutte le dipendenze della 0.2.19; cambia solo la versione dell’app.

## Panoramica compatta 0.2.21

Schede Operativa ridotte da 360 a 280 px; disposizione automatica centrata nella viewport, con origine stabile durante il trascinamento e coordinate manuali conservate. Righe più compatte, nomi personali rispettati, metadati nel tooltip e nel pannello del collegamento. L’intestazione offre aggiunta agente e connessione; oltre quattro agenti si può espandere il gruppo, senza nascondere gli estremi dei canali.

Nuovo instradamento su griglia di visibilità: i collegamenti girano attorno alle schede e hanno angoli arrotondati. Un clic o Invio apre i dettagli; scollegare richiede un comando esplicito, con guardia sulle richieste concorrenti. La creazione mantiene la selezione in due passaggi, anteprima, evidenza delle destinazioni ed Esc. Restano invariati i controlli API sui canali.

Il movimento è limitato ai collegamenti con due estremi vivi e almeno un agente osservato o recentemente dichiarato al lavoro; attenzione, blocchi, attesa e dichiarazioni di lavoro ormai inattive non animano il canale. Non è una misura dei messaggi scambiati. Il DOM SVG viene mantenuto quando contenuto e geometria non cambiano. CSS per riduzione del movimento e pausa quando la pagina è nascosta o non si sta guardando la panoramica.

Il nuovo `scripts/test-work-topology.mjs` verifica 36 coppie fra nove schede evitando gli ostacoli, estremi esatti e tutti gli stati, priorità degli hook, centratura e larghezze strette, coordinate salvate, metodi reali della mappa, SVG stabile, ispezione senza scritture, creazione e annullamento, rifiuto dello stesso nodo, scritture duplicate e scollegamento esplicito. Nessun browser usato: resa visiva da verificare nell’app da parte dell’utente.

## Ricerca, codice locale e squadre salvate — 11 novembre 2026

- ⌘K: filtri Tutto, Cartelle, Progetti, File, Codice, Documenti, Immagini e media, Oggetti e collegamenti. La query filtra nel database prima del limite dei candidati, sia con FTS sia nel fallback. Le risposte superate da una nuova ricerca o da un cambio filtro vengono ignorate.
- Dev → Codice: anche cartelle senza Git; albero e ricerca locale con limiti di tempo/dimensione, esclusione delle cartelle generate, protezione dei segreti nella ricerca locale e controllo dei percorsi. Il selettore include i progetti locali senza repository.
- Dev → GitHub: account tramite GitHub CLI, login in un terminale dell’app, elenco paginato anche delle repository accessibili nelle organizzazioni, scelta esplicita e sincronizzazione. Il percorso locale è visibile prima dell’azione. Il primo collegamento conserva i file esistenti, importa quelli mancanti e rende visibili le differenze locali rispetto al ramo remoto. Le sincronizzazioni successive richiedono una copia pulita e procedono solo in fast-forward. Il push richiede la casella “Pubblica anche i commit locali”; nessun commit automatico, cambio di origin esistente o sovrascrittura forzata.
- Avvia → Squadre salvate: fino a 12 configurazioni distinte per nodo, salvate atomicamente in `dataDir/teams/<nodeId>.json` dopo gli avvii riusciti. Comprendono agenti, ruoli, modelli, effort, nomi e policy. Anche cambi ai nomi e alle impostazioni della squadra aggiornano lo storico. Il recupero ricarica la configurazione nel launcher e, premendo Avvia, crea nuove sessioni con nuovi codici; la bacheca conserva riepilogo e incarichi. Non ripristina processi o trascrizioni dopo lo spegnimento. Un nodo con agenti attivi impedisce un recupero duplicato. I salvataggi non dipendono dal localStorage e non contengono token o credenziali. Se il limite salvato è inferiore alla composizione, il recupero lo porta almeno al numero dei membri.

Verifiche: suite `npm run test:work` completa, `test-node-tasks-harnesses.mjs`, TypeScript, build UI e `git diff --check`. I nuovi test `test-project-workflows.mjs` simulano il riavvio completo con una nuova istanza del deposito e nessuna sessione, i filtri con 450 risultati concorrenti, cartelle senza Git e fallimenti di avvio/salvataggio. `test-github-connect.mjs` usa Git reale con remoti temporanei su disco e un `gh` fittizio: primo collegamento, conservazione delle modifiche, contenimento dei symlink, fetch/fast-forward, push esplicito, origin diverso e cronologie divergenti. Nessun account reale o agente AI è stato usato nelle prove. Test di rollback/concorrenza squadra inclusi nella suite.

Limiti: nessuna verifica visiva nel browser e nessun login GitHub reale. Modifiche nel checkout e bundle UI ricostruito; nessun pacchetto desktop, release, installazione o riavvio dell’app eseguito. Il backend aggiornato entra in uso al prossimo avvio con questo checkout. Il salvataggio delle configurazioni vale per gli avvii eseguiti con il nuovo backend: non ricostruisce sessioni già perse.

Riferimenti dei comandi: [GitHub CLI login](https://cli.github.com/manual/gh_auth_login), [GitHub API](https://cli.github.com/manual/gh_api), [checkout-index senza force](https://git-scm.com/docs/git-checkout-index).

### Pacchetto 0.2.44

Build locale universal in `.build/release-target`, separata dall’app in esecuzione. ZIP `release/Visual-Brain-0.2.44-mac-universal.zip`, 124809716 byte, SHA256 `f330176eb8edcb65db58ca2a66d43f2ae16c121c62862160baef14bbfdced81b`.

Superati: TypeScript, suite Operativa completa, updater (77 controlli), servizio terminali e continuità dopo sostituzione runtime, harness/installer, build indicizzatore arm64+x64, build Tauri universal, firma ad-hoc, versione/identità/checksum ZIP e dry-run pubblicazione con verifica della firma del feed. Verificati 54 file del runtime estratto contro il checkout; prove desktop con profilo vuoto, terminale nativo e riavvio su arm64 e x64; installazione pulita degli harness su arm64 senza chiamate ai modelli. I blocchi macOS temporanei durante la preparazione sono stati risolti prima di completare i controlli. Restano i limiti della verifica visiva e del login GitHub reale già indicati; nessuna installazione o riapertura dell’app in uso.


### Pacchetto 0.2.45 — firma stabile

Build locale universal in `.build/release-target`; ZIP `release/Visual-Brain-0.2.45-mac-universal.zip`, 124823269 byte, SHA256 `42638240e6724d8f94ebf587db22dfb1552204e869215a81bfed63423a17ac25`. Nessuna modifica al codice applicativo rispetto alla 0.2.44; cambiano firma, versione e istruzioni per la migrazione.

Superati: TypeScript, suite Operativa completa, updater (77 controlli), launch, servizio terminali e runtime, harness/installer; firma reale su due versioni, rifiuto di firma ad-hoc/identificatore diverso/app modificata; build Tauri universal; dry-run di pubblicazione con controllo dell’identità e firma del feed. Dal pacchetto estratto: avvio con profilo vuoto, terminale nativo e persistenza su arm64 e x64; continuità PTY dopo sostituzione/rimozione del bundle su entrambe le architetture; installer di tutti gli harness e demo senza chiamate ai modelli su arm64. Tutti i 54 file sorgente/UI attesi corrispondono al checkout, istruzioni IT/EN incluse, assenza del materiale privato di firma verificata.

La firma del bundle estratto corrisponde al requisito designato della 0.2.44 corretta localmente: certificato `4D94B2CC913A298E670308D1CC7F48C73322615A` e identificatore `com.jethr.visualbrain`. La migrazione dalla 0.2.44 pubblica richiede di terminare le vecchie sessioni e lasciare uscire il servizio vuoto (chiudere l’app per almeno 10 secondi) oppure riavviare il Mac a lavoro terminato; non c’è rifirma remota dei vecchi processi. Nessuna installazione o riapertura dell’app in uso eseguita per questa release. Nessun test TCC/Gatekeeper su un secondo Mac pulito; nessuna nuova verifica visiva o login GitHub reale.

### Pacchetto 0.2.46 — più squadre, Main Brain, smistamento, terminali semplici

Build locale universal in `.build/release-target`; ZIP `release/Visual-Brain-0.2.46-mac-universal.zip`, 124848200 byte, SHA256 `5d4405fc7c4fd2b966954e4d6f5f875cdb7e1acbea8a6a99f126d104f5e64214`. Firma locale stabile (certificato `4D94B2CC913A298E670308D1CC7F48C73322615A`, identificatore `com.jethr.visualbrain`), non notarizzata.

Superati: TypeScript, suite Operativa completa (102 controlli, incluso `test-squads`), updater (77 controlli), launch, servizio terminali e runtime, harness/installer, firma locale su due versioni; dry-run di pubblicazione con controllo dell’identità e firma del feed. Dal pacchetto estratto: i 54 file sorgente/UI corrispondono al checkout, nessun materiale privato di firma; avvio con profilo vuoto, terminale nativo e persistenza su arm64 e x64. Bacheca, mappa e pannello di avvio controllati visivamente su un’anteprima isolata con agenti simulati (IT/EN, tema chiaro e scuro). Nessuna prova con agenti reali, nessuna installazione o riapertura dell’app in uso, nessun test su un secondo Mac.

### Pacchetto 0.2.47 — memoria di Claude per squadra

Build locale universal in `.build/release-target`; ZIP `release/Visual-Brain-0.2.47-mac-universal.zip`, 124849882 byte, SHA256 `3a4433c3c9afbe50322ef72f7c794acd401aeb5188143cc1e27e30a5242e35fa`. Firma locale stabile (certificato `4D94B2CC913A298E670308D1CC7F48C73322615A`, identificatore `com.jethr.visualbrain`), non notarizzata.

Superati: TypeScript, suite Operativa completa (103 controlli; `test-squads` copre memoria predefinita solo per orchestratore e Main Brain, cartella separata via `autoMemoryDirectory`, memoria spenta, tutta la squadra, valore non valido e modifica rifiutata agli agenti), updater (77 controlli), launch, resume, servizio terminali e runtime, harness/installer; dry-run di pubblicazione con controllo dell’identità e firma del feed. Dal pacchetto estratto: i 54 file sorgente/UI corrispondono al checkout, nessun materiale privato di firma; avvio con profilo vuoto, terminale nativo e persistenza su arm64 e x64; installer degli harness su profilo pulito arm64. Riga «Memoria di Claude» della bacheca controllata visivamente sull’anteprima isolata con agenti simulati. Nessuna prova con agenti Claude reali (la variabile e l’impostazione sono verificate negli argomenti e nell’ambiente di avvio), nessuna installazione o riapertura dell’app in uso, nessun test su un secondo Mac.

### Pacchetto 0.2.48 — Lavoro, impostazioni degli agenti, colonna dei nodi

Build locale universal in `.build/release-target`; ZIP `release/Visual-Brain-0.2.48-mac-universal.zip`, 124840141 byte, SHA256 `3135de923adca7c98aad3a16147dce53b04e80d55430ff128be38d49bd240cf4`. Firma locale stabile (identificatore `com.jethr.visualbrain`), non notarizzata.

Superati: TypeScript, build UI, suite Operativa completa (`test:work`, con il nuovo `test-work-reorder`), `test:harnesses` (con `test-agent-clis`: comandi ufficiali di installazione, aggiornamento, accesso e uscita, lettura dello stato di accesso), `test:team`, `test-ui-chrome`, `test-i18n`; dry-run di pubblicazione con controllo di firma, identità e versione. Nessun controllo visivo dell’app nuova (il browser non raggiunge l’app locale), nessuna prova con agenti reali, nessuna installazione o riapertura dell’app in uso, nessun test su un secondo Mac.
