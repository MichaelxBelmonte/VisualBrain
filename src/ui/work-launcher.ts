// Launch window of Operativa: the objective first, then Squadra | Un agente, then one agent line valid for everyone
// ("Personalizza per agente" opens one line per member). Destination squad, new squad name and saved squads sit in
// "Altre opzioni". The launch payload is the same as before: nothing changes on the server.
import { t as tr, ui } from './i18n.ts';
import { ROLE_WORDS } from './work-roles.ts';
import { api } from './api.ts';
import { effortChoices } from '../shared/agent-effort.ts';
import { parseFileDrop } from './work-input.ts';
import type { AgentAccountStatus, AgentName, AgentRole, ModelChoice, NodeDetail, SavedSquad, SwarmProposal, TeamSummary, TerminalInfo } from '../shared/types.ts';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const labels = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes', agy: 'Antigravity', shell: tr('Terminale') };
const roles = ROLE_WORDS;
/** `account`: an extra account of the agent CLI (Impostazioni → Agenti); absent: its main account. */
export type Choice = { agent: TerminalInfo['agent']; model: string; effort: string; account?: string; role?: AgentRole; name?: string };

/** Whether the first `count` members already run the same agent, account, model and effort. Pure. */
export function allSame(choices: Choice[], count: number): boolean {
  const [first, ...rest] = choices.slice(0, count);
  return !first || rest.every(c => c.agent === first.agent && c.account === first.account && c.model === first.model && c.effort === first.effort);
}

/** "Uguale per tutti": every member takes the first member's agent, account, model and effort; roles and names stay. Pure. */
export function sameForAll(choices: Choice[], count: number): Choice[] {
  const first = choices[0];
  return choices.map((c, i) => i > 0 && i < count ? { ...c, agent: first.agent, account: first.account, model: first.model, effort: first.effort } : c);
}

/** The agent menu's value: the agent, or agent@account for an extra account. Pure. */
export function agentValue(choice: Pick<Choice, 'agent' | 'account'>): string {
  return choice.account ? `${choice.agent}@${choice.account}` : choice.agent;
}
export function parseAgentValue(value: string): Pick<Choice, 'agent' | 'account'> {
  const [agent, account] = value.split('@');
  return { agent: agent as Choice['agent'], ...(account ? { account } : {}) };
}

export function openWorkLauncher(options: {
  node: NodeDetail; agents: Record<AgentName, boolean>; sessions: TerminalInfo[];
  squad: boolean; initialAgent?: TerminalInfo['agent']; mode: 'embedded' | 'external'; prompt: string;
  /** The squad to join ("new" for a new one); absent: the squad at work, otherwise the first. A Main Brain proposal fills the form. */
  teamId?: string; proposal?: SwarmProposal; initialRole?: AgentRole;
  initialModel?: string; initialEffort?: string;
  launched(sessions: TerminalInfo[], squad: boolean, external: boolean, warning?: string): void;
  dismissed(): void;
}): () => void {
  const overlay = document.getElementById('overlay')!;
  // Squads of the node: each has its own orchestrator and limit. The Main Brain belongs to none.
  const squadOf = (s: TerminalInfo) => s.teamId ?? '1';
  const working = options.sessions.find(s => s.alive && s.role === 'orchestrator');
  let teamId = options.proposal ? 'new' : options.teamId ?? (working ? squadOf(working) : '1');
  let teams: TeamSummary[] = [];
  const brainAlive = options.sessions.some(s => s.alive && s.role === 'brain');
  const members = () => teamId === 'new' ? [] : options.sessions.filter(s => s.alive && s.agent !== 'shell' && s.role !== 'brain' && squadOf(s) === teamId);
  let orchestrator = members().find(s => s.role === 'orchestrator');
  let busy = false;
  let squad = (options.squad || !!options.proposal) && options.mode === 'embedded';
  // With an orchestrator already running, a team only adds operators to it; otherwise it is an orchestrator plus operators.
  let addOnly = !!orchestrator;
  let alive = members().length;
  const HARD_MAX = 8;
  let maxAgents = 4;
  let extra = options.proposal ? options.proposal.members.length - 1 : 3;
  let restored: SavedSquad | null = null;
  let savedSquads: SavedSquad[] = [];
  let catalog: Record<AgentName, ModelChoice[]> | undefined;
  /** Extra accounts of Claude Code and Codex: each one is an entry of the agent menu. */
  let accounts: AgentAccountStatus[] = [];
  const defaultAgent = options.initialAgent ?? (['codex', 'claude', 'hermes', 'agy'] as const).find(a => options.agents[a]) ?? 'shell';
  if (defaultAgent === 'shell') squad = false;
  let choices: Choice[] = Array.from({ length: HARD_MAX }, () => ({ agent: defaultAgent, model: '', effort: '' }));
  for (let i = 0; i < choices.length; i++) {
    try {
      const saved = JSON.parse(localStorage.getItem(ui`vb:roster:${i}`) || 'null') as Choice | null;
      if (saved && saved.agent !== 'shell' && options.agents[saved.agent] && !options.initialAgent) choices[i] = { agent: saved.agent, model: saved.model, effort: saved.effort, ...(saved.account ? { account: saved.account } : {}) };
      else choices[i].model = localStorage.getItem(ui`vb:model:${defaultAgent}`) || '';
    } catch { /* keep defaults */ }
  }
  if (options.initialModel !== undefined) {
    choices[0].model = options.initialModel;
    choices[0].effort = options.initialEffort ?? '';
  }
  if (options.proposal) options.proposal.members.forEach((m, i) => { if (i < choices.length) choices[i] = { agent: m.agent, model: m.model ?? '', effort: m.effort ?? '', role: m.role }; });
  const total = () => squad && restored ? restored.members.length : squad ? Math.min(HARD_MAX, extra + (addOnly ? 0 : 1)) : 1;
  const launchLabel = () => {
    if (!squad) return tr('Avvia');
    const count = total();
    return count === 1 ? tr('Avvia 1 agente') : tr('Avvia {n} agenti').replace('{n}', String(count));
  };
  // One agent line for everyone unless the saved roster, a proposal or a saved squad already differ per member.
  let customize = squad && !allSame(choices, total());
  overlay.dataset.mode = 'work-launch';
  overlay.innerHTML = ui`<div class="dialog work-launch-dialog" role="dialog" aria-modal="true" aria-labelledby="work-launch-title"><div class="dhead"><span id="work-launch-title">Avvia · ${esc(options.node.name)}</span><button class="plain-icon" type="button" data-cancel aria-label="Chiudi">×</button></div><form><div class="dbody">`
    + ui`<div class="launch-objective" data-objective><textarea name="prompt" maxlength="4000" rows="4" aria-label="Obiettivo" placeholder="Obiettivo (facoltativo)" title="Invio avvia · Maiusc+Invio va a capo">${esc(options.prompt)}</textarea><div class="launch-attach"><ul class="launch-files" data-files aria-label="File allegati"></ul><span class="muted" data-attach-hint></span><button type="button" class="launch-attach-btn" data-attach title="Allega file, oppure trascinali sulla finestra: gli agenti ricevono il percorso.">＋ Allega</button><input type="file" multiple hidden data-attach-input></div></div>`
    + ui`<div class="launch-mode"><div class="segmented" role="group" aria-label="Avvio"><button type="button" data-preset-choice="squad" ${options.mode === 'external' || defaultAgent === 'shell' ? 'disabled' : ''}>Squadra</button><button type="button" data-preset-choice="single">Un agente</button></div><div class="launch-count" data-count-box><span id="launch-count-label">Operatori</span><div class="launch-stepper" role="group" aria-labelledby="launch-count-label"><button type="button" data-count-step="-1" aria-label="Un operatore in meno">−</button><output data-count aria-live="polite"></output><button type="button" data-count-step="1" aria-label="Un operatore in più">+</button></div></div><span class="muted launch-mode-hint" data-preset-hint></span></div>`
    + ui`<div class="launch-roster"></div><button type="button" class="launch-link" data-customize></button>`
    + ui`<div class="launch-capacity hidden" role="status"><span data-capacity></span><button type="button" class="btn small" data-raise></button></div>`
    + ui`<details class="launch-more" data-more><summary data-more-summary>Altre opzioni</summary><div class="launch-more-body"><div class="launch-team" data-team-box><label>Squadra<select data-team></select></label><input data-team-name class="hidden" maxlength="40" placeholder="Nome della nuova squadra (facoltativo)" aria-label="Nome della nuova squadra"><span class="muted" data-team-hint></span></div><div class="launch-saved" data-saved-box><label>Squadre salvate<select data-saved><option value="">Nuova configurazione</option></select></label><p class="muted" data-saved-hint>Ogni avvio salva la configurazione nel profilo di Visual Brain.</p></div></div></details>`
    + ui`<p class="launch-cli-hint hidden" data-cli-hint></p><div class="work-launch-error" role="alert"></div></div><div class="dfoot"><button type="submit" class="btn primary" title="Auto usa la configurazione del CLI.">Avvia</button></div></form></div>`;
  overlay.classList.remove('hidden');
  const form = overlay.querySelector<HTMLFormElement>('form')!;
  const prompt = form.querySelector<HTMLTextAreaElement>('[name=prompt]')!;
  const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  const roster = form.querySelector<HTMLElement>('.launch-roster')!;
  const customizeButton = form.querySelector<HTMLButtonElement>('[data-customize]')!;
  const error = form.querySelector('.work-launch-error')!;
  const dialog = overlay.querySelector<HTMLElement>('.work-launch-dialog')!;
  const more = form.querySelector<HTMLDetailsElement>('[data-more]')!;
  const filesEl = form.querySelector<HTMLElement>('[data-files]')!;
  const attachInput = form.querySelector<HTMLInputElement>('[data-attach-input]')!;
  const attachHint = form.querySelector<HTMLElement>('[data-attach-hint]')!;
  const attached: Array<{ name: string; path: string }> = [];
  let uploading = 0;
  const MAX_FILES = 20;
  const renderFiles = () => {
    filesEl.innerHTML = attached.map((f, i) => ui`<li><span title="${esc(f.path)}">${esc(f.name)}</span><button type="button" class="plain-icon" data-unattach="${i}" aria-label="Rimuovi ${esc(f.name)}">×</button></li>`).join('');
    filesEl.querySelectorAll<HTMLElement>('[data-unattach]').forEach(b => b.onclick = () => { attached.splice(Number(b.dataset.unattach), 1); renderFiles(); });
    attachHint.textContent = uploading ? tr('Caricamento allegati…') : '';
    refreshCapacity();
  };
  const room = () => { if (attached.length < MAX_FILES) return true; error.textContent = tr('Al massimo 20 allegati'); return false; };
  /** Desktop: the shell reports the dropped paths, the files are referenced where they are. */
  const attachPaths = (paths: string[]) => { for (const path of paths) if (!attached.some(f => f.path === path) && room()) attached.push({ name: path.split('/').pop() || path, path }); renderFiles(); };
  /** Browser or file picker: no path is exposed, so a copy is saved in the profile. */
  const attachFiles = async (files: File[]) => {
    for (const file of files) {
      if (!form.isConnected || !room()) break;
      uploading++; renderFiles();
      try { const saved = await api.attach(options.node.id, file); if (form.isConnected) attached.push(saved); }
      catch (err) { error.textContent = String(err); }
      finally { uploading--; if (form.isConnected) renderFiles(); }
    }
  };
  form.querySelector<HTMLButtonElement>('[data-attach]')!.onclick = () => attachInput.click();
  attachInput.onchange = () => { const files = [...attachInput.files ?? []]; attachInput.value = ''; void attachFiles(files); };
  const canAttach = () => !form.querySelector('[data-objective]')!.classList.contains('hidden');
  const onNativeDrop = (e: Event) => {
    if (!form.isConnected) { window.removeEventListener('vb-file-drop', onNativeDrop); return; }
    const drop = parseFileDrop((e as CustomEvent).detail);
    dialog.classList.toggle('drop-target', !!drop && drop.kind === 'over' && canAttach());
    if (drop?.kind === 'drop' && canAttach()) attachPaths(drop.paths);
  };
  window.addEventListener('vb-file-drop', onNativeDrop);
  dialog.addEventListener('dragover', e => { if (!canAttach() || !e.dataTransfer?.types.includes('Files')) return; e.preventDefault(); dialog.classList.add('drop-target'); });
  dialog.addEventListener('dragleave', e => { if (!dialog.contains(e.relatedTarget as Node | null)) dialog.classList.remove('drop-target'); });
  dialog.addEventListener('drop', e => { dialog.classList.remove('drop-target'); if (!canAttach() || !e.dataTransfer?.files.length) return; e.preventDefault(); void attachFiles([...e.dataTransfer.files]); });
  const close = () => { if (busy) return; window.removeEventListener('vb-file-drop', onNativeDrop); overlay.classList.add('hidden'); overlay.innerHTML = ''; delete overlay.dataset.mode; options.dismissed(); };
  overlay.querySelector('[data-cancel]')!.addEventListener('click', close);
  overlay.onmousedown = e => { if (e.target === overlay) close(); };
  let singleRole: AgentRole = options.initialRole === 'brain' && !brainAlive ? 'brain' : orchestrator ? 'operator' : 'orchestrator';
  const teamBox = form.querySelector<HTMLElement>('[data-team-box]')!;
  const teamSelect = form.querySelector<HTMLSelectElement>('[data-team]')!;
  const teamNameInput = form.querySelector<HTMLInputElement>('[data-team-name]')!;
  const savedBox = form.querySelector<HTMLElement>('[data-saved-box]')!;
  if (options.proposal) teamNameInput.value = options.proposal.name;
  /** "Altre opzioni" says where the agents go without being opened; it hides when nothing inside applies. */
  const renderMore = () => {
    const teamShown = !teamBox.classList.contains('hidden'), savedShown = squad && options.mode === 'embedded';
    savedBox.classList.toggle('hidden', !savedShown);
    more.classList.toggle('hidden', !teamShown && !savedShown);
    const target = teamId === 'new' ? (teamNameInput.value.trim() || tr('nuova squadra')) : teams.find(t => t.id === teamId)?.name ?? '';
    const parts = [teamShown && target ? target : '', restored?.name];
    if (!restored && savedShown && savedSquads.length) {
      parts.push(savedSquads.length === 1 ? tr('1 squadra salvata') : tr('{n} squadre salvate').replace('{n}', String(savedSquads.length)));
    }
    const summary = parts.filter(Boolean).join(' · ');
    form.querySelector('[data-more-summary]')!.textContent = tr('Altre opzioni') + (summary ? ' · ' + summary : '');
  };
  const renderTeams = () => {
    const list = teams.filter(t => !t.archived || t.id === teamId);
    if (!list.some(t => t.id === teamId) && teamId !== 'new') list.push({ id: teamId, name: ui`Squadra ${teamId}` } as TeamSummary);
    teamSelect.innerHTML = list.map(t => ui`<option value="${esc(t.id)}">${esc(t.name)}${t.alive ? ui` · ${t.alive} attivi` : ''}</option>`).join('') + ui`<option value="new">＋ Nuova squadra</option>`;
    teamSelect.value = teamId;
    teamSelect.disabled = !!options.proposal;
    const others = teams.filter(t => t.id !== teamId && t.alive > 0);
    teamNameInput.classList.toggle('hidden', teamId !== 'new');
    form.querySelector('[data-team-hint]')!.textContent = teamId === 'new'
      ? (others.length ? tr('Lavora in un worktree Git separato dalle altre squadre al lavoro.') : tr('Lavora nella cartella del progetto.'))
      : orchestrator ? ui`Si unisce a ${orchestrator.code || tr('l’orchestratore')}` : '';
    teamBox.classList.toggle('hidden', options.mode === 'external' || (!squad && (singleRole === 'brain' || choices[0].agent === 'shell')));
    renderMore();
  };
  teamNameInput.addEventListener('input', renderMore);
  /** Another squad chosen: its orchestrator, its members and its limit decide what the form offers. */
  const retarget = () => {
    orchestrator = members().find(s => s.role === 'orchestrator');
    addOnly = !!orchestrator; alive = members().length;
    const summary = teams.find(t => t.id === teamId);
    maxAgents = teamId === 'new' ? HARD_MAX : summary?.maxAgents ?? 4;
    if (singleRole === 'orchestrator' && orchestrator) singleRole = 'operator';
    savedSelect.disabled = options.mode !== 'embedded' || alive > 0 || !!options.proposal;
    form.querySelector('[data-saved-hint]')!.textContent = alive > 0 ? tr('Le configurazioni si recuperano in una squadra senza agenti attivi.') : tr('Ogni avvio salva la configurazione nel profilo di Visual Brain.');
    renderTeams(); renderRows();
  };
  teamSelect.onchange = () => { teamId = teamSelect.value; restored = null; savedSelect.value = ''; choices.forEach(c => { delete c.role; delete c.name; }); retarget(); };
  const minExtra = () => options.proposal && !addOnly ? 0 : 1;
  const maxExtra = () => Math.max(minExtra(), HARD_MAX - alive - (addOnly ? 0 : 1));
  const countBox = form.querySelector<HTMLElement>('[data-count-box]')!;
  const capacity = form.querySelector<HTMLElement>('.launch-capacity')!;
  const raise = capacity.querySelector<HTMLButtonElement>('[data-raise]')!;
  /** Free slots in the node: the team limit is the user's; here it is only shown, and raised on request. */
  const refreshCapacity = () => {
    countBox.classList.toggle('hidden', !squad || !!restored);
    countBox.querySelector('[data-count]')!.textContent = String(extra);
    countBox.querySelector<HTMLButtonElement>('[data-count-step="-1"]')!.disabled = extra <= minExtra();
    countBox.querySelector<HTMLButtonElement>('[data-count-step="1"]')!.disabled = extra >= maxExtra();
    const needed = alive + total();
    const limit = restored ? Math.max(restored.policy.maxAgents, restored.members.length) : maxAgents;
    const over = squad && (needed > limit || (!!restored && alive > 0));
    capacity.classList.toggle('hidden', !over);
    if (over) {
      capacity.querySelector('[data-capacity]')!.textContent = tr('Nella squadra ci sono {n} agenti attivi e il limite è {max}: ne servono {need}.').replace('{n}', String(alive)).replace('{max}', String(limit)).replace('{need}', String(needed));
      raise.textContent = tr('Porta il limite a {max}').replace('{max}', String(HARD_MAX));
      raise.classList.toggle('hidden', needed > HARD_MAX);
    }
    submit.disabled = busy || over || uploading > 0;
  };
  countBox.querySelectorAll<HTMLButtonElement>('[data-count-step]').forEach(b => b.onclick = () => { extra += Number(b.dataset.countStep); renderRows(); });
  raise.onclick = async () => {
    raise.disabled = true; error.textContent = '';
    try { if (teamId !== 'new') await api.updateTeam(options.node.id, { maxAgents: HARD_MAX }, teamId); maxAgents = HARD_MAX; refreshCapacity(); }
    catch (err) { error.textContent = String(err); }
    finally { raise.disabled = false; }
  };
  const savedSelect = form.querySelector<HTMLSelectElement>('[data-saved]')!;
  savedSelect.disabled = options.mode !== 'embedded' || alive > 0 || !!options.proposal;
  if (alive > 0) form.querySelector('[data-saved-hint]')!.textContent = tr('Le configurazioni si recuperano quando non ci sono agenti attivi nel nodo.');
  savedSelect.onchange = () => {
    restored = savedSquads.find(s => s.id === savedSelect.value) ?? null;
    if (restored) {
      squad = true;
      restored.members.forEach((m, i) => { choices[i] = { ...m, model: m.model ?? '', effort: m.effort ?? '' }; });
      customize = !allSame(choices, total());
      form.querySelector('[data-saved-hint]')!.textContent = tr('Ruoli, modelli e impostazioni recuperati. Avvia crea nuove sessioni; il riepilogo della bacheca resta disponibile.');
    } else { choices.forEach(c => { delete c.role; delete c.name; }); }
    renderRows(); renderMore();
  };
  void api.team(options.node.id).then(team => {
    if (!form.isConnected) return;
    teams = team.teamList ?? [];
    maxAgents = teamId === 'new' ? HARD_MAX : teams.find(t => t.id === teamId)?.maxAgents ?? team.policy.maxAgents;
    savedSquads = (team.savedSquads ?? []).filter(s => s.nodePath === options.node.path);
    savedSelect.innerHTML += savedSquads.map(s => `<option value="${esc(s.id)}">${esc(s.name)} · ${s.members.length} · ${esc(new Date(s.savedAt).toLocaleString())}</option>`).join('');
    renderTeams(); refreshCapacity();
  }).catch(() => { if (form.isConnected) form.querySelector('[data-saved-hint]')!.textContent = tr('Configurazioni salvate non disponibili. Riapri per riprovare.'); });

  // One agent line: agent menu, model (Auto by default) and effort menu. Shared line, per-member line or single agent.
  const agentOptions = (selected: Choice, withShell: boolean) => Object.entries(labels).filter(([a]) => withShell || a !== 'shell')
    .map(([a, label]) => {
      const off = a !== 'shell' && !options.agents[a as AgentName] ? 'disabled' : '';
      const main = ui`<option value="${a}" ${a === selected.agent && !selected.account ? 'selected' : ''} ${off}>${label}</option>`;
      return main + accounts.filter(x => x.agent === a).map(x => `<option value="${esc(agentValue({ agent: x.agent, account: x.id }))}" ${a === selected.agent && x.id === selected.account ? 'selected' : ''} ${off}>${esc(label)} · ${esc(x.label)}${x.signedIn === false ? ' ' + esc(tr('(accesso richiesto)')) : ''}</option>`).join('');
    }).join('');
  const updateEffort = (row: HTMLElement, choice: Choice) => {
    let available = effortChoices(choice.agent, choice.model, choice.agent === 'shell' ? [] : catalog?.[choice.agent]);
    if (choice.effort && !available.includes(choice.effort)) {
      // A saved model can have levels that only its catalogue entry supplies.
      if (!catalog && choice.agent !== 'shell' && choice.agent !== 'claude') available = [...available, choice.effort];
      else choice.effort = '';
    }
    const select = row.querySelector<HTMLSelectElement>('[data-effort]')!;
    select.innerHTML = ['', ...available].map(e => ui`<option value="${esc(e)}" ${choice.effort === e ? 'selected' : ''}>${e ? esc(e) : tr('Auto')}</option>`).join('');
    select.disabled = choice.agent === 'shell';
  };
  const updateModels = (row: HTMLElement, choice: Choice) => {
    const models = choice.agent === 'shell' ? [] : catalog?.[choice.agent] ?? [];
    row.querySelector('datalist')!.innerHTML = models.map(m => m.label.toLowerCase() === m.id.toLowerCase() ? ui`<option value="${esc(m.id)}"></option>` : ui`<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    row.querySelector<HTMLInputElement>('[data-model]')!.disabled = choice.agent === 'shell';
    updateEffort(row, choice);
  };
  const refreshObjective = () => {
    prompt.disabled = squad ? addOnly : choices[0].agent === 'shell';
    form.querySelector('[data-objective]')!.classList.toggle('hidden', prompt.disabled);
  };
  const toneOf = (role: AgentRole) => role === 'orchestrator' ? 'orchestrator' : 'active';
  const renderRows = () => {
    extra = Math.max(minExtra(), Math.min(extra, maxExtra()));
    const count = total();
    // The shared line drives every member: keep them aligned before showing or launching.
    if (squad && !customize) choices = sameForAll(choices, count);
    const lines = !squad ? [0] : customize ? choices.slice(0, count).map((_, i) => i) : [0];
    const member = (i: number) => {
      const choice = choices[i];
      const role = squad ? (choice.role ?? (i === 0 && !addOnly ? 'orchestrator' : 'operator')) : singleRole;
      const lead = !squad
        ? ui`<label class="launch-field launch-role" data-role-box><span>Ruolo</span><select data-role>${Object.entries(roles).map(([r, label]) => ui`<option value="${r}" ${r === singleRole ? 'selected' : ''} ${(r === 'orchestrator' && orchestrator) || (r === 'brain' && brainAlive) ? 'disabled' : ''}>${label}</option>`).join('')}</select></label>`
        : customize ? ui`<span class="role-tag" data-tone="${toneOf(role)}"><i></i>${roles[role]}${choice.name ? ' · ' + esc(choice.name) : ''}</span>` : '';
      return ui`<div class="launch-agent-row" data-row="${i}">${lead}<label class="launch-field"><span>${squad && !customize ? tr('Agente per tutti') : tr('Agente')}</span><select data-agent aria-label="Agente ${i + 1}">${agentOptions(choice, !squad)}</select></label><label class="launch-field launch-model"><span>Modello</span><input data-model list="roster-models-${i}" aria-label="Modello ${i + 1}" placeholder="Auto" title="Auto usa la configurazione del CLI." maxlength="160" autocomplete="off" value="${esc(choice.model)}"><datalist id="roster-models-${i}"></datalist></label><label class="launch-field launch-effort"><span>Effort</span><select data-effort aria-label="Effort ${i + 1}"></select></label></div>`;
    };
    roster.innerHTML = lines.map(member).join('');
    roster.classList.toggle('custom', squad && customize);
    roster.querySelectorAll<HTMLElement>('.launch-agent-row').forEach(row => {
      const i = Number(row.dataset.row), choice = choices[i];
      const model = row.querySelector<HTMLInputElement>('[data-model]')!;
      const shared = () => { if (squad && !customize) choices = sameForAll(choices, total()); };
      row.querySelector<HTMLSelectElement>('[data-agent]')!.onchange = e => {
        const picked = parseAgentValue((e.target as HTMLSelectElement).value), sameAgent = picked.agent === choice.agent;
        choice.agent = picked.agent; choice.account = picked.account;
        // Another account of the same CLI keeps model and effort; another CLI starts from its last model.
        if (sameAgent) { shared(); return; }
        choice.effort = '';
        try { choice.model = localStorage.getItem(ui`vb:model:${choice.agent}`) || ''; } catch { choice.model = ''; }
        model.value = choice.model; updateModels(row, choice); shared();
        row.querySelector('[data-role-box]')?.classList.toggle('hidden', choice.agent === 'shell' || options.mode === 'external');
        refreshObjective(); renderTeams();
      };
      row.querySelector<HTMLSelectElement>('[data-role]')?.addEventListener('change', e => { singleRole = (e.target as HTMLSelectElement).value as AgentRole; renderTeams(); });
      model.oninput = () => { choice.model = model.value.trim(); updateEffort(row, choice); shared(); };
      row.querySelector<HTMLSelectElement>('[data-effort]')!.onchange = e => { choice.effort = (e.target as HTMLSelectElement).value; shared(); };
      row.querySelector('[data-role-box]')?.classList.toggle('hidden', choice.agent === 'shell' || options.mode === 'external');
      updateModels(row, choice);
    });
    customizeButton.classList.toggle('hidden', !squad);
    customizeButton.textContent = customize ? tr('Uguale per tutti') : tr('Personalizza per agente');
    form.querySelectorAll<HTMLElement>('[data-preset-choice]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.presetChoice === 'squad') === squad)));
    submit.textContent = launchLabel();
    refreshObjective(); refreshCapacity();
    const hint = form.querySelector('[data-preset-hint]')!;
    if (!squad) hint.textContent = options.mode === 'external' ? tr('In Terminal.app') : '';
    else if (addOnly) hint.textContent = count === 1 ? tr('Collegato all’orchestratore') : tr('Collegati all’orchestratore');
    else if (count === 1) {
      const role = choices[0].role ?? 'orchestrator';
      hint.textContent = role === 'orchestrator' ? tr('Solo orchestratore') : roles[role];
    }
    else hint.textContent = tr('Orchestratore + operatori, già collegati tra loro');
  };
  customizeButton.onclick = () => { customize = !customize; renderRows(); };
  // Missing or signed-out CLIs: say which, and where to fix it, instead of a silent disabled option.
  void api.agents().then(({ clis, accounts: extra = [] }) => {
    const hint = form.querySelector<HTMLElement>('[data-cli-hint]');
    if (!hint?.isConnected) return;
    accounts = extra;
    // A remembered account that was removed falls back to the main one.
    for (const c of choices) if (c.account && !accounts.some(a => a.id === c.account && a.agent === c.agent)) delete c.account;
    if (accounts.length) renderRows();
    const missing = clis.filter(c => !c.path).map(c => c.label), signedOut = clis.filter(c => c.path && c.signedIn === false).map(c => c.label);
    if (!missing.length && !signedOut.length) return;
    hint.innerHTML = [missing.length ? ui`Non installati: ${esc(missing.join(', '))}.` : '', signedOut.length ? ui`Senza accesso: ${esc(signedOut.join(', '))}.` : ''].filter(Boolean).join(' ') + ui` <button type="button" class="link" data-open-agents>Impostazioni → Agenti</button>`;
    hint.classList.remove('hidden');
    hint.querySelector('[data-open-agents]')!.addEventListener('click', () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; delete overlay.dataset.mode; void import('./settings.ts').then(m => m.openSettings(false, 'agents')); });
  }).catch(() => {});
  form.querySelectorAll<HTMLButtonElement>('[data-preset-choice]').forEach(b => b.onclick = () => {
    if (b.disabled || (b.dataset.presetChoice === 'squad') === squad) return;
    restored = null; savedSelect.value = ''; choices.forEach(c => { delete c.role; delete c.name; });
    squad = b.dataset.presetChoice === 'squad';
    if (squad && choices[0].agent === 'shell') choices[0].agent = (['codex', 'claude', 'hermes', 'agy'] as const).find(a => options.agents[a])!;
    if (squad) customize = !allSame(choices, total());
    renderRows(); renderTeams();
  });
  // A Main Brain proposal fills team, name and members: show where it goes.
  more.open = !!options.proposal;
  renderRows(); renderTeams();
  void api.models().then(models => { if (!form.isConnected) return; catalog = models; roster.querySelectorAll<HTMLElement>('.launch-agent-row').forEach(row => updateModels(row, choices[Number(row.dataset.row)])); }).catch(() => { if (form.isConnected) error.textContent = tr('Catalogo non disponibile. Usa Auto o inserisci l’ID del modello.'); });
  prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  if (options.initialModel !== undefined) form.querySelector<HTMLInputElement>('[data-model]')?.focus();
  else if (prompt.disabled) form.querySelector<HTMLSelectElement>('[data-agent]')?.focus();
  else prompt.focus();
  form.onsubmit = async e => {
    e.preventDefault(); if (busy || submit.disabled) return;
    if (squad && !customize) choices = sameForAll(choices, total());
    if (squad && choices.slice(0, total()).some(c => c.agent === 'shell' || !options.agents[c.agent])) { error.textContent = tr('Installa gli agenti mancanti o cambia la configurazione.'); return; }
    busy = true; error.textContent = ''; submit.disabled = true; submit.textContent = tr('Avvio…');
    try {
      let sessions: TerminalInfo[] = [], external = false;
      let warning: string | undefined;
      const squadTarget = { teamId, ...(teamId === 'new' && teamNameInput.value.trim() ? { teamName: teamNameInput.value.trim() } : {}) };
      if (squad) {
        const result = await api.launchSquad({ id: options.node.id, savedId: restored?.id, prompt: prompt.value, files: attached.map(f => f.path), members: choices.slice(0, total()).map(c => ({ ...c, agent: c.agent as AgentName })), ...squadTarget, ...(options.proposal ? { proposalId: options.proposal.id } : {}) });
        sessions = result.sessions; warning = result.warning;
      } else {
        const choice = choices[0];
        const brain = singleRole === 'brain', shell = choice.agent === 'shell';
        const result = await api.launch({ id: options.node.id, ...choice, mode: options.mode, prompt: prompt.disabled ? '' : prompt.value, files: prompt.disabled ? [] : attached.map(f => f.path), role: singleRole, parentId: singleRole !== 'orchestrator' && !brain ? orchestrator?.id : undefined, ...(brain || shell || options.mode === 'external' ? {} : squadTarget) });
        if (!result.info && !result.opened) throw new Error(tr('Sessione non restituita dal server'));
        sessions = result.info ? [result.info] : []; external = !!result.opened; warning = result.warning;
      }
      for (const [i, choice] of choices.slice(0, total()).entries()) try { if (squad) localStorage.setItem(ui`vb:roster:${i}`, JSON.stringify({ agent: choice.agent, model: choice.model, effort: choice.effort, ...(choice.account ? { account: choice.account } : {}) })); localStorage.setItem(ui`vb:model:${choice.agent}`, choice.model); } catch { /* storage unavailable */ }
      busy = false; close(); options.launched(sessions, squad, external, warning);
    } catch (err) { error.textContent = String(err); }
    finally { busy = false; submit.disabled = false; submit.textContent = launchLabel(); refreshCapacity(); }
  };
  return close;
}
