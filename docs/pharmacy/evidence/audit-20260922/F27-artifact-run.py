from pathlib import Path
import tempfile,subprocess,json,os,hashlib,http.server,threading,shutil
root=Path.cwd(); app=root/'apps/liff'; e=root/'docs/pharmacy/evidence/audit-20260922'
env={k:os.environ[k] for k in ['PATH','LANG','TMPDIR'] if k in os.environ};env.update(CI='true',NO_COLOR='1')
with tempfile.TemporaryDirectory(prefix='.audit-F27-build-',dir=app) as td:
 t=Path(td);out=t/'dist'
 config={'root':str(app),'envDir':str(t),'build':{'outDir':str(out)}}
 (t/'vite.config.mts').write_text("import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({..."+json.dumps(config)+",plugins:[react()]});")
 with (e/'F27-build.log').open('w') as log:r=subprocess.run(['pnpm','--dir',str(app),'exec','vite','build','--config',str(t/'vite.config.mts')],env=env,stdout=log,stderr=subprocess.STDOUT)
 result={'buildExit':r.returncode};print('build',r.returncode,flush=True)
 if r.returncode==0:
  result['files']={str(f.relative_to(out)):{'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in out.rglob('*') if f.is_file()}
  runtime=t/'runtime';shutil.copytree(out,runtime)
  class Handler(http.server.SimpleHTTPRequestHandler):
   def __init__(self,*a,**kw):super().__init__(*a,directory=str(runtime),**kw)
   def log_message(self,*args):pass
  server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
  try:
   pc={'testDir':str(app/'e2e'),'testMatch':'startup.e2e.ts','workers':1,'retries':0,'reporter':'line','outputDir':str(t/'results'),'use':{'browserName':'chromium','baseURL':f'http://127.0.0.1:{server.server_address[1]}'}}
   (t/'playwright.config.mts').write_text("import {defineConfig} from '@playwright/test';export default defineConfig("+json.dumps(pc)+");")
   r=subprocess.run(['pnpm','--dir',str(app),'exec','playwright','test','--config',str(t/'playwright.config.mts'),'--grep','keeps startup failures technical-detail-free'],env=env,capture_output=True,text=True,timeout=60)
   (e/'F27-artifact-browser.log').write_text(r.stdout+r.stderr);result['runtimeExit']=r.returncode;print('runtime',r.returncode,flush=True)
  finally:server.shutdown();server.server_close()
 (e/'F27-artifact.json').write_text(json.dumps(result,indent=2)+'\n')
