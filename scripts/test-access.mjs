// Folders macOS refuses to the app: detection, the notice, and mapping again once the user allows them.
// Uso: node scripts/test-access.mjs — nessuna rete, nessun permesso reale: le letture sono finte o in cartelle temporanee.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRIVACY_SETTINGS, blockedFolders, folderAccess } from '../src/server/access.ts';
import { accessBanner, folderName } from '../src/ui/access.ts';
import { setLanguage } from '../src/ui/i18n.ts';

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const fail = code => Object.assign(new Error(code), { code });

// --- detection ----------------------------------------------------------------------------------------------------------
const reads = { '/h/Desktop': fail('EPERM'), '/h/Documents': fail('EACCES'), '/h/gone': fail('ENOENT'), '/h/file': fail('ENOTDIR'), '/h/busy': fail('EMFILE') };
const read = async dir => { if (reads[dir]) throw reads[dir]; return []; };
eq(await blockedFolders(['/h/Desktop', '/h/ok', '/h/Documents', '/h/gone', '/h/file', '/h/busy'], read), [
  { path: '/h/Desktop', reason: 'permission' }, { path: '/h/Documents', reason: 'permission' },
  { path: '/h/gone', reason: 'missing' }, { path: '/h/file', reason: 'missing' },
], 'EPERM/EACCES are refusals, ENOENT/ENOTDIR missing folders; a transient error is not reported');
const temp = mkdtempSync(join(tmpdir(), 'vb-access-test-'));
try {
  const locked = join(temp, 'locked'); mkdirSync(locked); chmodSync(locked, 0o000);
  try {
    if (process.getuid?.() !== 0) eq(await blockedFolders([temp, locked, join(temp, 'missing')]), [{ path: locked, reason: 'permission' }, { path: join(temp, 'missing'), reason: 'missing' }], 'real reads: an unreadable folder and a missing one');
  } finally { chmodSync(locked, 0o755); }
} finally { rmSync(temp, { recursive: true, force: true }); }

// --- mapping again once allowed -----------------------------------------------------------------------------------------
let allowed = 0, desktop = fail('EPERM');
const check = folderAccess(() => ['/h/Desktop', '/h/ok'], () => allowed++, async dir => { if (dir === '/h/Desktop' && desktop) throw desktop; return []; });
eq((await check()).length, 1, 'the Desktop is refused');
await check(); eq(allowed, 0, 'still refused: nothing to map');
desktop = null;
eq((await check()).length, 0, 'the user allowed it');
eq(allowed, 1, 'the folder is mapped again right away');
await check(); eq(allowed, 1, 'once');
const quiet = folderAccess(() => ['/h/ok'], () => allowed++, async () => []);
await quiet(); await quiet(); eq(allowed, 1, 'readable from the start: no extra mapping');
ok(PRIVACY_SETTINGS.startsWith('x-apple.systempreferences:com.apple.preference.security?Privacy_'), 'the button opens Privacy & Security');

// --- wording ------------------------------------------------------------------------------------------------------------
setLanguage('it');
eq(folderName('/Users/me/Desktop', '/Users/me'), 'Scrivania', 'the Desktop is called by its name');
eq(folderName('/Users/me/Progetti/x', '/Users/me'), '~/Progetti/x', 'other folders use ~');
eq(folderName('/Volumes/Dati', '/Users/me'), '/Volumes/Dati', 'outside home: the full path');
const view = (blocked, platform = 'darwin') => ({ blocked, platform });
eq(accessBanner(view([]), '/Users/me'), null, 'nothing to say when every folder is readable');
const refused = accessBanner(view([{ path: '/Users/me/Desktop', reason: 'permission' }, { path: '/Users/me/gone', reason: 'missing' }]), '/Users/me');
ok(refused.kind === 'permission' && /leggere Scrivania/.test(refused.text) && /File e cartelle/.test(refused.text) && /si aggiorna da sola/.test(refused.text), 'a refusal says which folder, where to allow it and that the map follows');
ok(/Cartelle mappate/.test(accessBanner(view([{ path: '/Users/me/gone', reason: 'missing' }]), '/Users/me').text), 'a missing folder points to the folder settings');
eq(accessBanner(view([{ path: '/Users/me/Desktop', reason: 'permission' }]), '/Users/me', true), null, 'it can be dismissed');
setLanguage('en');
ok(/does not let Visual Brain read Desktop: the map stays empty\. In System Settings › Privacy & Security › Files and Folders/.test(accessBanner(view([{ path: '/Users/me/Desktop', reason: 'permission' }]), '/Users/me').text), 'English wording');
setLanguage('it');

// --- wiring -------------------------------------------------------------------------------------------------------------
const src = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
ok(/\/api\/access/.test(src('src/server/api.ts')) && /folderAccess\(/.test(src('src/server/server.ts')) && /startIndex\(\)/.test(src('src/server/server.ts')), 'API wired; an allowed folder starts a scan');
ok(/id="access-banner"/.test(src('src/ui/index.html')) && /new Access\(/.test(src('src/ui/main.ts')), 'the banner is on the page');
console.log(`test-access: ${checks} controlli ok`);
