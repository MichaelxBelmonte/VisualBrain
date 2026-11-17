# Visual Brain 0.2.30

- Nuova impostazione della squadra, spenta all’inizio: **Ogni operatore lavora in un worktree Git separato** (··· → Attività e impostazioni → Impostazioni). Ogni nuovo operatore o revisore riceve una copia di lavoro e un ramo propri (`visual-brain/n<nodo>-op1`…), così due agenti non modificano mai gli stessi file su disco. L’operatore fa commit sul suo ramo; l’orchestratore lo integra dopo averlo verificato. Il ramo compare accanto alla sessione.
- Le copie stanno nel profilo dell’app, non nella cartella del progetto. Chiudendo la sessione la copia viene eliminata solo se non contiene modifiche non salvate; il ramo resta sempre. Fuori da Git, o in un repository senza commit, gli operatori lavorano nella cartella del progetto come prima.
