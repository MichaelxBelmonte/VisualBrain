# Motore di indicizzazione di riferimento (baseline)

Copia dei sorgenti TypeScript del bundle di release del 14/10/2026 15:51 (prima del lavoro su Rust/incrementali),
presa da `app/src-tauri/target/universal-apple-darwin/release/bundle/.../runtime/server/src`.

Unica differenza dal bundle: `server/index.ts` e `server/metrics.ts` contengono la sola strumentazione per fase
(tempi, RSS, blocchi del loop) introdotta per il benchmark; la logica di indicizzazione è identica.

Serve a `scripts/bench-index.mjs --src tests/indexing/baseline-engine/src` per misurare il "prima" sullo stesso
input e configurazione del "dopo". Non è usato dall'app.
