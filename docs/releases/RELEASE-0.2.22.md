# Visual Brain 0.2.22

- Avvio della squadra con obiettivo più ampio (fino a 4000 caratteri, casella più alta) e file allegati: **Allega file** oppure trascinamento sulla finestra, anche senza testo. Gli agenti ricevono solo i percorsi. Nell’app i file trascinati restano dove sono; quelli scelti col pulsante vengono copiati nel profilo (massimo 50 MB ciascuno, 20 per avvio, rimossi dopo 30 giorni).
- Bacheca più silenziosa: gli avvisi automatici per la stessa situazione (sessioni libere, incarichi non rivendicati, agenti fermi o in attesa) sono al massimo tre, a 5 e poi 10 minuti di distanza. Poi nessun altro finché qualcosa cambia. Prima si ripetevano ogni 5 minuti senza fine, svegliando gli agenti.
- Aprire un nodo dai Terminali (ricerca, + Nodo, Apri in Operativa) mostra i suoi terminali invece di tornare alla Panoramica.
- Panoramica più compatta: schede da 216 px con spazi ridotti, nodi senza agenti su una sola riga. Una scheda spostata a mano che finirebbe oltre il bordo viene ridisposta nella vista. Le posizioni salvate con le schede precedenti vengono azzerate una volta.
- Il motore dei terminali non si collega più a un processo estraneo dopo un riavvio del Mac quando il PID salvato è stato riassegnato.

Typecheck, test della CI e build verificati in locale; Panoramica, ricerca e upload provati su un profilo di prova. Mac universal, macOS 13.5 o successivo, firma ad hoc.
