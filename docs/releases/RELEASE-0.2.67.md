# Visual Brain 0.2.67

- **Ruolo cambiato mentre l'agente lavora.** Sotto la riga di una sessione Claude Code o Codex, accanto al modello, scegli Orchestratore, Operatore, Revisore o Nessun ruolo, e con più squadre anche la squadra. La sessione riparte con lo stesso id e la stessa conversazione e riceve le istruzioni del nuovo ruolo; il codice cambia (OP1 → REV1), i collegamenti con l'orchestratore si aggiornano e l'orchestratore viene avvisato.
- **Alla fine del turno, o subito.** Se l'agente è a metà turno il cambio aspetta: la riga mostra «→ Revisore · alla fine del turno» con *Subito* (interrompe il turno) e *Annulla*.
- **Claude avviato a mano entra nella squadra.** Un Claude Code o Codex lanciato da un terminale normale del nodo viene riconosciuto (sulla riga compare `claude` o `codex`): con «Aggiungi alla squadra…» diventa operatore, revisore o orchestratore e continua la sua conversazione.
- **Regole chiare.** Un solo orchestratore per squadra, il limite di agenti della squadra, il Main Brain e i terminali fuori dai nodi restano esclusi, con il motivo scritto.
- **Barra laterale senza giallo.** La sessione selezionata torna evidenziata in grigio neutro.
