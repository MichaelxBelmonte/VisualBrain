# Specifica dell'estrattore (`src/server/extract.ts`)

Modulo puro: riceve il contenuto di UN file e restituisce riferimenti, identificatori e termini.
Nessun accesso al disco o al database. La risoluzione dei riferimenti verso i nodi la fa `graph.ts`.

## Vincoli tecnici
- Node 24 con type stripping: ESM, `import type`, niente `enum`, niente `namespace`, niente proprietà-parametro nei costruttori; import relativi con estensione `.ts`.
- Nessuna dipendenza esterna. Solo regex e funzioni pure.
- Velocità: deve reggere ~10.000 file di testo in pochi secondi (regex per riga, niente backtracking catastrofico, cap sul numero di risultati per file: 500 refs, 200 identifiers).
- L'interfaccia esportata (ExtractInput, RawRef, ExtractResult, extract) resta com'è.

## Cosa deve riconoscere

### 1. Import (kind `imports`, relativeTo `file` o `root`)
- JS/TS/Apps Script: `import x from './a'`, `import './a'`, `export * from './a'`, `import('./a')`, `require('./a')`. Specificatori «bare» (`react`, `fs`, `@scope/x`) vanno in `packages`, non in `refs`.
- Python: `from .a import b`, `from pkg.mod import x`, `import pkg.mod`. I moduli relativi/locali → ref con target `pkg/mod` (relativeTo `root`) e, per i relativi, relativeTo `file`. Moduli noti della stdlib o di terze parti (`os`, `pandas`, `openpyxl`, `requests`…) → `packages`.
- Python con tree-sitter: l'intestazione del modulo (fino al primo `def`/`class` al margine) è letta dalla grammatica, quindi valgono anche gli import su più righe (`from . import (\n a,\n b)`) e una docstring che contiene «import» non conta; il resto del file usa le regole per riga sopra.
- Go (tree-sitter): ogni `import_spec`, anche nei blocchi `import ( … )`. Un pacchetto del proprio modulo (`go.mod` più vicino risalendo fino alla radice del progetto) → cartella, relativeTo `absolute`; moduli ospitati altrove (`github.com/u/r/...`) → `packages`; la libreria standard e gli import senza `go.mod` → nulla.
- Java (tree-sitter) e Kotlin (regola per riga): `import a.b.C` → `a/b/C` (root, risolto con `.java`/`.kt` sotto una radice dei sorgenti tra gli antenati del file); `import a.b.*` → cartella `a/b`; `import static a.b.C.m` → `a/b/C`. `java.*`, `javax.*`, `kotlin.*`, `kotlinx.*`, `jdk.*`, `sun.*` ignorati.
- C/C++/Objective-C (tree-sitter, grammatica C): `#include "x.h"` → relativeTo `file` (poi radice del progetto e `src/`); `#include <x.h>` ignorato; un include in un commento non conta.
- Le grammatiche (WebAssembly in `vendor/tree-sitter`) si caricano una volta per thread prima dell'estrazione; se mancano, Python torna alle regole per riga e gli altri linguaggi non producono import, senza errori.
- Rust: `mod a;` → `a` (file); `use crate::a::b` → `a/b` (root, prefisso `src/`).
- Shell: `source x.sh`, `. ./x.sh`, chiamate a `python3 percorso.py`, `node percorso.js`.
- HTML: `<script src>`, `<link href>`, `<img src>`, `<a href>` locali (non http).
- CSS: `@import`, `url(...)` locali.

### 2. Link (kind `links`)
- Markdown: `[testo](percorso)` locali (non http/mailto), `[[nome]]` wiki-link → relativeTo `name`.
- Markdown e testo: percorsi fra backtick come `` `operativo/scripts/cerca_cf.py` `` → `refpath` (relativeTo `root` se non inizia con `/` o `~`).

### 3. Percorsi scritti nei file (kind `refpath`)
In qualunque file di testo (codice, doc, config, json, yaml, sh, plist, log):
- `~/Desktop/...`, `$HOME/Desktop/...`, `/Users/<utente>/Desktop/...` → relativeTo `absolute` (normalizza `~` e `$HOME` a `/Users/<utente>` presente in `input.path`).
- Python `pathlib`: `HOME / "Desktop" / "prove-motore-zip" / "x"`, `Path.home() / "Desktop" / ...`, `os.path.join(home, "Desktop", "x")`, `os.path.expanduser("~/Desktop/x")` → ricomponi il percorso con `/`.
- Rust/JS: stringhe `"Desktop/<Cartella>/..."` → relativeTo `absolute` con prefisso home.
- Percorsi relativi plausibili `a/b/c.ext` (almeno uno slash, estensione nota) → relativeTo `root`.
- Percorsi fuori dalla Scrivania che parlano di questo Mac (`~/.hermes/...`, `~/.claude/...`, `~/Downloads/...`, `/opt/...`, `/usr/local/...`) → `externalRefs`.

### 4. Nomi di file citati (kind `mention`, relativeTo `name`)
Nomi con estensione nota citati nel testo senza percorso (`cerca_cf.py`, `MEMORIA.md`, `brain.db`), max 1 per nome per file. graph.ts li collega solo se il nome è unico nell'indice (o unico nel progetto).

### 5. Identificatori rari (`identifiers`)
- esadecimali di 8–40 caratteri (impronte di ZIP tipo `ff3d7e36`, commit),
- `PR #1234`, `#1234` vicino a «PR» o «issue», chiavi `ABC-123`,
- id Slack (`C0C377RRDV5`, `D0C6DC7H7SL`), timestamp Slack `1791875427.570599`,
- numeri di matricola/partita IVA NON servono.
Scarta parole comuni e numeri puri.

### 6. Termini (`terms`)
Parole di almeno 4 lettere, minuscole, senza stop-word (italiano + inglese + parole chiave dei linguaggi), senza numeri; conteggio per parola; cap a 2.000 parole distinte.

### 7. Complessità
- codice: numero di `def|function|fn|class|impl|=>` + `if|for|while|match|case|try|catch|except` ;
- doc: intestazioni `#` + link + tabelle ;
- config/json/yaml: numero di chiavi di primo livello.

## Prova
`scripts/test-extract.mjs`: importa `../src/server/extract.ts` e lo esegue su 5–6 contenuti di esempio scritti nello script (python con pathlib, markdown con link e backtick, js con import, html, sh, json). Stampa i refs trovati. Deve girare con `node scripts/test-extract.mjs`.
