// Imports read with tree-sitter (Go, Java, Python, C/C++) and the Kotlin rule: extractor output and the edges of a real index.
// Uso: node scripts/test-syntax-imports.mjs — cartelle e database temporanei, nessun modello.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extract } from '../src/server/extract.ts';
import { loadSyntax, syntaxImports } from '../src/server/syntax.ts';
import { Db } from '../src/server/db.ts';
import { DEFAULTS } from '../src/server/config.ts';
import { runIndex } from '../src/server/index.ts';

const targets = (res, kind = 'imports') => res.refs.filter(r => r.kind === kind).map(r => `${r.relativeTo}:${r.target}@${r.line}`);
const py = 'from . import (\n    helpers,\n)\nfrom .models import (\n    User,\n)\n"""from fake import nothing"""\nimport os\n\ndef later():\n    from .lazy import thing\n';
const input = (path, content, lang, extra = {}) => ({ path, content, ext: path.split('.').pop(), cls: 'code', lang, ...extra });

// Before the grammars load, the line rules answer (and miss the names on the next lines).
assert.equal(syntaxImports('python', py), null);
assert.deepEqual(targets(extract(input('/p/pkg/app.py', py, 'python'))), ['file:./models@4', 'file:./lazy@11', 'file:./lazy/thing@11']);
assert.equal(await loadSyntax(), true);
assert.equal(await loadSyntax(), true, 'loaded once');
assert.deepEqual(targets(extract(input('/p/pkg/app.py', py, 'python'))), ['file:./helpers@1', 'file:./models@4', 'file:./lazy@11', 'file:./lazy/thing@11'], 'names on the next lines count, a docstring does not, the body keeps its line rules');

const go = 'package main\n\nimport (\n\t"fmt"\n\tdb "example.com/app/internal/db"\n\t"github.com/spf13/cobra/doc"\n)\n// import "example.com/app/fake"\n';
const goRes = extract(input('/w/app/cmd/main.go', go, 'go', { goModule: { path: 'example.com/app', dir: '/w/app' } }));
assert.deepEqual(targets(goRes), ['absolute:/w/app/internal/db@5'], 'a package of the own module is its folder; comments and the standard library are not');
assert.deepEqual(goRes.packages, ['github.com/spf13/cobra']);
assert.deepEqual(targets(extract(input('/w/app/main.go', go, 'go'))), [], 'without go.mod nothing is guessed');

const java = 'package com.acme;\nimport com.acme.util.Strings;\nimport static com.acme.util.Maths.max;\nimport com.acme.model.*;\nimport java.util.List;\n';
assert.deepEqual(targets(extract(input('/j/src/main/java/com/acme/App.java', java, 'java'))), ['root:com/acme/util/Strings@2', 'root:com/acme/util/Maths@3', 'root:com/acme/model@4']);
const kt = 'package com.acme\n\nimport com.acme.util.Strings\nimport com.acme.model.*\nimport kotlin.math.max\nimport com.acme.util.Maths as M\n';
assert.deepEqual(targets(extract(input('/j/src/main/kotlin/com/acme/Main.kt', kt, 'kotlin'))), ['root:com/acme/util/Strings@3', 'root:com/acme/model@4', 'root:com/acme/util/Maths@6']);
const c = '#include "util/str.h"\n#include <stdio.h>\n// #include "fake.h"\n#if DEBUG\n#include "debug.h"\n#endif\n';
assert.deepEqual(targets(extract(input('/c/src/main.cpp', c, 'cpp'))), ['file:util/str.h@1', 'file:debug.h@5']);
console.log('PASS extractor: multi-line Python, Go module packages, Java/Kotlin classes and packages, C/C++ includes; comments, strings and standard libraries ignored');

// A real index over the same shapes: the edges land on the files and folders.
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vb-syntax-')));
try {
  const root = join(temp, 'Scrivania');
  const files = {
    'goapp/go.mod': 'module example.com/app\n\ngo 1.22\n',
    'goapp/cmd/main.go': go,
    'goapp/internal/db/db.go': 'package db\n',
    'javaapp/pom.xml': '<project></project>\n',
    'javaapp/src/main/java/com/acme/App.java': java,
    'javaapp/src/main/java/com/acme/util/Strings.java': 'package com.acme.util;\nclass Strings {}\n',
    'javaapp/src/main/java/com/acme/util/Maths.java': 'package com.acme.util;\nclass Maths {}\n',
    'javaapp/src/main/java/com/acme/model/User.java': 'package com.acme.model;\nclass User {}\n',
    'javaapp/src/main/kotlin/com/acme/Main.kt': kt,
    'pyapp/pyproject.toml': '[project]\nname = "pyapp"\n',
    'pyapp/pkg/__init__.py': '',
    'pyapp/pkg/app.py': py,
    'pyapp/pkg/helpers.py': 'X = 1\n',
    'pyapp/pkg/models.py': 'class User: pass\n',
    'capp/Makefile': 'all:\n\tcc src/main.cpp\n',
    'capp/src/main.cpp': c,
    'capp/src/util/str.h': '#pragma once\n',
    'capp/src/debug.h': '#pragma once\n',
    'capp/src/fake.h': '#pragma once\n',
  };
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); }
  const db = new Db(join(temp, 'i.db'));
  await runIndex(db, { ...DEFAULTS, roots: [root], dataDir: join(temp, 'profile'), excludePaths: [join(temp, 'profile')], llm: { ...DEFAULTS.llm, provider: 'none' } });
  const rel = p => p.slice(root.length + 1);
  const edges = new Set(db.all("SELECT a.path s, b.path d FROM edges e JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst WHERE e.kind = 'imports' AND e.origin = 'scan'").map(e => `${rel(e.s)} → ${rel(e.d)}`));
  const expected = [
    'goapp/cmd/main.go → goapp/internal/db',
    'javaapp/src/main/java/com/acme/App.java → javaapp/src/main/java/com/acme/util/Strings.java',
    'javaapp/src/main/java/com/acme/App.java → javaapp/src/main/java/com/acme/util/Maths.java',
    'javaapp/src/main/java/com/acme/App.java → javaapp/src/main/java/com/acme/model',
    'pyapp/pkg/app.py → pyapp/pkg/helpers.py',
    'pyapp/pkg/app.py → pyapp/pkg/models.py',
    'capp/src/main.cpp → capp/src/util/str.h',
    'capp/src/main.cpp → capp/src/debug.h',
  ];
  for (const e of expected) assert.ok(edges.has(e), `missing edge ${e}\n${[...edges].join('\n')}`);
  assert.ok(![...edges].some(e => e.includes('fake.h')), 'a commented include is no edge');
  // An index made by an older extractor: the affected languages are read once more and get their edges.
  const cfg = { ...DEFAULTS, roots: [root], dataDir: join(temp, 'profile'), excludePaths: [join(temp, 'profile')], llm: { ...DEFAULTS.llm, provider: 'none' } };
  db.exec('DELETE FROM refs'); db.exec("DELETE FROM edges WHERE kind = 'imports'"); db.setMeta('extractor', '1');
  const again = await runIndex(db, cfg);
  assert.equal(again.extracted, 15, 'only the Python, Go, Java, Kotlin and C/C++ files are read again');
  const rebuilt = new Set(db.all("SELECT a.path s, b.path d FROM edges e JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst WHERE e.kind = 'imports' AND e.origin = 'scan'").map(e => `${rel(e.s)} → ${rel(e.d)}`));
  for (const e of expected) assert.ok(rebuilt.has(e), `missing edge after the extractor update ${e}`);
  assert.equal(db.getMeta('extractor'), '2');
  assert.equal((await runIndex(db, cfg)).extracted, 0, 'and only once');
  db.close?.();
  console.log(`PASS index: ${expected.length} import edges for Go, Java, Python and C++ land on the right files and folders; an older index is read again once`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
