# Visual Brain 0.2.47

- **Memoria di Claude per squadra.** Claude Code tiene una sola memoria automatica per repository, condivisa da tutte le sessioni: con più operatori in parallelo si riempiva di note doppie. Ora ogni squadra sceglie in **Bacheca → Memoria di Claude**: **Solo orchestratore** (predefinita: orchestratore e Main Brain usano la memoria del progetto, operatori e revisori lavorano senza), **Tutta la squadra** (come prima), **Separata** (l’orchestratore usa una memoria solo della squadra, nel profilo dell’app) o **Spenta**.
- La scelta vale per gli agenti Claude avviati o ripresi da quel momento e si salva con la squadra. Non cambia le impostazioni di Claude Code, i file `CLAUDE.md`, i terminali semplici né Codex.
- Gli agenti delle squadre ricevono l’indicazione di non copiare lo stato della bacheca (incarichi, risultati, messaggi) nella memoria, in `CLAUDE.md` o in `AGENTS.md`.

Con l’impostazione predefinita, gli operatori avviati dopo l’aggiornamento non usano più la memoria automatica del progetto; per tornare al comportamento precedente scegli **Tutta la squadra**. Chi aggiorna dalla 0.2.44 o precedente segua le istruzioni della 0.2.45 (terminare le sessioni, chiudere l’app con ⌘Q e attendere 10 secondi prima di riaprirla).
