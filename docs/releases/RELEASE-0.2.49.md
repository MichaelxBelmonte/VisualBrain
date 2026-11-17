# Visual Brain 0.2.49

- **Una sola Visual Brain, quella in Applicazioni.** Gli aggiornamenti si installano sempre in Applicazioni: una copia aperta da altrove (cartella di build, Download) non viene toccata e l’app si riapre da Applicazioni dopo ⌘Q. Se apri una copia fuori da Applicazioni, un avviso in alto indica quella giusta.
- **Niente più icone con il divieto.** Le copie di sicurezza degli aggiornamenti e i pacchetti estratti vengono tolti anche da Launch Services prima di essere cancellati, così non restano in Launchpad e Spotlight. I pacchetti di un’installazione interrotta si cancellano da soli dopo 10 minuti.
- **Permesso della Scrivania.** Se macOS non lascia leggere una cartella mappata, un avviso lo dice e **Apri Impostazioni** porta a Privacy e sicurezza › File e cartelle. Appena dai il permesso la mappa si aggiorna da sola. Lo stesso avviso segnala le cartelle mappate che non esistono più.
- **Build locali:** `npm run install:mac` crea il pacchetto, lo installa in `/Applications` e toglie la copia di build.
- **Open source** con licenza MIT: https://github.com/MichaelxBelmonte/VisualBrain
