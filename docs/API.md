# API del server (contratto per la UI e per gli agenti)

Base: `http://127.0.0.1:4747`. Tutte le risposte sono JSON. I tipi sono in `src/shared/types.ts`.

| Metodo | Percorso | Corpo / parametri | Risposta |
|---|---|---|---|
| GET | `/api/status` | – | `StatusPayload` |
| GET | `/api/graph` | `view=projects` (default) o `folders`; `expanded=1,2,3` (id delle cartelle aperte); `kinds=imports,links` (filtro archi, opzionale); `min=0.2` (importanza minima dei file mostrati nelle cartelle con più di 40 voci); `symlinks=1`, `externals=1` (mostra link simbolici e riferimenti esterni di primo livello; default 0 nella vista progetti, 1 in quella cartelle); `extra=12,34` (nodi forzati nella vista) | `GraphPayload` |
| GET | `/api/node/:id` | – | `NodeDetail` |
| GET | `/api/node/:id/children` | `limit`, `offset`, `sort=importance|name|size|mtime` | `{ children: GraphNode[], total }` |
| GET | `/api/search` | `q`, `limit` | `{ results: GraphNode[] }` |
| GET | `/api/path` | `p=<percorso assoluto>` | `GraphNode` o 404 |
| GET | `/api/explore` | `node`, `target`, `query`, `to`, `depth` | vista compatta per gli agenti (vedi sotto) o 404 |
| POST | `/api/edges` | `{ src?, dst?, srcPath?, dstPath?, kind, confidence?, evidence?, origin?, verified? }` | `GraphEdge` |
| PATCH | `/api/edges/:id` | `{ hidden?, confidence?, kind? }` | `GraphEdge` |
| DELETE | `/api/edges/:id` | – | `{ ok: true }` |
| POST | `/api/nodes/:id/notes` | `{ text, kind?, origin? }` | `Note` |
| DELETE | `/api/notes/:id` | – | `{ ok: true }` |
| POST | `/api/index` | `{ paths?: string[] }` (sottoalberi; vuoto = tutto) | `{ started: true }` |
| POST | `/api/analyze` | `{ consent: 'metadata' | 'excerpts', dryRun?: boolean }` | dryRun: `{ payload, bytes, nodes }`; altrimenti `{ runId }` |
| GET | `/api/analyze/runs` | – | `LlmRun[]` |
| POST | `/api/launch` | `{ id, agent: 'claude' | 'codex' | 'hermes' | 'agy' | 'shell', mode: 'embedded' | 'external', model?, effort?, role?: 'orchestrator' | 'operator' | 'reviewer', task?, parentId?, prompt?, cols?, rows? }` | `{ termId, info: TerminalInfo }` oppure `{ opened: true }` |
| GET | `/api/models` | – | suggerimenti locali `{ codex, claude, hermes, agy }`, ciascuno `{ id, label, efforts }[]` |
| GET | `/api/harnesses` | – | catalogo locale `{id, label, installed, canInstall, install}[]`; `install` contiene stato/fase/errore oppure null; nessuna chiamata a modelli |
| POST | `/api/harnesses/install` | `{harness: 'deepseek' \| 'harness2-cli' \| 'harness2-google'}` | `202` e stato dell'installazione; solo UI, download nel profilo personale. Doppio clic riusa il lavoro in corso; strumenti pronti preservati. Nessuna chiamata a modelli |
| POST | `/api/launch-harness` | `{id, harness: 'deepseek' \| 'harness2-cli' \| 'harness2-google', action: 'prepare' \| 'run' \| 'setup', prompt?, maxCalls?: 1..200}` | `{termId, info}`; solo UI, terminale senza ruolo squadra. DeepSeek: run/setup; CLI community: prepare/run; ufficiale: prepare (demo). Vedi [HARNESSES.md](HARNESSES.md) |
| GET | `/api/work/:nodeId` | `session=<termId>` opzionale | `TeamView`: bacheca, sessioni, `peers` collegati, `links`; lettura autenticata incrementale per agenti |
| PATCH | `/api/work/:nodeId` | `{ from?, summary?, autoSpawn?, maxAgents?, worktrees? }` | bacheca; riepilogo aggiornabile dall’orchestratore, policy solo dall’utente |
| POST | `/api/work/:nodeId/messages` | `{ from?, to?: termId | null, text }` | messaggio; destinatari di altri nodi richiedono un canale esplicito |
| POST | `/api/work/:nodeId/tasks` | `{ from?, title, scope?: string[], assignedTo?: termId | null }` | incarico; utente o orchestratore |
| PATCH | `/api/work/:nodeId/tasks/:id` | `{ from?, status?, result?, assignedTo? }` | incarico; rivendicazione esclusiva; riassegnazione solo utente/orchestratore |
| POST | `/api/work/:nodeId/state` | `{ from: termId, state: 'working' | 'idle' | 'blocked' }` | stato; sessione autenticata |
| POST | `/api/work/:nodeId/spawn` | `{ from: termId, agent, model?, effort?, role: 'operator' | 'reviewer', task }` | sessione; orchestratore autenticato, delegazione abilitata e limite squadra |
| GET / POST | `/api/team-links` | POST: `{ srcNodeId, dstNodeId, srcSessionId?: termId | null, dstSessionId?: termId | null }` | canali bidirezionali, separati dagli archi dei file; null collega l’orchestratore del nodo |
| DELETE | `/api/team-links/:id` | – | `{ ok: true }`; rimozione del canale |
| POST | `/api/open` | `{ id, app: 'finder' | 'default' | 'editor' }` | `{ ok: true }` |
| GET | `/api/reminders` | – | `NodeReminder[]`: promemoria personali, aperti prima dei completati |
| POST | `/api/reminders` | `{nodeId, title, status?: 'pending' \| 'working' \| 'done', notes?}` | `NodeReminder`; nodo richiesto, titolo massimo 1000, appunti massimo 10000 caratteri |
| PATCH | `/api/reminders/:id` | `{nodeId?, title?, status?, notes?}` | `NodeReminder`; aggiorna, riassegna, completa o riapre |
| GET | `/api/terminals` | – | `TerminalInfo[]` |
| GET | `/api/terminals/:id/preview` | – | `{ text }` con al massimo sei righe di output recente. Disponibile alla UI sulla stessa origine. La lettura lascia intatti focus, dimensioni e input del terminale. |
| DELETE | `/api/terminals/:id` | – | `{ ok: true }` |
| POST | `/api/terminals/:id/resume` | `{cols?, rows?}` | `{ termId, info }` |
| GET | `/api/git/:nodeId` | – | `{ repo: GitOverview \| null, agents }`: repository del nodo (cartella o file), rami, worktree, ultimi 300 commit; `agents` = ramo → sessione |
| GET | `/api/git/:nodeId/commit/:hash` | – | `GitCommitDetail`: messaggio, genitori, file con righe aggiunte/tolte (max 300; `nodeId` se il file è nella mappa) |
| GET | `/api/git/:nodeId/github?fresh=1` | – | `GithubState`: PR aperte e ultime esecuzioni CI tramite `gh`, cache di 60 s |
| POST | `/api/git/:nodeId/fetch` | `{}` | `{ repo, agents }` dopo `git fetch --all --prune`; 502 se fallisce |
| POST | `/api/git/:nodeId/open` | `{ url }` | `{ ok: true }`; solo pagine del repository su GitHub |
| WS | `/ws/events` | – | `EventMessage` (JSON) |
| WS | `/ws/term?id=<termId>` | client → `{ type: 'input', data }`, `{ type: 'resize', cols, rows }`; server → testo grezzo del terminale | – |

## Semantica del grafo (`/api/graph`)

- **Vista `projects` (default).** I nodi di partenza sono i progetti con un'area (`topLevel` nella risposta): ogni progetto dell'inventario tranne i *contenitori* e i progetti annidati in un progetto della stessa area (questi compaiono aprendo il genitore). Un progetto annidato in un progetto di un'altra area resta un box della propria area (la UI mostra sotto il nome la cartella che lo contiene). Si aggiungono i file e le cartelle sciolte direttamente sotto le radici (file nascosti esclusi), i link simbolici e i riferimenti esterni solo se richiesti, e i nodi in `extra`.
- **Contenitore** = cartella al massimo a due livelli sotto una radice che contiene solo cartelle di progetto (e link): le cartelle di ordinamento della Scrivania (`Lavoro/`, `Lavoro/motori/`…). È trasparente: non compare come box. Si forza con `containers` / `notContainers` in `brain.config.json` (glob su percorsi assoluti).
- **Vista `folders`.** I nodi visibili sono i figli delle radici, i figli di ogni cartella in `expanded` (purché la cartella sia a sua volta visibile) e i nodi esterni di primo livello.
- In entrambe le viste una cartella aperta mostra al massimo 150 figli, ordinati per importanza; con più di 40 voci i file sotto `min` sono nascosti; il resto è un nodo sintetico con `id` negativo (`-<id cartella>`), `kind: 'dir'`, `cls: 'rest'`, `name: '+N altri'`. `min` non si applica ai file direttamente sotto una radice.
- `projects` nella risposta elenca tutti i progetti (`status`, `areaId`, `parentProjectId`, `container`); le aree arrivano in `areas` e non sono nodi.
- Gli archi sono **arrotolati**: ogni arco salvato fra due file viene attribuito ai rispettivi antenati visibili; gli archi interni a un nodo visibile e quelli fra un nodo e un suo antenato non compaiono. `count` è il numero di archi sottostanti, `confidence` la massima, `evidence` un campione (max 3). `id` è presente solo quando sotto c'è un unico arco salvato: selezionarlo o modificarlo (`PATCH`/`DELETE`) agisce su quello. L'`evidence` si manda come oggetto in `POST /api/edges` e torna sempre come array.
- `verified: true` = fatto osservato (import, link, percorso, hash, symlink, inventario verificato); `verified: false` = inferito (similarità testuale, LLM). L'origine è in `origin`.

## Per gli agenti

Un agente lanciato da un nodo riceve nel prompt il percorso, i vicini e questo riferimento. Può arricchire il grafo con:

```bash
curl -s -X POST http://127.0.0.1:4747/api/edges -H 'content-type: application/json' \
  -d '{"srcPath":"/Users/me/Desktop/a.py","dstPath":"/Users/me/Desktop/b.md","kind":"semantic","confidence":0.8,"evidence":{"note":"a.py implementa la regola descritta in b.md"},"origin":"agent:claude","verified":false}'
curl -s -X POST http://127.0.0.1:4747/api/nodes/123/notes -H 'content-type: application/json' -d '{"text":"...", "origin":"agent:codex"}'
```

### Strumento `brain_explore` (0.2.27)

Ogni agente Claude Code o Codex avviato da un nodo, anche fuori da una squadra, ha lo strumento MCP `brain_explore` del server `visual_brain`. È in sola lettura e interroga `/api/explore?node=<nodo della sessione>`:

- senza argomenti: il nodo della sessione con i suoi collegamenti visibili (prima quelli verificati, con la riga o la nota che li prova), i figli e le note;
- `target`: un percorso assoluto, `~/…`, relativo al nodo, oppure l'id di un nodo; `depth: 2` aggiunge i file collegati ai collegamenti;
- `query` da sola: cerca nomi e testo indicizzato;
- `target` e `to`: la catena più corta di collegamenti visibili tra i due file (al massimo 6 passaggi), oppure `null`.

Restituisce percorsi, tipi e prove, mai il contenuto dei file. Il bridge accetta solo l'indirizzo locale ricevuto all'avvio; le sessioni di squadra hanno anche `team_request`.

## Sessioni operative

`agent: 'shell'` supporta solo `mode: 'embedded'` e avvia la shell di login nella directory di lavoro del nodo, senza inviare un prompt. Gli agent continuano a ricevere il contesto del nodo. `nodeId` in `TerminalInfo` associa ogni sessione al suo nodo.

`GET /api/terminals` include le sessioni in esecuzione e quelle terminate finché non vengono eliminate. Collegarsi nuovamente a `/ws/term` riproduce il buffer recente di output. `POST /api/terminals/:id/resume` riavvia una sessione terminata con lo stesso id (quindi stesso codice, nome, ruolo, nodo e token della squadra): Claude riapre la conversazione con `--resume` (l'id viene scelto da Visual Brain all'avvio con `--session-id`), Codex con `codex resume` (la conversazione si trova nei file di `~/.codex/sessions` per cartella e ora di avvio), un terminale normale riparte nella stessa cartella. Risponde 409 per una sessione ancora attiva, per Hermes, Antigravity e gli harness, per una sessione Claude avviata da una versione precedente, oltre il limite della squadra o con un altro orchestratore attivo. Solo dall'interfaccia: con header `Authorization` risponde 403. Le sessioni restano attive passando fra Brain e Operativa o ricaricando la pagina; terminano alla chiusura del server.

Le nuove sessioni agent integrate ricevono il protocollo della squadra e un token per `Authorization: Bearer <token>`, necessario quando `from`/`session` identifica un agente. Il token non appare in `TerminalInfo`. Le richieste della UI sono attribuite a `user`. È un’API locale per processi fidati, non una barriera di sicurezza contro codice che già gira sul Mac. I canali tra nodi si gestiscono dall’utente in Operativa; senza canale i messaggi tra nodi sono rifiutati. Vedi [TEAM.md](TEAM.md) per limiti, persistenza e notifiche ai terminali.

### Git (0.2.33)

Le route `/api/git/*` leggono il repository che contiene il nodo con comandi `git` di sola lettura; l’unica eccezione è `fetch`, che aggiorna solo i rami remoti. Non chiedono mai credenziali (`GIT_TERMINAL_PROMPT=0`, SSH in batch mode): un fetch che ne richiede fallisce. PR e CI arrivano dalla GitHub CLI (`gh`) se installata e collegata; altrimenti `GithubState.state` è `missing` o `signed-out`. Un nodo fuori da un repository risponde `{ repo: null }`. Le POST sono solo dall’interfaccia (403 con `Authorization`); `open` accetta solo l’indirizzo GitHub del repository o pagine sotto di esso.

### Avvio di una squadra

`POST /api/launch-squad` con `{id, prompt?, members:[{agent, model?, effort?}, ...]}` restituisce `{sessions:[...]}`. Il primo membro è l’orchestratore, i successivi sono operatori collegati automaticamente. Da 1 a 8 membri entro il limite del nodo; la UI propone 1 + 3. Un orchestratore già presente produce 409. Tutti i parametri sono validati prima di creare PTY, gli operatori ricevono solo il protocollo in attesa degli incarichi e l’obiettivo arriva all’orchestratore. Errori sincroni di spawn eliminano le sole sessioni appena create. Non modifica `autoSpawn`. Con `policy.worktrees` attivo (solo l’utente può cambiarlo), ogni nuovo operatore o revisore parte in un worktree Git proprio, creato dal commit corrente in `<profilo>/worktrees/<nodo>/<codice>` sul ramo `visual-brain/n<nodo>-<codice>`, e la sessione riporta il ramo in `branch`. Fuori da Git o in un repository senza commit la sessione usa la cartella del progetto. `DELETE /api/terminals/:id` rimuove il worktree solo se Git può farlo senza forzare (nessuna modifica non salvata né file non tracciati); il ramo resta sempre. La rotta è destinata all’avvio esplicito dalla UI, non accetta l’autenticazione agente.


## Desktop setup and language (0.2)

All endpoints require a local Host and a same-origin browser request. Mutations use `Content-Type: application/json`; API clients without an Origin header are supported. Bind address: loopback only. The desktop app selects a free port when 4747 is occupied.

- `GET /api/health`: application identity, profile directory and instance identifier.
- `GET /api/preferences`: selected `roots`, `language` (`it` or `en`), `setupComplete`, home directory and `desktopMode`.
- `GET /api/folders?path=/absolute/path`: immediate visible subfolders for the setup picker; no recursive indexing.
- `PUT /api/preferences` with `{"language":"en","roots":["/Users/me/Documents"]}`: validates readable directories, deduplicates nested roots, persists preferences, resets watchers and starts a local scan. Returns 409 during an existing scan or AI analysis.

Desktop preferences and data live under the per-user Application Support directory. A fresh desktop profile never scans before setup. No LLM runs as part of setup. Changing folders updates the index without modifying the original files.

## Promemoria personali

`/api/reminders` funziona dall’interfaccia Operativa anche senza agenti attivi. Dalla 0.2.16, una sessione agente autenticata può aggiornare soltanto i promemoria del proprio nodo (vedi sotto). I promemoria sono salvati nella tabella SQLite `reminders`, separati dalle bacheche `Teams`, senza destinatari, modelli o notifiche agli agenti. Conservano nome e percorso del nodo anche se il file sparisce dall’indice, così gli appunti restano aggiornabili. Gli incarichi già presenti nelle squadre restano nella rispettiva bacheca; non vengono convertiti automaticamente in promemoria.

## Promemoria del nodo (0.2.16)

In Operativa, Task mostra i promemoria del nodo selezionato nella sidebar: aggiunta rapida, spunta e appunti modificabili. L’associazione al nodo è automatica e i promemoria restano indipendenti dagli incarichi della squadra.

Un agente con una sessione attiva può leggere e aggiornare soltanto i promemoria del proprio nodo. Usa l’header `Authorization: Bearer $VB_TEAM_TOKEN`, `GET /api/reminders?session=<id-sessione>` e `PATCH /api/reminders/<id>` con `{from:"<id-sessione>",status:"done",notes:"Risultato e prossimo passo"}`. Può aggiungerne con `POST /api/reminders` e `{from:"<id-sessione>",title:"Da riprendere",notes:"Contesto"}`: il nodo viene ricavato dalla sessione. Sessioni terminate, token errati e accessi ad altri nodi sono rifiutati. Il controllo include il percorso del nodo per evitare di ereditare i promemoria di un ID riutilizzato.

Per un aggiornamento a fine giornata, l’agente legge la lista e aggiorna stato e appunti delle task su cui ha lavorato. Non è attivata alcuna automazione giornaliera: l’aggiornamento avviene su richiesta dell’utente o all’interno del lavoro già assegnato.

## Cartelle spaziali delle task (0.2.18)

Ogni nodo ha una cartella iniziale “Promemoria”, rinominabile. La prima apertura della vista inizializza questa cartella e vi associa i promemoria esistenti, conservando ID, testi, appunti e date. Le cartelle aggiuntive hanno nome e coordinate persistenti. I collegamenti sono visivi, non orientati e senza duplicati: non aprono canali di comunicazione tra agenti. Si collegano solo cartelle dello stesso nodo.

| Metodo | Percorso | Parametri / corpo | Risposta |
|---|---|---|---|
| GET | `/api/reminder-board` | `nodeId`, `session` per agenti | `{folders,links}`; sola lettura |
| POST | `/api/reminder-board` | `{nodeId,from?}` | inizializza la cartella principale se manca e restituisce la mappa |
| POST | `/api/reminder-folders` | `{nodeId?,name,x?,y?,from?}` | nuova cartella; nodo implicito per agenti autenticati |
| PATCH | `/api/reminder-folders/:id` | `{name?,x?,y?,from?}` | rinomina o sposta una cartella |
| DELETE | `/api/reminder-folders/:id` | `{from?}` per agenti | rimuove la cartella e i suoi collegamenti, spostando le task nella principale; la principale non si elimina |
| POST | `/api/reminder-folder-links` | `{src,dst,from?}` | collegamento fra due cartelle dello stesso nodo; ordine inverso deduplicato |
| DELETE | `/api/reminder-folder-links/:id` | `{from?}` per agenti | rimuove solo il collegamento |

`NodeReminder` include `folderId`. `POST /api/reminders` e `PATCH /api/reminders/:id` accettano `folderId`: la cartella deve appartenere allo stesso nodo e percorso del promemoria. Senza `folderId` si usa la principale, oppure si conserva la cartella esistente. Cambiare nodo da API riassegna alla principale del nuovo nodo.

Per gli agenti valgono sessione attiva, ruolo, `Authorization: Bearer $VB_TEAM_TOKEN` e `from`/`session` della propria sessione: tutte le operazioni restano nel proprio nodo. Gli agenti non ereditano cartelle quando l’ID del nodo viene riutilizzato. La persona può continuare a modificare le liste salvate dopo che il file originale sparisce.

## Agent communication and command sandboxes (0.2.20)

New team sessions launched as Codex or Claude include the local stdio MCP server `visual_brain`. Its `team_request` tool supports `read`, `state`, `message`, `create_task`, `update_task`, `summary`, and `spawn`. Supply the operation fields in `data`, and `taskId` for `update_task`. Identity, authorization and node endpoint come from that session's environment; the tool never acts as `user` or creates team links. Existing HTTP role, node, recipient and policy checks remain authoritative.

This separates team communication from network restrictions on agent shell commands. The app passes MCP configuration only to that launch and does not change global CLI settings. Existing sessions keep their configuration. If an older session's curl fails inside its command sandbox, retry with permission for the specific local API before concluding the app is unavailable. An HTTP 403 is an authentication/authorization failure; it is not a connection refusal. While the app is closed its API remains unavailable, even though terminal processes persist.

Implementation references: [OpenAI MCP configuration](https://developers.openai.com/codex/mcp/), [OpenAI sandbox permissions](https://learn.chatgpt.com/docs/sandboxing), [Claude Code local MCP servers](https://code.claude.com/docs/en/mcp).
