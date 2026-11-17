// Prova dell'estrattore (docs/EXTRACT_SPEC.md) su contenuti di esempio scritti qui, tutti sintetici.
// Uso: node scripts/test-extract.mjs — stampa i riferimenti trovati ed esce con errore se un controllo fallisce.
import assert from 'node:assert/strict';
import { extract } from '../src/server/extract.ts';

const HOME = '/Users/someone';
const DESK = `${HOME}/Desktop`;
let checks = 0;

function run(name, file, content, ext, cls, lang, quiet = false) {
  const r = extract({ path: `${DESK}/progetto-a/${file}`, content, ext, cls, lang });
  if (quiet) return r;
  console.log(`\n== ${name} (${file}) · righe ${r.lines} · complessità ${r.complexity}`);
  for (const x of r.refs) console.log(`  ${x.kind.padEnd(8)} ${x.relativeTo.padEnd(8)} ${x.target}   [riga ${x.line}]`);
  for (const x of r.externalRefs) console.log(`  external absolute ${x.target}   [riga ${x.line}]`);
  if (r.packages.length) console.log(`  pacchetti: ${r.packages.join(', ')}`);
  if (r.identifiers.length) console.log(`  identificatori: ${r.identifiers.map((t) => t.token).join(', ')}`);
  return r;
}

const has = (r, kind, target, rel) => r.refs.some((x) => x.kind === kind && x.target === target && (rel === undefined || x.relativeTo === rel));
function ref(r, kind, target, rel) { checks++; assert.ok(has(r, kind, target, rel), `manca ${kind} ${rel ?? ''} ${target}`); }
function noRef(r, pred, msg) { checks++; assert.ok(!r.refs.some(pred), msg); }
function external(r, target) { checks++; assert.ok(r.externalRefs.some((x) => x.target === target), `manca external ${target}`); }
function packages(r, list) { for (const p of list) { checks++; assert.ok(r.packages.includes(p), `manca il pacchetto ${p}`); } }
function ids(r, list) { for (const t of list) { checks++; assert.ok(r.identifiers.some((x) => x.token === t), `manca l'identificatore ${t}`); } }
function noIds(r, list) { for (const t of list) { checks++; assert.ok(!r.identifiers.some((x) => x.token === t), `identificatore di troppo: ${t}`); } }

// --- contenuti di esempio ---------------------------------------------------------------------

const PY = [
  '#!/usr/bin/env python3',
  '"""Esempio sintetico."""',
  'import os, json',
  'import requests',
  'from pathlib import Path',
  'from .helpers import load_rows, Parser',
  'from ..common.io import write_csv',
  'from studio import onepassword_credentials',
  'import progetto_a.core.engine as eng',
  '',
  'HOME = Path.home()',
  'BENCH = HOME / "Desktop" / "progetto-a" / "1-zip"',
  'OUT = os.path.join(os.path.expanduser("~"), "Desktop", "progetto-b", "out")',
  'CFG = os.path.expanduser("~/Desktop/progetto-c/config.yaml")',
  'HERMES = Path("~/.hermes/config.yaml").expanduser()',
  'data = open("dati/input_righe.csv")  # legge dati/input_righe.csv',
  'subprocess.run("python3 scripts/prepara_zip.py --zip x", shell=True)',
  'cfg = load(settings.json)',
  'nome = "esito.csv"',
  '# vedi README.md e note_tecniche.md',
  'def main():',
  '    if BENCH.exists():',
  '        for f in BENCH.iterdir():',
  '            print(f)',
].join('\n');

const MD = [
  '# Titolo',
  '',
  'Vedi [la guida](docs/guida.md) e [il sito](https://example.com/x/y.md).',
  'Il bot usa `operativo/scripts/cerca_dati.py` e `~/Desktop/progetto-a/LEGGIMI.md`.',
  'Collegato: [[decisioni-progetto]] e ![schema](./img/schema.png).',
  'Percorso: /Users/someone/Desktop/progetto-b/run.sh:12',
  'Ticket PR #42, commit 9791d04ab, canale C0123ABC45, messaggio 1791875427.570599.',
  'Link a https://acme.slack.com/archives/C0123ABC45/p1791875427570599 e /pull/7.',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  'Node.js e console.log non sono file; MEMORIA.md sì, e di nuovo MEMORIA.md.',
  '```sh',
  'python3 tools/esegui.py',
  '```',
].join('\n');

const JS = [
  "import fs from 'node:fs';",
  "import { join } from 'path';",
  "import React from 'react';",
  "import { x } from '@scope/pkg/sub';",
  "import type { Db } from './db.ts';",
  "export * from '../shared/types.ts';",
  "import './side-effect.js';",
  "import { y } from '@/components/y';",
  "const m = await import('./lazy.ts');",
  "const cfg = require('../config.json');",
  "const p = join(os.homedir(), 'Desktop', 'progetto-a', 'dati');",
  '// vedi https://github.com/acme/repo/pull/77 e ~/Desktop/progetto-b/note.md',
  'const f = (a) => a + 1;',
].join('\n');

const HTML = [
  '<!doctype html>',
  '<link rel="stylesheet" href="style.css">',
  '<script type="module" src="./main.js"></script>',
  '<img src="img/logo.png" alt="">',
  '<a href="https://example.com">x</a> <a href="pagina2.html#sez">y</a> <a href="#top">su</a>',
  '<div style="background: url(\'img/bg.jpg\')"></div>',
].join('\n');

const SH = [
  '#!/bin/bash',
  'set -e',
  'DIR="$(cd "$(dirname "$0")" && pwd)"',
  'source "$DIR/lib/common.sh"',
  '. ./env-sintetico.sh',
  'python3 "$HOME/Desktop/progetto-a/tools/run.py" --fast',
  'node scripts/build.mjs',
  'cp ~/Downloads/esempio.zip /tmp/lavoro/',
].join('\n');

const JSON_TXT = [
  '{',
  '  "name": "esempio",',
  '  "scripts": { "build": "node scripts/build-ui.mjs" },',
  '  "cwd": "~/Desktop/progetto-b",',
  '  "token": "xoxb-0000-0000-fake",',
  '  "owner": "AAAAAA00A00A000A"',
  '}',
].join('\n');

const RS = [
  'mod jobs;',
  'pub mod settings;',
  'use crate::jobs::run_job;',
  'use crate::db::{self, Pool, query};',
  'use serde::{Deserialize, Serialize};',
  'use std::path::PathBuf;',
  'extern crate libc;',
  'let p = home.join("Desktop").join("progetto-a");',
  'fn main() { if true { match x { _ => {} } } }',
].join('\n');

const CSS = [
  '@import "base.css";',
  '@import url("theme/dark.css");',
  '.logo { background: url(../img/logo.svg); }',
  '.font { src: url(data:font/woff2;base64,AAAA); }',
].join('\n');

// --- 1. import --------------------------------------------------------------------------------

const py = run('python con pathlib', 'tools/prepara.py', PY, 'py', 'code', 'python');
packages(py, ['os', 'json', 'requests', 'pathlib']);
ref(py, 'imports', './helpers', 'file');
ref(py, 'imports', './helpers/load_rows', 'file');
noRef(py, (x) => x.target.endsWith('/Parser'), 'Parser è una classe, non un modulo');
ref(py, 'imports', '../common/io', 'file');
ref(py, 'imports', 'studio', 'root');
ref(py, 'imports', 'studio/onepassword_credentials', 'root');
ref(py, 'imports', 'progetto_a/core/engine', 'root');

const js = run('javascript con import', 'src/main.ts', JS, 'ts', 'code', 'typescript');
packages(js, ['fs', 'path', 'react', '@scope/pkg']);
checks++; assert.ok(!js.packages.some((p) => p.startsWith('@/')), 'gli alias @/ non sono pacchetti');
ref(js, 'imports', './db.ts', 'file');
ref(js, 'imports', '../shared/types.ts', 'file');
ref(js, 'imports', './side-effect.js', 'file');
ref(js, 'imports', './lazy.ts', 'file');
ref(js, 'imports', '../config.json', 'file');

const rs = run('rust', 'src/main.rs', RS, 'rs', 'code', 'rust');
ref(rs, 'imports', 'jobs', 'file');
ref(rs, 'imports', 'settings', 'file');
ref(rs, 'imports', 'src/jobs/run_job', 'root');
ref(rs, 'imports', 'src/jobs', 'root');
ref(rs, 'imports', 'src/db', 'root');
ref(rs, 'imports', 'src/db/query', 'root');
packages(rs, ['serde', 'libc']);
checks++; assert.ok(!rs.packages.includes('std'), 'std non è un pacchetto esterno');

const sh = run('shell', 'scripts/avvia.sh', SH, 'sh', 'code', 'shell');
ref(sh, 'imports', './lib/common.sh', 'file');
ref(sh, 'imports', './env-sintetico.sh', 'file');
ref(sh, 'imports', `${DESK}/progetto-a/tools/run.py`, 'absolute');
ref(sh, 'imports', 'scripts/build.mjs', 'root');

const html = run('html', 'web/index.html', HTML, 'html', 'code', 'html');
ref(html, 'imports', 'style.css', 'file');
ref(html, 'imports', './main.js', 'file');
ref(html, 'imports', 'img/logo.png', 'file');
ref(html, 'imports', 'pagina2.html', 'file');
ref(html, 'imports', 'img/bg.jpg', 'file');
noRef(html, (x) => x.target.includes('example.com') || x.target.startsWith('#'), 'niente URL né ancore');

const css = run('css', 'web/style.css', CSS, 'css', 'code', 'css');
ref(css, 'imports', 'base.css', 'file');
ref(css, 'imports', 'theme/dark.css', 'file');
ref(css, 'imports', '../img/logo.svg', 'file');
noRef(css, (x) => x.target.startsWith('data:') || x.target.includes('woff2'), 'i data: URI non sono file');

// --- 2. link e backtick -------------------------------------------------------------------------

const md = run('markdown con link e backtick', 'docs/LEGGIMI.md', MD, 'md', 'doc', 'markdown');
ref(md, 'links', 'docs/guida.md', 'file');
ref(md, 'links', './img/schema.png', 'file');
ref(md, 'links', 'decisioni-progetto', 'name');
noRef(md, (x) => x.target.includes('example.com') || x.target.endsWith('x/y.md'), 'i link http non sono riferimenti locali');
ref(md, 'refpath', 'operativo/scripts/cerca_dati.py', 'root');
ref(md, 'refpath', `${DESK}/progetto-a/LEGGIMI.md`, 'absolute');

// --- 3. percorsi scritti nei file ---------------------------------------------------------------

ref(py, 'refpath', `${DESK}/progetto-a/1-zip`, 'absolute');           // pathlib
ref(py, 'refpath', `${DESK}/progetto-b/out`, 'absolute');             // os.path.join
ref(py, 'refpath', `${DESK}/progetto-c/config.yaml`, 'absolute');     // expanduser
external(py, `${HOME}/.hermes/config.yaml`);
ref(py, 'refpath', 'dati/input_righe.csv', 'root');
ref(py, 'refpath', 'scripts/prepara_zip.py', 'root');                 // python3 x.py dentro una stringa
checks++; assert.equal(py.refs.filter((x) => x.target === 'dati/input_righe.csv').length, 1, 'stesso percorso sulla stessa riga: un solo riferimento');
ref(js, 'refpath', `${DESK}/progetto-a/dati`, 'absolute');            // path.join(os.homedir(), 'Desktop', ...)
ref(js, 'refpath', `${DESK}/progetto-b/note.md`, 'absolute');
ref(rs, 'refpath', `${DESK}/progetto-a`, 'absolute');                 // .join("Desktop").join(...)
ref(md, 'refpath', `${DESK}/progetto-b/run.sh`, 'absolute');          // il «:12» non fa parte del percorso
ref(md, 'refpath', 'tools/esegui.py', 'root');                        // comando in un blocco di codice
external(sh, `${HOME}/Downloads/esempio.zip`);
external(sh, '/tmp/lavoro');
const json = run('json', 'package.json', JSON_TXT, 'json', 'config', 'json');
ref(json, 'refpath', 'scripts/build-ui.mjs', 'root');
ref(json, 'refpath', `${DESK}/progetto-b`, 'absolute');
const spaces = run('percorso con spazi', 'cfg.json', '{ "app": "/Applications/Example Studio.app", "dir": "~/Desktop/Cartella Con Spazi/x.txt" }', 'json', 'config', 'json');
external(spaces, '/Applications/Example Studio.app');
ref(spaces, 'refpath', `${DESK}/Cartella Con Spazi/x.txt`, 'absolute');

// --- 4. nomi di file citati ---------------------------------------------------------------------

ref(py, 'mention', 'README.md', 'name');
ref(py, 'mention', 'note_tecniche.md', 'name');
ref(py, 'mention', 'esito.csv', 'name');                              // all'inizio di una stringa
noRef(py, (x) => x.target === 'settings.json', 'nel codice, fuori da stringhe e commenti, non è una menzione');
ref(md, 'mention', 'MEMORIA.md', 'name');
checks++; assert.equal(md.refs.filter((x) => x.kind === 'mention' && x.target === 'MEMORIA.md').length, 1, 'una sola menzione per nome e per file');
noRef(md, (x) => x.kind === 'mention' && (x.target === 'Node.js' || x.target === 'console.log'), 'Node.js e console.log non sono nomi di file');

// --- 5. identificatori rari ---------------------------------------------------------------------

ids(md, ['PR#42', '9791d04ab', 'C0123ABC45', '1791875427.570599', 'PR#7']);
ids(js, ['PR#77']);
const idt = run('identificatori', 'note.txt', [
  'Numero 12345678 e parola CONSTANTS, UTF-8, ISO-8601, colore #ff3d7e, versione V8.46.',
  'Ticket JIRA-123 e uuid 0a1b2c3d-1111-2222-3333-444455556666.',
  'Commit completo 9791d04abcdef0123456789abcdef0123456789a nel registro.',
].join('\n'), 'txt', 'doc', 'text');
ids(idt, ['JIRA-123', '0a1b2c3d-1111-2222-3333-444455556666', '9791d04abcdef0123456789abcdef0123456789a']);
noIds(idt, ['12345678', 'CONSTANTS', 'UTF-8', 'ISO-8601', 'ff3d7e', '0a1b2c3d', '444455556666']);

// --- 6. termini ---------------------------------------------------------------------------------

const t = run('termini', 'appunti.md', [
  'Il motore calcola le aliquote contributive; the engine computes rates 2025.',
  'Funzione parseUniemensFile e variabile max_rows; sono questi i casi.',
].join('\n'), 'md', 'doc', 'markdown', true);
for (const w of ['motore', 'calcola', 'aliquote', 'contributive', 'engine', 'computes', 'rates', 'parse', 'uniemens', 'file', 'funzione', 'variabile', 'rows', 'casi']) {
  checks++; assert.ok(t.terms[w] >= 1, `manca il termine ${w}`);
}
for (const w of ['the', 'sono', 'questi', '2025', 'max', 'il', 'le']) {
  checks++; assert.equal(t.terms[w], undefined, `termine di troppo: ${w}`);
}

// --- 7. complessità -----------------------------------------------------------------------------

checks++; assert.equal(py.complexity, 3, 'codice: def + if + for');
checks++; assert.equal(md.complexity, 1 + 1 + 4, 'doc: 1 intestazione + 1 tabella + 4 link');
checks++; assert.equal(html.complexity, 3, 'html: 3 <a>');
checks++; assert.equal(json.complexity, 5, 'config: 5 chiavi di primo livello');
const yml = run('yaml', 'config.yaml', 'nome: x\nopzioni:\n  a: 1\n  b: 2\n# commento: no\nultimo: y\n', 'yaml', 'config', 'yaml', true);
checks++; assert.equal(yml.complexity, 3, 'yaml: 3 chiavi di primo livello');

// --- notebook -----------------------------------------------------------------------------------

const NB = JSON.stringify({
  cells: [
    { cell_type: 'code', source: ['import pandas as pd\n', 'from progetto_a import utils\n', 'df = pd.read_csv("~/Desktop/progetto-a/dati/righe.csv")\n', '%run scripts/prepara.py\n'] },
    { cell_type: 'markdown', source: ['Vedi [note](note.md)\n'] },
  ],
}, null, 1);
const nb = run('notebook', 'analisi.ipynb', NB, 'ipynb', 'notebook', null);
packages(nb, ['pandas']);
ref(nb, 'imports', 'progetto_a', 'root');
ref(nb, 'imports', 'progetto_a/utils', 'root');
ref(nb, 'refpath', `${DESK}/progetto-a/dati/righe.csv`, 'absolute');
ref(nb, 'imports', 'scripts/prepara.py', 'file');
ref(nb, 'links', 'note.md', 'file');

// --- stringhe a forma di codice fiscale e di segreto (mai in termini e identificatori, mascherate negli snippet)

const priv = run('stringhe sensibili', 'registro.log', [
  'utente AAAAAA00A00A000A in ~/Desktop/progetto-a/report.pdf',
  'header Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl',
  'slack xoxb-0000-0000-fake e chiave sk-test0000000000fake',
].join('\n'), 'log', 'log', 'text');
checks++; assert.ok(!priv.identifiers.some((x) => /AAAAAA00A00A000A/i.test(x.token)), 'niente codici fiscali negli identificatori');
checks++; assert.ok(!Object.keys(priv.terms).some((w) => w.startsWith('aaaaaa') || w.startsWith('eyj') || w === 'xoxb' || w === 'fake'), 'niente codici fiscali né token nei termini');
const rp = priv.refs.find((x) => x.target === `${DESK}/progetto-a/report.pdf`);
checks++; assert.ok(rp && rp.snippet.includes('«***»') && !rp.snippet.includes('AAAAAA00A00A000A'), 'nello snippet il codice fiscale è mascherato');
checks++; assert.ok(!json.identifiers.length && !Object.keys(json.terms).includes('xoxb'), 'il token nel json non diventa identificatore né termine');

// --- limiti per file ----------------------------------------------------------------------------

const many = run('limiti', 'tanti.txt', Array.from({ length: 600 }, (_, i) => `dir/file_${i}.py e ${(0x10000000 + i).toString(16)}a`).join('\n'), 'txt', 'doc', 'text', true);
checks++; assert.equal(many.refs.length, 500, 'al massimo 500 riferimenti per file');
checks++; assert.equal(many.identifiers.length, 200, 'al massimo 200 identificatori per file');
const letters = (i) => String.fromCharCode(97 + (i % 26), 97 + (Math.floor(i / 26) % 26), 97 + (Math.floor(i / 676) % 26));
const words = run('limiti termini', 'parole.txt', Array.from({ length: 2500 }, (_, i) => `parola${letters(i)}`).join(' '), 'txt', 'doc', 'text', true);
checks++; assert.equal(Object.keys(words.terms).length, 2000, 'al massimo 2.000 termini distinti');

// --- velocità -----------------------------------------------------------------------------------

const corpus = [
  [PY, 'py', 'code', 'python'], [MD, 'md', 'doc', 'markdown'], [JS, 'ts', 'code', 'typescript'],
  [SH, 'sh', 'code', 'shell'], [JSON_TXT, 'json', 'config', 'json'], [HTML, 'html', 'code', 'html'],
];
let lines = 0;
const t0 = performance.now();
for (let i = 0; i < 3000; i++) {
  const [content, ext, cls, lang] = corpus[i % corpus.length];
  const text = content.repeat(6);
  lines += extract({ path: `${DESK}/progetto-a/f${i}.${ext}`, content: text, ext, cls, lang }).lines;
}
const ms = performance.now() - t0;
console.log(`\nvelocità: 3.000 file, ${lines} righe in ${ms.toFixed(0)} ms (${(ms / 3000).toFixed(2)} ms per file)`);
checks++; assert.ok(ms < 15000, `troppo lento: ${ms.toFixed(0)} ms per 3.000 file`);

const nasty = {
  'punti': 'a.'.repeat(10000),
  'barre': 'x/'.repeat(10000),
  'barre con file': 'x/'.repeat(10000) + 'y.py',
  'backtick': '`' + 'a/'.repeat(5000),
  'parentesi markdown': '['.repeat(5000) + ']('.repeat(5000),
  'wiki': '[['.repeat(5000),
  'maiuscole': 'A'.repeat(20000),
  'risalite': '../'.repeat(6000) + 'z.ts',
  'base64': 'QUJD'.repeat(5000),
};
for (const [nome, s] of Object.entries(nasty)) {
  for (const [ext, cls, lang] of [['md', 'doc', 'markdown'], ['py', 'code', 'python'], ['yaml', 'config', 'yaml']]) {
    const t1 = performance.now();
    extract({ path: `${DESK}/progetto-a/strano.${ext}`, content: s, ext, cls, lang });
    const d = performance.now() - t1;
    checks++; assert.ok(d < 1000, `riga patologica «${nome}» (${ext}) lenta: ${d.toFixed(0)} ms`);
  }
}

// --- pre-filtri di velocità: stesso risultato dei rilevatori completi ----------------------------------------------------
{
  const md = (content) => extract({ path: `${DESK}/progetto-a/n.md`, content, ext: 'md', cls: 'doc', lang: 'markdown' });
  // percorso relativo molto dopo l'inizio della riga, dopo punti e testo senza barre
  const late = md('Nota v1.2 e a.b.c finali: vedi docs/guida/indice.md per i dettagli');
  ref(late, 'refpath', 'docs/guida/indice.md');
  // barra senza punto dopo di essa: nessun riferimento, nessun errore
  checks++; assert.equal(md('a / b e </div> senza estensione').refs.length, 0);
  // percorso con lettere non ASCII e con ./ iniziale
  ref(md('apri ./città/è.pdf subito'), 'refpath', './città/è.pdf');
  // menzione con estensione maiuscola e con estensione sconosciuta (solo la prima conta)
  ref(md('leggi README.MD e anche foo.bar'), 'mention', 'README.MD');
  noRef(md('leggi foo.bar e this.value.next'), (x) => x.kind === 'mention', 'estensioni sconosciute non diventano menzioni');
  // termini: ASCII, camelCase, accenti e cifre
  const t = md('getUserName PDFRenderer città verità abc123 naïve plain');
  for (const w of ['user', 'name', 'renderer', 'città', 'verità', 'naïve', 'plain']) { checks++; assert.ok(w in t.terms, `manca il termine ${w}`); }
  checks++; assert.ok(!('abc123' in t.terms), 'le parole con cifre non sono termini');
  // un codice fiscale non entra nei termini ed è mascherato; una riga simile ma troppo corta no
  const cf = md('titolare RSSMRA80A01H501U fine');
  checks++; assert.ok(!('rssmra80a01h501u' in cf.terms) && !('rssmra' in cf.terms), 'il codice fiscale non diventa termine');
}

console.log(`\nOK: ${checks} controlli superati.`);
