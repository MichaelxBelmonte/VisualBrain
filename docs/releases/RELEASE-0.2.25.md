# Visual Brain 0.2.25

- Trascinare un file o un’immagine su un terminale ora funziona anche quando la sorgente non è il Finder: la miniatura di uno screenshot, un’immagine da Chrome o Safari, un allegato da Slack, Mail o Foto. Prima il terminale si illuminava ma non riceveva niente, perché queste app non passano un percorso ma promettono il file o ne inviano solo i dati. Ora Visual Brain se lo fa consegnare, lo salva in `attachments/dropped` nella cartella dei dati e incolla il percorso nel terminale. Le copie più vecchie di 30 giorni vengono cancellate.
- Con più terminali affiancati su uno schermo Retina il file finisce nel terminale su cui lo rilasci. Prima la posizione veniva dimezzata e il file poteva arrivare in un altro terminale.
- Se un trascinamento non porta nessun file, compare un messaggio invece di non succedere nulla.
