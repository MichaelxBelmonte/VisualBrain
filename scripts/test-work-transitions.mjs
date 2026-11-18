// Invoked by test-ui-chrome.mjs --transitions. The page uses the real renderers with an in-memory team.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function checkTransitions(Terminals, mountWorkBoard) {
  function expect(condition, message) {
    if (!condition) throw new Error(message);
  }
  let now = 200_000;
  Date.now = () => now;
  const members = ['OP1', 'OP2'].map(id => ({
    id, code: id, name: id, nodeId: 1, agent: 'codex', role: 'operator', cwd: '/fixture',
    alive: true, workState: 'working', stateAt: now, lastOutputAt: now, createdAt: 1,
  }));
  const [active] = members;
  const view = { sessions: members, tasks: [], messages: [], inbox: [], peers: [], summary: '', policy: {}, teamList: [], team: { id: '1' } };
  window.fetch = async () => ({ ok: true, text: async () => JSON.stringify(view) });
  const board = document.getElementById('board');
  const update = mountWorkBoard(board, {});
  async function pollBoard() {
    update([{ id: 1, name: 'Nodo' }], 1, true);
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const list = document.getElementById('list');
  const rail = Object.assign(Object.create(Terminals.prototype), {
    root: document.body, listEl: list, active: null, selectedNode: 1,
    tabs: new Map(members.map(info => [info.id, { info }])), nodes: new Map([[1, { name: 'Nodo', path: '/fixture' }]]),
    links: [], nodeOrder: [], sessionOrder: [], filter: '', stateFilter: 'all', collapsedNodes: new Set(),
    railDragCleanup: [], picker: { open: false }, sel: { ids: [] }, cb: { sessionsChanged() {} },
    control: () => null, renderTabs() {}, renderNodeMenu() {}, syncSel() {}, bindNodeDrag() {}, renderRailLinks() {},
  });
  const row = id => list.querySelector(`[data-sid="${id}"]`);
  const chip = id => board.querySelector(`.member-chip[data-goto="${id}"]`);
  rail.renderList();
  await pollBoard();

  const quietRow = row('OP2'), quietChip = chip('OP2');
  const button = quietRow.querySelector('button[data-session]');
  const hint = board.querySelector('.lavoro-hint');
  expect(quietChip && hint, 'board fixture must be ready');
  button.focus();
  rail.railPreviewId = 'OP2';
  rail.markPreviewRow();
  active.workState = 'blocked';
  rail.renderList();
  await pollBoard();
  expect(row('OP2') === quietRow && document.activeElement === button && quietRow.classList.contains('previewed'), 'unchanged rail row, focus and preview must survive a transition');
  expect(chip('OP2') === quietChip && board.querySelector('.lavoro-hint') === hint, 'unchanged member and board hint must keep their DOM nodes');
  expect(row('OP1').dataset.tone === 'blocked' && chip('OP1').dataset.tone === 'blocked', 'both views must show the new tone');

  active.workState = 'working';
  rail.renderList();
  await pollBoard();
  now += 4000;
  await pollBoard();
  expect(chip('OP1').title.includes('4 s fa'), 'the member tooltip must advance on an unchanged poll');

  rail.stateFilter = 'active';
  rail.renderList();
  active.attention = 'permission';
  rail.renderList();
  await pollBoard();
  expect(!row('OP1') && row('OP2') === quietRow, 'changing filter membership must preserve surviving rows');
  expect(board.querySelector('[data-lane="you"] [data-goto="OP1"]'), 'the permission card must appear in Serve te');
  delete active.attention;
  rail.renderList();
  await pollBoard();
  expect(row('OP1') && row('OP2') === quietRow && chip('OP2') === quietChip, 'reinserting a filtered session must preserve its neighbours');
  expect(!board.querySelector('[data-lane="you"] [data-goto="OP1"]'), 'resolved permission must leave Serve te');
}

export async function testTransitions() {
  const dir = mkdtempSync(join(tmpdir(), 'vb-work-transitions-'));
  try {
    const contents = `
      import { Terminals } from './src/ui/terminal.ts';
      import { mountWorkBoard } from './src/ui/work-board.ts';
      (${checkTransitions.toString()})(Terminals, mountWorkBoard).then(
        () => document.body.dataset.result = 'pass',
        err => document.body.dataset.result = String(err)
      );`;
    const bundle = await build({
      stdin: { contents, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
      bundle: true, write: false, format: 'iife', logLevel: 'silent',
    });
    writeFileSync(join(dir, 'test.js'), bundle.outputFiles[0].contents);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="list"></div><div id="board"></div><span id="session-count"></span><script src="test.js"></script>');
    const chrome = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
    const html = execFileSync(chrome, [
      '--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run',
      '--user-data-dir=' + join(dir, 'browser'), '--virtual-time-budget=1000', '--dump-dom',
      pathToFileURL(join(dir, 'index.html')).href,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    const result = html.match(/data-result="([^"]*)"/)?.[1];
    if (result !== 'pass') throw new Error(result ?? 'Chrome did not finish the transitions test');
    console.log('PASS session transitions: row and member identity, focus, preview, filters, permission cards and relative time');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
