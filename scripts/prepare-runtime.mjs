// Curated runtime: never copy the development checkout, data, credentials or local configuration.
import { cp, mkdir, readFile, writeFile, rm, chmod, readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareHarnessTools } from './prepare-harness-tools.mjs';
const root = resolve(import.meta.dirname, '..');
const version = '24.21.0';
const arch = process.argv.find(a => a.startsWith('--arch='))?.split('=')[1] || process.arch;
if (!['arm64', 'x64', 'universal'].includes(arch) || process.platform !== 'darwin') throw Error('This packaging script targets macOS (arm64, x64 or universal).');
const arches = arch === 'universal' ? ['arm64', 'x64'] : [arch];
// Optional native indexer: shipped when built (scripts/build-indexer.mjs); --no-native leaves it out,
// --engine-default=ts|auto|native sets the packaged default (the app stays on `ts` unless this says otherwise).
const withNative = !process.argv.includes('--no-native');
const engineDefault = process.argv.find(a => a.startsWith('--engine-default='))?.split('=')[1];
if (engineDefault && !['ts', 'auto', 'native'].includes(engineDefault)) throw Error('--engine-default must be ts, auto or native.');
const out = join(root, 'app/runtime');
const downloads = join(root, '.build/downloads');
await mkdir(downloads, { recursive: true });
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'server/src'), { recursive: true });
async function download(name) {
  const file = join(downloads, name);
  try { return await readFile(file); } catch {}
  const url = `https://nodejs.org/dist/v${version}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw Error(`Download failed: ${url} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer()); await writeFile(file, bytes); return bytes;
}
const sums = (await download('SHASUMS256.txt')).toString();
for (const a of arches) {
  const name = `node-v${version}-darwin-${a}.tar.gz`;
  const bytes = await download(name);
  const expected = sums.split('\n').find(l => l.endsWith('  ' + name))?.split(/\s+/)[0];
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw Error(`Checksum mismatch: ${name}`);
  const extract = join(downloads, `node-${a}`); await mkdir(extract, { recursive: true });
  execFileSync('tar', ['-xzf', join(downloads, name), '-C', extract, '--strip-components=1']);
  await cp(join(extract, 'bin/node'), join(out, `node-${a}`)); await chmod(join(out, `node-${a}`), 0o755);
  await cp(join(extract, 'LICENSE'), join(out, 'NODE-LICENSE.txt'));
}
for (const dir of ['server', 'shared']) await cp(join(root, 'src', dir), join(out, 'server/src', dir), { recursive: true, filter: file => !/\.(test|spec)\./.test(file) });
const harnessInstallers = await prepareHarnessTools(out, arches, downloads);
await cp(join(root, 'src/cli.ts'), join(out, 'server/src/cli.ts'));
await cp(join(root, 'dist/ui'), join(out, 'server/dist/ui'), { recursive: true, filter: p => !p.endsWith('.map') });
await writeFile(join(out, 'server/package.json'), JSON.stringify({ name: 'visual-brain-runtime', private: true, type: 'module' }));
for (const name of ['ws', 'node-pty']) {
  const source = join(root, 'node_modules', name), dest = join(out, 'server/node_modules', name);
  await mkdir(dest, { recursive: true });
  await cp(join(source, 'package.json'), join(dest, 'package.json'));
  for (const entry of await readdir(source)) {
    if (/^LICENSE/i.test(entry) || (name === 'ws' && ['index.js', 'wrapper.mjs', 'browser.js'].includes(entry))) await cp(join(source, entry), join(dest, entry));
  }
  await cp(join(source, 'lib'), join(dest, 'lib'), { recursive: true, filter: p => !/\.test\.|\.map$/.test(p) });
  if (name === 'node-pty') for (const a of arches) {
    await cp(join(source, 'prebuilds', `darwin-${a}`), join(dest, 'prebuilds', `darwin-${a}`), { recursive: true });
    await chmod(join(dest, 'prebuilds', `darwin-${a}`, 'spawn-helper'), 0o755);
  }
}
// Tree-sitter runtime and the import grammars (WebAssembly: one copy serves every architecture).
const sitter = join(out, 'server/node_modules/web-tree-sitter');
await mkdir(sitter, { recursive: true });
for (const f of ['package.json', 'LICENSE', 'web-tree-sitter.js', 'web-tree-sitter.wasm']) await cp(join(root, 'node_modules/web-tree-sitter', f), join(sitter, f));
await cp(join(root, 'vendor/tree-sitter'), join(out, 'server/vendor/tree-sitter'), { recursive: true });
const nativeNotices = [];
const nativeArches = [];
const nativeCrates = [];
if (withNative) {
  const expected = { arm64: 'arm64', x64: 'x86_64' };
  for (const a of arches) {
    const bin = join(root, 'native/indexer/bin', `darwin-${a}`, 'vb-indexer');
    try { await access(bin); } catch { console.warn(`Native indexer for ${a} not built: that architecture uses the TypeScript engine.`); continue; }
    // never ship a binary built for the wrong architecture
    const archs = execFileSync('lipo', ['-archs', bin], { encoding: 'utf8' }).trim();
    if (archs !== expected[a]) throw Error(`vb-indexer for ${a} is ${archs}; rebuild with node scripts/build-indexer.mjs`);
    await mkdir(join(out, 'bin'), { recursive: true });
    await cp(bin, join(out, 'bin', `vb-indexer-${a}`)); await chmod(join(out, 'bin', `vb-indexer-${a}`), 0o755);
    nativeArches.push(a);
  }
  if (nativeArches.length) {
    // statically linked Rust crates: keep their licence notices with the binary
    const lock = await readFile(join(root, 'native/indexer/Cargo.lock'), 'utf8');
    const registry = join(homedir(), '.cargo/registry/src');
    const dirs = [];
    try { for (const d of await readdir(registry)) dirs.push(join(registry, d)); } catch {}
    for (const m of lock.matchAll(/name = "([^"]+)"\nversion = "([^"]+)"/g)) {
      if (m[1] === 'vb-indexer') continue;
      nativeCrates.push(`${m[1]} ${m[2]}`);
      for (const d of dirs) {
        const crate = join(d, `${m[1]}-${m[2]}`);
        let files = []; try { files = await readdir(crate); } catch { continue; }
        for (const f of files.filter(f => /^(LICENSE|LICENCE|COPYING|NOTICE)/i.test(f))) nativeNotices.push(`=== Rust crate ${m[1]} ${m[2]} / ${f} ===\n${await readFile(join(crate, f), 'utf8')}`);
        break;
      }
    }
  }
}
if (engineDefault) await writeFile(join(out, 'server/engine.default.json'), JSON.stringify({ engine: engineDefault }) + '\n');
await mkdir(join(out, 'server/docs'), { recursive: true });
await cp(join(root, 'docs/API.md'), join(out, 'server/docs/API.md'));
await cp(join(root, 'docs/HARNESSES.md'), join(out, 'server/docs/HARNESSES.md'));
// Preserve notices for JS packages, including libraries compiled into the UI.
const notices = [], visited = new Set();
async function license(name) {
  if (visited.has(name)) return; visited.add(name);
  const dir = join(root, 'node_modules', name), pkg = JSON.parse(await readFile(join(dir, 'package.json')));
  for (const f of await readdir(dir)) if (/^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(f)) notices.push(`=== ${name} ${pkg.version} / ${f} ===\n${await readFile(join(dir, f), 'utf8')}`);
  for (const dep of Object.keys(pkg.dependencies || {})) await license(dep);
}
for (const name of Object.keys(JSON.parse(await readFile(join(root, 'package.json'))).dependencies)) await license(name);
notices.push(`=== tree-sitter grammars (vendor/tree-sitter) ===\n${await readFile(join(root, 'vendor/tree-sitter/LICENSES.txt'), 'utf8')}`);
await writeFile(join(out, 'THIRD-PARTY-NOTICES.txt'), [...notices, ...(nativeCrates.length ? [`Native indexer (vb-indexer) statically links: ${nativeCrates.join(', ')}`] : []), ...nativeNotices].join('\n\n'));
await writeFile(join(out, 'manifest.json'), JSON.stringify({ app: 'Visual Brain', version: JSON.parse(await readFile(join(root, 'package.json'))).version, node: version, architectures: arches, harnessInstallers, engines: { default: engineDefault || 'ts', native: nativeArches } }, null, 2));
console.log(`Standalone runtime ready (${arches.join(', ')}): ${out}`);
