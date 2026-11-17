// Execute the real Terminals methods with disposable state, without opening a PTY or browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { nodePickerGroups } from '../src/ui/work-tiles.ts';

const bundle = await build({
  entryPoints: [resolve(import.meta.dirname, '../src/ui/terminal.ts')],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'unused-xterm', setup(builder) {
    builder.onResolve({ filter: /^@xterm\// }, args => ({ path: args.path, namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class Terminal {} export class FitAddon {}', loader: 'js' }));
  } }],
});
const { Terminals } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
const cls = new Set();
globalThis.document = { body: { classList: { contains: name => cls.has(name) } } };
const sessions = Array.from({ length: 9 }, (_, i) => ({ id: `a${i + 1}`, nodeId: 138, alive: true, createdAt: i }));
const state = () => {
  const t = Object.create(Terminals.prototype);
  Object.assign(t, {
    tabs: new Map(sessions.map(info => [info.id, { info, term: {}, ws: {}, pane: {} }])),
    views: new Map([[138, { hidden: [], guests: [], page: 1 }]]), links: [], selectedNode: 138,
    active: 'a6', tiled: true, composed: false, tileOrder: [], sel: { ids: [], focus: null },
    renderBody() { this.syncSel(); }, renderList() { this.syncSel(); },
  });
  t.syncSel(); return t;
};
const t = state(), originalTabs = new Map(t.tabs);
assert.deepEqual(t.sel.ids, ['a5', 'a6', 'a7', 'a8']);
t.moveTerminal('a8', 'a5');
assert.deepEqual(t.sel, { ids: ['a8', 'a5', 'a6', 'a7'], focus: 'a6' });
assert.deepEqual(t.nodeViewList(), ['a1', 'a2', 'a3', 'a4', 'a8', 'a5', 'a6', 'a7', 'a9'], 'reordering page two preserves page one and page three');
assert.deepEqual(JSON.parse(memory.get('vb:tile-order')), t.nodeViewList(), 'the complete order is saved, including the other pages');
t.views.get(138).page = 0; t.syncSel();
assert.deepEqual(t.sel.ids, ['a1', 'a2', 'a3', 'a4']);
t.active = 'a2'; t.syncSel(); t.moveTerminal('a4', 'a1');
assert.deepEqual(t.nodeViewList(), ['a4', 'a1', 'a2', 'a3', 'a8', 'a5', 'a6', 'a7', 'a9'], 'reordering another page preserves the first manual move');
for (const [id, tab] of originalTabs) {
  assert.equal(t.tabs.get(id), tab, 'tab identity is preserved');
  assert.equal(t.tabs.get(id).term, tab.term); assert.equal(t.tabs.get(id).ws, tab.ws); assert.equal(t.tabs.get(id).pane, tab.pane);
}
const reload = state(); reload.tileOrder = JSON.parse(memory.get('vb:tile-order')); reload.syncSel();
assert.deepEqual(reload.sel.ids, ['a8', 'a5', 'a6', 'a7'], 'saved order is restored before pagination');
const picked = nodePickerGroups(sessions, 138, { hidden: [], guests: [], page: 1 }, [], String, reload.tileOrder)[0].items;
assert.deepEqual(reload.sel.ids.map(id => picked.find(item => item.id === id).tile), [1, 2, 3, 4], 'picker badges match rendered tile order');
reload.tabs.delete('a5'); reload.syncSel();
assert.deepEqual(reload.sel.ids, ['a8', 'a6', 'a7', 'a9'], 'a vanished session reconciles and fills the current page');
reload.tabs.set('new', { info: { id: 'new', nodeId: 138, alive: true, createdAt: 100 } });
assert.equal(reload.nodeViewList().at(-1), 'new', 'a newly launched terminal follows the saved order');

const composed = state();
composed.composed = true; composed.sel = { ids: ['a1', 'a3', 'a7'], focus: 'a3' };
composed.moveTerminal('a7', 'a1');
assert.deepEqual(composed.sel, { ids: ['a7', 'a1', 'a3'], focus: 'a3' }, 'composition keeps its selected sessions and focus');

// Real keyboard binding: a downward arrow crosses grid rows without moving DOM panes.
const keyboard = state();
keyboard.tileDragCleanup = null;
const handles = keyboard.sel.ids.map(() => Object.assign(new EventTarget(), { style: {}, focus() {} }));
keyboard.sel.ids.forEach((id, i) => { keyboard.tabs.get(id).pane = { dataset: { session: id }, querySelector: () => handles[i] }; });
keyboard.bindTileDrag(keyboard.sel.ids);
let prevented = false;
handles[0].onkeydown({ key: 'ArrowDown', preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.deepEqual(keyboard.sel.ids, ['a6', 'a7', 'a5', 'a8'], 'ArrowDown moves a tile by two slots');
keyboard.tileDragCleanup();

const actual = Object.create(Terminals.prototype);
cls.add('reordering');
assert.doesNotThrow(() => actual.renderBody(), 'polling does not rebuild the terminal grid during a drag');
assert.doesNotThrow(() => actual.renderList(), 'polling does not rebuild the rail during a drag');
cls.clear();
let cleaned = 0;
const fakeControl = { classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {} };
Object.assign(actual, {
  tileDragCleanup() { cleaned++; }, sideOpen: true,
  nodes: new Map([[138, { name: "fixture node" }]]), selectedNode: 138,
  root: { classList: fakeControl.classList, querySelector: () => fakeControl },
  bodyEl: fakeControl, syncChannel() {},
});
actual.renderBody();
assert.equal(cleaned, 1, 'switching to personal reminders cleans up grid pointer listeners');
assert.equal(actual.tileDragCleanup, null);
const source = readFileSync(new URL('../src/ui/terminal.ts', import.meta.url), 'utf8');
assert.match(source, /nodePickerGroups\(infos, this\.selectedNode, view, this\.links, id => this\.nodeLabel\(id\), this\.tileOrder\)/, 'the real picker receives manual order');
// Reminders are a filter of Lavoro: created and moved through the reminders API, never through a terminal.
const board = readFileSync(new URL('../src/ui/work-board.ts', import.meta.url), 'utf8');
assert.match(board, /api\.createReminder/); assert.match(board, /api\.updateReminder/); assert.match(board, /api\.reminders\(\)/);
console.log('PASS real terminal methods: cross-page reorder, persistence/reload, reconciliation, focus, pane identity, grid keyboard, polling guards, picker wiring and independent reminders');

// Sidebar moves whole node modules and session rows from dedicated keyboard handles.
const rail = Object.create(Terminals.prototype);
const nodeHandle = () => Object.assign(new EventTarget(), { style: {} });
const nodeRows = [1, 3].map(id => {
  const grip = nodeHandle(), label = nodeHandle();
  return { dataset: { drag: String(id) }, grip, label,
    querySelector: sel => sel === '.work-node' ? label : grip,
    querySelectorAll: () => [] };
});
const sessionRows = ['s1', 's2'].map(id => {
  const grip = nodeHandle();
  return { dataset: { sid: id }, grip, querySelector: () => grip };
});
nodeRows[0].querySelectorAll = () => sessionRows;
const tabObjects = ['s1','s2'].map(id => ({ info: { id, nodeId:1, role:'operator' }, term:{}, ws:{} }));
Object.assign(rail, {
  nodes: new Map([[1,{}],[2,{}],[3,{}]]), tabs: new Map(tabObjects.map(t => [t.info.id,t])),
  nodeOrder: [1,2,3], sessionOrder: [], links: [{srcNodeId:1,dstNodeId:3}], railDragCleanup: [],
  listEl: { querySelectorAll: () => nodeRows }, renderList() {},
});
rail.bindNodeDrag();
nodeRows[1].grip.onkeydown({altKey:true, key:'ArrowUp', preventDefault(){}});
assert.deepEqual(rail.nodeOrder,[3,1,2], 'filtered node reorder follows visible target and retains hidden nodes');
assert.deepEqual(JSON.parse(memory.get('vb:node-order')),[3,1,2]);
sessionRows[1].grip.onkeydown({altKey:true,key:'ArrowUp',preventDefault(){}});
assert.deepEqual(rail.sessionOrder,['s2','s1']);
assert.deepEqual(JSON.parse(memory.get('vb:session-order')),['s2','s1']);
for (const tab of tabObjects) { assert.equal(rail.tabs.get(tab.info.id),tab); assert.equal(tab.info.nodeId,1); }
rail.railDragCleanup.forEach(cleanup => cleanup());
console.log('PASS sidebar: dedicated node/session handles, filtered reorder retains other nodes, persistence and session ownership unchanged');

// Real sidebar handlers scope new agents and connections to the row, preserving every terminal.
const sidebar = Object.create(Terminals.prototype), buttons = new Map();
const list = { dataset: {}, contains: () => false, html: '',
  set innerHTML(value) {
    this.html = value; buttons.clear();
    for (const match of value.matchAll(/<button\b([^>]*)>/g)) {
      const attrs = [...match[1].matchAll(/data-([\w-]+)="([^"]*)"/g)];
      if (!attrs.length) continue;
      const dataset = Object.fromEntries(attrs.map(([, key, val]) => [key.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), val]));
      for (const [, key, val] of attrs) buttons.set(`[data-${key}="${val}"]`, { dataset, focus() {} });
    }
  },
  querySelectorAll(selector) { return [...buttons].filter(([key]) => key.startsWith(selector.slice(0, -1) + '=')).map(([, button]) => button); },
  querySelector(selector) { return buttons.get(selector) || null; },
};
const nodeRowsInfo = new Map([[1, { name: 'Primo', path: '/tmp/one' }], [2, { name: 'Secondo', path: '/tmp/two' }]]);
const sidebarSessions = [
  { id:'shell',nodeId:1,agent:'shell',cwd:'/tmp/one',alive:true,createdAt:0 },
  { id:'op',nodeId:1,agent:'codex',role:'operator',cwd:'/tmp/one',alive:true,createdAt:1 },
  { id:'orch',nodeId:2,agent:'codex',role:'orchestrator',cwd:'/tmp/two',alive:true,createdAt:2 },
  { id:'dead',nodeId:2,agent:'codex',role:'operator',cwd:'/tmp/two',alive:false,createdAt:3 },
];
const sidebarTabs = new Map(sidebarSessions.map(info => [info.id,{info,term:{},ws:{},pane:{}}]));
let launched = null;
Object.assign(sidebar, {
  nodes:nodeRowsInfo,tabs:sidebarTabs,selectedNode:1,active:'shell',links:[],filter:'',nodeOrder:[],sessionOrder:[],
  collapsedNodes:new Set(),railDragCleanup:[],railLinkSource:null,listEl:list,cb:{sessionsChanged(){}},
  syncSel(){},bindNodeDrag(){},renderRailLinks(){},control:()=>({querySelector:()=>null}),picker:{open:false},sel:{ids:[]},updateConnection(){},
  openLauncher(_agent,_mode,_prompt,_squad,nodeId){launched=nodeId ?? this.selectedNode;},
});
document.getElementById=()=>({});
sidebar.renderList();
assert.match(list.html, /work-group current-node[^]*?data-node="1" aria-current="true"/);
assert.match(list.html, /data-node="2" aria-current="false"/);
assert.ok(list.querySelector('[data-session-link="op"]'));
assert.ok(!list.querySelector('[data-session-link="shell"]'), 'shells are not offered agent communication');
assert.ok(!list.querySelector('[data-session-link="dead"]'), 'closed sessions cannot be linked');
list.querySelector('[data-add-agent="2"]').onclick();
assert.equal(launched,2,'sidebar plus opens the launcher for its own node');
assert.equal(sidebar.selectedNode,1,'opening another node launcher preserves the current view until launch');
assert.equal(sidebar.active,'shell','opening the launcher does not change the running terminal');
list.querySelector('[data-node-link="1"]').onclick();
assert.equal(sidebar.railLinkSource,'node:1');
list.querySelector('[data-session-link="op"]').onclick();
assert.equal(sidebar.railLinkSource,'session:op');
for (const [id,tab] of sidebarTabs) assert.equal(sidebar.tabs.get(id),tab);
console.log('PASS sidebar actions: selected node indication, node-scoped launcher, node/session connections and terminal identity');

// State filters follow the visible lights, intersect search, and never unmount terminals.
sidebar.nodes.set(3, { name: 'Vuoto', path: '/tmp/empty' });
sidebar.stateFilter = 'active'; sidebar.collapsedNodes.add(1); sidebar.renderList();
assert.ok(list.querySelector('[data-node="1"]'));
assert.ok(list.querySelector('[data-session="op"]'), 'a state filter reveals matching sessions even in a folded node');
assert.ok(!list.querySelector('[data-session="shell"]'));
assert.ok(!list.querySelector('[data-node="2"]'), 'a node with no green agents is hidden');
assert.ok(!list.querySelector('[data-node="3"]'), 'empty nodes do not pass state filters');
sidebar.filter = 'secondo'; sidebar.renderList();
assert.match(list.html, /Nessun nodo trovato/, 'node name matches cannot bypass the state filter');
sidebar.filter = 'codex'; sidebar.renderList();
assert.ok(list.querySelector('[data-session="op"]'), 'search and state match the same session');
sidebar.filter = '';
const opInfo = sidebar.tabs.get('op').info;
Object.assign(opInfo, { workState: 'idle', stateSource: 'hook', stateAt: Date.now(), lastOutputAt: Date.now() - 1 });
sidebar.renderList();
assert.ok(!list.querySelector('[data-node="1"]'), 'polling removes agents whose light is no longer green');
for (const [filter, properties] of [
  ['idle', {}],
  ['blocked', { workState: 'blocked' }],
  ['attention', { attention: 'permission' }],
  ['stale', { attention: undefined, workState: 'working', stateSource: 'server', stateAt: 1, lastOutputAt: 1 }],
]) {
  Object.assign(opInfo, properties); sidebar.stateFilter = filter; sidebar.renderList();
  assert.ok(list.querySelector('[data-session="op"]'), `${filter}: matching session is shown`);
  assert.ok(!list.querySelector('[data-node="2"]'), `${filter}: unrelated nodes stay hidden`);
}
sidebar.stateFilter = 'ended'; sidebar.renderList();
assert.ok(list.querySelector('[data-session="dead"]'));
assert.ok(!list.querySelector('[data-session="op"]'));
sidebar.stateFilter = 'orchestrator'; sidebar.renderList();
assert.ok(list.querySelector('[data-session="orch"]'), 'purple orchestrators have their own option');
sidebar.stateFilter = 'terminal'; sidebar.renderList();
assert.ok(list.querySelector('[data-session="shell"]'));
assert.ok(!list.querySelector('[data-session="op"]'));
sidebar.stateFilter = 'all'; sidebar.renderList();
assert.ok(list.querySelector('[data-node="3"]'), 'all states restores nodes without sessions');
assert.ok(!list.querySelector('[data-session="op"]'), 'saved fold state is restored after filtering');
assert.ok(sidebar.collapsedNodes.has(1));
sidebar.collapsedNodes.clear(); sidebar.renderList();
assert.ok(list.querySelector('[data-session="op"]'));
assert.equal(sidebar.selectedNode, 1); assert.equal(sidebar.active, 'shell');
for (const [id, tab] of sidebarTabs) assert.equal(sidebar.tabs.get(id), tab, 'filters preserve xterm, socket and pane identity');
sidebar.nodes.delete(3);
console.log('PASS sidebar state filters: green agents, all states, text intersection, live transitions, empty nodes, fold restoration and terminal identity');

// Execute the actual API wiring with fake HTTP responses, without touching the user's channels.
const requests=[], oldFetch=globalThis.fetch;
sidebar.control=()=>null; sidebar.message=message=>assert.equal(message,'');
sidebar.refreshLinks=async()=>{
  const request=requests.at(-1);
  sidebar.links=request.method==='DELETE'?[]:[{id:'new-link',...JSON.parse(request.body)}];
};
globalThis.fetch=async(url,options)=>{requests.push({url,...options});return new Response('{}',{status:200});};
try {
  sidebar.railLinkSource='node:1';
  const first=sidebar.toggleRailLinkWith('node:2');
  await sidebar.toggleRailLinkWith('node:2'); await first;
  assert.equal(requests.length,1,'pending writes cannot create duplicate channels');
  assert.deepEqual(JSON.parse(requests[0].body),{srcNodeId:1,srcSessionId:null,dstNodeId:2,dstSessionId:null,from:'user'});
  sidebar.railLinkSource='node:2'; await sidebar.toggleRailLinkWith('node:1');
  assert.equal(requests.at(-1).method,'DELETE','existing reverse link is disconnected');
  sidebar.railLinkSource='session:op'; await sidebar.toggleRailLinkWith('node:2');
  assert.equal(JSON.parse(requests.at(-1).body).srcSessionId,'op','operator links retain their exact endpoint');
  const count=requests.length;
  sidebar.railLinkSource='session:shell'; await sidebar.toggleRailLinkWith('node:2');
  sidebar.railLinkSource='session:dead'; await sidebar.toggleRailLinkWith('node:1');
  sidebar.railLinkSource='node:1'; await sidebar.toggleRailLinkWith('node:1');
  assert.equal(requests.length,count,'shell, dead and same-node endpoints cannot create channels');
} finally {globalThis.fetch=oldFetch;}
console.log('PASS sidebar channel wiring: node endpoints, reverse unlink, operator endpoints, pending write guard and unavailable sessions');

const panel = { dataset:{}, classList:{toggle(){}}, innerHTML:'', querySelector:()=>({focus(){}}), querySelectorAll:()=>[] };
sidebar.control=()=>panel; delete sidebar.renderRailLinks;
sidebar.railLinkSource='node:1'; sidebar.renderRailLinks();
assert.match(panel.innerHTML,/data-link-with="node:2"/);
assert.doesNotMatch(panel.innerHTML,/data-link-with="session:orch"|data-link-with="session:shell"|data-link-with="session:dead"|data-link-with="session:op"/,'node choices do not duplicate orchestrators or include invalid/same-node sessions');
sidebar.railLinkSource='node:2'; sidebar.renderRailLinks();
assert.match(panel.innerHTML,/data-link-with="session:op"/,'a node may link directly to another node operator');
sidebar.railLinkSource='session:dead'; sidebar.renderRailLinks();
assert.equal(panel.innerHTML,''); assert.equal(sidebar.railLinkSource,null,'expired source closes the panel');
console.log('PASS sidebar connection panel: deduplicated node choices, explicit operators and expired source cleanup');

// Opening Lavoro before the pinned node is ready should repaint it as soon as restore resolves.
const restoring = Object.create(Terminals.prototype);
const nodeRequested = Promise.withResolvers();
const nodeResponse = Promise.withResolvers();
const originalFetch = globalThis.fetch;
let boardPaints = 0;
memory.set('vb:work-nodes', '[138]');
Object.assign(restoring, {
  nodes: new Map(), pendingNodes: new Map(), sideOpen: true, boardOpen: false,
  isOpen: () => true, renderList() {}, refreshLinks: async () => {},
  renderBody() { assert.equal(this.nodes.get(138)?.name, 'Pinned'); boardPaints++; },
});
try {
  globalThis.fetch = async url => {
    if (url === '/api/terminals') return Response.json([]);
    assert.equal(url, '/api/node/138');
    nodeRequested.resolve();
    return nodeResponse.promise;
  };
  const restored = restoring.restore();
  await nodeRequested.promise;
  restoring.boardOpen = true;
  nodeResponse.resolve(Response.json({ id: 138, name: 'Pinned' }));
  await restored;
  assert.equal(boardPaints, 1);
} finally {
  globalThis.fetch = originalFetch;
  memory.delete('vb:work-nodes');
}
console.log('PASS opening the board during restore shows its pinned node when the detail arrives');
