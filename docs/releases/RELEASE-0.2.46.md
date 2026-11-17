# Visual Brain 0.2.46

- **Più squadre nello stesso nodo.** Puoi avviare squadre indipendenti nello stesso nodo, ognuna con orchestratore, operatori, bacheca e colore propri (Alfa, Beta… o un nome scelto da te). Gli operatori parlano solo con la propria squadra. Se un’altra squadra è già al lavoro in un repository Git, la nuova lavora in un worktree e un ramo propri, così le squadre non modificano gli stessi file.
- **Main Brain.** Un coordinatore per nodo: segue obiettivi e avanzamento delle squadre, parla con i loro orchestratori e propone nuove squadre. Le proposte partono solo quando le avvii tu, dal pannello già compilato.
- **Smistamento.** Con la consegna «Manuale» l’orchestratore vede solo che un operatore ha consegnato; il contenuto arriva prima nella bacheca, dove lo classifichi (risultato, bloccato, domanda, nota), aggiungi una nota e decidi cosa inoltrare. La classificazione è locale, senza chiamate ai modelli.
- **Bacheca.** Nuova voce accanto a Panoramica e Terminali: una scheda per il Main Brain e una per ogni squadra, con smistamento, incarichi in colonne e messaggi. Sostituisce «Attività e impostazioni». Nella Panoramica le squadre sono fasce colorate dentro la scheda del nodo.
- **Terminali semplici.** «Terminale» nella barra (⌘⇧J) o l’icona sul nodo aprono una shell nella cartella del nodo con un clic; senza nodo selezionato si apre un terminale libero nella cartella home.

Le sessioni già attive al momento dell’aggiornamento restano nella prima squadra del nodo e continuano a funzionare; le istruzioni su Main Brain e smistamento le ricevono gli agenti avviati con questa versione. Chi aggiorna dalla 0.2.44 o precedente segua le istruzioni della 0.2.45 (terminare le sessioni, chiudere l’app con ⌘Q e attendere 10 secondi prima di riaprirla).
