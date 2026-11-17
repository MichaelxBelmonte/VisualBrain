import type { TeamLink, TeamMessage, TerminalInfo } from '../shared/types.ts';

export interface VisibleChannel { key: string; a: TerminalInfo; b: TerminalInfo; active: boolean }

/** Only direct, explicit channels between the displayed sessions. A path through other nodes does not grant a channel. */
export function visibleChannels(links: TeamLink[], sessions: TerminalInfo[], visible: string[]): VisibleChannel[] {
  const shown = [...new Set(visible)].map(id => sessions.find(s => s.id === id)).filter((s): s is TerminalInfo => !!s);
  const result: VisibleChannel[] = [];
  const endpoint = (s: TerminalInfo, nodeId: number, sessionId: string | null) => s.nodeId === nodeId && (sessionId ? s.id === sessionId : s.role === 'orchestrator');
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    const a = shown[i], b = shown[j];
    if (a.nodeId == null || b.nodeId == null || a.nodeId === b.nodeId) continue;
    const linked = links.some(l => (endpoint(a, l.srcNodeId, l.srcSessionId) && endpoint(b, l.dstNodeId, l.dstSessionId)) || (endpoint(b, l.srcNodeId, l.srcSessionId) && endpoint(a, l.dstNodeId, l.dstSessionId)));
    if (linked) result.push({ key: [a.id, b.id].sort().join(':'), a, b, active: a.alive && b.alive });
  }
  return result;
}

/** Messages are mirrored to both node boards. Read one board per pair, without mixing general team chatter or transcripts. */
export function channelMessages(channel: VisibleChannel, messages: TeamMessage[]): TeamMessage[] {
  return messages.filter(m => (m.from === channel.a.id && m.to === channel.b.id) || (m.from === channel.b.id && m.to === channel.a.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id).slice(-20);
}
