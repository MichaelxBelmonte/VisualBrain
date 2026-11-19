# Terminali persistenti durante gli aggiornamenti

Il server HTTP non possiede più gli pseudo-terminali. `terminal-host.ts` li ospita in un processo separato, mentre `terminal-service.ts` fornisce al server lo stesso accesso a sessioni, input, output e metadati. L’app continua ad arrestare il proprio server alla chiusura; il server conferma le modifiche pendenti e si scollega dal servizio terminali.

Alla riapertura, il nuovo server si collega al servizio esistente. PID dei processi, ID delle sessioni, ruoli, nomi, token della squadra, cursori dei messaggi e stato di attività rimangono gli stessi. Il replay conserva gli ultimi 200.000 caratteri di output per sessione. Un programma a schermo intero (la vista fullscreen di Claude Code, un editor) è entrato nello schermo alternativo molto prima di quei caratteri: se il suo tracciamento del mouse è ancora attivo, il server fa precedere il replay dal passaggio allo schermo alternativo e, alla prima dimensione inviata dal pannello, riduce il terminale di una riga e lo riporta alla misura reale, così il programma ridisegna tutto invece di lasciare i suoi fotogrammi nella cronologia. La chiusura esplicita di una sessione continua a terminarne il processo.

## Aggiornamento e prima attivazione

1. L’updater installa il nuovo bundle conservando la copia ancora in uso, come prima.
2. Con un backend che espone `persistentTerminals: true`, si può chiudere e riaprire l’app: i terminali rimangono nel servizio e vengono riagganciati dal nuovo backend.
3. Il servizio terminali viene riutilizzato mentre ci sono sessioni attive. Quando non ha più sessioni vive né un server collegato, termina dopo cinque secondi; un successivo avvio può caricare il nuovo runtime del servizio.

La capability è pubblicata da `/api/health` e `/api/update` e descrive **il backend attualmente in esecuzione**, non il bundle appena installato. Una UI nuova collegata a un backend precedente non deve promettere la persistenza.

Le sessioni già avviate dalle versioni precedenti appartengono al vecchio processo e non possono essere trasferite salvandone i PID. La prima attivazione richiede di lasciare il vecchio motore aperto finché quelle sessioni hanno finito. Nessuno script di migrazione, installazione o riavvio automatico è incluso in questa modifica.

## Runtime e protocollo

- Il servizio copia esclusivamente Node, l’addon `node-pty`, i suoi helper nativi e i quattro moduli necessari in `<profilo>/terminal-service/runtime-<hash>`. Il percorso resta valido anche quando il bundle sorgente viene spostato o rimosso. Non viene copiata la configurazione del progetto.
- Il servizio usa TCP su loopback con protocollo JSON a righe, autenticazione con segreto casuale e versione esplicita. Il record `host.json` è accessibile solo all’utente (`0600`) nella directory privata (`0700`). Il segreto non passa negli argomenti dei processi.
- Un solo backend può collegarsi al servizio di un profilo. Un lock protegge l’avvio concorrente; un host vivo ma non raggiungibile o incompatibile non viene sostituito e non riceve segnali di arresto.
- Le risposte positive delle API terminali/squadra aspettano la conferma del servizio. Il testo dell’avviso e il suo Invio raggiungono la PTY nella stessa scrittura. Il cursore conservato dal servizio evita di ripetere l’avviso al riaggancio. Se il CLI ha una bozza, un turno in corso o una richiesta di permesso, il messaggio resta in bacheca.
- Gli avvii di sessioni e squadre sono serializzati per contesto, così l’attesa del servizio non permette a richieste contemporanee di superare i limiti o creare due orchestratori.
- Il launcher conserva la porta HTTP registrata dal servizio. Se è occupata, segnala il problema invece di spostare l’API su un’altra porta: gli agenti attivi hanno già l’URL nel loro ambiente e contesto.

## Limiti operativi

Durante la chiusura dell’app il servizio continua a leggere i terminali, ma le API del grafo e della squadra non sono disponibili. Gli agenti devono ritentare le richieste dopo la riapertura; le istruzioni delle nuove sessioni lo indicano. Non vengono riprodotte automaticamente richieste HTTP non confermate.

Questa persistenza copre chiusura, aggiornamento e crash del processo app/server. Con il Mac in stop i processi restano sospesi e riprendono al risveglio. Il riavvio del computer, il logout o l’arresto forzato del servizio terminali chiudono invece i processi: per questi casi c’è il registro delle sessioni descritto sotto. Il servizio ignora i segnali ordinari di chiusura mentre possiede sessioni vive; i terminali si chiudono dall’interfaccia tramite le API esistenti.

## Dopo un riavvio del computer

`session-registry.ts` avvolge il servizio terminali e scrive in `<profilo>/sessions.json` (permessi `0600`) le ultime 64 sessioni Claude, Codex e shell: id, cartella, nome, nodo, ruolo, modello, ragionamento, incarico, ramo, id della conversazione, token della squadra e cursore della bacheca. Lo stato del momento (attenzione, attività) non viene scritto. Il file si aggiorna quando una sessione si apre, si chiude, termina o cambia nome, e ogni cinque secondi solo se qualcosa è cambiato.

All’avvio, le sessioni del registro che il servizio non conosce (cioè dopo un riavvio, quando il servizio è nuovo) tornano nella lista come **concluse**, con lo stesso id, codice, nome, ruolo, nodo e squadra. «Riprendi» le riavvia come una qualsiasi sessione conclusa: Claude con `--resume`, Codex dai suoi registri, la shell nella sua cartella. La chiusura esplicita di una sessione ricordata la toglie dal registro. Se il servizio è sopravvissuto (solo l’app è stata chiusa), il registro non aggiunge copie. Prova: `node scripts/test-session-registry.mjs`.

Un cambio incompatibile del protocollo richiede una migrazione esplicita: il client rifiuta di collegarsi con una versione diversa senza interrompere le sessioni. I runtime privati delle versioni precedenti possono rimanere nella directory del profilo; non sono ulteriori applicazioni registrate nel Dock.

## Verifiche

Tutte le prove usano profili temporanei, processi fittizi e porte locali; non usano i terminali dell’app aperta.

```sh
node scripts/test-terminal-service.mjs
node scripts/test-terminal-runtime.mjs
node scripts/test-squad.mjs
node scripts/test-node-tasks-harnesses.mjs
node scripts/test-launch.mjs
node scripts/test-work-state.mjs
node scripts/test-team-watch.mjs
node scripts/test-work-rename-link.mjs
node scripts/test-work-channel.mjs
node scripts/test-update.mjs
npx tsc --noEmit
cargo test --offline --manifest-path app/src-tauri/Cargo.toml --target-dir /private/tmp/vb-terminal-rust-tests
```

Le prove di integrazione verificano: stesso PID dopo disconnessione, SIGTERM e SIGKILL del backend; input/output e resize; autenticazione e incarichi della squadra; metadati e cursori; notifica completata dopo detach; rifiuto di seconda connessione e porta diversa; rimozione del bundle sorgente seguita da avvio di un nuovo PTY; output ed exit durante la disconnessione; buffer limitato; chiusura esplicita e arresto del servizio vuoto. I test Rust verificano anche il mantenimento della porta nel launcher.

## Consegna iniziale del 21 ottobre 2026

Implementazione dell’incarico `d36d6ac6` presente nel checkout, senza commit, packaging o pubblicazione da questa sessione. Tutte le prove elencate sopra sono passate; updater: 74 controlli, launcher Rust: 11 test. Passata anche `node scripts/test-index-responsive.mjs --no-compare`: ciclo pesante 5371 ms, peggior latenza health 9 ms, massimo intervallo terminale 33 ms, 283/283 scritture accettate e conservate. `test-squad` include avvii remoti concorrenti e rollback senza toccare sessioni preesistenti.

La UI e la release appartengono a un incarico separato. Il campo `persistentTerminals` è pronto per distinguere i messaggi sul riavvio; nessuna verifica visiva del nuovo flusso è stata eseguita. La modifica di `scripts/test-index-responsive.mjs` chiude esplicitamente il solo terminale fittizio prima di arrestare il backend, perché l’arresto del server ora lo conserva.

Durante la verifica finale l’app reale è risultata riavviata, con un nuovo `instance` e nessuna sessione nella bacheca. Token e identità `05aea36c` non erano più disponibili nel terminale di lavoro: non è stato possibile segnare concluso/idle via API senza impersonare un’altra identità. Questo documento conserva l’esito per il successivo coordinamento. Nessun processo dell’app reale è stato arrestato da questa implementazione o dai suoi test.

## Preparazione della release 0.2.17

Su richiesta diretta dell’utente, dopo aver verificato la pubblicazione della 0.2.16, la funzionalità entra nella 0.2.17. La UI usa la capability del backend per gli avvisi IT/EN; un bundle nuovo scaricato da un backend precedente non promette la persistenza. Le istruzioni di installazione e le note di release spiegano il primo passaggio dalle versioni precedenti.

Verifiche sul checkout finale: typecheck, suite `test:work`, launcher agenti, harness, squadra e concorrenza; updater **77 controlli**, launcher Rust **11 test**, controlli whitespace. Pacchetto universal compilato in `.build/release-target` senza toccare il bundle in esecuzione. Sullo ZIP estratto in `.build/verify-0.2.17`: firma, checksum e corrispondenza dei sorgenti server/shared/UI con il checkout; test terminal-service, terminal-runtime e desktop su **arm64 e x64**, inclusi crash del backend, rimozione del bundle sorgente, stesso PID e nuovi PTY. Passata l’installazione reale degli harness in un profilo arm64 vuoto, senza chiamate ai modelli.

Il test del runtime Intel copiato richiedeva più dei precedenti 10 secondi durante la preparazione Rosetta su Apple Silicon: il limite della fixture è ora 60 secondi; il test desktop usa i 90 secondi già previsti dal launcher e rileva anche l’uscita per segnale. I test sono passati con il pacchetto invariato. Nessuna verifica visiva tramite browser o installazione dell’app reale è stata eseguita.

ZIP: `release/Visual-Brain-0.2.17-mac-universal.zip`, 123040552 byte, SHA256 `e9556b5c09f0ec9f56942124ce202c1b6f2432b7c5203912579612c1db94c09f`. Preflight di pubblicazione e firma del feed passati. La vecchia identità della bacheca continua a rispondere HTTP 403; nessuna identità altrui è stata usata.
