# Visual Brain 0.2.23

- Ogni agente di squadra ha un codice fisso nel suo nodo: `ORC1` per l’orchestratore, `OP1`, `OP2`… per gli operatori, `REV1`… per i revisori. Il numero non viene mai riusato e resta anche se rinomini la sessione. Il codice compare nella colonna dei nodi, nell’intestazione del terminale, nella Panoramica e nella bacheca.
- Gli agenti conoscono il proprio codice e quelli degli altri, li usano nei messaggi e nel riepilogo e possono indicarli come destinatario o assegnatario. Anche gli avvisi automatici all’orchestratore citano i codici.
- Un codice o un id di sessione dello stesso nodo scritto in un terminale o in un messaggio della bacheca è un collegamento: un clic apre quella sessione. La colonna dei nodi si può filtrare anche per codice.
- Il numero dell’operatore è lo stesso nella colonna e nell’intestazione del terminale. Prima i due elenchi li contavano in ordini diversi.
- Le sessioni già aperte ricevono il codice al primo aggiornamento, in ordine di avvio; i terminali non vanno chiusi.
