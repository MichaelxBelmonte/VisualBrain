# Visual Brain 0.2.20

- Corretto il caso in cui Codex dichiara l’API locale irraggiungibile perché la sandbox dei comandi blocca la rete, anche se Visual Brain è aperto e il messaggio del collega è arrivato.
- I nuovi agenti Codex e Claude avviati in squadra ricevono uno strumento locale per leggere la bacheca, scambiarsi messaggi e aggiornare incarichi e stato. Il collegamento usa MCP stdio e l’autenticazione della singola sessione; non richiede di aprire l’API in rete o disattivare la sandbox.
- Il ponte accetta solo le operazioni della propria bacheca. Mantiene i controlli esistenti su ruoli, destinatari e collegamenti; non offre accesso a file, terminali, URL arbitrari o alla creazione dei canali.
- Configurazione limitata alla sessione avviata dall’app, senza modificare le preferenze globali di Codex o Claude. I token del ponte vengono passati nell’ambiente, senza inserirli nel prompt o negli argomenti del processo.
- Istruzioni HTTP di ripiego aggiornate: distinguere un errore della sandbox da un’API realmente spenta e chiedere l’accesso locale mirato prima di dichiarare il servizio irraggiungibile.

Il nuovo strumento è disponibile per gli agenti avviati dopo l’aggiornamento. Le sessioni già aperte mantengono la propria configurazione e i terminali restano attivi. Per sbloccare una vecchia sessione che usa curl, chiedile di riprovare l’API locale con il permesso di rete richiesto dalla sandbox.

Mac universal, macOS 13.5 o successivo, firma ad hoc. Pubblicazione senza installazione automatica. Nessun browser usato per verifiche visive.
