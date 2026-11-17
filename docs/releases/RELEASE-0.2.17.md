# Visual Brain 0.2.17

- I terminali avviati dalla 0.2.17 restano attivi anche quando chiudi, riapri o aggiorni Visual Brain. Alla riapertura ritrovi gli stessi processi, sessioni e incarichi della squadra.
- Il servizio terminali ha un runtime indipendente dal bundle dell’app: la sostituzione della vecchia versione non interrompe gli agenti. Conserva gli ultimi 200.000 caratteri di output per sessione.
- Gli avvisi di aggiornamento distinguono il motore in uso: promettono la persistenza solo quando è effettivamente disponibile.

**Primo passaggio dalla 0.2.16 o precedente:** le sessioni già aperte sul vecchio motore non possono essere trasferite. Completa quel lavoro prima di chiudere la vecchia app; la persistenza si applica alle sessioni avviate con la 0.2.17.

Mentre l’app è chiusa gli agenti continuano a lavorare, ma le API del grafo e della squadra tornano disponibili alla riapertura. Riavvio del Mac e logout terminano le sessioni. «Termina sessione» continua a chiudere il processo selezionato.

Mac universal, macOS 13.5 o successivo. Firma ad hoc, senza notarizzazione Apple.
