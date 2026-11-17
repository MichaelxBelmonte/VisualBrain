import { ui } from './i18n.ts';
// Typed client of the local API.
import type { NodeReminder, ReminderBoard, AgentName, ModelChoice, TeamLink, TeamView, GraphEdge, GraphNode, GraphPayload, LaunchRequest, NodeDetail, Note, StatusPayload, TerminalInfo, GitRepoView, CodeTree, CodeFile, CodeSearchHit, RepoChoice, GitCommitDetail, GitCommitFile, GithubState } from '../shared/types.ts';

/** One agent CLI as Impostazioni → Agenti shows it (src/server/agent-clis.ts). */
export interface AgentCli { id: AgentName; label: string; command: string; path: string | null; version: string | null; signedIn: boolean | null; account: string | null; installCommand: string; canLogout: boolean; docs: string }

let graphPreview: string | null = null;
let firstGraph = true;

async function call<T>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const r = await fetch(url, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!r.ok) throw new Error((data as { error?: string })?.error ?? ui`${method} ${url}: ${r.status}`);
  if (url.startsWith('/api/graph?')) graphPreview = r.headers.get('x-vb-map-preview');
  return data as T;
}

export const api = {
  graphEventQuery: (): string => graphPreview ? '?' + new URLSearchParams({ preview: graphPreview }) : '',
  readReminderBoard: (nodeId: number) => call<ReminderBoard>('GET', `/api/reminder-board?nodeId=${nodeId}`),
  reminders: () => call<NodeReminder[]>('GET', '/api/reminders'),
  createReminder: (body: { nodeId: number; title: string; notes: string; folderId?: string; status: NodeReminder['status'] }) => call<NodeReminder>('POST', '/api/reminders', body),
  updateReminder: (id: string, body: Partial<Pick<NodeReminder, 'nodeId' | 'title' | 'notes' | 'status' | 'folderId'>>) => call<NodeReminder>('PATCH', `/api/reminders/${id}`, body),
  preferences: () => call<import('../shared/types.ts').Preferences>('GET', '/api/preferences'),
  folders: (path: string) => call<{ path: string; folders: string[] }>('GET', `/api/folders?path=${encodeURIComponent(path)}`),
  savePreferences: (prefs: { roots: string[]; language: 'it' | 'en' }) => call('PUT', '/api/preferences', prefs),
  status: () => call<StatusPayload>('GET', '/api/status'),
  updateState: () => call<import('./updates.ts').UpdateView>('GET', '/api/update'),
  updateCheck: () => call<import('./updates.ts').UpdateView>('POST', '/api/update/check', {}),
  updateInstall: () => call<import('./updates.ts').UpdateView>('POST', '/api/update/install', {}),
  access: () => call<import('./access.ts').AccessView>('GET', '/api/access'),
  accessSettings: () => call<{ ok: boolean }>('POST', '/api/access/settings', {}),
  graph: (q: { expanded: number[]; kinds: string[] | null; min: number; symlinks: boolean; externals: boolean; extra: number[] }) => {
    const p = new URLSearchParams();
    p.set('view', 'projects');
    p.set('detail', 'map');
    if (q.expanded.length) p.set('expanded', q.expanded.join(','));
    if (q.kinds) p.set('kinds', q.kinds.join(','));
    if (q.min > 0) p.set('min', String(q.min));
    if (q.symlinks) p.set('symlinks', '1');
    if (q.externals) p.set('externals', '1');
    if (q.extra.length) p.set('extra', q.extra.join(','));
    const headers = firstGraph ? { 'x-vb-startup-map': '1' } : undefined;
    firstGraph = false;
    return call<GraphPayload>('GET', ui`/api/graph?${p}`, undefined, headers);
  },
  node: (id: number) => call<NodeDetail>('GET', ui`/api/node/${id}`),
  children: (id: number, limit = 200, offset = 0, sort = 'importance') => call<{ children: GraphNode[]; total: number }>('GET', ui`/api/node/${id}/children?limit=${limit}&offset=${offset}&sort=${sort}`),
  search: (q: string, limit = 30, filter: import('../shared/search-filter.ts').SearchFilter = 'all') => call<{ results: GraphNode[] }>('GET', ui`/api/search?q=${encodeURIComponent(q)}&limit=${limit}&filter=${filter}`),
  addEdge: (body: Record<string, unknown>) => call<GraphEdge>('POST', '/api/edges', body),
  patchEdge: (id: number, body: Record<string, unknown>) => call<GraphEdge>('PATCH', ui`/api/edges/${id}`, body),
  deleteEdge: (id: number) => call<{ ok: boolean }>('DELETE', ui`/api/edges/${id}`),
  addNote: (id: number, text: string) => call<Note>('POST', ui`/api/nodes/${id}/notes`, { text }),
  deleteNote: (id: number) => call<{ ok: boolean }>('DELETE', ui`/api/notes/${id}`),
  index: (paths?: string[]) => call<{ started: boolean }>('POST', '/api/index', { paths }),
  analyze: (consent: 'metadata' | 'excerpts', dryRun = false) => call<{ runId?: number; payload?: string; bytes?: number; nodes?: number }>('POST', '/api/analyze', { consent, dryRun }),
  launch: (req: LaunchRequest & { cols?: number; rows?: number }) => call<{ termId?: string; info?: TerminalInfo; opened?: boolean; teamId?: string; warning?: string }>('POST', '/api/launch', req),
  open: (id: number, app: 'finder' | 'default' | 'editor') => call<{ ok: boolean }>('POST', '/api/open', { id, app }),
  terminals: () => call<TerminalInfo[]>('GET', '/api/terminals'),
  terminalPreview: (id: string) => call<{ text: string }>('GET', `/api/terminals/${encodeURIComponent(id)}/preview`),
  killTerminal: (id: string) => call<{ ok: boolean }>('DELETE', ui`/api/terminals/${id}`),
  models: () => call<Record<AgentName, ModelChoice[]>>('GET', '/api/models'),
  harnesses: () => call<Array<{ id: string; label: string; installed: boolean; canInstall: boolean; install: { state: 'installing' | 'ready' | 'error'; step: string; error?: string } | null; version?: string | null; latest?: string; outdated?: boolean }>>('GET', '/api/harnesses'),
  installHarness: (harness: string) => call('POST', '/api/harnesses/install', { harness }),
  launchHarness: (body: { id: number; harness: string; prompt: string; action: string; maxCalls: number }) => call<{ info: TerminalInfo }>('POST', '/api/launch-harness', body),
  /** Saves a copy of a file chosen in the page (its path is not exposed) and returns where the agents can read it. */
  attach: async (nodeId: number, file: File) => {
    const r = await fetch(`/api/attachments?node=${nodeId}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file });
    const data = await r.json().catch(() => null) as { path?: string; name?: string; error?: string } | null;
    if (!r.ok || !data?.path) throw new Error(data?.error ?? ui`Allegato non caricato: ${file.name}`);
    return { path: data.path, name: data.name ?? file.name };
  },
  launchSquad: (req: import('../shared/types.ts').SquadRequest) => call<{ sessions: TerminalInfo[]; teamId?: string; warning?: string }>('POST', '/api/launch-squad', req),
  /** A plain shell: in the node's folder, or free (no node) in the home folder. */
  shell: (id: number | null) => call<{ info: TerminalInfo }>('POST', '/api/launch', { ...(id !== null ? { id } : {}), agent: 'shell', mode: 'embedded' }),
  /** A board of the node: a squad ("1" by default) or the Main Brain's ("brain"). */
  team: (id: number, team = '1') => call<TeamView>('GET', `/api/work/${id}?team=${encodeURIComponent(team)}`),
  updateTeam: (id: number, body: Record<string, unknown>, team = '1') => call('PATCH', ui`/api/work/${id}`, { ...body, team, from: 'user' }),
  teamMessage: (id: number, to: string | null, text: string, team = '1') => call('POST', ui`/api/work/${id}/messages`, { from: 'user', to, text, team }),
  teamTask: (id: number, title: string, assignedTo: string | null, scope: string[], team = '1') => call('POST', ui`/api/work/${id}/tasks`, { from: 'user', title, assignedTo, scope, team }),
  patchTask: (id: number, taskId: string, body: Record<string, unknown>, team = '1') => call('PATCH', ui`/api/work/${id}/tasks/${taskId}`, { from: 'user', team, ...body }),
  sortItem: (id: number, team: string, item: number, body: { column?: string; kind?: string; note?: string }) => call('PATCH', ui`/api/work/${id}/inbox/${item}`, { from: 'user', team, ...body }),
  forward: (id: number, team: string, items: number[], to: string | null, note: string) => call('POST', ui`/api/work/${id}/forward`, { from: 'user', team, items, ...(to ? { to } : {}), note }),
  discardProposal: (id: number, proposal: string) => call('PATCH', ui`/api/work/${id}/proposals/${proposal}`, { from: 'user', status: 'discarded' }),
  teamLinks: () => call<TeamLink[]>('GET', '/api/team-links'),
  linkTeams: (body: Omit<TeamLink, 'id'>) => call<TeamLink>('POST', '/api/team-links', { ...body, from: 'user' }),
  renameTerminal: (id: string, name: string) => call<TerminalInfo>('PATCH', ui`/api/terminals/${id}`, { name }),
  git: (node: number) => call<GitRepoView>('GET', ui`/api/git/${node}`),
  gitFetch: (node: number) => call<GitRepoView>('POST', ui`/api/git/${node}/fetch`, {}),
  gitCommit: (node: number, hash: string) => call<Omit<GitCommitDetail, 'files'> & { files: GitCommitFile[] }>('GET', ui`/api/git/${node}/commit/${hash}`),
  github: (node: number, fresh = false) => call<GithubState>('GET', ui`/api/git/${node}/github${fresh ? '?fresh=1' : ''}`),
  gitOpen: (node: number, url: string) => call('POST', ui`/api/git/${node}/open`, { url }),
  repos: () => call<RepoChoice[]>('GET', '/api/repos'),
  githubRepos: (page = 1) => call<import('../shared/types.ts').GithubRepositories>('GET', `/api/github/repos?page=${page}`),
  githubLogin: (id: number) => call<{ info: TerminalInfo }>('POST', `/api/github/${id}/login`, {}),
  githubConnect: (id: number, repository: string, push: boolean) => call<{ top: string; branch: string; pushed: boolean; localChanges?: boolean }>('POST', `/api/github/${id}/connect`, { repository, push }),
  nodeAt: (path: string) => call<GraphNode>('GET', `/api/path?p=${encodeURIComponent(path)}`),
  codeTree: (node: number) => call<CodeTree>('GET', `/api/git/${node}/code/tree`),
  codeFile: (node: number, path: string, reveal = false) => call<CodeFile>('GET', `/api/git/${node}/code/file?path=${encodeURIComponent(path)}${reveal ? '&reveal=1' : ''}`),
  codeDiff: (node: number, path: string) => call<{ diff: string; truncated: boolean }>('GET', `/api/git/${node}/code/diff?path=${encodeURIComponent(path)}`),
  codeSearch: (node: number, q: string) => call<{ hits: CodeSearchHit[]; truncated: boolean }>('GET', `/api/git/${node}/code/search?q=${encodeURIComponent(q)}`),
  codeOpen: (node: number, path: string, line?: number) => call<{ editor: string }>('POST', `/api/git/${node}/code/open`, { path, line }),
  resumeTerminal: (id: string, size: { cols: number; rows: number }) => call<{ termId: string; info: TerminalInfo }>('POST', ui`/api/terminals/${id}/resume`, size),
  agents: (fresh = false) => call<{ clis: AgentCli[]; sessions: Record<string, number> }>('GET', `/api/agents${fresh ? '?fresh=1' : ''}`),
  agentAction: (id: string, action: 'install' | 'update' | 'login' | 'logout') => call<{ info: TerminalInfo }>('POST', `/api/agents/${id}/${action}`, {}),
  githubAccountLogin: () => call<{ info: TerminalInfo }>('POST', '/api/github/login', {}),
  githubAccountLogout: () => call<{ info: TerminalInfo }>('POST', '/api/github/logout', {}),
  unlinkTeams: (id: string) => call('DELETE', ui`/api/team-links/${id}`),
};
