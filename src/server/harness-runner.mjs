// Runs only after an explicit UI launch. Every command uses argv, never prompt interpolation.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { spawn } from 'node:child_process';

const run = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const en = run.language === 'en';
const say = (it, english) => console.log(en ? english : it);
const execute = (file, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { cwd: run.cwd, env, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`${file}: ${signal || code}`)));
});

try {
  if (run.harness === 'deepseek') {
    if (run.action !== 'setup') say('DeepSeek: eseguo un task; la sessione termina alla fine. Modello e accesso provengono dal profilo headless di dsh.',
      'DeepSeek: running one task, then exiting. Model and credentials come from the dsh headless profile.');
    await execute(run.executable, run.action === 'setup' ? ['web', '--host', '127.0.0.1', '--port', '0'] : ['headless', '--', run.prompt]);
  } else if (run.harness === 'harness2-cli') {
    if (!existsSync(join(run.cwd, '.harness2/config.toml'))) await execute(run.executable, ['-C', run.cwd, 'init', '--yes']);
    const imported = join(run.runDir, 'task.jsonl');
    writeFileSync(imported, JSON.stringify({ id: run.runId, prompt: run.taskPrompt, domain: `visual-brain-${run.runId.split('-')[1]}`, workspace: 'project' }) + '\n', { mode: 0o600 });
    await execute(run.executable, ['-C', run.cwd, 'task', 'import', imported]);
    const args = ['-C', run.cwd, 'run', '--only-tasks', run.runId, '--name', run.runId, '--max-calls', String(run.maxCalls)];
    say('Harness² CLI community: lavora su copie Git dell’ultimo commit. Le modifiche non committate non sono incluse.',
      'Community Harness² CLI: uses Git copies of the latest commit. Uncommitted changes are not included.');
    try {
      await execute(run.executable, [...args, ...(run.action === 'prepare' ? ['--dry-run'] : [])]);
    } catch (error) {
      if (run.action !== 'prepare') throw error;
      say('Task importato, ma anteprima non disponibile. Controlla l’errore sopra e configura l’accesso con harness2 doctor / harness2 login.',
        'Task imported, but preview is unavailable. Check the error above and configure credentials with harness2 doctor / harness2 login.');
    }
    say('Per vedere e applicare il risultato usa harness2 diff e harness2 apply. Per seguire il run usa harness2 status.',
      'Review and apply results with harness2 diff and harness2 apply. Follow the run with harness2 status.');
    if (run.action === 'prepare') {
      say('Task importato. Per avviare l’ottimizzazione dal terminale:', 'Task imported. To start optimization from the terminal:');
      console.log(`harness2 run --only-tasks ${run.runId} --name ${run.runId} --max-calls ${run.maxCalls}`);
    }
  } else {
    say('Harness² ufficiale Google Research: demo deterministica, senza modelli. I benchmark reali richiedono dati e credenziali Vertex AI.',
      'Official Google Research Harness²: deterministic demo, no models. Real benchmarks require data and Vertex AI credentials.');
    await execute(join(dirname(run.executable), 'harness2-demo'), ['--output', join(run.runDir, 'demo'), '--k', '1']);
    console.log('https://github.com/google-research/harness2');
    say('Contesto del nodo disponibile in VB_NODE_CONTEXT. Comandi: harness2 --help, harness2-check --help.',
      'Node context is available in VB_NODE_CONTEXT. Commands: harness2 --help, harness2-check --help.');
  }
  if (run.harness !== 'deepseek') await execute(process.env.SHELL || '/bin/zsh', ['-i'], {
    ...process.env, PATH: dirname(run.executable) + delimiter + process.env.PATH,
    VB_NODE_CONTEXT: run.contextFile,
  });
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
