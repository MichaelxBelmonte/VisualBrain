// Files attached to a launch objective: the agents receive their paths in the prompt, never their content.
import type { IncomingMessage } from 'node:http';
import { createWriteStream, statSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { TeamError } from './team.ts';

export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** Uploaded copies older than this are removed at the next upload of the same node. */
const KEEP_MS = 30 * 24 * 60 * 60_000;

/** A display-safe file name: no folders, control characters or leading dots. */
export function attachmentName(raw: string): string {
  let name = '';
  try { name = decodeURIComponent(raw); } catch { name = raw; }
  name = basename(name.replace(/\\/g, '/')).replace(/[\p{Cc}/:]/gu, '_').replace(/^\.+/, '').trim().slice(-120);
  return name || 'file';
}

/**
 * Copy of a file chosen in the page (the browser does not expose its path): saved in the profile, outside the index,
 * in a folder of its own so that two files with the same name never overwrite each other.
 */
export async function saveAttachment(dataDir: string, nodeId: number, rawName: string, req: IncomingMessage): Promise<{ path: string; name: string; bytes: number }> {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_ATTACHMENT_BYTES) throw new TeamError(413, 'File troppo grande: massimo 50 MB');
  const root = join(dataDir, 'attachments', String(nodeId));
  await prune(root);
  const name = attachmentName(rawName);
  const dir = join(root, randomUUID());
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  let bytes = 0;
  const limit = new Transform({ transform(chunk: Buffer, _enc, done) { bytes += chunk.length; done(bytes > MAX_ATTACHMENT_BYTES ? new TeamError(413, 'File troppo grande: massimo 50 MB') : null, chunk); } });
  try { await pipeline(req, limit, createWriteStream(path, { flags: 'wx' })); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return { path, name, bytes };
}

async function prune(root: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(root); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    try { if (now - (await stat(join(root, entry))).mtimeMs > KEEP_MS) await rm(join(root, entry), { recursive: true, force: true }); }
    catch { /* best effort */ }
  }
}

/** Validates the attached paths of a launch request: absolute, existing and few. */
export function attachedFiles(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TeamError(400, 'Allegati non validi');
  if (value.length > MAX_ATTACHMENTS) throw new TeamError(400, `Al massimo ${MAX_ATTACHMENTS} allegati`);
  const files = [...new Set(value.map(v => {
    if (typeof v !== 'string' || !isAbsolute(v) || v.length > 1024 || /[\r\n]/.test(v)) throw new TeamError(400, 'Allegato non valido');
    return v;
  }))];
  for (const file of files) {
    try { statSync(file); } catch { throw new TeamError(400, `Allegato non trovato: ${basename(file)}`); }
  }
  return files;
}

/** The objective with the attached paths listed after it; files alone are a valid objective. */
export function withAttachments(prompt: string, files: string[], english: boolean): string {
  if (!files.length) return prompt;
  const list = (english ? 'Attached files (read them as part of the request):' : 'File allegati (leggili come parte della richiesta):') + '\n' + files.map(f => `- ${f}`).join('\n');
  return prompt ? `${prompt}\n\n${list}` : list;
}
