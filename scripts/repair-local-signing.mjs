// One-time transition from ad-hoc bundles to the pinned local identity. Never stops terminals or edits TCC.
// --prepare stages signed copies; --apply gracefully restarts only the desktop shell and preserves the PTY host.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { localSigning, unlockLocalSigning, signLocal, verifyReleaseIdentity } from './local-signing.mjs';
const root=resolve(import.meta.dirname,'..'), appName='Visual Brain.app';
const work=join(root,'.build/local-signing-repair'), planFile=join(work,'plan.json');
const identity=localSigning(root); if(!identity) throw Error('Prepare the persistent local identity first');
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});
const plist=(app,key)=>run('/usr/libexec/PlistBuddy',['-c',`Print ${key}`,join(app,'Contents/Info.plist')]).trim();
const hash=app=>createHash('sha256').update(readFileSync(join(app,'Contents/MacOS',plist(app,'CFBundleExecutable')))).digest('hex');
const inspect=app=>{
 if(plist(app,'CFBundleIdentifier')!=='com.jethr.visualbrain') throw Error('Unexpected app identity: '+app);
 run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
 return {path:app,version:plist(app,'CFBundleShortVersionString'),hash:hash(app)};
};
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
const health=()=>fetch('http://127.0.0.1:4747/api/health',{signal:AbortSignal.timeout(1500)}).then(r=>r.json());
const sessions=()=>fetch('http://127.0.0.1:4747/api/terminals',{signal:AbortSignal.timeout(1500)}).then(r=>r.json()).then(list=>list.filter(t=>t.alive).map(t=>t.id));
const noExecutableUsers=app=>{
 const exe=join(app,'Contents/MacOS',plist(app,'CFBundleExecutable'));
 try { if(run('/usr/sbin/lsof',['-t','--',exe]).trim()) throw Error('The app executable is still running: '+app); }
 catch(e) { if(e.status!==1 || e.stdout?.toString().trim()) throw e; }
};
const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
if(process.argv.includes('--prepare')) {
 if(existsSync(planFile)) throw Error('A repair plan already exists; inspect it instead of overwriting it.');
 if(!arg('active') || !arg('legacy')) throw Error('Provide --active and --legacy app paths discovered from the running processes/TCC logs.');
 const active=realpathSync(arg('active')), legacy=realpathSync(arg('legacy'));
 const current=inspect(active), old=inspect(legacy);
 noExecutableUsers(legacy);
 const staged=join(work,'current',appName), oldStage=join(work,'legacy',appName);
 mkdirSync(work,{recursive:true,mode:0o700});
 unlockLocalSigning(identity);
 for(const [source,dest] of [[active,staged],[legacy,oldStage]]) {
   mkdirSync(resolve(dest,'..'),{recursive:true,mode:0o700});run('/usr/bin/ditto',[source,dest]);
   signLocal(dest,identity,'com.jethr.visualbrain');verifyReleaseIdentity(root,dest);
 }
 const plan={schema:1,createdAt:new Date().toISOString(),certificateSha256:identity.sha256,current,legacy:old,staged,oldStage,destination:join(homedir(),'Applications',appName)};
 writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({ready:true,current:current.version,legacy:old.version,destination:plan.destination,certificateSha256:identity.sha256}));
} else if(process.argv.includes('--apply')) {
 const plan=JSON.parse(readFileSync(planFile,'utf8'));
 if(plan.schema!==1 || plan.certificateSha256!==identity.sha256 || plan.appliedAt) throw Error('Unexpected or already-applied repair plan');
 for(const item of [plan.current,plan.legacy]) if(inspect(item.path).hash!==item.hash) throw Error('App changed since preparation: '+item.path);
 noExecutableUsers(plan.legacy.path);verifyReleaseIdentity(root,plan.staged);verifyReleaseIdentity(root,plan.oldStage);
 const before=await health();if(!before.persistentTerminals)throw Error('The running backend cannot preserve terminals');
 const live=await sessions();
 const profile=before.profile;
 const hostFile=join(profile,'terminal-service/host.json');
 const host=JSON.parse(readFileSync(hostFile,'utf8')).pid;
 if(!Number.isInteger(host)||host<=1)throw Error('Missing live terminal host');
 if(process.argv.includes('--check')) { console.log(JSON.stringify({preflight:'PASS',terminalHost:host,liveSessions:live.length,destination:plan.destination}));process.exit(0); }
 const backup=join(profile,'signature-repair-backups',new Date().toISOString().replace(/\D/g,'').slice(0,14));
 mkdirSync(backup,{recursive:true,mode:0o700});
 for(const [name,app] of [['legacy',plan.legacy.path],['current',plan.current.path]]) {
   const target=join(backup,name);mkdirSync(target,{recursive:true});
   run('/usr/bin/ditto',[join(app,'Contents/MacOS'),join(target,'MacOS')]);
   run('/usr/bin/ditto',[join(app,'Contents/_CodeSignature'),join(target,'_CodeSignature')]);
 }
 writeFileSync(join(backup,'recovery.json'),JSON.stringify({host,sessionIds:live,current:plan.current.path,legacy:plan.legacy.path,staged:plan.staged,destination:plan.destination},null,2),{mode:0o600});
 unlockLocalSigning(identity);
 let quit=false,opened=false;
 try {
   // Graceful app quit invokes its existing server detach path. No signal is sent to the terminal host or agents.
   run('/usr/bin/osascript',['-e',`tell application ${JSON.stringify(plan.current.path)} to quit`]);quit=true;
   const deadline=Date.now()+30000;
   for(;;) {
     try {noExecutableUsers(plan.current.path);break;}catch(error){if(Date.now()>deadline)throw error;await pause(250);}
   }
   for(const item of [plan.legacy,plan.current]) {
     noExecutableUsers(item.path);
     // Only the inactive native launcher and its resource seal change; the runtime and live PTYs are untouched.
     signLocal(item.path,identity,'com.jethr.visualbrain');verifyReleaseIdentity(root,item.path);
   }
   mkdirSync(resolve(plan.destination,'..'),{recursive:true});
   if(existsSync(plan.destination))renameSync(plan.destination,join(backup,'previous-installed.app'));
   try {run('/usr/bin/ditto',[plan.staged,plan.destination]);verifyReleaseIdentity(root,plan.destination);}
   catch(error) {
     // Preserve both copies on failure; reopen the verified staged app rather than discarding anything.
     throw error;
   }
   run('/usr/bin/open',['-n',plan.destination]);opened=true;
   let after;
   const until=Date.now()+90000;
   while(Date.now()<until) {try {after=await health();if(after.instance!==before.instance)break;}catch{}await pause(500);}
   if(!after || after.instance===before.instance)throw Error('New backend did not start; no terminal was stopped');
   if(JSON.parse(readFileSync(hostFile,'utf8')).pid!==host)throw Error('Terminal host changed unexpectedly');
   const current=await sessions();
   const preserved=live.filter(id=>current.includes(id)).length;
   plan.appliedAt=new Date().toISOString();plan.backup=backup;plan.terminalHost=host;plan.sessionsBefore=live.length;plan.sessionsPreserved=preserved;
   writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n',{mode:0o600});
   console.log(JSON.stringify({applied:true,destination:plan.destination,terminalHost:host,sessionsBefore:live.length,sessionsPreserved:preserved,backup}));
 } finally {
   // If signing/copying fails after quit, restore the UI from a known verified copy; never kill a session.
   if(quit&&!opened)try{run('/usr/bin/open',['-n',plan.staged]);}catch{}
 }
} else throw Error('Use --prepare --active=PATH --legacy=PATH or --apply');
