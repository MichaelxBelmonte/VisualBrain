// Writes and signs the update feed for a packaged release: latest.json + latest.json.sig (Ed25519 over the exact bytes).
// The private key never leaves the owner's Mac: .release-keys/update-private.pem (or VB_UPDATE_PRIVATE_KEY for a one-off run).
// Uso: node scripts/make-feed.mjs --zip release/Visual-Brain-X.Y.Z-mac-universal.zip [--out DIR] [--notes "testo"]
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { UPDATE_REPO, parseFeed } from '../src/server/updater.ts';
import { UPDATE_PUBLIC_KEY } from '../src/server/update-key.ts';

const root = resolve(import.meta.dirname, '..');
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);

export function buildFeed(zip, notes = '') {
  const name = basename(zip);
  const version = /^Visual-Brain-([0-9.]+)-mac-universal\.zip$/.exec(name)?.[1];
  if (!version) throw Error(`Nome del pacchetto inatteso: ${name}`);
  const bytes = readFileSync(zip);
  return {
    schema: 1, app: 'visual-brain', version, publishedAt: new Date().toISOString(), notes,
    archive: { name, url: `https://github.com/${UPDATE_REPO}/releases/download/v${version}/${name}`, size: statSync(zip).size, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
}

export function signFeed(feed, pem) {
  const text = JSON.stringify(feed, null, 2) + '\n';
  const signature = sign(null, Buffer.from(text, 'utf8'), createPrivateKey(pem)).toString('base64');
  parseFeed(text, signature, UPDATE_PUBLIC_KEY); // the embedded public key must accept it, or installed apps would refuse the update
  return { text, signature };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const zip = arg('zip'); if (!zip) throw Error('Uso: node scripts/make-feed.mjs --zip FILE.zip [--out DIR] [--notes "testo"]');
  const pem = process.env.VB_UPDATE_PRIVATE_KEY || readFileSync(join(root, '.release-keys/update-private.pem'), 'utf8');
  const out = resolve(arg('out') ?? join(root, 'release/feed')); mkdirSync(out, { recursive: true });
  const { text, signature } = signFeed(buildFeed(resolve(zip), arg('notes') ?? ''), pem);
  writeFileSync(join(out, 'latest.json'), text); writeFileSync(join(out, 'latest.json.sig'), signature + '\n');
  console.log(`Feed firmato in ${out}`);
}
