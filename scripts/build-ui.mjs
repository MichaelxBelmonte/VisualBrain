// Bundles the browser UI with esbuild. `--watch` rebuilds on every change.
import { build, context, transformSync } from 'esbuild';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'ui');
const watch = process.argv.includes('--watch');
mkdirSync(out, { recursive: true });

const options = {
  entryPoints: [join(root, 'src/ui/main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: out,
  sourcemap: watch ? true : 'external',
  minify: !watch,
  logLevel: 'info',
  loader: { '.css': 'css' },
};

function copyStatic() {
  copyFileSync(join(root, 'src/ui/index.html'), join(out, 'index.html'));
  const css = readFileSync(join(root, 'src/ui/style.css'), 'utf8');
  const xterm = readFileSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8');
  const styles = xterm + '\n' + css;
  writeFileSync(join(out, 'style.css'), watch ? styles : transformSync(styles, { loader: 'css', minifyWhitespace: true }).code);
}

if (watch) {
  const ctx = await context(options);
  copyStatic();
  await ctx.watch();
  console.log('[ui] watching');
} else {
  copyStatic();
  await build(options);
}
