# Visual Brain

[English](README.md) · **Italiano**

Grafo locale dei file della Scrivania: ogni file, cartella e progetto è un nodo; le relazioni (import, link, percorsi scritti nei file, copie, symlink, identificatori condivisi, similarità, inferenze del modello) sono archi con evidenza e confidenza. Da ogni nodo si lancia Claude Code, Codex o Hermes con il contesto del nodo.

Tutto gira in locale: Node 24, SQLite (`node:sqlite`), un canvas 2D e un walker Rust facoltativo. Al provider LLM arrivano solo metadati, salvo consenso esplicito per gli estratti dei README.

## Avvio

```bash
npm install            # una volta (sistema anche il permesso di esecuzione di node-pty)
npm run build:ui       # compila l'interfaccia in dist/ui
node src/cli.ts index  # prima indicizzazione di ~/Desktop; tempi misurati in docs/INDEXING-BENCHMARK.md
node src/cli.ts serve  # http://127.0.0.1:4747
```

`npm run dev` avvia il server con l'interfaccia ricompilata a ogni modifica. `vb` è lo stesso comando (`bin/vb.js`).

Il server tiene d'occhio la Scrivania (`fs.watch`) e reindicizza da solo la cartella toccata; `--no-watch` lo spegne. `vb index --reextract` rilegge i contenuti di tutti i file (serve dopo aver cambiato l'estrattore).

## App installabile · Italiano / English

L'app desktop contiene il runtime: chi la riceve non deve installare Node, npm o Rust. Il pacchetto universal funziona su Mac Apple Silicon e Intel con macOS 13.5 o successivo. Windows non è ancora distribuito.

1. Scarica l'ultimo `Visual-Brain-X.Y.Z-mac-universal.zip` dalle [release](https://github.com/MichaelxBelmonte/VisualBrain-releases/releases/latest), estrailo e trascina l'app in Applicazioni.
2. Al primo avvio scegli lingua e cartelle: nessuna scansione parte prima della scelta.
3. Cambia lingua o cartelle da **Altro → Impostazioni** / **More → Settings**.

L'indice, le preferenze e le bacheche sono personali e separati dall'app in `~/Library/Application Support/Visual Brain/`; i log sono in `logs/server.log`. Il pacchetto non include `brain.config.json`, database, seed, account o dati del computer di sviluppo. L'app usa una porta locale disponibile e non si collega a server estranei sulla 4747. La chiusura dell'app termina i terminali avviati dal suo motore.

Claude Code, Codex e Hermes sono facoltativi: ogni utente li installa e autentica con il proprio account. I nomi dei file, i contenuti, le note e l'output dei terminali restano nella lingua originale.

Le istruzioni per chi riceve l'app sono in [Italiano](docs/INSTALL-IT.txt) e [English](docs/INSTALL-EN.txt). La build interna usa una firma ad hoc; per una distribuzione pubblica senza il passaggio di autorizzazione macOS serve una firma Developer ID con notarizzazione.

Per ricreare il pacchetto su Mac:

```bash
npm install
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run package:mac                   # universal; ZIP e checksum in release/
node scripts/test-desktop.mjs         # runtime incluso, profilo e file di prova
node scripts/test-i18n.mjs
```

Per provare una build locale **usa `npm run install:mac`**: crea il pacchetto, lo installa in `/Applications` (con l'app aperta i terminali restano attivi: ⌘R per la nuova interfaccia) e toglie la copia di build dal disco e da Launch Services. Così sul Mac c'è sempre una sola Visual Brain, quella in Applicazioni; non aprire l'app dalla cartella di build. Se lo fai, un avviso in alto lo segnala.

`app/installa.sh` è un alias del packaging e non sostituisce copie installate. Il processo di build scarica Node dal sito ufficiale, verifica SHA-256 e include solo i sorgenti runtime e le dipendenze necessarie. Per firmare impostare `APPLE_SIGNING_IDENTITY`; per notarizzare impostare anche `VB_NOTARY_PROFILE` con un profilo già configurato in Keychain.

Solo per sviluppo, `VISUAL_BRAIN_DIR` o il vecchio `config.json` con `serverDir` indicano un checkout esterno. La copia distribuita usa altrimenti le proprie risorse incluse. La configurazione utente desktop è `settings.json`; in modalità CLI resta `brain.config.json`.

**Più brain (es. Mac e VM).** Il server si avvia anche senza app: `VISUAL_BRAIN_DATA_DIR=<profilo> node src/cli.ts serve --port N`, con `roots`, `setupComplete: true`, `"llm": {"provider": "none"}` e `"label": "Brain VM"` in `<profilo>/settings.json`; l'etichetta compare nella barra in alto e nel titolo della pagina. Il server accetta solo l'Host `127.0.0.1:N` / `localhost:N`: un tunnel SSH deve usare la stessa porta sui due lati (`ssh -N -L N:127.0.0.1:N host`).

## Comandi

| Comando | Cosa fa |
|---|---|
| `vb index [--root DIR] [--subtree DIR] [--reextract] [--engine ts\|native\|auto]` | scansione incrementale, estrazione, progetti, archi, pesi |
| `vb serve [--port N] [--no-watch] [--watch-ui] [--open] [--index]` | server HTTP + WebSocket |
| `vb stats` | numeri dell'indice e archi per tipo |
| `vb analyze [--consent metadata\|excerpts] [--dry-run]` | analisi semantica con il modello; `--dry-run` stampa esattamente cosa verrebbe inviato |

Prova dell'API senza toccare l'indice vero: `node scripts/smoke-api.mjs` (copia isolata dei sorgenti, fixture inventata, porta propria).

## Indicizzazione: motori e prove

Il motore TypeScript resta disponibile con `--engine ts`. `--engine native` richiede il walker Rust; `--engine auto` lo usa quando disponibile e ripiega su TypeScript in caso di errore. Il walker elenca file e cartelle con parallelismo limitato: estrazione dei riferimenti, risoluzione degli archi e ranking mantengono la logica TypeScript. Non vengono chiamati modelli AI durante l'indicizzazione.

La suite usa indici temporanei, collegamenti attesi e confronti fra i due motori. I dettagli, i comandi per riprodurre le prove e il pacchetto Mac separato sono in [docs/INDEXING.md](docs/INDEXING.md); misure per fase e limiti del confronto in [docs/INDEXING-BENCHMARK.md](docs/INDEXING-BENCHMARK.md).

## Interfaccia

La mappa è una disposizione ordinata, non un grafo a molla: le **aree** (per esempio Motore, Strumenti, Dati e prove…) sono i gruppi grigi, ogni **progetto** è un box con il nome dentro e, sotto, la cartella che lo contiene. I box in tratteggio sono copie e archivi; quelli grigi, dati. Le cartelle di ordinamento della Scrivania (`Lavoro/`, `Lavoro/motori/`…) sono trasparenti: dentro ogni area si vedono i progetti, non i contenitori.

- **Clic** su un box: lo seleziona, evidenzia i suoi collegamenti (gli altri restano in trasparenza) e apre il pannello. **`▸ N`** a destra del nome (o doppio clic): apre la cartella dentro il box, con i file e le sottocartelle in riquadri annidati; **`▾`** la chiude. Doppio clic su un file: lo apre con l'app predefinita.
- **Trascina** un box o il titolo di un'area: resta dove lo lasci. **Riordina** (`R`) rimette tutto al suo posto; **Mostra tutta la mappa** (`F`) riporta ogni elemento nella vista. Scorri per spostarti, `⌘`+scorri o pizzico per lo zoom, `+`/`−`/`0` da tastiera.
- **Cerca** (`⌘K`): trova file, cartelle e progetti; il risultato viene aperto nella mappa (le cartelle che lo contengono si aprono da sole).
- **Collegamenti ▾**: solo dell'elemento scelto (default), tutti, nessuno; con o senza i collegamenti ipotizzati; tipi di collegamento; link simbolici e riferimenti esterni (nascosti di default); soglia d'importanza per i file nelle cartelle con più di 40 voci (il resto finisce nel riquadro «+N altri»).
- **Altro ▾**: aggiorna dai file, trova collegamenti con l'AI (dialogo con la scelta di cosa inviare e l'anteprima), chiudi tutte le cartelle, terminali, tema chiaro o scuro.
- **Pannello**: dati del nodo, poi *Esplora* (apri o chiudi nella mappa, trova nella mappa), *Apri sul Mac* (Finder, app), *Lavora su questo elemento* (Claude Code, Codex, Hermes con una richiesta), descrizione, progetto, collegamenti con la prova di ciascuno (osservati e ipotizzati, nascondibili), contenuto, note.
- Linee piene = fatti osservati nei file; tratteggiate = ipotesi (testi simili, AI); punteggiate = regole (permessi del bot). Le frecce e i conteggi `×N` compaiono sui collegamenti dell'elemento scelto.
- Le posizioni sono stabili: la stessa mappa torna uguale a ogni apertura; aprire una cartella sposta i vicini con una breve animazione.

## Agenti

Dal pannello di un nodo: **Claude Code**, **Codex**, **Hermes**, nella vista **Operativa** (pty vero via node-pty + xterm.js) oppure in Terminal.app. **Apri terminale** avvia una shell normale nella vista Operativa; **Terminale** nella barra (o **⌘⇧J**) ne apre una nel nodo selezionato, o libera se nessun nodo è selezionato. L'agente parte nella cartella del progetto con un primo prompt che contiene percorso, progetto, relazioni principali, contenuto e note del nodo, più l'indirizzo dell'API locale per arricchire il grafo (`docs/API.md`).

Codex nella vista Operativa carica prima la shell interattiva di login, come Terminal.app: usa il PATH e le variabili configurate dall'utente, evitando di selezionare una vecchia installazione dal PATH dell'app.

**Più account.** Claude Code e Codex possono girare con più account contemporaneamente (per esempio due abbonamenti Claude). In **Impostazioni → Agenti**, nella scheda del provider, *+ Aggiungi account* crea una cartella dedicata nel profilo di Visual Brain e apre l'accesso della CLI in un terminale. Ogni account, principale compreso, si può rinominare (*Rinomina*): il nome compare accanto alle sessioni di Claude Code e Codex (scheda, intestazione del terminale, elenco e bacheca), così si vede con quale account sta lavorando ciascuna. Senza account aggiuntivi né nomi l'etichetta non compare. Al lancio, l'account si sceglie dal menu **Agente** («Claude Code · Lavoro»), anche per singoli membri di una squadra. La sessione riceve `CLAUDE_CONFIG_DIR` o `CODEX_HOME`, che puntano a quella cartella; **Riprendi** riapre la conversazione con lo stesso account. Ogni account aggiuntivo ha impostazioni, memoria, plugin e cronologia propri; le credenziali restano alla CLI. In **Avanzate** (sulla riga dell'account) puoi fargli usare la memoria di progetto dell'account principale (solo Claude Code) e le sue skill, plugin, comandi, agenti e istruzioni personali (`CLAUDE.md`, `AGENTS.md`). Sono collegati, non copiati; impostazioni, modello predefinito, permessi e accesso restano separati. *Rimuovi* toglie l'account da Visual Brain ma conserva la sua cartella.

**Aggiornare gli agenti.** Ogni scheda di **Impostazioni → Agenti** mostra la versione installata della CLI e se ne è uscita una più nuova (registro npm per Claude Code e Codex, `hermes update --check` per Hermes; Antigravity non la pubblica). *Aggiorna* lancia il comando ufficiale della CLI (`claude update`, `codex update`, `hermes update --yes`, `agy update`) in background, senza terminale: a fine aggiornamento la scheda mostra la nuova versione e il registro. Le sessioni già aperte restano sulla versione con cui sono partite finché non le riavvii. Lo stesso elenco compare in **Impostazioni → Aggiornamenti**, sotto quello dell'app; se l'aggiornamento non riesce, *Apri nel terminale* lo ripete in vista. Il controllo avviene al massimo ogni 6 ore e non invia dati dell'utente.

**Operativa** mostra i nodi come squadre compatte. Da **Avvia squadra** si lanciano un orchestratore e tre operatori, con CLI, modello ed effort indipendenti e un solo obiettivo facoltativo. Sono già coordinati sullo stesso nodo; le scelte vengono ricordate. Clic sui punti di due nodi o agenti per collegarli, clic su un agente per aprirne il terminale. Incarichi, messaggi e impostazioni sono in **Lavoro**. Un nodo può ospitare più squadre indipendenti, ognuna con la sua bacheca e, se serve, il suo worktree Git; un **Main Brain** per nodo coordina gli orchestratori e propone nuove squadre, che avvii tu; con la consegna **Manuale** i risultati degli operatori arrivano prima nella colonna **Serve te**, dove li classifichi e decidi cosa inoltrare. Ogni squadra sceglie chi usa la memoria automatica di Claude: di default solo orchestratore e Main Brain, così gli operatori in parallelo non la riempiono di duplicati. Il Brain mantiene la navigazione dei file e i rimandi alle sessioni. Dettagli e limiti: [docs/TEAM.md](docs/TEAM.md).

**Lavoro** è la vista predefinita di **Operativa**: una bacheca per nodo in quattro colonne (Da fare, In corso, Serve te, Fatto). Le squadre, il Main Brain e i **Promemoria** del nodo sono filtri della stessa bacheca; in **Serve te** finisce tutto ciò che aspetta te (incarichi bloccati, risultati trattenuti, permessi o domande nei terminali, proposte del Main Brain). I promemoria sono note personali senza agenti, restano nel database dopo il riavvio e sono indipendenti dagli incarichi delle squadre. **Impostazioni** (⚙ o **⌘,**) raccoglie lingua, tema, cartelle mappate, l’installazione e l’accesso delle CLI degli agenti (Claude Code, Codex, Hermes, Antigravity), l’account GitHub, gli aggiornamenti e le scorciatoie. Claude Code offre **Auto, low, medium, high, xhigh, max**, anche con modello Auto o ID personalizzato; gli ID delle versioni precedenti ricevono i livelli compatibili.

**Harness del nodo** installa e apre DeepSeek Harness, Harness² ufficiale di Google Research o Harness² CLI community. Il pacchetto Mac include gli strumenti per installarli nel profilo personale; ogni utente collega il proprio account. Si può scegliere un task dalla bacheca: DeepSeek lo esegue con il contesto del nodo; il CLI community lo importa e prepara/avvia l’ottimizzazione del harness su copie Git. Il framework Google offre un laboratorio con demo locale e comandi benchmark, non un agente chat. Configurazione e limiti: [docs/HARNESSES.md](docs/HARNESSES.md).

Avvia il server da un Terminale normale, non da dentro una sessione di Claude Code: gli agenti lanciati dal pannello ereditano l'ambiente del server, e da dentro Claude Code partirebbero come «sessioni figlie» (trascrizioni spente, avviso `CLAUDE_CODE_CHILD_SESSION`). Il processo si chiude con la × della sessione, con **Chiudi**, oppure con `DELETE /api/terminals/:id`.

## Vista Operativa

**Brain** e **Operativa** nella barra superiore separano l’esplorazione della mappa dal lavoro sui nodi. L’avvio di un agent o terminale integrato apre automaticamente Operativa. Il pulsante **Aggiungi alla vista Operativa** nel pannello aggiunge invece il nodo senza avviare un processo.

- La sidebar è modulare: le maniglie **⠿** riordinano interi gruppi di nodi e le sessioni al loro interno (anche **Alt+↑/↓**). Ogni gruppo si può richiudere; **⌃** li compatta tutti. Il pulsante **≡** alterna righe compatte e comode; trascinando il bordo destro si regola la larghezza (**180–360 px**, adattata alla finestra). Sul bordo, frecce sinistra/destra ridimensionano, Home o doppio clic ripristinano. Ordine, densità, larghezza e gruppi chiusi restano salvati; spostare un nodo non cambia i suoi collegamenti.
- Trascina la maniglia **⠿** dei nodi nella mappa per posizionarli liberamente; **Ripristina disposizione** torna alla disposizione automatica. Nella vista affiancata la stessa maniglia riordina i terminali senza riavviarli. Le frecce spostano l’elemento con la maniglia selezionata; Esc annulla un trascinamento. Posizioni e ordine restano salvati nel browser (l’ordine dei terminali vale per le sessioni ancora esistenti).
- **+ Nodo** (o **⌘K** in Operativa) cerca file, cartelle e progetti da aggiungere. I nodi aggiunti restano salvati nel browser.
- **+ Agent / terminale** sceglie Claude Code, Codex, Hermes o una shell normale; la richiesta iniziale è facoltativa. Puoi avviare più sessioni sullo stesso nodo e su nodi diversi.
- L’elenco laterale raggruppa tutte le sessioni per nodo, con filtro, stato e comando di chiusura. Selezionare un nodo apre la sua scheda; selezionare una sessione apre il suo terminale.
- **Singolo** mostra un terminale con il nodo accanto: percorso, descrizione, file e collegamenti. Le cartelle si esplorano nella scheda; i file si aprono con l’app predefinita. **Nel Brain ↗** riporta il nodo nella mappa.
- **Affiancati** mostra fino a quattro sessioni contemporaneamente. Selezionare un’altra sessione nell’elenco la porta fra quelle visibili. Le altre continuano a lavorare sul server: puoi gestire decine di sessioni senza disegnarle tutte insieme.
- Tornare a **Brain** mantiene processi e output. Ricaricare la pagina ripristina le sessioni presenti sul server, comprese quelle terminate, con l’output recente. **Riconnetti** recupera una connessione interrotta. Chiudere il server termina i processi; le sessioni non sopravvivono al riavvio del server.

## Struttura

```
src/server/   scan.ts (walk incrementale) · classify.ts · extract.ts (riferimenti nei file) · projects.ts
              graph.ts (risoluzione → archi, duplicati, id condivisi, similarità) · seed.ts (inventari verificati)
              rank.ts (PageRank, gradi, importanza) · cache.ts (grafo in memoria, rollup) · api.ts · server.ts
              terminals.ts · launch.ts · llm/provider.ts · llm/analyze.ts
src/ui/       main.ts · layout.ts (disposizione a box) · graph.ts (canvas) · panel.ts · search.ts · terminal.ts · toolbar.ts
src/shared/   types.ts (contratto UI/API)
data/         brain.db (SQLite), seed/ (inventari a mano), context/ (prompt degli agenti)
docs/         API.md · EXTRACT_SPEC.md
```

## Configurazione

`brain.config.json` nella radice del progetto (facoltativo, escluso da git: parti da `brain.config.example.json`) sovrascrive i default di `src/server/config.ts`: `roots`, `port`, `excludePaths`, `vendorNames`, `secretPatterns`, `containers` / `notContainers` (glob di cartelle che raggruppano solo progetti: trasparenti nella mappa; di default si riconoscono da sole), `llm` (`provider`: `claude-cli` | `anthropic-api` | `none`, `model`, `effort`, `consent`), `agents`. Gli `excludePaths` si aggiungono a quelli predefiniti: mettici le cartelle private da non leggere mai (per esempio `"~/Desktop/privato"`).

Mai letti: le cartelle in `excludePaths`, i file `.env*`, chiavi e credenziali (indicizzati solo per nome, classe `secret`). Le cartelle `node_modules`, `target`, `venv`, `.tools`, `.build`… entrano solo come totale (conteggio e byte).

## Contribuire e licenza

Come proporre modifiche: [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilità: [SECURITY.md](SECURITY.md). Note di rilascio: [docs/releases/](docs/releases/). Licenza [MIT](LICENSE).

## Dati di partenza

`data/seed/dependencies.jsonl` (una relazione per riga: `from`, `to`, `kind`, `confidence`, `evidence`, `origin`) e `data/seed/projects.json` (schede dei progetti: nome, descrizione, area, stato, copia di, tecnologie). Vengono importati a ogni indicizzazione come relazioni verificate con origine `import:<file>`.
