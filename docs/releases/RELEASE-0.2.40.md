# Visual Brain 0.2.40

- Corretto: dopo un aggiornamento o una riapertura dell'app, le sessioni di Claude Code a schermo intero tornavano nello schermo normale, con righe sfasate e fotogrammi finiti nella cronologia. Ora il terminale riprende lo schermo intero e Claude ridisegna tutto una volta.
- Meno memoria: le passate complete dell'indicizzazione usano circa 1 GB in meno, e la ricarica della mappa che segue ogni passata circa 800 MB in meno. Archi e pesi restano identici, e le fasi globali sono anche più veloci (riferimenti e similarità circa la metà del tempo, pesi circa un terzo).
