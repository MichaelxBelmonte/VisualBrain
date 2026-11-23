# Visual Brain 0.2.65

- **Barra di Operativa più chiara.** La ricerca è un campo sempre visibile. I quattro pallini senza scritta sono diventati filtri con nome e numero: *Tutti*, *Attivi*, *Per te*, *Chiusi*. «Per te» si colora solo quando qualcosa ti aspetta.
- **Nuovo incarico in una riga.** In cima a «Da fare» scrivi il titolo e premi Invio. `!alta` o `!bassa` danno la priorità, `#etichetta` aggiunge un'etichetta, `@OP1` lo assegna subito.
- **Schede modificabili.** Una scheda aperta si modifica direttamente: titolo, descrizione, priorità, etichette, file e «Assegna a». Si salva quando esci dal campo. Ci sono anche *Duplica* ed *Elimina*. Se un agente ci sta lavorando, riceve la modifica o l'ordine di fermarsi.
- **Trascina le schede.** Tra le colonne e dentro la stessa colonna per cambiare l'ordine; da tastiera con Alt+frecce. Se porti in «In corso» un incarico senza nessuno, la scheda chiede «Chi lo fa?» e lo avvia appena scegli. Portato in «Fatto», nelle Stats conta come completato.
- **In tempo reale.** La bacheca si aggiorna appena una squadra o un promemoria cambia, senza attese. Sulle schede in corso una riga dice cosa sta facendo l'agente, da quanto ci lavora e se sta scrivendo adesso.
- **Per gli agenti.** Gli incarichi accettano i campi facoltativi `description`, `priority` e `labels`; gli agenti che li ignorano continuano a funzionare. Nuove rotte `DELETE /api/work/:nodeId/tasks/:id` e `DELETE /api/reminders/:id`, solo per la persona.
