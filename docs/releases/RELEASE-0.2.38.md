# Visual Brain 0.2.38

- L'indicizzazione non mostra più un riquadro in basso: mentre lavora compare solo un pallino nell'angolo in basso a sinistra, con i dettagli al passaggio del mouse (rosso se qualcosa va storto).
- Molte meno indicizzazioni mentre gli agenti lavorano. Un file modificato si aggiorna subito, in meno di un secondo. File nuovi, cancellati o spostati richiedono invece una passata completa, circa un minuto su un Desktop grande: ora vengono raccolti e indicizzati insieme, al massimo una volta ogni 3 minuti, invece che a ogni file.
- Le cartelle `.worktrees` non vengono più indicizzate: sono copie temporanee di repository già presenti nella mappa, e ogni nuova copia costava decine di migliaia di file.
