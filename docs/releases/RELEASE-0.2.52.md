# Visual Brain 0.2.52

- **Serve te.** La bacheca mostra inizialmente due righe di richieste. Il pulsante indica quante altre richieste puoi espandere e permette di richiuderle.

- **Stats del Mega Brain.** In Operativa puoi filtrare per periodo, progetto, squadra e sessione. La pagina mostra i turni rilevati dagli hook, le richieste HTTP locali, gli incarichi completati e le sessioni in attesa o bloccate. Accanto ai tempi P50 e P95 trovi il numero di campioni. La copertura indica per quante sessioni sono osservabili i turni. Le misure mancanti compaiono come **N/D**.
- **Disponibilità dei provider.** Per ogni gruppo di quota puoi vedere la fonte, quando è stata osservata, la quota residua e il prossimo ripristino, se comunicato. Codex fornisce i dati tramite `account/rateLimits/read`. Per Claude, `StopFailure` segnala il raggiungimento del limite e la `statusLine` opzionale fornisce le finestre di utilizzo. Per Hermes e Antigravity, senza una segnalazione compare **N/D**.
- **Instradamento per squadra.** Puoi attivarlo da Stats scegliendo i provider ammessi, il margine di riserva e come trattare una quota sconosciuta. Puoi anche raggruppare i provider che condividono una quota. Le decisioni registrate mostrano l’incarico, l’eventuale assegnatario e il motivo della scelta o dell’attesa.
- **Consegne tra agenti.** I prompt iniziali indicano ruolo, obiettivo, interlocutore e prima azione. Gli avvisi in bacheca identificano l’incarico da verificare. Ripetere lo stesso blocco produce un solo avviso, mentre un cambiamento del blocco genera una nuova segnalazione.
