// Side-by-side grid of sessions from different nodes: picker rules (max 4, no eviction), focus preservation, "remove from
// view" without kill, refresh with ended/vanished sessions, keyboard shortcuts and colour-independent markers.
// The model is pure (src/ui/work-tiles.ts); the last block checks that terminal.ts wires it without killing or remounting.
// Uso: node scripts/test-work-tiles.mjs — nessun server, nessuna app, nessun dato reale.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_TILES, TILE_SHAPES, connectionEndpoints, crossNodeLinks, defaultTiles, directPeers, pairTiles, orchestratorEndpoint, focusIndex, focusTile, gridColumns, groupSuggestion, linkedNodes, standaloneNodeSession, pickerGroups, reconcileTiles, removeTile,
  stepFocus, stepTab, tabStepKey, tileKeyAction, tileMarker, toggleTile,
  orderTiles, moveTile,
  clampPage, emptyNodeView, needsLink, nodePickerGroups, nodeViewIds, nodesLinked, orchestratorLink, pageCount, pageIds, pageOfId,
} from '../src/ui/work-tiles.ts';

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };

eq(orderTiles(['new', 'a', 'b'], ['gone', 'b', 'a', 'b']), ['b', 'a', 'new'], 'saved tile order ignores stale ids and duplicates, and appends newly launched sessions');
const moved = moveTile({ ids: ['a', 'b', 'c', 'd'], focus: 'c' }, 'd', 'a');
eq(moved, { ids: ['d', 'a', 'b', 'c'], focus: 'c' }, 'a horizontal or cross-row move preserves the focused terminal');
eq(moveTile(moved, 'd', null), { ids: ['a', 'b', 'c', 'd'], focus: 'c' }, 'moving to the last slot preserves the selection');
eq(moveTile(moved, 'gone', null), moved, 'a disappeared terminal cannot be moved');
eq(moveTile(moved, 'a', 'gone'), moved, 'a disappeared target is ignored');
eq(moveTile(moved, 'a', 'a'), moved, 'dropping onto itself changes nothing');

// nodes 1, 2, 3 with sessions; 'a2' is terminated
const S = (id, nodeId, alive = true, createdAt = 0) => ({ id, nodeId, alive, createdAt });
const sessions = [S('a1', 1, true, 1), S('a2', 1, false, 2), S('a3', 1, true, 3), S('b1', 2, true, 4), S('b2', 2, true, 5), S('c1', 3, true, 6), S('x1', null, true, 7)];
const known = new Set(sessions.map(s => s.id));

ok(MAX_TILES === 4, 'at most four tiles');

// --- default selection: focused session, then live siblings, then ended siblings; never more than four ---------
eq(defaultTiles(sessions, 'a3'), { ids: ['a3', 'a1', 'a2'], focus: 'a3' }, 'the focused session leads, live siblings before the ended one');
eq(defaultTiles(sessions, 'b2'), { ids: ['b2', 'b1'], focus: 'b2' }, 'only the same node by default');
eq(defaultTiles(sessions, null), { ids: [], focus: null }, 'nothing focused, nothing to show');
eq(defaultTiles(sessions, 'gone'), { ids: [], focus: null }, 'an unknown focus is ignored');
const many = Array.from({ length: 9 }, (_, i) => S(`m${i}`, 7, true, i));
eq(defaultTiles(many, 'm5').ids.length, 4, 'a node with nine sessions fills four slots');
eq(defaultTiles(many, 'm5').ids[0], 'm5', 'and the focused one is among them, first');

// --- picker: cross-node, max four, a full grid refuses instead of evicting --------------------------------------
let sel = { ids: ['a1'], focus: 'a1' };
for (const id of ['b1', 'c1', 'x1']) { const r = toggleTile(sel, id, known); eq(r.change, 'added', `${id} added`); sel = { ids: r.ids, focus: r.focus }; }
eq(sel.ids, ['a1', 'b1', 'c1', 'x1'], 'four sessions from four different nodes (one without node)');
const full = toggleTile(sel, 'b2', known);
eq(full.change, 'full', 'the fifth is refused');
eq(full.ids, sel.ids, 'a refused add leaves the grid untouched (no eviction)');
eq(full.focus, 'a1', 'and the focus too');
eq(toggleTile(sel, 'nope', new Set()).change, 'unknown', 'an unknown session cannot be added');
eq(toggleTile({ ids: [], focus: null }, 'b1', known), { ids: ['b1'], focus: 'b1', change: 'added' }, 'the first tile takes the focus');
const unchecked = toggleTile(sel, 'c1', known);
eq([unchecked.change, unchecked.ids], ['removed', ['a1', 'b1', 'x1']], 'unchecking removes it from the view');
eq(toggleTile({ ids: ['a1', 'a1'], focus: 'a1' }, 'b1', known, 2).change, 'added', 'duplicates in the input do not eat the slots wrongly');

// --- remove from view: focus moves to the neighbour that takes the slot ------------------------------------------
eq(removeTile({ ids: ['a1', 'b1', 'c1'], focus: 'b1' }, 'b1'), { ids: ['a1', 'c1'], focus: 'c1' }, 'removing the focused tile focuses the next one');
eq(removeTile({ ids: ['a1', 'b1', 'c1'], focus: 'c1' }, 'c1'), { ids: ['a1', 'b1'], focus: 'b1' }, 'the last one falls back to the previous');
eq(removeTile({ ids: ['a1', 'b1', 'c1'], focus: 'a1' }, 'c1'), { ids: ['a1', 'b1'], focus: 'a1' }, 'removing another tile keeps the focus where it was');
eq(removeTile({ ids: ['a1'], focus: 'a1' }, 'a1'), { ids: [], focus: null }, 'the last tile leaves an empty grid');
const same = { ids: ['a1'], focus: 'a1' };
ok(removeTile(same, 'zzz') === same, 'removing a session that is not in the grid is a no-op');
const afterRemoval = removeTile({ ids: ['a1', 'b1'], focus: 'a1' }, 'b1');
ok(known.has('b1') && !afterRemoval.ids.includes('b1'), 'the session is still known: removal is a view operation, not a kill');

// --- focus preservation -------------------------------------------------------------------------------------------
eq(focusTile({ ids: ['a1', 'b1'], focus: 'a1' }, 'b1'), { ids: ['a1', 'b1'], focus: 'b1' }, 'clicking a tile already in the grid only moves the focus (no reshuffle)');
eq(focusTile({ ids: ['a1', 'b1'], focus: 'a1' }, 'c1'), { ids: ['a1', 'b1', 'c1'], focus: 'c1' }, 'a session from the rail takes a free slot, the others stay');
eq(focusTile({ ids: ['a1', 'b1', 'c1', 'x1'], focus: 'b1' }, 'b2'), { ids: ['a1', 'b2', 'c1', 'x1'], focus: 'b2' }, 'with a full grid it replaces the focused tile only');
eq(focusTile({ ids: ['a1', 'b1', 'c1', 'x1'], focus: null }, 'b2').ids.length, 4, 'and never grows past four');
// switching node by clicking a session of another node must not throw away the grid (the old behaviour rebuilt it from the node)
const crossNode = focusTile({ ids: ['a1', 'b1'], focus: 'a1' }, 'b1');
eq(crossNode.ids, ['a1', 'b1'], 'cross-node focus keeps both nodes in the grid');
eq(stepFocus({ ids: ['a1', 'b1', 'c1'], focus: 'c1' }, 1).focus, 'a1', 'next wraps around');
eq(stepFocus({ ids: ['a1', 'b1', 'c1'], focus: 'a1' }, -1).focus, 'c1', 'previous wraps around');
eq(stepFocus({ ids: [], focus: null }, 1), { ids: [], focus: null }, 'stepping in an empty grid does nothing');
eq(focusIndex({ ids: ['a1', 'b1'], focus: 'a1' }, 1).focus, 'b1', 'focus by tile number');
eq(focusIndex({ ids: ['a1', 'b1'], focus: 'a1' }, 3).focus, 'a1', 'a number without a tile is ignored');

// --- refresh: vanished sessions leave, ended ones stay, focus stays valid ---------------------------------------
const withEnded = reconcileTiles({ ids: ['a1', 'a2', 'b1'], focus: 'a2' }, known);
eq(withEnded, { ids: ['a1', 'a2', 'b1'], focus: 'a2' }, 'a terminated session stays in the grid until the user removes it');
const afterSync = reconcileTiles({ ids: ['a1', 'a2', 'b1'], focus: 'a2' }, new Set(['a1', 'b1']));
eq(afterSync, { ids: ['a1', 'b1'], focus: 'a1' }, 'a session that vanished from the server leaves the grid and the focus moves');
eq(reconcileTiles({ ids: ['q'], focus: 'q' }, new Set()), { ids: [], focus: null }, 'all gone: an empty grid, no stale focus');
eq(reconcileTiles({ ids: ['a1', 'a1', 'b1', 'c1', 'x1', 'b2'], focus: 'b2' }, known).ids, ['a1', 'b1', 'c1', 'x1'], 'duplicates are removed and the cap is enforced');
// a refresh with an unchanged world returns an equal selection, so the focus is never moved by polling
const stable = { ids: ['a1', 'b1'], focus: 'b1' };
for (let i = 0; i < 5; i++) eq(reconcileTiles(stable, known), stable, 'polling does not change a valid selection');

// --- picker model ---------------------------------------------------------------------------------------------------
const name = (id) => (id === null ? 'Senza nodo' : `Nodo ${id}`);
let groups = pickerGroups(sessions, { ids: ['b1', 'a1'], focus: 'b1' }, name);
eq(groups.map(g => g.nodeId), [1, 2, 3, null], 'every node appears once, in first-seen order');
eq(groups[0].items.map(i => i.id), ['a1', 'a3', 'a2'], 'live sessions come before the terminated one');
eq(groups[0].items.find(i => i.id === 'a1'), { id: 'a1', nodeId: 1, alive: true, selected: true, tile: 2, disabled: false, linked: false, suggested: false }, 'a selected item carries its tile number');
ok(groups.flatMap(g => g.items).every(i => !i.disabled), 'nothing is disabled while there is room');
groups = pickerGroups(sessions, sel, name);
const items = groups.flatMap(g => g.items);
eq(items.filter(i => i.disabled).map(i => i.id).sort(), ['a2', 'a3', 'b2'], 'with a full grid the unselected sessions are disabled');
ok(items.filter(i => i.selected).every(i => !i.disabled), 'while the selected ones stay enabled so they can be removed');
eq(pickerGroups(sessions, { ids: [], focus: null }, name, id => id.startsWith('b')).map(g => g.nodeId), [2], 'the filter narrows the groups');
eq(pickerGroups(sessions, { ids: ['a1'], focus: 'a1' }, name, () => false).flatMap(g => g.items.map(i => i.id)), ['a1'], 'a selected session stays listed whatever the filter');
eq(pickerGroups([], { ids: [], focus: null }, name), [], 'no sessions, no groups');

// --- the picker shows `sel`, so a toggle flips exactly the item it displays (no seeded active session) ----------------------
for (const start of [{ ids: [], focus: null }, { ids: ['a1'], focus: 'a1' }, { ids: ['a1', 'b1', 'c1', 'x1'], focus: 'b1' }]) {
  const shownBefore = pickerGroups(sessions, start, name).flatMap(x => x.items);
  for (const item of shownBefore.filter(i => !i.disabled)) {
    const after = toggleTile(start, item.id, known);
    const shownAfter = pickerGroups(sessions, { ids: after.ids, focus: after.focus }, name).flatMap(x => x.items);
    const changed = shownAfter.filter((i, k) => i.selected !== shownBefore[k].selected).map(i => i.id);
    eq(changed, [item.id], `from ${JSON.stringify(start.ids)} toggling ${item.id} flips only ${item.id}`);
    eq(shownAfter.find(i => i.id === item.id).selected, !item.selected, `${item.id} ends up ${item.selected ? 'unselected' : 'selected'}`);
  }
}
eq(toggleTile({ ids: [], focus: null }, 'b1', known).ids, ['b1'], 'picking the first session from an empty picker gives exactly that session');

// --- "Affianca collegati": live endpoints of the persistent links, node endpoint = orchestrator, max four ----------------
const R = (id, nodeId, role, alive = true, createdAt = 0) => ({ id, nodeId, role, alive, createdAt });
const team = [R('o1', 1, 'orchestrator', true, 1), R('w1', 1, 'operator', true, 2), R('o2', 2, 'orchestrator', true, 3), R('w2', 2, 'operator', true, 4), R('s3', 3, undefined, true, 5), R('d3', 3, undefined, false, 6), R('o4', 4, 'orchestrator', true, 7)];
const L = (id, srcNodeId, dstNodeId, srcSessionId = null, dstSessionId = null) => ({ id, srcNodeId, dstNodeId, srcSessionId, dstSessionId });
eq(standaloneNodeSession(2, team), 'o2', 'a node endpoint is its live orchestrator');
eq(standaloneNodeSession(3, team), 's3', 'with no orchestrator, its first live session');
eq(standaloneNodeSession(9, team), null, 'a node without live sessions has no endpoint');
eq(standaloneNodeSession(1, team.map(s => (s.id === 'o1' ? { ...s, alive: false } : s))), 'w1', 'a dead orchestrator is skipped');
eq(linkedNodes(1, [L('a', 1, 2), L('b', 2, 3)]), [1, 2, 3], 'links are followed transitively, the pressed node first');
eq(linkedNodes(3, [L('a', 1, 2), L('b', 2, 3)]), [3, 2, 1], 'from the other end');
eq(linkedNodes(1, [L('same', 1, 1, 'o1', 'w1'), L('a', 1, 2)]), [1, 2], 'a link inside one node is ignored');
eq(crossNodeLinks([L('same', 1, 1, 'o1', 'w1'), L('a', 1, 2)]).map(l => l.id), ['a'], 'and never proposed');
let g = groupSuggestion(1, [L('a', 1, 2)], team);
eq([g.ids, g.fits, g.inactive], [['o1', 'o2'], true, []], 'node-to-node link: both orchestrators');
g = groupSuggestion(1, [L('a', 1, 2, 'w1', 'w2')], team);
eq(g.ids, ['w1', 'w2'], 'session-to-session link: exactly those two, not the orchestrators');
g = groupSuggestion(1, [L('a', 1, 2, 'w1', null)], team);
eq(g.ids, ['w1', 'o2'], 'mixed link: the session on one side, the orchestrator on the other');
g = groupSuggestion(1, [L('a', 1, 3, 'o1', 'd3')], team);
eq([g.ids, g.inactive, g.fits], [['o1'], ['d3'], true], 'a link to a terminated session is reported inactive and not suggested');
// W2: a node-level link only reaches the orchestrator; no live orchestrator = inactive channel, never a shell
const noOrch = team.map(s => (s.id === 'o2' ? { ...s, alive: false } : s));
g = groupSuggestion(1, [L('a', 1, 2)], noOrch);
eq([g.ids, g.inactive], [['o1'], ['node:2']], 'node link with a dead orchestrator: inactive, the operator of that node is not suggested');
g = groupSuggestion(1, [L('a', 1, 3)], team);
eq([g.ids, g.inactive], [['o1'], ['node:3']], 'node link to a node with only a shell: inactive, the shell is not suggested');
g = groupSuggestion(3, [L('a', 1, 3)], team);
eq([g.ids, g.inactive], [['o1'], ['node:3']], 'same from the other end: the pressed node gets no shell fallback when it has links');
g = groupSuggestion(1, [L('a', 1, 2, 'o1', 'w2')], noOrch);
eq([g.ids, g.inactive], [['o1', 'w2'], []], 'a session-level link is unaffected by the orchestrator being gone');
eq([orchestratorEndpoint(3, team), orchestratorEndpoint(2, noOrch), orchestratorEndpoint(2, team)], [null, null, 'o2'], 'orchestratorEndpoint: only a live orchestrator');
g = groupSuggestion(3, [], team);
eq(g.ids, ['s3'], 'a node with no links at all may still fall back to its first live session');
g = groupSuggestion(2, [], team);
eq([g.ids, g.nodes], [['o2'], [2]], 'a node without links shows its own endpoint');
g = groupSuggestion(1, [L('a', 1, 2), L('b', 2, 3), L('c', 3, 4)], team.map(s => (s.id === 's3' ? { ...s, role: 'orchestrator' } : s)));
eq(g.ids, ['o1', 'o2', 's3', 'o4'], 'four linked nodes fit exactly');
g = groupSuggestion(1, [L('a', 1, 2), L('b', 2, 3), L('c', 3, 4)], team);
eq([g.ids, g.inactive], [['o1', 'o2', 'o4'], ['node:3']], 'a node without orchestrator in the chain is inactive, the others still show');
g = groupSuggestion(1, [L('a', 1, 2, 'o1', 'o2'), L('b', 1, 2, 'w1', 'w2'), L('c', 2, 3, 'w2', 's3')], team);
eq([g.ids.length, g.fits], [5, false], 'more than four endpoints: it does not fit, the user chooses explicitly');
eq(g.ids.slice(0, 2), ['o1', 'w1'], 'the pressed node comes first');
eq(groupSuggestion(1, [L('a', 1, 2, 'o1', 'o2')], team.map(s => ({ ...s, alive: false }))).ids, [], 'everything terminated: nothing to show');
eq(groupSuggestion(1, [L('a', 2, 3)], team).nodes, [1], 'links of unrelated nodes do not leak into the component');
// the picker marks link endpoints and suggestions with a text marker, and flags default to false
let pg = pickerGroups(team, { ids: [], focus: null }, name, undefined, MAX_TILES, { linked: new Set(['o1']), suggested: new Set(['o2']) });
const flat = pg.flatMap(x => x.items);
eq([flat.find(i => i.id === 'o1').linked, flat.find(i => i.id === 'o2').suggested, flat.find(i => i.id === 'w1').linked], [true, true, false], 'linked / suggested flags reach the picker items');

// --- connection endpoints and direct peers ("Affianca orchestratore") -----------------------------------------------------------
const T2 = [R('o1', 1, 'orchestrator', true, 1), R('w1', 1, 'operator', true, 2), R('o2', 2, 'orchestrator', true, 3), R('w2', 2, 'operator', true, 4), R('o3', 3, 'orchestrator', true, 5), R('x3', 3, 'operator', false, 6)];
eq([...connectionEndpoints([L('a', 1, 2)], T2)], [['o1', 'node'], ['o2', 'node']], 'node link: the real endpoints are the two orchestrators');
eq([...connectionEndpoints([L('a', 1, 2, 'w1', 'w2')], T2)], [['w1', 'session'], ['w2', 'session']], 'session link: exactly those sessions');
eq([...connectionEndpoints([L('a', 1, 2, 'w1', null)], T2)], [['w1', 'session'], ['o2', 'node']], 'mixed link: one of each kind');
eq([...connectionEndpoints([L('a', 1, 3, 'w1', 'x3')], T2)], [['w1', 'session']], 'a terminated endpoint is not marked');
eq([...connectionEndpoints([L('same', 1, 1, 'o1', 'w1')], T2)], [], 'a link inside one node marks nothing');
eq(directPeers('o1', [L('a', 1, 2)], T2), ['o2'], 'node link: the orchestrators are peers of each other');
eq(directPeers('o2', [L('a', 1, 2)], T2), ['o1'], 'both directions');
eq(directPeers('w1', [L('a', 1, 2)], T2), [], 'an operator is not reached by a node link');
eq(directPeers('w1', [L('a', 1, 2, 'w1', null)], T2), ['o2'], 'mixed link: session to the other node orchestrator');
eq(directPeers('o2', [L('a', 1, 2, 'w1', null)], T2), ['w1'], 'and the orchestrator sees that session');
eq(directPeers('o1', [L('a', 1, 2), L('b', 1, 3), L('c', 1, 2, 'o1', 'o2')], T2), ['o2', 'o3'], 'several links: each live peer once, in link order');
eq(directPeers('o1', [L('a', 1, 3, 'o1', 'x3')], T2), [], 'a terminated peer is never offered');
eq(directPeers('o1', [L('a', 1, 2)], T2.map(s => (s.id === 'o2' ? { ...s, alive: false } : s))), [], 'a node link with a dead orchestrator offers nothing (inactive channel)');
eq(directPeers('o1', [L('same', 1, 1, 'o1', 'w1')], T2), [], 'no peers through a same-node link');
eq(pairTiles('o1', 'o2'), { ids: ['o1', 'o2'], focus: 'o1' }, 'pairing gives exactly two tiles, the first keeps the focus');

// --- indicators: distinguishable without colour -----------------------------------------------------------------------
const markers = [0, 1, 2, 3].map(tileMarker);
eq(new Set(markers.map(m => m.text)).size, 4, 'four different markers');
eq(new Set(markers.map(m => m.shape)).size, 4, 'four different shapes (not only numbers)');
eq(markers.map(m => m.number), [1, 2, 3, 4], 'numbered from 1, like the shortcuts');
eq(TILE_SHAPES.length, MAX_TILES, 'one shape per slot');

// --- keyboard -----------------------------------------------------------------------------------------------------------
const key = (code, over = {}) => ({ code, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, ...over });
eq(tileKeyAction(key('Digit1')), { type: 'focus', index: 0 }, 'Ctrl+Alt+1 focuses the first tile');
eq(tileKeyAction(key('Digit4')), { type: 'focus', index: 3 }, 'Ctrl+Alt+4 focuses the fourth');
eq(tileKeyAction(key('BracketRight')), { type: 'step', delta: 1 }, 'Ctrl+Alt+] next');
eq(tileKeyAction(key('BracketLeft')), { type: 'step', delta: -1 }, 'Ctrl+Alt+[ previous');
// Single view tabs.
const plain = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
eq(tabStepKey({ ...plain, code: 'BracketRight', metaKey: true, shiftKey: true }), 1, '⌘⇧] next tab');
eq(tabStepKey({ ...plain, code: 'BracketLeft', metaKey: true, shiftKey: true }), -1, '⌘⇧[ previous tab');
eq(tabStepKey({ ...plain, code: 'Tab', ctrlKey: true }), 1, '⌃Tab next tab');
eq(tabStepKey({ ...plain, code: 'Tab', ctrlKey: true, shiftKey: true }), -1, '⌃⇧Tab previous tab');
eq(tabStepKey({ ...plain, code: 'BracketRight', metaKey: true }), null, '⌘] alone is left to the terminal');
eq(tabStepKey({ ...plain, code: 'Tab' }), null, 'Tab alone is typed into the terminal');
eq(stepTab(['a', 'b', 'c'], 'c', 1), 'a', 'wraps forward');
eq(stepTab(['a', 'b', 'c'], 'a', -1), 'c', 'wraps backward');
eq(stepTab(['a', 'b'], 'x', 1), 'a', 'from elsewhere: the first tab');
eq(stepTab([], 'a', 1), null);
eq(tileKeyAction(key('KeyW')), { type: 'remove' }, 'Ctrl+Alt+W removes the view');
eq(tileKeyAction(key('KeyG')), { type: 'picker' }, 'Ctrl+Alt+G opens the picker');
for (const code of ['Digit1', 'KeyW', 'KeyG', 'BracketLeft']) {
  eq(tileKeyAction(key(code, { ctrlKey: false })), null, `Alt+${code} alone belongs to the shell`);
  eq(tileKeyAction(key(code, { altKey: false })), null, `Ctrl+${code} alone belongs to the shell`);
  eq(tileKeyAction(key(code, { metaKey: true })), null, `Cmd combinations are left to the system (${code})`);
  eq(tileKeyAction(key(code, { shiftKey: true })), null, `Shift variants are left alone (${code})`);
}
eq(tileKeyAction(key('KeyC')), null, 'other Ctrl+Alt keys are not captured');
eq(tileKeyAction({ code: 'ArrowLeft', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }), null, 'Alt+arrows (word movement) never captured');

eq([0, 1, 2, 3, 4].map(gridColumns), [1, 1, 2, 2, 2], 'one tile fills the area, two or more use two columns');


// --- per-node view: own terminals only, 4 per page, other nodes only through a link ---------------------------------------
{
  const S = (id, nodeId, extra = {}) => ({ id, nodeId, alive: true, createdAt: Number(id.replace(/\D/g, '')) || 0, ...extra });
  const sessions = [S('a1', 1, { role: 'orchestrator' }), S('a2', 1), S('a3', 1), S('a4', 1), S('a5', 1), S('b1', 2, { role: 'orchestrator' }), S('b2', 2), S('c1', 3, { role: 'orchestrator' })];
  const links = [{ id: 'l1', srcNodeId: 1, dstNodeId: 2, srcSessionId: null, dstSessionId: null }, { id: 'l2', srcNodeId: 2, dstNodeId: 3, srcSessionId: null, dstSessionId: null }];
  const view = emptyNodeView();
  eq(nodeViewIds(1, sessions, view, links), ['a1', 'a2', 'a3', 'a4', 'a5'], 'a node view lists only its own terminals, never those of other nodes');
  eq(nodeViewIds(2, sessions, view, links), ['b1', 'b2'], 'the other node sees its own two');
  eq([pageCount(0), pageCount(4), pageCount(5), pageCount(8), pageCount(9)], [1, 1, 2, 2, 3], 'more than 4 terminals means more pages');
  eq(pageIds(['a1', 'a2', 'a3', 'a4', 'a5'], 0), ['a1', 'a2', 'a3', 'a4'], 'page one holds four');
  eq(pageIds(['a1', 'a2', 'a3', 'a4', 'a5'], 1), ['a5'], 'page two holds the rest');
  eq(pageIds(['a1', 'a2', 'a3', 'a4', 'a5'], 9), ['a5'], 'an out-of-range page is clamped');
  eq([clampPage(-1, 5), clampPage(5, 5), clampPage(1, 0)], [0, 1, 0], 'page clamping');
  eq([pageOfId(['a1', 'a2', 'a3', 'a4', 'a5'], 'a5'), pageOfId(['a1'], 'zz')], [1, null], 'the page of a session');
  // hidden / guests
  eq(nodeViewIds(1, sessions, { hidden: ['a2'], guests: [], page: 0 }, links), ['a1', 'a3', 'a4', 'a5'], 'removing a view hides it from the node view only');
  eq(nodeViewIds(1, sessions, { hidden: [], guests: ['b2'], page: 0 }, links), ['a1', 'a2', 'a3', 'a4', 'a5', 'b2'], 'a session of a directly linked node can be a guest (it goes after the own ones)');
  eq(nodeViewIds(1, sessions, { hidden: [], guests: ['c1'], page: 0 }, links), ['a1', 'a2', 'a3', 'a4', 'a5'], 'a node linked only through another node is not directly linked: no guest');
  eq(nodeViewIds(1, sessions, { hidden: [], guests: ['b2'], page: 0 }, []), ['a1', 'a2', 'a3', 'a4', 'a5'], 'when the link is removed the guest leaves the view');
  eq(nodeViewIds(1, sessions, { hidden: [], guests: ['b2', 'b2', 'zz'], page: 0 }, links).filter(x => x === 'b2').length, 1, 'no duplicates, unknown sessions ignored');
  // link rule
  ok(nodesLinked(1, 2, links) && nodesLinked(2, 1, links) && !nodesLinked(1, 3, links), 'direct link only, no transitivity');
  ok(!nodesLinked(1, 1, [{ id: 'x', srcNodeId: 1, dstNodeId: 1, srcSessionId: null, dstSessionId: null }]), 'a link inside one node is not a link between nodes');
  ok(!needsLink([1], 1, links) && !needsLink([1], 2, links) && needsLink([1], 3, links), 'own node and linked node need nothing, an unlinked node needs a link');
  ok(!needsLink([1, 3], 2, links) && needsLink([1], 3, []) && !needsLink([1], null, links) && !needsLink([], 3, links), 'composition bases and edge cases');
  eq(orchestratorLink(1, 3, sessions), { srcNodeId: 1, srcSessionId: null, dstNodeId: 3, dstSessionId: null }, 'adding a terminal of another node links the two orchestrators (node-level link)');
  eq(orchestratorLink(1, 3, sessions.filter(s => s.id !== 'c1')), null, 'no live orchestrator on one side: nothing to link');
  eq(orchestratorLink(1, 3, sessions.map(s => s.id === 'c1' ? { ...s, alive: false } : s)), null, 'a terminated orchestrator cannot carry the channel');
  // picker
  const groups = nodePickerGroups(sessions, 1, { hidden: ['a2'], guests: ['b2'], page: 0 }, links, id => `n${id}`);
  eq(groups.map(g => g.nodeId), [1, 2, 3], 'picker: own node first, then linked nodes, then the others');
  eq(groups.map(g => [g.own, g.linked]), [[true, false], [false, true], [false, false]], 'picker: own / linked flags');
  eq(groups[0].items.map(i => [i.id, i.selected, i.tile]), [['a1', true, 1], ['a2', false, null], ['a3', true, 2], ['a4', true, 3], ['a5', true, 4]], 'picker: page one tiles are numbered 1-4, a hidden one is unchecked');
  eq(groups[1].items.map(i => [i.id, i.selected, i.tile]), [['b1', false, null], ['b2', true, null]], 'picker: a guest on a later page is selected without a tile number');
  ok(groups.flatMap(g => g.items).every(i => !i.disabled), 'picker: pages replace the full-grid refusal');
  const reordered = nodePickerGroups(sessions, 1, { hidden: [], guests: [], page: 1 }, links, id => `n${id}`, ['a5', 'a4', 'a3', 'a2', 'a1']);
  eq(reordered[0].items.map(i => [i.id, i.tile]), [['a1', 1], ['a2', null], ['a3', null], ['a4', null], ['a5', null]], 'picker page and slot numbers follow the saved tile order');
}

// --- wiring in terminal.ts: a view removal never kills, the grid never remounts ---------------------------------------
const src = readFileSync(new URL('../src/ui/terminal.ts', import.meta.url), 'utf8');
const method = (n) => { let i = src.indexOf(`  private ${n}(`); if (i < 0) i = src.indexOf(`  private async ${n}(`); if (i < 0) i = src.indexOf(`  ${n}(`); assert.ok(i > 0, `terminal.ts has ${n}`); const end = src.indexOf('\n  }\n', i); return src.slice(i, end); };
const removeView = method('removeView');
ok(removeView.includes('removeTile(') && !/killTerminal|\.ws\?\.close|term\?\.dispose|pane\?\.remove|tabs\.delete/.test(removeView), 'removeView only edits the selection: no kill, no WebSocket close, no xterm dispose');
const renderBody = method('renderBody');
ok(/renderTabs\(\)/.test(method('renderBody')) && /this\.tiled/.test(method('renderTabs')), 'the tab strip belongs to the single view');
ok(!/dispose|killTerminal|ws\?\.close/.test(renderBody) && /if \(!tab\.pane\) this\.mount\(tab\)/.test(renderBody), 'the grid mounts a pane once and then only toggles it');
ok(/classList\.toggle\('hidden'/.test(renderBody) && /style\.order/.test(renderBody), 'reordering uses CSS order, so DOM nodes (and xterm) are not moved');
ok(/this\.sel\s*=\s*reconcileTiles/.test(method('syncSessions')), 'every refresh reconciles the selection');
ok(!/this\.visible/.test(src), 'the old per-node `visible` list is gone');
ok(/focusTile\(/.test(method('activate')), 'activate keeps the grid instead of rebuilding it from the node');
ok(/attachCustomKeyEventHandler/.test(src), 'shortcuts are kept out of the PTY');
ok(!/killTerminal/.test(method('createPicker')), 'the picker cannot kill sessions');
const pairWith = method('pairWith');
ok(/pairTiles\(/.test(pairWith) && !/killTerminal|dispose|ws\?\.close|tabs\.delete/.test(pairWith), 'pairing two sessions only sets the selection (no kill, no remount)');
ok(/data-pair/.test(method('updateConnection')) && /connectionGroups\(this\.links\)/.test(method('updateConnection')) && /dataset\.connectionTone/.test(method('updateConnection')), 'panes get the connection tone, the endpoint kind and the peer buttons');
ok(/data-connection-tone/.test(method('renderList')) && /connectionEndpoints\(/.test(method('renderList')), 'the rail carries the same tone and endpoint marks');
ok(/channel\.update\(/.test(method('syncChannel')) && /refresh\(\)/.test(method('syncChannel')), 'the channel board is fed from links, sessions and visible tiles');
ok(/new WorkChannel\(this\.channelEl\)/.test(src) && /const visible = !show \? \[\]/.test(method('syncChannel')), 'the board is created and gets no visible sessions when Operativa is closed or in overview');
ok(/esc\(text\)/.test(method('updateConnection')), 'the peer button text (session label with model/effort) is escaped');
ok(/syncChannel\(\)/.test(method('show')), 'leaving Operativa syncs the board at once (visible = [])');
ok(/syncChannel\(true\)/.test(method('syncSessions')), 'the 4 s sync refreshes the channel board');
ok(!/setTiled\(/.test(method('createPicker')), 'the picker does not seed a selection of its own');
ok(/pickerGroups\(infos, this\.sel,/.test(method('renderPicker')), 'the picker displays the same selection the toggle starts from');
ok(/data-group/.test(method('renderList')) && /this\.groupLinked\(Number\(b\.dataset\.group\)\)/.test(src) && /linksChanged:/.test(src), 'a linked node offers "Affianca collegati" in the rail; the board reports link changes');
ok(!/killTerminal|dispose|ws\?\.close/.test(method('groupLinked')), 'grouping linked nodes never kills or closes anything');

ok(/dropFromNodeView\(/.test(method('removeView')) && !/killTerminal|\.ws\?\.close|term\?\.dispose|pane\?\.remove|tabs\.delete/.test(method('dropFromNodeView')), 'removing a node-view tile only hides it or drops the guest');
ok(/nodeViewList\(\)/.test(method('syncSel')) && /nodeViewIds\(/.test(method('nodeViewList')) && /pageIds\(/.test(method('syncSel')) && /if \(!this\.tiled\) return/.test(method('syncSel')) && /if \(this\.composed\).*orderTiles.*return/.test(method('syncSel')), 'the grid shows the current page of the selected node view unless a composition is on');
ok(/this\.syncSel\(\)/.test(method('renderBody')) && /this\.syncSel\(\)/.test(method('renderList')) && /this\.syncSel\(\)/.test(method('syncChannel')), 'the page is recomputed before the body, the rail and the channel board read it');
ok(/needsLink\(this\.linkBases\(\)/.test(method('createPicker')) && /pendingAdd = id/.test(method('createPicker')), 'adding a session of an unlinked node asks first');
ok(/orchestratorLink\(/.test(method('confirmLink')) && /api\.linkTeams\(link\)/.test(method('confirmLink')) && /toggleInView\(id\)/.test(method('confirmLink')) && !/killTerminal/.test(method('confirmLink')), 'confirming links the two orchestrators and then adds the session');
ok(/nodePickerGroups\(/.test(method('renderPicker')), 'outside a composition the picker is the node picker');
ok(/this\.composed = true/.test(method('pairWith')) && /this\.composed = true/.test(method('groupLinked')), 'pairs and linked groups are explicit compositions');
ok(/data-page/.test(method('renderPager')) && /pageCount\(/.test(method('renderPager')), 'more than four terminals give page buttons');

console.log(`test-work-tiles: ${checks} controlli ok`);
