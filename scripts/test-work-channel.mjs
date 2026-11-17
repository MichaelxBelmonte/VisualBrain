// The channel view must show actual directed board messages between the two visible endpoints, never other team chatter.
import assert from 'node:assert/strict';
import { visibleChannels, channelMessages } from '../src/ui/work-channel-model.ts';

const session = (id, nodeId, role = 'orchestrator', alive = true) => ({ id, nodeId, role, alive, agent: 'codex', cwd: '/fixture', title: id, createdAt: 0 });
const sessions = [session('a', 1), session('b', 2), session('c', 3), session('op', 1, 'operator'), session('old', 2, 'operator', false)];
const link = (srcNodeId, dstNodeId, srcSessionId = null, dstSessionId = null) => ({ id: `${srcNodeId}-${dstNodeId}`, srcNodeId, dstNodeId, srcSessionId, dstSessionId });
const links = [link(1, 2), link(2, 3)];
const view = ids => visibleChannels(links, sessions, ids);
assert.equal(view(['a', 'b']).length, 1);
assert.equal(view(['b', 'a'])[0].key, view(['a', 'b'])[0].key);
assert.equal(view(['a', 'a', 'b']).length, 1);
assert.equal(view(['a']).length, 0);
assert.equal(view(['a', 'c']).length, 0, 'transitive group does not imply a direct channel');
assert.equal(view(['a', 'op']).length, 0, 'same-node board chatter is not a cross-node channel');
assert.equal(view(['op', 'b']).length, 0, 'node link only connects orchestrators');
assert.equal(view(['unknown', 'b']).length, 0);
assert.equal(view(['a', 'b', 'c']).length, 2);
assert.equal(visibleChannels([...links, link(2, 1)], sessions, ['a', 'b']).length, 1);
const explicit = visibleChannels([link(1, 2, 'op', 'old')], sessions, ['op', 'old']);
assert.equal(explicit.length, 1);
assert.equal(explicit[0].active, false, 'ended explicit endpoint still has a readable history');
assert.equal(visibleChannels([link(1, 2, 'op', null)], sessions, ['op', 'b']).length, 1);
assert.equal(visibleChannels([], sessions, ['a', 'b']).length, 0, 'unlink removes the channel immediately');

const message = (id, from, to, createdAt = id) => ({ id, from, to, createdAt, text: `message ${id}` });
const messages = [message(1, 'user', 'a'), message(2, 'a', null), message(3, 'op', 'b'), message(4, 'a', 'b'), message(5, 'b', 'a'), message(6, 'c', 'b'), message(7, 'a', 'old')];
const pair = view(['a', 'b'])[0];
assert.deepEqual(channelMessages(pair, messages).map(m => m.id), [4, 5]);
assert.deepEqual(channelMessages(pair, [...messages].reverse()).map(m => m.id), [4, 5]);
assert.deepEqual(channelMessages(pair, []).map(m => m.id), []);
assert.deepEqual(channelMessages(pair, [message(8, 'a', 'b', 10), message(9, 'b', 'a', 10)]).map(m => m.id), [8, 9], 'distinct equal-time messages retained');
const many = Array.from({ length: 25 }, (_, i) => message(i, 'a', 'b'));
assert.deepEqual(channelMessages(pair, many).map(m => m.id), Array.from({ length: 20 }, (_, i) => i + 5));
assert.equal(many.length, 25, 'input board is unchanged');
console.log('PASS 20 channel checks: exact endpoints, no transitive permissions, bidirectional messages, no unrelated chatter, history and limit');
