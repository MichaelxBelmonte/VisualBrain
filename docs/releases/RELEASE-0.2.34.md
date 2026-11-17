# Visual Brain 0.2.34

- Avvio molto più rapido: la finestra e i terminali sono pronti in circa un secondo, la mappa arriva subito dopo invece di bloccare tutto. Su un Desktop di circa 780 mila file il caricamento della mappa scende da 12–18 secondi a 2–3 e la memoria usata da circa 1,9 GB a meno di 1.
- La mappa risponde circa 10 volte più in fretta (da 0,6–1,2 s a 40–100 ms per vista), con gli stessi riquadri e collegamenti.
- Indicizzazione incrementale: quando un file cambia (per esempio mentre un agente lavora), l'aggiornamento richiede circa mezzo secondo invece di 70–120 secondi. Classifica e somiglianze fra i testi si ricalcolano al massimo ogni 10 minuti; il risultato è lo stesso di una scansione completa.
- I terminali non si bloccano più dopo ogni indicizzazione: la mappa si ricarica a piccoli blocchi, mentre prima il server restava fermo per diversi secondi.
- Nella vista a un terminale con le schede, il nome della sessione compare solo nella scheda e non viene più ripetuto nell'intestazione.
