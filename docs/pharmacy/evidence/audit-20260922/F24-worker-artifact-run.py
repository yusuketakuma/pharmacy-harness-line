from pathlib import Path
import json,tempfile,shutil,os,subprocess,sqlite3,hashlib
root=Path.cwd();e=root/'docs/pharmacy/evidence/audit-20260922'
env={k:os.environ[k] for k in ['PATH','LANG','TMPDIR'] if k in os.environ};env.update(CI='true',NO_COLOR='1',WRANGLER_SEND_METRICS='false')
config=json.loads((e/'worker-artifact-work.json').read_text())['config']
with tempfile.TemporaryDirectory(prefix='.worker-F24-',dir=e) as td:
 work=Path(td)
 (work/'src').symlink_to(root/'apps/worker/src',target_is_directory=True)
 (work/'node_modules').symlink_to(root/'apps/worker/node_modules',target_is_directory=True)
 for name in ['index.html','package.json']:shutil.copy2(root/'apps/worker'/name,work/name)
 (work/'wrangler.json').write_text(json.dumps(config))
 (work/'vite.config.mts').write_text("import { cloudflare } from '@cloudflare/vite-plugin'; import react from '@vitejs/plugin-react'; import tailwindcss from '@tailwindcss/vite'; import { defineConfig } from 'vite'; export default defineConfig({envDir:'.',plugins:[cloudflare({configPath:'./wrangler.json',persistState:false}),react(),tailwindcss()]});")
 with (e/'F24-worker-build.log').open('w') as log:r=subprocess.run(['pnpm','exec','vite','build','--config','vite.config.mts'],cwd=work,env=env,stdout=log,stderr=subprocess.STDOUT)
 print('build exit',r.returncode,flush=True)
 result={'buildExit':r.returncode,'config':config}
 if r.returncode==0:
  with tempfile.TemporaryDirectory(prefix='.runtime-F24-',dir=e) as runtime:
   dest=Path(runtime)/'dist';shutil.copytree(work/'dist',dest)
   result['files']={str(f.relative_to(dest)):{'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in dest.rglob('*') if f.is_file()}
   pending='';statements=[]
   for line in (root/'packages/db/bootstrap.sql').read_text().splitlines(True):
    pending+=line
    if sqlite3.complete_statement(pending):statements.append(pending);pending=''
   assert not pending.strip()
   (dest/'bootstrap-statements.json').write_text(json.dumps(statements))
   smoke=subprocess.run(['node',str(e/'F24-worker-artifact-smoke.mjs'),str(dest),str(root/'apps/worker/node_modules/wrangler')],env=env,capture_output=True,text=True,timeout=45)
   result.update(runtimeExit=smoke.returncode,stdout=smoke.stdout,stderr=smoke.stderr)
   print('runtime exit',smoke.returncode,flush=True);print(smoke.stdout[-1200:]);print(smoke.stderr[-1500:])
 (e/'F24-worker-artifact.json').write_text(json.dumps(result,indent=2)+'\n')
