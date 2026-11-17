import { t as tr, ui } from './i18n.ts';
import { ROLE_WORDS } from './work-roles.ts';
import { api } from './api.ts';
import { openSettings } from './settings.ts';
import { effortChoices } from '../shared/agent-effort.ts';
import { parseFileDrop } from './work-input.ts';
import type { AgentName, AgentRole, ModelChoice, NodeDetail, SavedSquad, SwarmProposal, TeamSummary, TerminalInfo } from '../shared/types.ts';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const marks: Record<string, string> = { codex: 'Cx', claude: 'Cl', hermes: 'He', agy: 'Ag', shell: '>_' };
const labels = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes', agy: 'Antigravity', shell: tr('Terminale') };
const roles = ROLE_WORDS;
type Choice = { agent: TerminalInfo['agent']; model: string; effort: string; role?: AgentRole; name?: string };

export function openWorkLauncher(options: {
  node: NodeDetail; agents: Record<AgentName, boolean>; sessions: TerminalInfo[];
  squad: boolean; initialAgent?: TerminalInfo['agent']; mode: 'embedded' | 'external'; prompt: string;
  /** The squad to join ("new" for a new one); absent: the squad at work, otherwise the first. A Main Brain proposal fills the form. */
  teamId?: string; proposal?: SwarmProposal; initialRole?: AgentRole;
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
  let extra = options.proposal ? Math.max(1, options.proposal.members.length - 1) : 3;
  let restored: SavedSquad | null = null;
  let savedSquads: SavedSquad[] = [];
  let catalog: Record<AgentName, ModelChoice[]> = { claude: [], codex: [], hermes: [], agy: [] };
  const defaultAgent = options.initialAgent ?? (['codex', 'claude', 'hermes', 'agy'] as const).find(a => options.agents[a]) ?? 'shell';
  if (defaultAgent === 'shell') squad = false;
  const choices: Choice[] = Array.from({ length: HARD_MAX }, () => ({ agent: defaultAgent, model: '', effort: '' }));
  for (let i = 0; i < choices.length; i++) {
    try {
      const saved = JSON.parse(localStorage.getItem(ui`vb:roster:${i}`) || 'null') as Choice | null;
      if (saved && saved.agent !== 'shell' && options.agents[saved.agent] && !options.initialAgent) choices[i] = { agent: saved.agent, model: saved.model, effort: saved.effort };
      else choices[i].model = localStorage.getItem(ui`vb:model:${defaultAgent}`) || '';
    } catch { /* keep defaults */ }
  }
  if (options.proposal) options.proposal.members.forEach((m, i) => { if (i < choices.length) choices[i] = { agent: m.agent, model: m.model ?? '', effort: m.effort ?? '', role: m.role }; });
  overlay.dataset.mode = 'work-launch';
  overlay.innerHTML = ui`<div class="dialog work-launch-dialog" role="dialog" aria-modal="true" aria-labelledby="work-launch-title"><div class="dhead"><span id="work-launch-title">Avvia · ${esc(options.node.name)}</span><button class="plain-icon" type="button" data-cancel aria-label="Chiudi">×</button></div><form><div class="dbody"><div class="launch-saved"><label>Squadre salvate<select data-saved><option value="">Nuova configurazione</option></select></label><p class="muted" data-saved-hint>Ogni avvio salva la configurazione nel profilo di Visual Brain.</p></div><div class="launch-preset"><label>Avvio<select name="preset"><option value="squad" ${options.mode === 'external' || defaultAgent === 'shell' ? 'disabled' : ''}>${orchestrator ? tr('Squadra · aggiungi operatori') : tr('Squadra · orchestratore + operatori')}</option><option value="single">Singolo agente</option></select></label><span class="muted" data-preset-hint></span></div><div class="launch-team" data-team-box><label>Squadra<select data-team></select></label><input data-team-name class="hidden" maxlength="40" placeholder="Nome della nuova squadra (facoltativo)" aria-label="Nome della nuova squadra"><span class="muted" data-team-hint></span></div><div class="launch-count hidden" data-count-box><span id="launch-count-label">Operatori</span><div class="chips" role="radiogroup" aria-labelledby="launch-count-label" data-count></div></div><div class="launch-capacity hidden" role="status"><span data-capacity></span><button type="button" class="btn small" data-raise></button></div><div class="launch-roster"></div><div class="launch-objective" data-objective><label class="work-field">Obiettivo <textarea name="prompt" maxlength="4000" rows="7" placeholder="Facoltativo, anche solo con file allegati. Invio avvia, Maiusc+Invio va a capo. Puoi dare le istruzioni anche dal terminale.">${esc(options.prompt)}</textarea></label><div class="launch-attach"><button type="button" class="btn small" data-attach>Allega file</button><input type="file" multiple hidden data-attach-input><span class="muted" data-attach-hint>oppure trascinali sulla finestra. Gli agenti ricevono il percorso.</span><ul class="launch-files" data-files aria-label="File allegati"></ul></div></div><p class="launch-cli-hint hidden" data-cli-hint></p><div class="work-launch-error" role="alert"></div></div><div class="dfoot"><span class="muted launch-default-hint">Auto usa la configurazione del CLI.</span><button type="submit" class="btn active">Avvia squadra</button></div></form></div>`;
  overlay.classList.remove('hidden');
  const form = overlay.querySelector<HTMLFormElement>('form')!;
  const preset = form.querySelector<HTMLSelectElement>('[name=preset]')!;
  preset.value = squad ? 'squad' : 'single';
  const prompt = form.querySelector<HTMLTextAreaElement>('[name=prompt]')!;
  const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  const roster = form.querySelector<HTMLElement>('.launch-roster')!;
  const error = form.querySelector('.work-launch-error')!;
  const dialog = overlay.querySelector<HTMLElement>('.work-launch-dialog')!;
  const filesEl = form.querySelector<HTMLElement>('[data-files]')!;
  const attachInput = form.querySelector<HTMLInputElement>('[data-attach-input]')!;
  const attachHint = form.querySelector<HTMLElement>('[data-attach-hint]')!;
  const attached: Array<{ name: string; path: string }> = [];
  let uploading = 0;
  const MAX_FILES = 20;
  const renderFiles = () => {
    filesEl.innerHTML = attached.map((f, i) => ui`<li><span title="${esc(f.path)}">${esc(f.name)}</span><button type="button" class="plain-icon" data-unattach="${i}" aria-label="Rimuovi ${esc(f.name)}">×</button></li>`).join('');
    filesEl.querySelectorAll<HTMLElement>('[data-unattach]').forEach(b => b.onclick = () => { attached.splice(Number(b.dataset.unattach), 1); renderFiles(); });
    attachHint.textContent = uploading ? tr('Caricamento allegati…') : attached.length ? tr('{n} allegati: gli agenti ricevono il percorso.').replace('{n}', String(attached.length)) : tr('oppure trascinali sulla finestra. Gli agenti ricevono il percorso.');
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
  if (options.proposal) teamNameInput.value = options.proposal.name;
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
  };
  /** Another squad chosen: its orchestrator, its members and its limit decide what the form offers. */
  const retarget = () => {
    orchestrator = members().find(s => s.role === 'orchestrator');
    addOnly = !!orchestrator; alive = members().length;
    const summary = teams.find(t => t.id === teamId);
    maxAgents = teamId === 'new' ? HARD_MAX : summary?.maxAgents ?? 4;
    if (singleRole === 'orchestrator' && orchestrator) singleRole = 'operator';
    savedSelect.disabled = options.mode !== 'embedded' || alive > 0 || !!options.proposal;
    form.querySelector('[data-saved-hint]')!.textContent = alive > 0 ? tr('Le configurazioni si recuperano in una squadra senza agenti attivi.') : tr('Ogni avvio salva la configurazione nel profilo di Visual Brain.');
    const squadOption = preset.querySelector<HTMLOptionElement>('option[value=squad]')!;
    squadOption.textContent = orchestrator ? tr('Squadra · aggiungi operatori') : tr('Squadra · orchestratore + operatori');
    renderTeams(); renderRows();
  };
  teamSelect.onchange = () => { teamId = teamSelect.value; restored = null; savedSelect.value = ''; choices.forEach(c => { delete c.role; delete c.name; }); retarget(); };
  const maxExtra = () => Math.max(1, HARD_MAX - alive - (addOnly ? 0 : 1));
  const total = () => squad && restored ? restored.members.length : squad ? Math.min(HARD_MAX, extra + (addOnly ? 0 : 1)) : 1;
  const countBox = form.querySelector<HTMLElement>('[data-count-box]')!;
  const capacity = form.querySelector<HTMLElement>('.launch-capacity')!;
  const raise = capacity.querySelector<HTMLButtonElement>('[data-raise]')!;
  /** Free slots in the node: the team limit is the user's; here it is only shown, and raised on request. */
  const refreshCapacity = () => {
    extra = Math.min(extra, maxExtra());
    countBox.classList.toggle('hidden', !squad || !!restored);
    countBox.querySelector('[data-count]')!.innerHTML = Array.from({ length: maxExtra() }, (_, i) => ui`<button type="button" role="radio" class="chip" data-count-choice="${i + 1}" aria-checked="${i + 1 === extra}">${i + 1}</button>`).join('');
    countBox.querySelectorAll<HTMLElement>('[data-count-choice]').forEach(b => b.onclick = () => { extra = Number(b.dataset.countChoice); renderRows(); });
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
  raise.onclick = async () => {
    raise.disabled = true; error.textContent = '';
    try { if (teamId !== 'new') await api.updateTeam(options.node.id, { maxAgents: HARD_MAX }, teamId); maxAgents = HARD_MAX; refreshCapacity(); }
    catch (err) { error.textContent = String(err); }
    finally { raise.disabled = false; }
  };
  const savedSelect = form.querySelector<HTMLSelectElement>('[data-saved]')!;
  savedSelect.disabled = options.mode !== 'embedded' || alive > 0;
  if (alive > 0) form.querySelector('[data-saved-hint]')!.textContent = tr('Le configurazioni si recuperano quando non ci sono agenti attivi nel nodo.');
  savedSelect.onchange = () => {
    restored = savedSquads.find(s => s.id === savedSelect.value) ?? null;
    if (restored) {
      squad = true; preset.value = 'squad';
      restored.members.forEach((m, i) => { choices[i] = { ...m, model: m.model ?? '', effort: m.effort ?? '' }; });
      form.querySelector('[data-saved-hint]')!.textContent = tr('Ruoli, modelli e impostazioni recuperati. Avvia crea nuove sessioni; il riepilogo della bacheca resta disponibile.');
    } else { choices.forEach(c => { delete c.role; delete c.name; }); }
    renderRows();
  };
  void api.team(options.node.id).then(team => {
    if (!form.isConnected) return;
    teams = team.teamList ?? [];
    maxAgents = teamId === 'new' ? HARD_MAX : teams.find(t => t.id === teamId)?.maxAgents ?? team.policy.maxAgents;
    savedSquads = (team.savedSquads ?? []).filter(s => s.nodePath === options.node.path);
    savedSelect.innerHTML += savedSquads.map(s => `<option value="${esc(s.id)}">${esc(s.name)} · ${s.members.length} · ${esc(new Date(s.savedAt).toLocaleString())}</option>`).join('');
    renderTeams(); refreshCapacity();
  }).catch(() => { if (form.isConnected) form.querySelector('[data-saved-hint]')!.textContent = tr('Configurazioni salvate non disponibili. Riapri per riprovare.'); });
  const effortChips = (choice: Choice, available: string[]) => ['', ...available].map(e => ui`<button type="button" role="radio" class="chip" data-effort-choice="${esc(e)}" aria-checked="${choice.effort === e}" ${choice.agent === 'shell' ? 'disabled' : ''}>${e ? esc(e) : tr('Auto')}</button>`).join('');
  const updateEffort = (row: HTMLElement, choice: Choice) => {
    const available = effortChoices(choice.agent, choice.model, choice.agent === 'shell' ? [] : catalog[choice.agent]);
    if (!available.includes(choice.effort)) choice.effort = '';
    const box = row.querySelector<HTMLElement>('[data-effort]')!;
    box.innerHTML = effortChips(choice, available);
    box.querySelectorAll<HTMLElement>('[data-effort-choice]').forEach(b => b.onclick = () => { choice.effort = b.dataset.effortChoice!; updateEffort(row, choice); });
  };
  const updateModels = (row: HTMLElement, choice: Choice) => {
    row.querySelector('datalist')!.innerHTML = choice.agent === 'shell' ? '' : catalog[choice.agent].map(m => m.label.toLowerCase() === m.id.toLowerCase() ? ui`<option value="${esc(m.id)}"></option>` : ui`<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    row.querySelector<HTMLInputElement>('[data-model]')!.disabled = choice.agent === 'shell';
    updateEffort(row, choice);
    prompt.disabled = squad ? addOnly : choices[0].agent === 'shell';
    form.querySelector('[data-objective]')!.classList.toggle('hidden', prompt.disabled);
  };
  const toneOf = (role: AgentRole) => role === 'orchestrator' ? 'orchestrator' : 'active';
  const renderRows = () => {
    const count = total();
    const member = (choice: Choice, i: number) => {
      const role = squad ? (choice.role ?? (i === 0 && !addOnly ? 'orchestrator' : 'operator')) : singleRole;
      const roleBox = squad
        ? ui`<span class="role-tag" data-tone="${toneOf(role)}"><i></i>${roles[role]}${choice.name ? ' · ' + esc(choice.name) : ''}</span>`
        : ui`<div class="chips" role="radiogroup" aria-label="Ruolo" data-role>${Object.entries(roles).map(([r, label]) => ui`<button type="button" role="radio" class="chip" data-role-choice="${r}" aria-checked="${r === singleRole}" ${(r === 'orchestrator' && orchestrator) || (r === 'brain' && brainAlive) ? 'disabled' : ''} title="${r === 'brain' ? (brainAlive ? tr('Il nodo ha già un Main Brain attivo') : tr('Coordina gli orchestratori delle squadre del nodo e propone nuove squadre')) : ''}">${label}</button>`).join('')}</div>`;
      const agentBox = Object.entries(labels).filter(([a]) => !squad || a !== 'shell').map(([a, label]) => ui`<button type="button" role="radio" class="chip agent-chip" data-agent-choice="${a}" aria-checked="${a === choice.agent}" ${a !== 'shell' && !options.agents[a as AgentName] ? 'disabled' : ''}><span class="agent-mark" aria-hidden="true">${marks[a] ?? ''}</span>${label}</button>`).join('');
      return ui`<div class="launch-member"><div class="member-role">${roleBox}</div><div class="chips" role="radiogroup" aria-label="Agent ${i + 1}">${agentBox}</div><label class="member-field">Modello<input data-model list="roster-models-${i}" aria-label="Modello ${i + 1}" placeholder="Auto" maxlength="160" autocomplete="off" value="${esc(choice.model)}"><datalist id="roster-models-${i}"></datalist></label><div class="member-field">Effort<div class="chips" role="radiogroup" data-effort aria-label="Effort ${i + 1}"></div></div></div>`;
    };
    roster.innerHTML = choices.slice(0, count).map(member).join('');
    roster.querySelectorAll<HTMLElement>('.launch-member').forEach((row, i) => {
      const choice = choices[i];
      const model = row.querySelector<HTMLInputElement>('[data-model]')!;
      row.querySelectorAll<HTMLElement>('[data-agent-choice]').forEach(b => b.onclick = () => {
        if (b.hasAttribute('disabled')) return;
        choice.agent = b.dataset.agentChoice as Choice['agent']; choice.effort = '';
        try { choice.model = localStorage.getItem(ui`vb:model:${choice.agent}`) || ''; } catch { choice.model = ''; }
        row.querySelectorAll<HTMLElement>('[data-agent-choice]').forEach(o => o.setAttribute('aria-checked', String(o === b)));
        model.value = choice.model; updateModels(row, choice);
        row.querySelector('[data-role]')?.classList.toggle('hidden', choice.agent === 'shell' || options.mode === 'external');
        renderTeams();
      });
      row.querySelectorAll<HTMLElement>('[data-role-choice]').forEach(b => b.onclick = () => {
        if (b.hasAttribute('disabled')) return;
        singleRole = b.dataset.roleChoice as AgentRole;
        row.querySelectorAll<HTMLElement>('[data-role-choice]').forEach(o => o.setAttribute('aria-checked', String(o === b)));
        renderTeams();
      });
      model.oninput = () => { choice.model = model.value.trim(); updateEffort(row, choice); };
      row.querySelector('[data-role]')?.classList.toggle('hidden', choice.agent === 'shell' || options.mode === 'external');
      updateModels(row, choice);
    });
    submit.textContent = squad ? tr('Avvia {n} agenti').replace('{n}', String(count)) : tr('Avvia');
    refreshCapacity();
    form.querySelector('[data-preset-hint]')!.textContent = squad ? (addOnly ? tr('Collegati all’orchestratore') : tr('Già collegati tra loro')) : options.mode === 'external' ? tr('In Terminal.app') : '';
  };
  // Missing or signed-out CLIs: say which, and where to fix it, instead of a silent disabled chip.
  void api.agents().then(({ clis }) => {
    const hint = form.querySelector<HTMLElement>('[data-cli-hint]');
    if (!hint?.isConnected) return;
    const missing = clis.filter(c => !c.path).map(c => c.label), signedOut = clis.filter(c => c.path && c.signedIn === false).map(c => c.label);
    if (!missing.length && !signedOut.length) return;
    hint.innerHTML = [missing.length ? ui`Non installati: ${esc(missing.join(', '))}.` : '', signedOut.length ? ui`Senza accesso: ${esc(signedOut.join(', '))}.` : ''].filter(Boolean).join(' ') + ui` <button type="button" class="link" data-open-agents>Impostazioni → Agenti</button>`;
    hint.classList.remove('hidden');
    hint.querySelector('[data-open-agents]')!.addEventListener('click', () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; delete overlay.dataset.mode; void openSettings(false, 'agents'); });
  }).catch(() => {});
  preset.onchange = () => { restored = null; savedSelect.value = ''; choices.forEach(c => { delete c.role; delete c.name; }); squad = preset.value === 'squad'; if (squad && choices[0].agent === 'shell') choices[0].agent = (['codex', 'claude', 'hermes', 'agy'] as const).find(a => options.agents[a])!; renderRows(); };
  renderRows(); renderTeams();
  void api.models().then(models => { if (!form.isConnected) return; catalog = models; roster.querySelectorAll<HTMLElement>('.launch-member').forEach((row, i) => updateModels(row, choices[i])); }).catch(() => { if (form.isConnected) error.textContent = tr('Catalogo non disponibile. Usa Auto o inserisci l’ID del modello.'); });
  prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  form.onsubmit = async e => {
    e.preventDefault(); if (busy || submit.disabled) return;
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
      for (const [i, choice] of choices.slice(0, total()).entries()) try { if (squad) localStorage.setItem(ui`vb:roster:${i}`, JSON.stringify({ agent: choice.agent, model: choice.model, effort: choice.effort })); localStorage.setItem(ui`vb:model:${choice.agent}`, choice.model); } catch { /* storage unavailable */ }
      busy = false; close(); options.launched(sessions, squad, external, warning);
    } catch (err) { error.textContent = String(err); }
    finally { busy = false; submit.disabled = false; submit.textContent = squad ? tr('Avvia {n} agenti').replace('{n}', String(total())) : tr('Avvia'); refreshCapacity(); }
  };
  return close;
}
