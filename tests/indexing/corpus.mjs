// Synthetic Desktop for the indexing benchmark: deterministic (seeded), shaped like a real Desktop
// (≈ data 36%, archives 24%, documents 20%, sheets 11%, code 6%), with projects, vendor folders, data dumps,
// duplicates, secrets, symlinks and Italian/English texts that reference each other.
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IT = 'cedolino contratto dipendente assunzione stipendio ferie permesso busta paga contributi inps inail welfare benefit trasferta rimborso nota spese fattura cliente fornitore preventivo ordine consegna magazzino bilancio budget riunione verbale progetto scadenza revisione approvazione documento allegato modulo richiesta risposta azienda ufficio sede reparto responsabile collaboratore formazione corso valutazione obiettivo premio straordinario turno orario presenza assenza malattia maternità congedo tredicesima quattordicesima tfr liquidazione'.split(' ');
const EN = 'payroll contract employee onboarding salary leave holiday payslip tax benefit expense invoice customer supplier quote order delivery warehouse report budget meeting minutes project deadline review approval document attachment form request response company office team manager contractor training course evaluation goal bonus overtime shift schedule attendance absence sick parental pension severance pipeline dashboard metric funnel churn retention cohort'.split(' ');
const CODE_WORDS = 'load parse build render fetch save update compute validate export import sync merge split format normalize resolve index rank score filter group sort map reduce cache queue worker client server route handler model schema store state config util helper'.split(' ');

export const DEFAULT_MIX = { data: 0.36, archive: 0.24, doc: 0.20, sheet: 0.11, code: 0.06, other: 0.02, config: 0.005, log: 0.003, image: 0.002 };

function words(r, list, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += list[Math.floor(r() * list.length)] + (r() < 0.08 ? '.\n' : ' ');
  return s;
}

function bytes(r, pool, n) {
  const off = Math.floor(r() * (pool.length - n));
  return pool.subarray(off, off + n);
}

const pick = (r, a) => a[Math.floor(r() * a.length)];
const camel = (a, b) => a + b[0].toUpperCase() + b.slice(1);

/**
 * Writes the corpus under `dir` (wiped first). `files` is the approximate number of regular files outside
 * vendor folders; `vendorFiles` the files inside node_modules/.venv (indexed only as totals).
 * Returns the counts actually written.
 */
export function generateCorpus(dir, { files = 20000, seed = 1, sizeScale = 1 } = {}) {
  const r = rng(seed);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pool = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < pool.length; i++) pool[i] = Math.floor(r() * 256);
  const out = { files: 0, dirs: 0, bytes: 0, vendorFiles: 0, symlinks: 0, secrets: 0, duplicates: 0, projects: 0 };
  const sz = (lo, hi) => Math.max(16, Math.floor((lo + r() * (hi - lo)) * sizeScale));
  const madeDirs = new Set();
  const put = (p, content) => {
    const d = dirname(p);
    if (!madeDirs.has(d)) { mkdirSync(d, { recursive: true }); madeDirs.add(d); out.dirs++; }
    writeFileSync(p, content);
    out.files++;
    out.bytes += typeof content === 'string' ? Buffer.byteLength(content) : content.length;
  };
  const docs = [];      // text documents, targets of links and mentions
  const n = (k) => Math.max(1, Math.round(files * (DEFAULT_MIX[k] ?? 0)));

  // --- code projects ------------------------------------------------------------------------
  const codeTotal = n('code');
  const perProject = 40;
  const projectCount = Math.max(1, Math.ceil(codeTotal / perProject));
  out.projects = projectCount;
  for (let p = 0; p < projectCount; p++) {
    const py = p % 3 === 2;
    const name = `${pick(r, ['gestionale', 'portal', 'tool', 'motore', 'sync', 'report'])}-${p}`;
    const root = join(dir, 'Progetti', name);
    const shared = Array.from({ length: 6 }, () => camel(pick(r, CODE_WORDS), pick(r, IT)) + p);
    const count = Math.min(perProject, codeTotal - p * perProject);
    const mods = [];
    for (let i = 0; i < count; i++) mods.push(`${py ? 'pkg' : 'src'}/${pick(r, ['core', 'api', 'ui', 'lib'])}/${pick(r, CODE_WORDS)}_${i}.${py ? 'py' : 'ts'}`);
    if (py) put(join(root, 'pyproject.toml'), `[project]\nname = "${name}"\nversion = "0.1.0"\ndependencies = ["requests", "pandas"]\n`);
    else put(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', dependencies: { react: '^19', zod: '^3' } }, null, 2));
    for (let i = 0; i < mods.length; i++) {
      const lines = [];
      const imports = Math.floor(r() * 4);
      for (let k = 0; k < imports; k++) {
        const t = mods[Math.floor(r() * mods.length)];
        if (t === mods[i]) continue;
        if (py) lines.push(`from ${t.replace(/\.py$/, '').replace(/\//g, '.')} import ${pick(r, shared)}`);
        else lines.push(`import { ${pick(r, shared)} } from './${relative(dirname(mods[i]), t).replace(/\.ts$/, '')}';`.replace("'./../", "'../"));
      }
      lines.push(py ? 'import os, json\nimport requests' : "import { z } from 'zod';");
      const body = sz(1500, 9000);
      let code = lines.join('\n') + '\n';
      while (code.length < body) {
        const fn = camel(pick(r, CODE_WORDS), pick(r, CODE_WORDS));
        code += py
          ? `\ndef ${fn}_${Math.floor(r() * 99)}(rows, ${pick(r, shared)}):\n    # ${words(r, IT, 8)}\n    for row in rows:\n        if row.get("${pick(r, IT)}"):\n            yield ${pick(r, shared)}(row)\n`
          : `\nexport function ${fn}${Math.floor(r() * 99)}(input: unknown) {\n  // ${words(r, EN, 8)}\n  if (!input) return ${pick(r, shared)};\n  for (const x of [1, 2, 3]) { console.log(x, '${pick(r, EN)}'); }\n  return null;\n}\n`;
      }
      put(join(root, mods[i]), code);
    }
    const readme = join(root, 'README.md');
    put(readme, `# ${name}\n\n${words(r, p % 2 ? EN : IT, 120)}\n\n- [main](${mods[0]})\n- vedi \`${mods[mods.length - 1]}\`\n- config: ${py ? 'pyproject.toml' : 'package.json'}\n`);
    docs.push(readme);
    if (!py) put(join(root, 'scripts', 'run.sh'), `#!/bin/sh\nnode ${mods[0].replace(/\.ts$/, '.js')}\nsource ./env.sh\n`);
    // vendor tree: many small files that the scan only counts
    const vendor = join(root, py ? '.venv/lib/site-packages' : 'node_modules');
    if (py) { mkdirSync(join(root, '.venv'), { recursive: true }); writeFileSync(join(root, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n'); }
    for (let v = 0; v < 120; v++) {
      const vp = join(vendor, `dep${v % 12}`, `f${v}.js`);
      mkdirSync(dirname(vp), { recursive: true });
      writeFileSync(vp, `module.exports = ${v};\n`);
      out.vendorFiles++;
    }
    put(join(root, '.env'), `API_TOKEN=sk-test-${Math.floor(r() * 1e9)}\nSECRET_IDENTIFIER=${shared[0]}\n`);
    out.secrets++;
  }

  // --- documents (clients, notes) -------------------------------------------------------------
  const docTotal = n('doc');
  const clients = Math.max(2, Math.round(docTotal / 60));
  for (let i = 0; i < docTotal; i++) {
    const c = i % clients;
    const year = 2021 + (i % 5);
    const it = c % 2 === 0;
    const base = join(dir, it ? 'Clienti' : 'Clients', `${it ? 'cliente' : 'client'}-${c}`, String(year));
    const kind = r();
    if (kind < 0.55) {
      const p = join(base, `${it ? 'verbale' : 'minutes'}-${i}.md`);
      let txt = `# ${it ? 'Verbale' : 'Minutes'} ${i}\n\n${words(r, it ? IT : EN, Math.floor(sz(80, 600) / 6))}\n`;
      if (docs.length && r() < 0.5) {
        const t = pick(r, docs);
        txt += `\nVedi [${it ? 'documento' : 'document'}](${relative(dirname(p), t)})\n`;
      }
      if (docs.length && r() < 0.3) txt += `\nRif: ${pick(r, docs).split('/').pop()}\n`;
      if (r() < 0.1) txt += `\n[[${it ? 'verbale' : 'minutes'}-${Math.floor(r() * i)}]]\n`;
      put(p, txt);
      docs.push(p);
    } else if (kind < 0.8) {
      put(join(base, `${it ? 'contratto' : 'contract'}-${i}.pdf`), Buffer.concat([Buffer.from('%PDF-1.7\n'), bytes(r, pool, sz(8000, 60000))]));
    } else {
      put(join(base, `${it ? 'offerta' : 'offer'}-${i}.docx`), Buffer.concat([Buffer.from('PK\x03\x04'), bytes(r, pool, sz(6000, 40000))]));
    }
  }

  // --- data dumps and loose data ---------------------------------------------------------------
  const dataTotal = n('data');
  const dumpSize = 150;
  for (let i = 0; i < dataTotal; i++) {
    const loose = i % 10 === 0;
    const d = loose ? join(dir, 'Analisi', `run-${i % 40}`) : join(dir, 'Dati', `export-${Math.floor(i / dumpSize)}`);
    const csv = r() < 0.7;
    const rows = Math.floor(sz(20, 300));
    let s = csv ? 'id,nome,importo,data\n' : '';
    for (let k = 0; k < rows; k++) s += csv ? `${k},${pick(r, IT)},${(r() * 1e4).toFixed(2)},2024-0${1 + (k % 9)}-1${k % 9}\n` : JSON.stringify({ id: k, voce: pick(r, IT), valore: Math.floor(r() * 1e4) }) + '\n';
    put(join(d, `${csv ? 'righe' : 'eventi'}-${i}.${csv ? 'csv' : 'jsonl'}`), s);
  }

  // --- sheets, archives, other binaries, images, logs, config -------------------------------------
  const bin = (folder, ext, k, lo, hi) => {
    for (let i = 0; i < n(k); i++) put(join(dir, folder, `lotto-${i % 30}`, `${k}-${i}.${pick(r, ext)}`), bytes(r, pool, sz(lo, hi)));
  };
  bin('Fogli', ['xlsx', 'xls', 'numbers'], 'sheet', 4000, 40000);
  bin('Archivio', ['zip', 'gz', 'tar'], 'archive', 5000, 80000);
  bin('Varie', ['bin', 'dat', 'tmp'], 'other', 500, 8000);
  bin('Immagini', ['png', 'jpg'], 'image', 20000, 120000);
  for (let i = 0; i < n('log'); i++) put(join(dir, 'Logs', `run-${i}.log`), words(r, EN, 400).replace(/\./g, `\nINFO ${i}`));
  for (let i = 0; i < n('config'); i++) put(join(dir, 'Config', `servizio-${i}.yaml`), `name: servizio-${i}\nport: ${3000 + i}\npath: Progetti/gestionale-0/README.md\n`);

  // --- exact duplicates of documents, a secret folder file, symlinks -------------------------------
  const dupes = Math.max(1, Math.round(docs.length * 0.04));
  for (let i = 0; i < dupes; i++) {
    const src = docs[Math.floor(r() * docs.length)];
    const dst = join(dir, 'Archivio', 'copie', `${i}-${src.split('/').pop()}`);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(src));
    out.files++;
    out.duplicates++;
  }
  put(join(dir, 'credentials.json'), '{"client_secret": "not-a-real-secret"}\n');
  out.secrets++;
  mkdirSync(join(dir, 'Collegamenti'), { recursive: true });
  for (let i = 0; i < Math.min(20, projectCount); i++) {
    const target = join(dir, 'Progetti', readdirSync(join(dir, 'Progetti'))[i]);
    symlinkSync(target, join(dir, 'Collegamenti', `progetto-${i}`));
    out.symlinks++;
  }
  // stable mtimes: the warm run must see an unchanged tree
  const t = new Date('2025-01-01T00:00:00Z');
  utimesSync(dir, t, t);
  return out;
}

/**
 * Changes a share of the corpus the way a working day does: edits text files, adds new ones, deletes some.
 * Returns the counts. Deterministic for a given seed.
 */
export function mutateCorpus(dir, { share = 0.01, seed = 7 } = {}) {
  const r = rng(seed);
  const all = [];
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.venv' || e.isSymbolicLink()) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p); else all.push(p);
    }
  };
  visit(dir);
  all.sort();
  const k = Math.max(3, Math.round(all.length * share));
  const out = { edited: 0, added: 0, deleted: 0 };
  for (let i = 0; i < k; i++) {
    const p = all[Math.floor(r() * all.length)];
    if (!existsSync(p)) continue;
    const op = r();
    if (op < 0.6) {
      writeFileSync(p, readFileSync(p).toString('utf8') + `\n${words(r, IT, 20)}\n`);
      out.edited++;
    } else if (op < 0.85) {
      const q = join(dirname(p), `nuovo-${i}.md`);
      writeFileSync(q, `# Nuovo ${i}\n\n${words(r, EN, 60)}\n\nVedi [origine](./${p.split('/').pop()})\n`);
      out.added++;
    } else {
      rmSync(p);
      out.deleted++;
    }
  }
  return out;
}
