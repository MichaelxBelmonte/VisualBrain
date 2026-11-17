// Can the app read the mapped folders? macOS asks once per app (Privacy › Files and Folders) before it may read the Desktop,
// Documents or Downloads. Without that permission every read fails with EPERM and the walk skips it in silence: the map just
// stays empty. This says which folders are blocked, so the page can explain how to allow them, and maps them again once allowed.
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';

export interface BlockedFolder { path: string; reason: 'permission' | 'missing' }

/** Privacy & Security › Files and Folders in System Settings. */
export const PRIVACY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';

const PERMISSION = new Set(['EPERM', 'EACCES']);

/** The roots that cannot be listed: refused by macOS (EPERM/EACCES) or gone (ENOENT/ENOTDIR). Other errors count as readable. */
export async function blockedFolders(roots: string[], read: (dir: string) => Promise<unknown> = readdir): Promise<BlockedFolder[]> {
  const blocked: BlockedFolder[] = [];
  for (const path of roots) {
    try { await read(path); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (PERMISSION.has(code)) blocked.push({ path, reason: 'permission' });
      else if (code === 'ENOENT' || code === 'ENOTDIR') blocked.push({ path, reason: 'missing' });
    }
  }
  return blocked;
}

/**
 * Checks the roots; when a folder that was refused becomes readable (the user allowed it in System Settings), `onAllowed`
 * maps again. Returns the current blocked list.
 */
export function folderAccess(roots: () => string[], onAllowed: () => void, read?: (dir: string) => Promise<unknown>): () => Promise<BlockedFolder[]> {
  let refused = new Set<string>();
  return async () => {
    const blocked = await blockedFolders(roots(), read);
    const now = new Set(blocked.filter(b => b.reason === 'permission').map(b => b.path));
    if ([...refused].some(path => !now.has(path))) onAllowed();
    refused = now;
    return blocked;
  };
}

/** Opens Files and Folders in System Settings (macOS only). */
export function openPrivacySettings(): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Solo su macOS.'));
  return new Promise((resolve, reject) => execFile('/usr/bin/open', [PRIVACY_SETTINGS], error => error ? reject(error) : resolve()));
}
