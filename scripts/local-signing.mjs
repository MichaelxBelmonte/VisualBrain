// A persistent, non-Apple signing identity. Private material stays in .release-keys (never in the package/repository).
// The explicit designated requirement pins both the bundle identifier and the signing certificate.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function localSigning(root) {
  const dir = join(root, '.release-keys/local-code-signing');
  if (!existsSync(join(dir, 'identity.json'))) return null;
  const info = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'));
  const certificate = readFileSync(join(dir, 'certificate.der'));
  if (info.schema !== 1 || info.keychain !== 'signing.keychain-db'
    || createHash('sha1').update(certificate).digest('hex').toUpperCase() !== info.sha1
    || createHash('sha256').update(certificate).digest('hex') !== info.sha256) throw Error('Local signing identity does not match its certificate; do not regenerate it.');
  return { ...info, dir, keychain: join(dir, info.keychain) };
}

export function unlockLocalSigning(identity) {
  const password = readFileSync(join(identity.dir, 'keychain-password'), 'utf8');
  try { execFileSync('/usr/bin/security', ['unlock-keychain', '-p', password, identity.keychain], { stdio: 'pipe' }); }
  catch { throw Error('Cannot unlock the dedicated Visual Brain signing keychain.'); }
}

export function localRequirement(identifier, certificateSha1) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier) || !/^[A-Fa-f0-9]{40}$/.test(certificateSha1)) throw Error('Invalid local signing requirement');
  return `identifier "${identifier}" and certificate leaf = H"${certificateSha1}"`;
}

export function signLocal(path, identity, identifier) {
  // codesign requires the identity's keychain on the search list even with --keychain.
  // Add just our keychain temporarily, retaining every existing/default keychain.
  const search = () => execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => JSON.parse(line.trim()));
  const before = search(), added = !before.includes(identity.keychain);
  if (added) execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...before, identity.keychain], { stdio: 'pipe' });
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', identity.sha1, '--keychain', identity.keychain,
      '--identifier', identifier, '--timestamp=none', '--requirements', `=designated => ${localRequirement(identifier, identity.sha1)}`, path], { stdio: 'pipe' });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R', '=' + localRequirement(identifier, identity.sha1), path], { stdio: 'pipe' });
  } finally {
    if (added) execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...search().filter(p => p !== identity.keychain)], { stdio: 'pipe' });
  }
}

/** Public release policy. A missing private identity must never silently revert a published release to ad-hoc. */
export function verifyReleaseIdentity(root, app) {
  const policyPath = join(root, 'scripts/signing-policy.json');
  if (!existsSync(policyPath)) throw Error('Missing public release signing policy.');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  if (policy.schema !== 1) throw Error('Unknown signing policy');
  try { execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=' + localRequirement('com.jethr.visualbrain', policy.certificateSha1), app], { stdio: 'pipe' }); }
  catch { throw Error('Release signature is not the stable Visual Brain identity. Sign it locally before publishing; never fall back to ad-hoc.'); }
}
