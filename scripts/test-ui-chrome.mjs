// Window chrome and icons: Lucide paths for controls and map nodes, native glass behind the shell and the terminals, minimal remote permissions.
// Uso: node scripts/test-ui-chrome.mjs — nessun server, nessuna app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { glyphOf, icon } from '../src/ui/icons.ts';
import { nativeMac } from '../src/ui/window-chrome.ts';

const svg = icon('close');
assert.match(svg, /viewBox="0 0 24 24"/);
assert.equal((svg.match(/<path /g) ?? []).length, 2, 'every Lucide shape keeps its own path: relative moves stay relative');
assert.match(readFileSync(new URL('../src/ui/icons.ts', import.meta.url), 'utf8'), /^\/\*! Icon paths from Lucide[\s\S]*ISC License/, 'the licence notice survives bundling');

const glyph = (kind, cls) => glyphOf({ kind, cls });
assert.equal(glyph('file', 'code'), 'code');
assert.equal(glyph('file', 'sheet'), 'sheet');
assert.equal(glyph('dir', 'project'), 'project');
assert.equal(glyph('dir', 'folder'), 'folder');
assert.equal(glyph('dir', 'unknown-role'), 'folder');
assert.equal(glyph('file', 'unknown-class'), 'other');
assert.equal(glyph('external', 'other'), 'external');
assert.equal(glyph('symlink', 'code'), 'symlink');
assert.equal(glyph('area', 'folder'), null, 'groups have no glyph');
assert.equal(glyph('dir', 'rest'), null);
assert.equal(glyph('file', 'session'), null);
assert.equal(nativeMac, false, 'outside the Mac app nothing turns transparent');

const conf = JSON.parse(readFileSync(new URL('../app/src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.windows[0];
assert.equal(conf.titleBarStyle, 'Overlay');
assert.equal(conf.trafficLightPosition, undefined, 'the shell places the traffic lights itself: Tauri only does it on a redraw that never comes');
const shell = readFileSync(new URL('../app/src-tauri/src/main.rs', import.meta.url), 'utf8');
assert.match(shell, /const BAR: f64 = 56\.0;/, 'traffic lights centred on the 56 px top bar');
assert.match(shell, /WindowEvent::Resized\(_\) \| tauri::WindowEvent::Focused\(_\)[^\n]*traffic_lights::place\(window\)/, 'placed again whenever AppKit may reset them');
assert.equal(conf.transparent, true);
assert.deepEqual(conf.windowEffects.effects, ['liquidGlassRegular', 'sidebar'], 'Liquid Glass on macOS 26, sidebar material before');
const cap = JSON.parse(readFileSync(new URL('../app/src-tauri/capabilities/local-ui.json', import.meta.url), 'utf8'));
assert.deepEqual(cap.remote.urls, ['http://127.0.0.1:*'], 'only the local server page gets these commands');
assert.deepEqual(cap.permissions.sort(), ['core:window:allow-internal-toggle-maximize', 'core:window:allow-set-theme', 'core:window:allow-start-dragging']);

const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
assert.match(html, /<header id="top" data-tauri-drag-region="deep">/, 'the top bar moves the window; its buttons stay clickable');
const css = readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
assert.match(css, /:root\.vb-glass \.term-body \.terminal-surface \{ background: var\(--glass-term\); \}/, 'terminals let the glass through');
assert.match(css, /:root\.vb-glass \.term-body \.xterm \.xterm-viewport \{ background-color: transparent; \}/, 'xterm.css does not cover the glass with its black scroll layer');
assert.match(css, /--glass-term: color-mix\(in srgb, var\(--bg\) 62%, transparent\)/, 'denser than the chrome, for the text');
assert.match(css, /prefers-reduced-transparency: reduce\)[^\n]*\.terminal-surface \{ background: var\(--bg\)/, 'solid again when the system asks for less transparency');
assert.match(css, /--stage-alpha: 0\.42/, 'the map lets the glass through');
assert.match(css, /prefers-reduced-transparency/);
// indexing shows only the corner dot: a notice in the status bar would stay there, nothing clears it at the end of a pass
const mainTs = readFileSync(new URL('../src/ui/main.ts', import.meta.url), 'utf8');
const toolbarTs = readFileSync(new URL('../src/ui/toolbar.ts', import.meta.url), 'utf8');
assert.doesNotMatch(mainTs, /setProgress\([^)]*(ndicizzazione|aggiornamento dai file)/, 'no lasting indexing notice in main.ts');
assert.doesNotMatch(toolbarTs, /setProgress\([^)]*Aggiornamento/, 'the rescan notice is a flash');
assert.match(mainTs, /indexDot\(store\.status\.indexing/, 'a pass already running at load shows the dot');
// Renaming with tabs: the heading hides the name (the tab shows it), so the field takes the tabs' place while it is open,
// a double click on a tab renames it, and the click that activates the tab does not move the focus into the terminal.
const termTs = readFileSync(new URL('../src/ui/terminal.ts', import.meta.url), 'utf8');
assert.match(css, /\.term-pane\.renaming \.session-heading > \.session-label \{ display: inline-flex;/);
assert.match(css, /\.term-pane\.renaming \.session-head \.term-tabs \{ display: none; \}/);
assert.match(termTs, /tabStrip\.addEventListener\('dblclick'[^\n]*startRename/);
assert.match(termTs, /if \(!t\.pane\?\.classList\.contains\('renaming'\)\) t\.term\?\.focus\(\)/);
console.log('PASS Lucide icons and map glyphs, glass on the shell and, denser, behind the terminals, indexing only as the corner dot, local-only window permissions, renaming a session shown in tabs');

// The node menu says which node it is for and what closing it stops; the app menu is grouped, the theme a two-way switch.
const nodeMenu = html.match(/<details class="work-overflow work-node-options">[\s\S]*?<\/details>/)[0];
assert.match(nodeMenu, /<summary[^>]*>[^]*id="work-node-title"[^]*▾/, 'the node menu is labelled with the node, not three dots');
assert.ok(!nodeMenu.includes('data-icon="more"'));
assert.match(nodeMenu, /<button id="work-close-node" class="danger">/);
assert.match(termTs, /private confirmCloseNode\(id: number\)[^]*if \(!sessions\.length\) \{ void this\.closeNode\(id\); return; \}[^]*role="alertdialog"/, 'sessions are listed and confirmed before they are stopped');
assert.match(termTs, /private async closeNode\(id: number\)[^]*\.map\(t => this\.close\(t\.info\.id\)\)[^]*if \(\[\.\.\.this\.tabs\.values\(\)\]\.some\(t => t\.info\.nodeId === id\)\) return;/, 'a session that will not stop keeps its node');
assert.match(termTs, /'work-launch', 'work-team', 'work-close-node'/, 'Esc dismisses the confirmation');
// ⚙ opens Impostazioni directly; the map's own actions sit in its "Vista" menu, the look in Impostazioni → Generale.
const view = toolbarTs.slice(toolbarTs.indexOf('private edgesMenu()'), toolbarTs.indexOf('private bindEdgesMenu()'));
assert.deepEqual([...view.matchAll(/<h4>([^<]+)<\/h4>/g)].map(m => m[1]).slice(0, 2), ['Mappa', 'Quali collegamenti mostrare']);
assert.match(toolbarTs, /getElementById\('btn-more'\)!\.addEventListener\('click', \(\) => \{ this\.closeMenus\(\); void openSettings\(\)/);
const settingsTs = readFileSync(new URL('../src/ui/settings.ts', import.meta.url), 'utf8');
assert.match(settingsTs, /\['general', 'Generale'\], \['folders', 'Cartelle mappate'\], \['agents', 'Agenti'\], \['github', 'GitHub'\], \['updates', 'Aggiornamenti'\], \['shortcuts', 'Scorciatoie'\]/);
assert.match(settingsTs, /data-theme="light">Chiaro<\/button><button data-theme="dark">Scuro/);
const { setLanguage, t, ui } = await import('../src/ui/i18n.ts');
setLanguage('en');
assert.equal(t('<h4>Mappa</h4>'), '<h4>Map</h4>');
assert.equal(ui`termina le sue ${3} sessioni e lo toglie dalla vista`, 'stops its 3 sessions and removes it from view');
assert.equal(ui`<span>Chiudere ${'X'}?</span>`, '<span>Close X?</span>');
setLanguage('it');
console.log('PASS node menu named after its node, closing a node confirmed with its sessions listed, settings in one window');
