# Visual Brain 0.2.61

- **Ogni sessione mostra l'account.** Accanto al nome delle sessioni di Claude Code e Codex (operatore, orchestratore, agente singolo) c'è l'etichetta dell'account con cui lavorano: nella scheda, nell'intestazione del terminale, nell'elenco delle sessioni e sulla bacheca. Compare quando hai account aggiuntivi o hai dato un nome all'account principale.
- **Nomi degli account modificabili.** In Impostazioni → Agenti la sezione «Account» elenca l'account principale di ogni CLI e quelli aggiuntivi; «Rinomina» cambia il nome mostrato sulle sessioni e nel menu Agente. Accesso, cartella e conversazioni dell'account non cambiano.
- **Stats rifatte.** Richieste e token vengono letti dai registri di Claude Code e Codex (non stimati), con la cache a parte, per sessione, per account e in totale. In alto: chi lavora, chi aspetta te e cosa è bloccato; poi il periodo scelto, la tabella per account, progetti e squadre con le sessioni e gli incarichi. Contano tutte le sessioni, non solo quelle dei nodi collegati. Le misure interne sono in «Dettagli tecnici».
- **Tolto il Mega Brain dalle Stats**: il coordinamento tra progetti non era operativo e confondeva.
