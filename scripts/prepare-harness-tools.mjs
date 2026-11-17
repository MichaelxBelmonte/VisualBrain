// Build-time only: verified uv binaries and npm from the verified Node distribution.
import { mkdir, readFile, writeFile, cp, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const UV_VERSION = '0.13.3';
const UV = {
  arm64: { target: 'aarch64-apple-darwin', sha256: 'bf1e4fb6f5f5079a2902ad3f3a9e2d337575b226a1378f2449d8404353650608' },
  x64: { target: 'x86_64-apple-darwin', sha256: '5c35634957db7ebd9c2e4cc6c66b8979fb2c26a6b0dbd1d214d6acbac4033a89' },
};
async function cached(file, url) {
  try { return await readFile(file); } catch {}
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw Error(`Download failed: ${url} (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  await writeFile(file, data);
  return data;
}
export async function prepareHarnessTools(out, arches, downloads) {
  await mkdir(join(out, 'bin'), { recursive: true });
  for (const arch of arches) {
    const { target, sha256 } = UV[arch], name = `uv-${target}.tar.gz`;
    const archive = join(downloads, `uv-${UV_VERSION}-${target}.tar.gz`);
    const bytes = await cached(archive, `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}`);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error(`Checksum mismatch: ${name}`);
    const unpack = join(downloads, `uv-${UV_VERSION}-${arch}`);
    await mkdir(unpack, { recursive: true });
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', unpack]);
    await cp(join(unpack, `uv-${target}`, 'uv'), join(out, 'bin', `uv-${arch}`));
    await chmod(join(out, 'bin', `uv-${arch}`), 0o755);
  }
  const npm = join(downloads, `node-${arches[0]}`, 'lib/node_modules/npm');
  await mkdir(join(out, 'server/vendor'), { recursive: true });
  await cp(npm, join(out, 'server/vendor/npm'), { recursive: true });
  const notices = [await readFile(join(npm, 'LICENSE'), 'utf8')];
  for (const name of ['LICENSE-MIT', 'LICENSE-APACHE']) {
    const bytes = await cached(join(downloads, `uv-${UV_VERSION}-${name}`), `https://raw.githubusercontent.com/astral-sh/uv/${UV_VERSION}/${name}`);
    notices.push(`uv ${UV_VERSION} / ${name}\n${bytes.toString()}`);
  }
  await writeFile(join(out, 'HARNESS-INSTALLER-NOTICES.txt'), notices.join('\n\n'));
  return { uv: UV_VERSION, npm: JSON.parse(await readFile(join(npm, 'package.json'))).version };
}
