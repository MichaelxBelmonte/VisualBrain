// Files attached to a launch objective: safe names, size limit, validated paths, and paths listed in the prompt.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { attachedFiles, attachmentName, saveAttachment, withAttachments, MAX_ATTACHMENTS } from '../src/server/attachments.ts';

const dir = mkdtempSync(join(tmpdir(), 'vb-attach-'));
const upload = (body, length = body.length) => Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-length': String(length) } });
try {
  assert.equal(attachmentName(encodeURIComponent('../../etc/passwd')), 'passwd');
  assert.equal(attachmentName('.env'), 'env');
  assert.equal(attachmentName(encodeURIComponent('brief cliente.pdf')), 'brief cliente.pdf');
  assert.equal(attachmentName('%E0%A4%A'), '%E0%A4%A', 'malformed encoding is kept as text');
  assert.equal(attachmentName(''), 'file');

  const one = await saveAttachment(dir, 7, encodeURIComponent('note.md'), upload('# ciao'));
  const two = await saveAttachment(dir, 7, encodeURIComponent('note.md'), upload('# altro'));
  assert.notEqual(one.path, two.path, 'same name, separate copies');
  assert.equal(readFileSync(one.path, 'utf8'), '# ciao');
  assert.ok(one.path.startsWith(join(dir, 'attachments', '7') + '/'));
  await assert.rejects(saveAttachment(dir, 7, 'big.bin', upload('x', 60 * 1024 * 1024)), /troppo grande/);

  assert.deepEqual(attachedFiles(undefined), []);
  assert.deepEqual(attachedFiles([one.path, one.path]), [one.path], 'duplicates collapse');
  assert.throws(() => attachedFiles(['relative.md']), /non valido/);
  assert.throws(() => attachedFiles([join(dir, 'missing.md')]), /non trovato: missing.md/);
  assert.throws(() => attachedFiles(Array(MAX_ATTACHMENTS + 1).fill(one.path)), /Al massimo/);
  assert.throws(() => attachedFiles('x'), /non validi/);

  const local = join(dir, 'spec.txt'); writeFileSync(local, 'x');
  assert.equal(withAttachments('Fai il punto', [], false), 'Fai il punto');
  assert.equal(withAttachments('Fai il punto', [local], false), `Fai il punto\n\nFile allegati (leggili come parte della richiesta):\n- ${local}`);
  assert.equal(withAttachments('', [local], true), `Attached files (read them as part of the request):\n- ${local}`, 'files alone are an objective');
  assert.ok(existsSync(dirname(two.path)));
  console.log('attachments: ok');
} finally { rmSync(dir, { recursive: true, force: true }); }
