// Extra accounts of Claude Code and Codex: kept in the settings file, chosen at launch, handed to the CLI as
// CLAUDE_CONFIG_DIR / CODEX_HOME, kept by «Riprendi», and used to find the session's own records.
// No real agent, PTY or server: the main and extra accounts are temporary folders.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vb-accounts-'));
const mainClaude = join(dir, 'main-claude'), mainCodex = join(dir, 'main-codex'), cwd = join(dir, 'progetto');
for (const d of [mainClaude, mainCodex, cwd]) mkdirSync(d);
process.env.CLAUDE_CONFIG_DIR = mainClaude; process.env.CODEX_HOME = mainCodex;

const accounts = await import('../src/server/accounts.ts');
const { launchEmbedded, resumeEmbedded, findCodexSession } = await import('../src/server/launch.ts');
const { sessionModel } = await import('../src/server/session-model.ts');
const { cliAction } = await import('../src/server/agent-clis.ts');
const { DEFAULTS } = await import('../src/server/config.ts');
const { allSame, sameForAll, agentValue, parseAgentValue } = await import('../src/ui/work-launcher.ts');

try {
  // --- Names, ids and the settings file.
  {
    assert.equal(accounts.accountId('Lavoro', []), 'lavoro');
    assert.equal(accounts.accountId('Personale è Più', []), 'personale-e-piu', 'accents and spaces become a readable id');
    assert.equal(accounts.accountId('Lavoro', ['lavoro', 'lavoro-2']), 'lavoro-3', 'ids stay unique');
    assert.equal(accounts.accountId('!!!', []), 'account');
    assert.deepEqual(accounts.parseAccounts([{ id: 'a', agent: 'claude', label: 'A', home: '/x' }, { id: 'a', agent: 'codex', label: 'dup', home: '/y' },
      { id: 'B', agent: 'claude', label: 'b', home: '/z' }, { id: 'c', agent: 'hermes', label: 'c', home: '/z' }, { id: 'd', agent: 'codex', label: ' ', home: '/z' },
      { id: 'e', agent: 'codex', label: 'e', home: 'relative' }, null, 'x']), [{ id: 'a', agent: 'claude', label: 'A', home: '/x' }], 'only well-formed, unique entries are kept');
    assert.deepEqual(accounts.parseAccounts(undefined), []);

    const configFile = join(dir, 'profile', 'settings.json');
    mkdirSync(join(dir, 'profile'));
    writeFileSync(configFile, JSON.stringify({ roots: ['/tmp/x'], language: 'it' }));
    const cfg = { dataDir: join(dir, 'profile'), configFile };
    accounts.useAccounts([]);
    const work = accounts.addAccount(cfg, 'claude', '  Lavoro  ');
    assert.deepEqual(work, { id: 'lavoro', agent: 'claude', label: 'Lavoro', home: join(dir, 'profile', 'accounts', 'claude-lavoro') });
    assert.equal(statSync(work.home).mode & 0o777, 0o700, 'the account folder is private');
    const personal = accounts.addAccount(cfg, 'codex', 'Personale');
    assert.throws(() => accounts.addAccount(cfg, 'claude', 'lavoro'), /Esiste già/);
    assert.throws(() => accounts.addAccount(cfg, 'hermes', 'Altro'), /Claude Code e Codex/);
    assert.throws(() => accounts.addAccount(cfg, 'claude', '   '), /nome/);
    let saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.deepEqual(saved.roots, ['/tmp/x'], 'the other settings stay');
    assert.deepEqual(saved.accounts.map(a => a.id), ['lavoro', 'personale']);
    assert.equal(statSync(configFile).mode & 0o777, 0o600);

    assert.equal(accounts.accountFor('claude', undefined), undefined, 'no account: the main one');
    assert.equal(accounts.accountFor('claude', '')?.id, undefined);
    assert.equal(accounts.accountFor('claude', 'lavoro').id, 'lavoro');
    assert.throws(() => accounts.accountFor('codex', 'lavoro'), /non valido/, 'an account of another agent is refused');
    assert.throws(() => accounts.accountFor('claude', 'nessuno'), /non valido/);
    assert.throws(() => accounts.accountFor('claude', 42), /non valido/);

    assert.equal(accounts.agentHome('claude'), mainClaude, 'the main account follows the CLI’s own variable');
    assert.equal(accounts.agentHome('claude', 'lavoro'), work.home);
    assert.equal(accounts.agentHome('claude', 'rimosso'), mainClaude);
    assert.deepEqual(accounts.accountEnv('claude', 'lavoro'), { CLAUDE_CONFIG_DIR: work.home });
    assert.deepEqual(accounts.accountEnv('codex', 'personale'), { CODEX_HOME: personal.home });
    assert.deepEqual(accounts.accountEnv('codex', 'lavoro'), {}, 'never the variable of another CLI');
    assert.deepEqual(accounts.accountEnv('claude'), {});
    console.log('PASS accounts: ids, validation, private folders and the settings file');
  }

  // --- Launch and resume hand the account's folder to the CLI; the main account gets nothing new.
  {
    let options;
    const terms = { spawn(opts) { options = opts; return { info: {} }; } };
    const detail = { id: 7, name: 'fixture' };
    launchEmbedded(terms, 'claude', DEFAULTS, detail, cwd, 'ciao', undefined, { account: 'lavoro' });
    assert.equal(options.env.CLAUDE_CONFIG_DIR, accounts.agentHome('claude', 'lavoro'));
    assert.ok(options.env.VB_EXPLORE_URL, 'the graph tool stays');
    assert.equal(options.account, 'lavoro', 'the session remembers its account');
    assert.equal(options.title, 'claude (Lavoro) · fixture');
    launchEmbedded(terms, 'claude', DEFAULTS, detail, cwd, 'ciao', undefined, { role: 'operator' });
    assert.equal(options.env.CLAUDE_CONFIG_DIR, undefined, 'main account: the CLI keeps its default folder');
    assert.equal(options.account, undefined);
    assert.equal(options.title, 'claude · fixture');
    launchEmbedded(terms, 'codex', DEFAULTS, detail, cwd, 'ciao', undefined, { account: 'personale', role: 'operator' });
    assert.equal(options.env.CODEX_HOME, accounts.agentHome('codex', 'personale'));
    assert.ok(options.env.VB_TEAM_TOKEN, 'team variables stay beside the account');
    resumeEmbedded(terms, DEFAULTS, { id: 's1', agent: 'claude', cwd, title: 't', nodeId: null, createdAt: Date.now(), account: 'lavoro' }, 'conv', 'token', 0);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, accounts.agentHome('claude', 'lavoro'), '«Riprendi» reopens the conversation in the same account, even without a node');
    assert.equal(options.account, 'lavoro');
    assert.ok(options.args.includes('--resume') && options.args.includes('conv'));
    console.log('PASS launch and «Riprendi» run the CLI with the account’s folder; the main account is unchanged');
  }

  // --- The session's records are read in its account's folder.
  {
    const resumeId = '11111111-2222-3333-4444-555555555555';
    const munged = realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-');
    const projects = join(accounts.agentHome('claude', 'lavoro'), 'projects', munged);
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${resumeId}.jsonl`), JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'claude-haiku-5-5' } }) + '\n');
    const createdAt = Date.now();
    assert.equal(sessionModel({ id: 'acc-1', agent: 'claude', cwd, createdAt, resumeId, account: 'lavoro' }, undefined, createdAt, true)?.now, 'claude-haiku-5-5');
    assert.equal(sessionModel({ id: 'main-1', agent: 'claude', cwd, createdAt, resumeId }, undefined, createdAt, true), undefined, 'the main folder does not hold it');

    const day = new Date(createdAt);
    const codexDay = join(accounts.agentHome('codex', 'personale'), 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    mkdirSync(codexDay, { recursive: true });
    const codexId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeFileSync(join(codexDay, `rollout-x-${codexId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: codexId, cwd, timestamp: new Date(createdAt).toISOString() } }) + '\n');
    assert.equal(findCodexSession(cwd, createdAt, new Set(), accounts.agentHome('codex', 'personale')), codexId);
    assert.equal(findCodexSession(cwd, createdAt, new Set()), undefined, 'the main Codex folder does not hold it');
    console.log('PASS model and Codex conversation are found in the account’s folder');
  }

  // --- Sign-in runs the CLI's own command in the account's folder; the name never enters the script.
  {
    const odd = { id: 'odd', agent: 'codex', label: `x"; rm -rf ~ #'$(id)`, home: join(dir, "it's home") };
    const action = cliAction(DEFAULTS, 'codex', 'login', odd);
    const script = action.args[1];
    assert.ok(script.startsWith(`CODEX_HOME='${join(dir, "it'\\''s home")}' 'codex' 'login'`), script);
    assert.ok(!script.includes('rm -rf') && !script.includes('$(id)'), 'the account name stays out of the shell script');
    assert.equal(action.title, `Codex (${odd.label}) · accesso`);
    assert.ok(cliAction(DEFAULTS, 'claude', 'logout', { ...odd, agent: 'claude' }).args[1].includes("'claude' 'auth' 'logout'"));
    assert.throws(() => cliAction(DEFAULTS, 'claude', 'login', odd), /non disponibile/, 'an account of another CLI');
    assert.throws(() => cliAction(DEFAULTS, 'codex', 'install', odd), /non disponibile/, 'install and update are for the CLI, not an account');
    assert.ok(!cliAction(DEFAULTS, 'codex', 'login').args[1].includes('CODEX_HOME'), 'the main account signs in as before');
    console.log('PASS sign-in and sign-out of an extra account in a visible terminal, in its own folder');
  }

  // --- Launcher: the agent menu value and «Uguale per tutti» carry the account.
  {
    assert.equal(agentValue({ agent: 'claude' }), 'claude');
    assert.equal(agentValue({ agent: 'claude', account: 'lavoro' }), 'claude@lavoro');
    assert.deepEqual(parseAgentValue('claude@lavoro'), { agent: 'claude', account: 'lavoro' });
    assert.deepEqual(parseAgentValue('codex'), { agent: 'codex' });
    const roster = [{ agent: 'claude', account: 'lavoro', model: '', effort: '' }, { agent: 'claude', model: '', effort: '' }];
    assert.equal(allSame(roster, 2), false, 'another account is another configuration');
    assert.equal(sameForAll(roster, 2)[1].account, 'lavoro');
    assert.equal(allSame(sameForAll(roster, 2), 2), true);
    console.log('PASS launcher: account in the agent menu and in the shared line');
  }

  // --- Avanzate: what an extra account borrows from the main one. Off by default; linked, never copied.
  {
    const cfg = { configFile: join(dir, 'profile', 'settings.json') };
    assert.equal(accounts.accountById('lavoro').share, undefined, 'nothing is shared by default');
    assert.throws(() => accounts.setAccountShare(cfg, 'personale', { memory: true }), /solo con Claude Code/, 'Codex memory is never shared');
    assert.throws(() => accounts.setAccountShare(cfg, 'lavoro', { memory: 'yes' }), /non valide/);
    assert.throws(() => accounts.setAccountShare(cfg, 'nessuno', {}), /non trovato/);
    assert.deepEqual(accounts.parseShare('codex', { memory: true, tools: true }), { tools: true });
    assert.equal(accounts.parseShare('claude', { memory: false }), undefined);

    // The main folder: skills, plugins, personal instructions and enabled plugins in settings.json.
    mkdirSync(join(mainClaude, 'skills', 'mia-skill'), { recursive: true });
    mkdirSync(join(mainClaude, 'plugins'));
    writeFileSync(join(mainClaude, 'CLAUDE.md'), 'istruzioni personali');
    writeFileSync(join(mainClaude, 'settings.json'), JSON.stringify({ model: 'opus', enabledPlugins: { 'a@m': true }, permissions: { allow: ['Bash(ls)'] } }));
    // The account already had a skills folder of its own: it is set aside, never deleted.
    const home = accounts.agentHome('claude', 'lavoro');
    mkdirSync(join(home, 'skills', 'sua'), { recursive: true });

    const { syncShared, sharedClaudeSettings, memoryProject, SHARED_TOOLS } = await import('../src/server/account-share.ts');
    const link = name => { try { return readlinkSync(join(home, name)); } catch { return null; } };
    let account = accounts.setAccountShare(cfg, 'lavoro', { tools: true });
    assert.deepEqual(account.share, { tools: true });
    assert.deepEqual(JSON.parse(readFileSync(cfg.configFile, 'utf8')).accounts.find(a => a.id === 'lavoro').share, { tools: true }, 'the choice is saved');
    assert.deepEqual(syncShared(account).sort(), ['CLAUDE.md', 'plugins', 'skills']);
    assert.equal(link('skills'), join(mainClaude, 'skills'));
    assert.equal(readFileSync(join(home, 'CLAUDE.md'), 'utf8'), 'istruzioni personali');
    assert.ok(statSync(join(home, 'skills.own', 'sua')).isDirectory(), 'the account’s own skills are kept beside');
    assert.equal(link('agents'), null, 'what the main folder lacks is not linked');
    assert.equal(link('settings.json'), null, 'settings stay separate');
    assert.ok(!SHARED_TOOLS.claude.includes('settings.json') && !SHARED_TOOLS.claude.includes('.claude.json'), 'never settings or the account state');
    assert.deepEqual(syncShared(account).sort(), ['CLAUDE.md', 'plugins', 'skills'], 'idempotent');
    mkdirSync(join(mainClaude, 'agents'));
    assert.ok(syncShared(account).includes('agents'), 'an entry the main folder gains later is linked at the next launch');

    const settings = sharedClaudeSettings('lavoro', cwd);
    assert.deepEqual(settings, { enabledPlugins: { 'a@m': true } }, 'enabled plugins only: not the model, not the permissions');

    account = accounts.setAccountShare(cfg, 'lavoro', { tools: false });
    syncShared(account);
    for (const name of ['CLAUDE.md', 'plugins', 'agents']) assert.equal(link(name), null, `${name}: our link is removed`);
    assert.ok(statSync(join(home, 'skills', 'sua')).isDirectory() && !existsSync(join(home, 'skills.own')), 'the account’s own skills come back');
    assert.ok(existsSync(join(mainClaude, 'skills', 'mia-skill')), 'the main folder is never touched');

    // Memory: the main account's auto memory of the project, the Git repository shared by its folders and worktrees.
    accounts.setAccountShare(cfg, 'lavoro', { memory: true });
    const munge = p => realpathSync(p).replace(/[^a-zA-Z0-9]/g, '-');
    assert.deepEqual(sharedClaudeSettings('lavoro', cwd), { autoMemoryDirectory: join(mainClaude, 'projects', munge(cwd), 'memory') }, 'outside a repository: the folder');
    assert.deepEqual(sharedClaudeSettings('lavoro', cwd, 'off'), {}, 'a squad that keeps memory off keeps it off');
    assert.deepEqual(sharedClaudeSettings(undefined, cwd), {}, 'the main account gets nothing');
    assert.deepEqual(sharedClaudeSettings('personale', cwd), {}, 'Codex gets no Claude settings');
    const repo = join(dir, 'repo'), sub = join(repo, 'src', 'deep'), tree = join(dir, 'albero');
    mkdirSync(sub, { recursive: true });
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, stdio: 'ignore' });
    git('init'); writeFileSync(join(repo, 'f'), 'x'); git('add', 'f'); git('commit', '-m', 'x'); git('worktree', 'add', tree, '-b', 'ramo');
    assert.equal(memoryProject(sub), realpathSync(repo), 'a subfolder belongs to its repository');
    assert.equal(memoryProject(tree), realpathSync(repo), 'a worktree shares the memory of its repository');

    // At launch: the borrowed settings ride on --settings; with a team role the hooks are added, a squad memory wins.
    let options;
    const terms = { spawn(opts) { options = opts; return { info: {} }; } };
    launchEmbedded(terms, 'claude', DEFAULTS, { id: 7, name: 'fixture' }, sub, 'ciao', undefined, { account: 'lavoro' });
    let flag = JSON.parse(options.args[options.args.indexOf('--settings') + 1]);
    assert.equal(flag.autoMemoryDirectory, join(mainClaude, 'projects', munge(repo), 'memory'));
    assert.equal(flag.hooks, undefined, 'a single agent gets no team hooks');
    launchEmbedded(terms, 'claude', DEFAULTS, { id: 7, name: 'fixture' }, sub, 'ciao', undefined, { account: 'lavoro', role: 'orchestrator', memory: join(dir, 'squad-memory') });
    flag = JSON.parse(options.args[options.args.indexOf('--settings') + 1]);
    assert.equal(flag.autoMemoryDirectory, join(dir, 'squad-memory'), 'a squad memory of its own wins');
    assert.ok(flag.hooks?.Stop, 'team hooks stay');
    launchEmbedded(terms, 'claude', DEFAULTS, { id: 7, name: 'fixture' }, sub, 'ciao', undefined, {});
    assert.ok(!options.args.includes('--settings'), 'the main account launches exactly as before');

    // Codex: skills, rules, prompts and AGENTS.md, linked at launch.
    mkdirSync(join(mainCodex, 'rules'));
    writeFileSync(join(mainCodex, 'AGENTS.md'), 'regole');
    accounts.setAccountShare(cfg, 'personale', { tools: true });
    launchEmbedded(terms, 'codex', DEFAULTS, { id: 7, name: 'fixture' }, cwd, 'ciao', undefined, { account: 'personale' });
    assert.equal(readlinkSync(join(accounts.agentHome('codex', 'personale'), 'rules')), join(mainCodex, 'rules'));
    assert.equal(readFileSync(join(accounts.agentHome('codex', 'personale'), 'AGENTS.md'), 'utf8'), 'regole');
    accounts.setAccountShare(cfg, 'lavoro', {});
    console.log('PASS Avanzate: memory, skills and plugins of the main account, linked on request and given back when turned off');
  }

  // --- Names: the main account of each CLI and the extra ones, renamable; the label shown on each session.
  {
    const cfg = { configFile: join(dir, 'profile', 'settings.json') };
    const home = accounts.agentHome('claude', 'lavoro');
    const renamed = accounts.renameAccount(cfg, 'lavoro', '  Ufficio   Milano ');
    assert.deepEqual([renamed.id, renamed.label, renamed.home], ['lavoro', 'Ufficio Milano', home], 'renaming keeps id and folder');
    assert.equal(accounts.agentHome('claude', 'lavoro'), home);
    assert.throws(() => accounts.renameAccount(cfg, 'lavoro', '  '), /nome/);
    assert.throws(() => accounts.renameAccount(cfg, 'nessuno', 'X'), /non trovato/);
    assert.deepEqual(accounts.parseMainNames({ claude: '  Personale ', codex: '', hermes: 'x', extra: 1 }), { claude: 'Personale' });
    assert.deepEqual(accounts.parseMainNames(null), {});
    assert.deepEqual(accounts.setMainName(cfg, 'claude', 'Personale'), { claude: 'Personale' });
    assert.equal(accounts.mainName('claude'), 'Personale');
    assert.equal(accounts.mainName('shell'), undefined);
    assert.throws(() => accounts.setMainName(cfg, 'claude', 'ufficio milano'), /Esiste già/, 'the main name differs from the extra ones');
    assert.throws(() => accounts.renameAccount(cfg, 'lavoro', 'PERSONALE'), /Esiste già/, 'and the other way round');
    assert.throws(() => accounts.setMainName(cfg, 'hermes', 'X'), /Claude Code e Codex/);
    let saved = JSON.parse(readFileSync(cfg.configFile, 'utf8'));
    assert.deepEqual(saved.accountNames, { claude: 'Personale' });
    assert.equal(saved.accounts.find(a => a.id === 'lavoro').label, 'Ufficio Milano');
    assert.deepEqual(saved.roots, ['/tmp/x'], 'the other settings stay');
    assert.deepEqual(accounts.setMainName(cfg, 'claude', ' '), {}, 'an empty name goes back to «Principale»');
    assert.deepEqual(JSON.parse(readFileSync(cfg.configFile, 'utf8')).accountNames, {});
    accounts.setMainName(cfg, 'claude', 'Personale');

    const { useAccountNames, accountTag, mainAccountName } = await import('../src/ui/account-names.ts');
    useAccountNames({ accounts: [], main: {} });
    assert.equal(accountTag({ agent: 'claude' }), null, 'a single account nobody named: no label');
    assert.equal(mainAccountName('claude'), 'Principale');
    useAccountNames({ accounts: [{ id: 'lavoro', agent: 'claude', label: 'Ufficio Milano' }], main: {} });
    assert.equal(accountTag({ agent: 'claude' }), 'Principale', 'with an extra account the main one is told apart');
    assert.equal(accountTag({ agent: 'codex' }), null, 'another CLI without extra accounts: no label');
    assert.equal(accountTag({ agent: 'claude', account: 'lavoro' }), 'Ufficio Milano');
    assert.equal(accountTag({ agent: 'claude', account: 'rimosso' }), 'rimosso', 'a removed account still shows which one it was');
    assert.equal(accountTag({ agent: 'shell' }), null);
    useAccountNames({ accounts: [], main: { codex: 'Lavoro' } });
    assert.equal(accountTag({ agent: 'codex' }), 'Lavoro', 'a named main account always shows its name');
    assert.equal(mainAccountName('codex'), 'Lavoro');
    console.log('PASS renaming extra and main accounts, unique names, saved in the settings file, label on the sessions');
  }
  {
    const cfg = { configFile: join(dir, 'profile', 'settings.json') };
    const home = accounts.agentHome('claude', 'lavoro');
    accounts.removeAccount(cfg, 'lavoro');
    assert.equal(accounts.accountById('lavoro'), undefined);
    assert.ok(statSync(home).isDirectory(), 'removing forgets the account but keeps its folder');
    assert.deepEqual(JSON.parse(readFileSync(cfg.configFile, 'utf8')).accounts.map(a => a.id), ['personale']);
    assert.throws(() => accounts.removeAccount(cfg, 'lavoro'), /non trovato/);
    const again = accounts.addAccount({ dataDir: join(dir, 'profile'), configFile: cfg.configFile }, 'claude', 'Lavoro');
    assert.equal(again.home, home, 'added again with the same name, it finds its folder');
    console.log('PASS removal keeps the folder; adding the same name again reuses it');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
