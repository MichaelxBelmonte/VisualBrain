# Visual Brain 0.2.33

- Nuova scheda **Git** in Operativa: per il nodo scelto mostra ramo corrente, commit avanti/indietro rispetto al remoto, modifiche non salvate, rami locali e remoti, worktree e il grafo dei commit con merge e tag. Accanto ai rami compare il codice della sessione che ci lavora (per esempio gli operatori con il loro worktree).
- Un clic su un commit ne mostra messaggio, genitori e file modificati; **Mappa** porta il file nel Brain e **Apri su GitHub** apre la pagina del commit.
- **Aggiorna da GitHub** esegue `git fetch` senza toccare i tuoi file né i rami locali e senza chiedere password. Con la GitHub CLI collegata (`gh auth login`) compaiono anche le pull request aperte, con lo stato dei controlli, e le ultime esecuzioni CI.
- La vista è in sola lettura: checkout, merge e push restano nei terminali.
