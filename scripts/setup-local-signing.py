# Dedicated, persistent local code-signing identity. No Apple account and no TCC/database edits.
# Run --prepare to inspect, or --trust to authorize only user-level code signing.
import pathlib,subprocess,secrets,os,json,sys,hashlib
root=pathlib.Path(__file__).resolve().parent.parent
dir=root/'.release-keys/local-code-signing'
os.umask(0o077)
dir.mkdir(mode=0o700,parents=True,exist_ok=True)
passwordfile=dir/'keychain-password'; key=dir/'private-key.pem';cert=dir/'certificate.pem';chain=dir/'signing.keychain-db';meta=dir/'identity.json'
password=passwordfile.read_text() if passwordfile.exists() else secrets.token_urlsafe(48)
def run(args,label):
    r=subprocess.run(args,capture_output=True,text=True)
    if r.returncode: raise RuntimeError(label+': '+(r.stderr or r.stdout).replace(password,'[redacted]')[-900:])
    return r.stdout+r.stderr
policy=root/'scripts/signing-policy.json'
if not meta.exists():
    if policy.exists(): raise RuntimeError('Restore the existing private signing identity from backup; a public policy is already pinned. Never regenerate it.')
    if key.exists() or cert.exists(): raise RuntimeError('Partial identity exists; refusing to overwrite')
    passwordfile.write_text(password)
    conf=dir/'certificate.cnf';conf.write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Visual Brain Local Code Signing\nO=Visual Brain\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n')
    run(['/usr/bin/openssl','req','-new','-newkey','rsa:3072','-nodes','-x509','-sha256','-days','7300','-config',str(conf),'-keyout',str(key),'-out',str(cert)],'create local certificate')
    der=dir/'certificate.der';run(['/usr/bin/openssl','x509','-in',str(cert),'-outform','der','-out',str(der)],'certificate encoding')
    meta.write_text(json.dumps({'schema':1,'name':'Visual Brain Local Code Signing','sha1':hashlib.sha1(der.read_bytes()).hexdigest().upper(),'sha256':hashlib.sha256(der.read_bytes()).hexdigest(),'keychain':'signing.keychain-db'},indent=2)+'\n')
info=json.loads(meta.read_text())
if hashlib.sha256((dir/'certificate.der').read_bytes()).hexdigest()!=info['sha256']: raise RuntimeError('Certificate does not match identity metadata')
if policy.exists() and json.loads(policy.read_text())['certificateSha256']!=info['sha256']: raise RuntimeError('Certificate does not match the published identity')
print(json.dumps({'name':info['name'],'sha256':info['sha256'],'mode':'prepare' if '--trust' not in sys.argv else 'user-code-signing-only'}))
if '--trust' in sys.argv:
    if not chain.exists():run(['/usr/bin/security','create-keychain','-p',password,str(chain)],'create dedicated keychain')
    run(['/usr/bin/security','unlock-keychain','-p',password,str(chain)],'unlock dedicated keychain')
    valid=run(['/usr/bin/security','find-identity','-v','-p','codesigning',str(chain)],'inspect identity')
    if info['sha1'] in valid:
        print('Persistent local identity already available; no trust changes.');sys.exit(0)
    p12=dir/'import.p12'
    try:
        run(['/usr/bin/openssl','pkcs12','-export','-inkey',str(key),'-in',str(cert),'-out',str(p12),'-passout','file:'+str(passwordfile)],'prepare protected import')
        run(['/usr/bin/security','import',str(p12),'-k',str(chain),'-P',password,'-T','/usr/bin/codesign'],'import local identity')
    finally:
        if p12.exists():p12.unlink()
    # User trust only, restricted to code signing. No administrator/system trust, TLS trust or TCC changes.
    run(['/usr/bin/security','add-trusted-cert','-r','trustRoot','-p','codeSign','-k',str(chain),str(cert)],'authorize user code-signing certificate')
    print(run(['/usr/bin/security','find-identity','-v','-p','codesigning',str(chain)],'verify local identity'))
