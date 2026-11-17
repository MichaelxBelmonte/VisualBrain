// Hand-written corpus for the indexing quality test: every edge the engine must find is listed in EXPECTED, so
// precision and recall are exact. Italian and English texts, accents and spaces in names, symlinks, exclusions,
// secrets, vendor folders. All content is synthetic.
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const FILES = {
  'progetto-app/package.json': JSON.stringify({ name: 'progetto-app', version: '1.0.0', dependencies: { react: '^19' } }, null, 2),
  'progetto-app/src/index.ts': [
    "import { somma } from './lib/math';",
    "import { avvia } from './util';",
    "import './styles.css';",
    "import React from 'react';",
    "export * from './lib/math';",
    'avvia(somma(1, 2));',
  ].join('\n') + '\n',
  'progetto-app/src/util.ts': "import { somma } from './lib/math';\nexport function avvia(n: number) { return somma(n, 1); }\n",
  'progetto-app/src/lib/math.ts': 'export function somma(a: number, b: number) { return a + b; }\n',
  'progetto-app/src/styles.css': "@import './base.css';\n.logo { background: url('../assets/logo.png'); }\n",
  'progetto-app/src/base.css': 'body { margin: 0; }\n',
  'progetto-app/assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2, 3]),
  'progetto-app/README.md': [
    '# Progetto app',
    '',
    'Documentazione: [Guida](docs/guida.md) e [English guide](docs/guide-en.md).',
    'Il punto di ingresso è `src/index.ts`.',
    'Le funzioni matematiche sono in math.ts.',
    'Il rapporto scaricato è in ~/Downloads/rapporto-vb-test.pdf.',
    '',
  ].join('\n'),
  'progetto-app/docs/guida.md': '# Guida\n\nTorna al [README](../README.md). Versione inglese: [[guide-en]].\n',
  'progetto-app/docs/guide-en.md': '# Guide\n\nMeeting notes: [minutes](../../Note/Riunione%20città.md).\n',
  'progetto-app/scripts/run.sh': '#!/bin/sh\nsource ./env.sh\npython3 ../tools/pulisci.py\n',
  'progetto-app/scripts/env.sh': 'export MODE=prova\n',
  'progetto-app/tools/pulisci.py': 'from .aiuti import carica\nimport os\n\ncarica(os.getcwd())\n',
  'progetto-app/tools/aiuti.py': 'def carica(p):\n    return p\n',
  'progetto-app/node_modules/react/index.js': "module.exports = require('./cjs/react.js');\n",
  'progetto-app/node_modules/react/cjs/react.js': 'module.exports = {};\n',
  'progetto-app/dist/bundle.js': "import './src/index';\nimport '../README.md';\n",
  'progetto-app/.env': 'API_KEY=prova-non-reale\nCONFIG=./src/util.ts\n',
  'Note/Riunione città.md': '# Riunione in città\n\nDecisioni prese, vedi guida.md e il [progetto](../progetto-app/README.md).\n',
  'Note/copia-guida.md': '# Guida\n\nTorna al [README](../README.md). Versione inglese: [[guide-en]].\n',
  'Note/.private/riservato.md': 'Non leggere: [guida](../../progetto-app/docs/guida.md)\n',
  'Archivio-escluso/vecchio.md': '[guida](../progetto-app/docs/guida.md)\n',
  'credentials.json': '{ "path": "progetto-app/src/util.ts" }\n',
};

export const SYMLINKS = {
  'Collegamenti/app': '../progetto-app',
  'Collegamenti/rotto': '../non-esiste',
};

/** Directories passed as `excludePaths` (relative to the root). */
export const EXCLUDED = ['Archivio-escluso'];

/**
 * Every edge of a deterministic kind the scan must produce, as `kind src → dst` relative to the root
 * (`~/…` for external identities outside the roots). duplicate is undirected.
 */
export const EXPECTED = [
  'imports progetto-app/src/index.ts → progetto-app/src/lib/math.ts',
  'imports progetto-app/src/index.ts → progetto-app/src/util.ts',
  'imports progetto-app/src/index.ts → progetto-app/src/styles.css',
  'imports progetto-app/src/util.ts → progetto-app/src/lib/math.ts',
  'imports progetto-app/src/styles.css → progetto-app/src/base.css',
  'imports progetto-app/src/styles.css → progetto-app/assets/logo.png',
  'imports progetto-app/scripts/run.sh → progetto-app/scripts/env.sh',
  'imports progetto-app/scripts/run.sh → progetto-app/tools/pulisci.py',
  'imports progetto-app/tools/pulisci.py → progetto-app/tools/aiuti.py',
  'links progetto-app/README.md → progetto-app/docs/guida.md',
  'links progetto-app/README.md → progetto-app/docs/guide-en.md',
  'refpath progetto-app/README.md → progetto-app/src/index.ts',
  'mention progetto-app/README.md → progetto-app/src/lib/math.ts',
  'external progetto-app/README.md → ~/Downloads/rapporto-vb-test.pdf',
  'links progetto-app/docs/guida.md → progetto-app/README.md',
  'links progetto-app/docs/guida.md → progetto-app/docs/guide-en.md',
  'links progetto-app/docs/guide-en.md → Note/Riunione città.md',
  'mention Note/Riunione città.md → progetto-app/docs/guida.md',
  'links Note/Riunione città.md → progetto-app/README.md',
  'links Note/copia-guida.md → progetto-app/docs/guide-en.md',
  'duplicate Note/copia-guida.md → progetto-app/docs/guida.md',
  'symlink Collegamenti/app → progetto-app',
];

/** After `mutate`: guide-en.md deleted, nuovo.md added, the Downloads reference removed from the README. */
export const EXPECTED_AFTER = [
  ...EXPECTED.filter((e) => !e.includes('guide-en.md') && !e.includes('rapporto-vb-test')),
  'links progetto-app/docs/nuovo.md → progetto-app/docs/guida.md',
];

export function writeFixture(root) {
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  for (const [rel, target] of Object.entries(SYMLINKS)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    symlinkSync(target, join(root, rel));
  }
}
