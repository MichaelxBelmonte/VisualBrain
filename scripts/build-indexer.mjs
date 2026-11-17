// Builds the optional native walker (native/indexer) for macOS arm64 and x64.
// Output: native/indexer/bin/darwin-<arm64|x64>/vb-indexer. Missing Rust toolchain or target → that arch is skipped
// with a message and a non-zero exit only when nothing was built; the TypeScript walker remains the fallback.
//   node scripts/build-indexer.mjs            both architectures
//   node scripts/build-indexer.mjs --host     only the architecture of this Mac
//   node scripts/build-indexer.mjs --test     also run `cargo test` first
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = join(ROOT, 'native', 'indexer');
const TARGETS = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' };
const args = new Set(process.argv.slice(2));
const archs = args.has('--host') ? [process.arch] : Object.keys(TARGETS);

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { cwd: CRATE, stdio: 'inherit', env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET || '11.0' } });
  return r.status === 0;
}

if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('build-indexer: cargo non trovato / cargo not found — il motore TypeScript resta attivo');
  process.exit(1);
}
const installed = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' }).stdout ?? '';

if (args.has('--test') && !run('cargo', ['test', '--release', '--offline'])) process.exit(1);

const built = [];
for (const arch of archs) {
  const triple = TARGETS[arch];
  if (!triple) continue;
  if (installed && !installed.includes(triple)) {
    console.warn(`build-indexer: target ${triple} mancante (rustup target add ${triple}) — salto ${arch}`);
    continue;
  }
  // Offline by default (the Rust crates are cached on the developer's Mac); CI has no cache yet and may download them (--locked still pins versions).
  const offline = existsSync(join(CRATE, 'Cargo.lock')) && !process.env.CI ? ['--offline'] : [];
  if (!run('cargo', ['build', '--release', '--locked', ...offline, '--target', triple])) {
    console.warn(`build-indexer: build ${triple} fallita`);
    continue;
  }
  const src = join(CRATE, 'target', triple, 'release', 'vb-indexer');
  const dst = join(CRATE, 'bin', `darwin-${arch}`, 'vb-indexer');
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  chmodSync(dst, 0o755);
  built.push(`${dst.slice(ROOT.length + 1)} (${Math.round(statSync(dst).size / 1024)} KB)`);
}
if (!built.length) process.exit(1);
console.log('build-indexer: ' + built.join(', '));
