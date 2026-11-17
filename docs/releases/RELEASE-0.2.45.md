# Visual Brain 0.2.45

- Firma stabile autofirmata, senza certificati Apple, per mantenere la stessa identità dell’app tra gli aggiornamenti. Corregge la causa identificata delle richieste ripetute di accesso alla Scrivania quando cambiano le firme delle versioni. L’app resta non notarizzata; il consenso iniziale alle cartelle resta necessario.
- Controllo di pubblicazione che rifiuta pacchetti privi della firma prevista. Nessuna chiave privata è inclusa nell’app.

**Primo aggiornamento dalla 0.2.44 pubblica o precedente:** termina e chiudi tutte le sessioni agente/terminale prima di aggiornare. Dopo l’installazione, chiudi con ⌘Q, attendi almeno 10 secondi e riapri da Applicazioni, oppure riavvia il Mac dopo aver salvato e terminato il lavoro. Questo permette al servizio terminali precedente di uscire e al nuovo di partire con la nuova identità. macOS può chiedere un nuovo consenso una volta. I terminali vecchi lasciati attivi possono mantenere il conflitto; l’aggiornamento non li interrompe automaticamente.

La continuità della firma è verificata su due versioni e la correzione dei permessi è stata verificata sul Mac di sviluppo. Non è stato eseguito un test TCC su un secondo Mac pulito.
