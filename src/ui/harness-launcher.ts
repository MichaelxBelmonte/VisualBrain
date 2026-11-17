import { api } from './api.ts';
import { t, ui } from './i18n.ts';
import { openSettings } from './settings.ts';
import type { TerminalInfo } from '../shared/types.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function openHarnessLauncher(nodeId: number, launched: (info: TerminalInfo) => void): Promise<void> {
  const overlay = document.getElementById('overlay')!;
  overlay.dataset.mode = 'harness-launch';
  overlay.classList.remove('hidden');
  overlay.innerHTML = ui`<div class="dialog" role="dialog" aria-modal="true"><div class="dhead"><span>Harness del nodo</span><button class="btn small" data-close>Chiudi</button></div>
    <form><div class="dbody"><label class="work-field">Harness<select name="harness"></select></label><p data-hint class="muted"></p>
      <div data-install-box><p data-install-status role="status" aria-live="polite"></p><button type="button" class="btn" data-install>Installa da Impostazioni → Agenti</button></div>
      <label class="work-field" data-task-picker>Task del nodo<select name="task"><option value="">Nuovo incarico</option></select></label>
      <label class="work-field" data-prompt>Obiettivo<textarea name="prompt" rows="3" maxlength="1000"></textarea></label>
      <label class="work-field" data-limit>Limite chiamate<input name="maxCalls" type="number" min="1" max="200" value="20"></label>
      <div class="work-launch-error" role="alert"></div></div><div class="dfoot"><button class="btn" type="submit" name="action" value="prepare">Prepara task</button>
      <button class="btn active" type="submit" name="action" value="run">Esegui task</button>
      <button class="btn" type="submit" name="action" value="setup" formnovalidate>Configura DeepSeek</button></div></form></div>`;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { if (!busy) { clearTimeout(timer); overlay.classList.add('hidden'); overlay.innerHTML = ''; delete overlay.dataset.mode; } };
  overlay.querySelector('[data-close]')!.addEventListener('click', close);
  overlay.onmousedown = e => { if (e.target === overlay) close(); };
  const form = overlay.querySelector<HTMLFormElement>('form')!;
  const select = form.querySelector<HTMLSelectElement>('[name=harness]')!;
  const prompt = form.querySelector<HTMLTextAreaElement>('textarea')!;
  const error = form.querySelector<HTMLElement>('[role=alert]')!;
  const buttons = [...form.querySelectorAll<HTMLButtonElement>('[name=action]')];
  const installButton = form.querySelector<HTMLButtonElement>('[data-install]')!;
  installButton.disabled = true;
  buttons.forEach(b => { b.disabled = true; });
  try {
    let [catalog, board] = await Promise.all([api.harnesses(), api.team(nodeId)]);
    if (!form.isConnected) return;
    select.innerHTML = catalog.map(h => `<option value="${h.id}">${esc(h.label)}</option>`).join('');
    select.value = catalog.find(h => h.installed)?.id || catalog[0]?.id || '';
    const tasks = board.tasks.filter(task => task.status !== 'done');
    const picker = form.querySelector<HTMLSelectElement>('[name=task]')!;
    picker.innerHTML += tasks.map(task => `<option value="${esc(task.id)}">${esc(task.title)}</option>`).join('');
    picker.onchange = () => { prompt.value = tasks.find(task => task.id === picker.value)?.title || ''; };
    const update = () => {
      const google = select.value === 'harness2-google', deepseek = select.value === 'deepseek';
      const choice = catalog.find(h => h.id === select.value);
      const installed = !!choice?.installed, installing = choice?.install?.state === 'installing';
      form.querySelector<HTMLElement>('[data-prompt]')!.hidden = google || !installed;
      form.querySelector<HTMLElement>('[data-task-picker]')!.hidden = google || !installed;
      form.querySelector<HTMLElement>('[data-limit]')!.hidden = google || deepseek || !installed;
      prompt.required = installed && !google;
      const outdated = installed && !!choice?.outdated && !installing;
      form.querySelector<HTMLElement>('[data-install-box]')!.hidden = installed && !outdated && !installing;
      const steps: Record<string, string> = { download: t('Scaricamento componenti'), python: t('Preparazione Python'), packages: t('Installazione pacchetti'), verify: t('Verifica installazione') };
      form.querySelector('[data-install-status]')!.textContent = installing
        ? `${steps[choice!.install!.step] || t('Installazione in corso…')} · ${t('Puoi chiudere questa finestra; l’installazione continua finché l’app resta aperta.')}`
        : choice?.install?.error ? t(choice.install.error) : outdated ? ui`Installata: ${choice!.version} · disponibile: ${choice!.latest}` : choice?.canInstall ? t('Non installato') : t('Installer non disponibile. Usa il pacchetto Mac completo.');
      installButton.disabled = busy;
      buttons[0].hidden = deepseek;
      buttons[1].hidden = google;
      buttons[2].hidden = !deepseek;
      buttons[0].textContent = google ? t('Apri laboratorio') : t('Prepara task');
      buttons[1].textContent = deepseek ? t('Esegui task') : t('Ottimizza harness');
      buttons.forEach(b => { b.disabled = busy || !installed; });
      form.querySelector('[data-hint]')!.textContent = google
        ? t('Framework ufficiale: apre una demo locale e un terminale per i benchmark. Il contesto del nodo viene esportato.')
        : deepseek ? t('Esegue il task con il profilo headless di dsh e termina. Configura prima modello e accesso in DeepSeek Harness.')
        : t('CLI community indipendente da Google. Importa il task nel progetto Git. Prepara mostra il piano senza chiamate; Ottimizza usa modelli e quota. Il risultato si rivede con diff e apply.');
    };
    select.onchange = update;
    update();
    const refresh = async () => {
      if (!form.isConnected) return;
      try { catalog = await api.harnesses(); if (form.isConnected) update(); }
      catch (err) { if (form.isConnected) error.textContent = String(err); }
      if (form.isConnected && catalog.some(h => h.install?.state === 'installing')) timer = setTimeout(() => void refresh(), 1500);
    };
    if (catalog.some(h => h.install?.state === 'installing')) timer = setTimeout(() => void refresh(), 1500);
    // Installing and updating live in one place: Impostazioni → Agenti.
    installButton.onclick = () => { busy = false; close(); void openSettings(false, 'agents'); };
    form.onsubmit = async e => {
      e.preventDefault(); if (busy || !catalog.find(h => h.id === select.value)?.installed) return;
      busy = true; buttons.forEach(b => { b.disabled = true; }); error.textContent = '';
      try {
        const result = await api.launchHarness({ id: nodeId, harness: select.value, prompt: prompt.value, maxCalls: Number(form.querySelector<HTMLInputElement>('[name=maxCalls]')!.value), action: (e.submitter as HTMLButtonElement | null)?.value || (select.value === 'deepseek' ? 'run' : 'prepare') });
        busy = false; close(); launched(result.info);
      } catch (err) { error.textContent = String(err); }
      finally { busy = false; if (form.isConnected) update(); }
    };
  } catch (err) { error.textContent = String(err); }
}
