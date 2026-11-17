# Harness sui nodi

Dal pannello di un nodo apri **Harness del nodo**. Le esecuzioni compaiono nei terminali di Operativa con il proprio nome. Sono strumenti dedicati: non ricevono un ruolo di squadra e non vengono avviati dagli orchestratori. I task del pannello e quelli di Attività appartengono alla stessa bacheca, salvata in `dataDir/teams/`.

## DeepSeek Harness

Fonte: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), pacchetto `@deepseek-ai/dsh` **0.2.1-rc.5**. È una developer preview. Chi ha una versione precedente la vede nel pannello («Installata: … · disponibile: …») e la aggiorna con **Aggiorna**; intanto quella installata continua a funzionare.

**Configura DeepSeek** apre `dsh web --host 127.0.0.1 --port 0`, con una porta libera. L'interfaccia permette di configurare provider/modelli; l'esecuzione usa il profilo `headless` della configurazione DSH dell'utente (`DSH_HOME` o `~/.dsh`). Verificare che il profilo abbia un modello e le credenziali necessari.

**Esegui task** avvia `dsh headless -- <contesto e richiesta>` nella directory del nodo/progetto. È un'esecuzione singola, terminata la risposta si chiude il processo. Non simula una TUI né passa flag `--model` o `--effort` che il comando headless non espone. Il task originale in bacheca non viene segnato automaticamente completato: il risultato resta da verificare.

Su un brain remoto, l'interfaccia DSH è sul loopback della macchina server: occorre inoltrare anche la porta stampata da DSH.

## Harness² CLI community

Fonte: [3ae3ae/harness2-cli](https://github.com/3ae3ae/harness2-cli), commit `0c811344a4edfe34960b2fc8f286369d7e81fb27`. È un fork indipendente, non mantenuto da Google.

Richiede un repository Git con almeno un commit. **Prepara task** inizializza `.harness2/` solo quando manca, importa un incarico con ID unico e lancia il dry-run. Conserva configurazioni e task esistenti, anche un percorso task personalizzato. Il task contiene il percorso relativo al repository e la richiesta: indica di lavorare esclusivamente nel checkout di esecuzione. Il contesto completo originale è salvato separatamente in `dataDir/harness-runs/`.

Il dry-run non invia chiamate ai modelli, ma il CLI può richiedere un login valido anche per calcolare l'anteprima. In questo caso il task resta importato e il terminale rimane aperto per `harness2 doctor`, login e configurazione.

**Ottimizza harness** esegue il run con `--only-tasks <id>` e un limite esplicito `--max-calls` (20 proposto, da 1 a 200). Consuma quota o API del provider configurato. Le prove usano copie Git dell'ultimo commit: le modifiche non committate non sono incluse. Il risultato è una proposta di harness da rivedere con `harness2 diff` e applicare con `harness2 apply`; Visual Brain non applica automaticamente il risultato. Il terminale resta disponibile con il CLI nel PATH.

## Harness² ufficiale

Fonte: [google-research/harness2](https://github.com/google-research/harness2), commit `1cfe254e8d25b15f37048c3730134686abe60335`.

**Apri laboratorio** esegue la demo deterministica ufficiale (`harness2-demo --k 1`, senza modelli) e lascia un terminale con gli eseguibili ufficiali nel PATH. Il contesto del nodo è esportato nel file indicato da `VB_NODE_CONTEXT`. La demo usa i task fittizi upstream, non esegue il task del nodo.

I benchmark reali JobBench, LAB e WorkBuddy richiedono dataset, setup e credenziali Vertex AI descritti dal progetto upstream; non vengono installati o avviati automaticamente. L'upstream raccomanda Linux per quei benchmark. Il pacchetto Python e la demo locale sono verificati anche sul Mac.

## Installazione e riproducibilità

Nel pacchetto Mac 0.2.13 scegli lo strumento in **Harness del nodo → Installa**. L'app include Node, npm e uv per Intel e Apple Silicon: non serve installarli a parte. Scarica i pacchetti nel profilo personale, mostra l'avanzamento e permette di riprovare dopo un errore. Puoi chiudere il pannello durante il download; l'app deve restare aperta. L'installazione non avvia modelli e non configura account condivisi: ogni utente collega il proprio provider.

L'installer usa Python 3.12.15 gestito e isolato per ciascuno dei due Harness², che esportano entrambi il comando `harness2`; non condividono un ambiente. Il CLI community richiede comunque un repository Git con almeno un commit per i task reali. L'installazione dall'app è disponibile su macOS; un server remoto deve predisporre gli stessi eseguibili nella propria directory dati.

Per lo sviluppo, prepara prima il runtime completo:

```sh
npm run prepare:runtime -- --arch=universal
node scripts/install-harnesses.mjs
# Profilo desktop o altro server:
node scripts/install-harnesses.mjs --data-dir="/percorso/dati/Visual Brain"
```

Il percorso di base è `dataDir/harnesses` (oppure `VISUAL_BRAIN_HARNESSES_DIR`):

| Strumento | Eseguibile relativo |
|---|---|
| DeepSeek | `dsh/node_modules/.bin/dsh` |
| Harness² CLI community | `cli-venv/bin/harness2` |
| Harness² ufficiale | `google-venv/bin/harness2` |

L'installer fissa versione npm e commit upstream; verifica SHA256 degli archivi Harness² e del bootstrap uv 0.13.3. Conserva stato e errori in `install-state/`, rileva le installazioni interrotte e non reinstalla strumenti già pronti. L'app controlla gli eseguibili senza rete. I pacchetti opzionali vengono scaricati su richiesta; il bundle include solo gli strumenti necessari a installarli, con le rispettive licenze in `HARNESS-INSTALLER-NOTICES.txt`.

Verifica senza modelli: `npm run test:harnesses`. Copre persistenza task/API, effort Claude, validazione, trasporto letterale dei prompt, installazioni concorrenti, errori, ripresa e checksum. `node scripts/test-harness-clean.mjs` prova i download reali via API con un profilo vuoto e PATH senza strumenti di sviluppo: avvia DSH e le due demo deterministiche. Un esito locale non certifica login, quota o disponibilità del provider.
