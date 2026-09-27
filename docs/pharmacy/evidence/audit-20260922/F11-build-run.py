from pathlib import Path
import json,shutil,os,subprocess,hashlib
root=Path.cwd();e=root/'docs/pharmacy/evidence/audit-20260922';w=Path(json.loads((e/'frontend-build-work.json').read_text())['temporary_root'])
shutil.copy2(root/'apps/web/src/lib/safe-next-path.ts',w/'apps/web/src/lib/safe-next-path.ts')
env={k:os.environ[k] for k in ['PATH','LANG','TMPDIR'] if k in os.environ};env.update(CI='true',NO_COLOR='1',NEXT_TELEMETRY_DISABLED='1',NEXT_PUBLIC_API_URL='https://api.example.invalid',NEXT_PUBLIC_LIFF_ORIGIN='https://liff.example.invalid',APP_COMMIT_SHA='af9a0822ef17f2f57557512c6fafabd0ea977b70',APP_BUILD_TIME='2026-09-22T00:00:00.000Z')
with (e/'F11-build.log').open('w') as f:r=subprocess.run(['pnpm','run','build'],cwd=w/'apps/web',env=env,stdout=f,stderr=subprocess.STDOUT)
print('build exit',r.returncode,flush=True)
files={str(x.relative_to(w/'apps/web/out')):{'bytes':x.stat().st_size,'sha256':hashlib.sha256(x.read_bytes()).hexdigest()} for x in (w/'apps/web/out').rglob('*') if x.is_file()}
(e/'F11-artifact.json').write_text(json.dumps({'exit':r.returncode,'source_base':'af9a082','changed_source_sha256':hashlib.sha256((root/'apps/web/src/lib/safe-next-path.ts').read_bytes()).hexdigest(),'files':files},indent=2)+'\n')
with (e/'F11-green.log').open('w') as f:
 for cmd in [['pnpm','--filter','web','test'],['pnpm','--filter','web','exec','tsc','--noEmit']]:
  r=subprocess.run(cmd,env=env,stdout=f,stderr=subprocess.STDOUT);print(' '.join(cmd),'exit',r.returncode,flush=True)
  if r.returncode:break
