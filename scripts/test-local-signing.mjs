// Real signing of disposable fixture apps with the local identity; no privacy database or live app changes.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { localSigning, unlockLocalSigning, signLocal, localRequirement, verifyReleaseIdentity } from './local-signing.mjs';
const root=resolve(import.meta.dirname,'..'), identity=localSigning(root);
assert.ok(identity, 'This release test requires the persistent local signing identity');
const temp=mkdtempSync(join(tmpdir(),'vb-stable-signing-'));
const keychains=()=>execFileSync('/usr/bin/security',['list-keychains','-d','user'],{encoding:'utf8'});
const originalKeychains=keychains();
try {
  unlockLocalSigning(identity);
  const make=(name,version,identifier='com.jethr.visualbrain')=>{
    const app=join(temp,name+'.app'); mkdirSync(join(app,'Contents/MacOS'),{recursive:true});
    copyFileSync('/bin/echo',join(app,'Contents/MacOS/fixture'));
    writeFileSync(join(app,'Contents/Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    signLocal(app,identity,identifier);return app;
  };
  const old=make('old','0.2.44'), next=make('new','0.2.45');
  const requirement=app=>execFileSync('/usr/bin/codesign',['-d','-r-',app],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('designated => ')[1].trim();
  const before=requirement(old),after=requirement(next);
  assert.equal(before,after,'same identity despite different bundle version and code directory hash');
  assert.ok(!before.includes('cdhash'),'the requirement is pinned to the certificate, not this one build');
  for (const app of [old,next]) {
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict','-R','='+before,app]);
    verifyReleaseIdentity(root,app);
  }
  const impostor=make('other','0.2.45','com.example.other');
  assert.throws(()=>execFileSync('/usr/bin/codesign',['--verify','--strict','-R','='+before,impostor],{stdio:'pipe'}));
  const fake=make('adhoc','0.2.45');
  execFileSync('/usr/bin/codesign',['--force','--sign','-','--requirements','=designated => identifier "com.jethr.visualbrain"',fake],{stdio:'pipe'});
  assert.throws(()=>verifyReleaseIdentity(root,fake),/not the stable/,'an identifier-only/ad-hoc signature is not trusted');
  assert.throws(()=>localRequirement('invalid" or true','A'.repeat(40)),/Invalid/);
  assert.equal(keychains(),originalKeychains,'signing does not leave a changed keychain search list');
  writeFileSync(join(next,'Contents/Info.plist'),readFileSync(join(next,'Contents/Info.plist'),'utf8').replace('0.2.45','0.2.99'));
  assert.throws(()=>verifyReleaseIdentity(root,next),/not the stable/,'a modified app must be rejected even with the right certificate');
  console.log('PASS stable local signing across versions, certificate+identifier pinned, ad-hoc and other identifiers rejected, public-release guard');
} finally { rmSync(temp,{recursive:true,force:true}); }
