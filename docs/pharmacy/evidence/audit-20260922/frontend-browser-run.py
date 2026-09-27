from pathlib import Path
import json,os,subprocess,http.server,threading,sys
root=Path.cwd();e=root/'docs/pharmacy/evidence/audit-20260922';work=Path(json.loads((e/'frontend-build-work.json').read_text())['temporary_root']);out=work/'apps/web/out'
class Handler(http.server.SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw): super().__init__(*a,directory=str(out),**kw)
 def log_message(self,*args): pass
 def translate_path(self,path):
  result=super().translate_path(path)
  if Path(result+'.html').is_file():return result+'.html'
  return result
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();port=server.server_address[1]
config=work/'apps/web/artifact.playwright.config.mts'
config.write_text("import { defineConfig } from '@playwright/test'; export default defineConfig("+json.dumps({'testDir':str(root/'apps/web/e2e'),'testMatch':'login-next-origin.e2e.ts','workers':1,'reporter':'line','outputDir':str(work/'browser-results'),'use':{'browserName':'chromium','baseURL':f'http://127.0.0.1:{port}'}})+");")
env={k:os.environ[k] for k in ['PATH','LANG','TMPDIR'] if k in os.environ};env.update(CI='true',NO_COLOR='1')
try:
 r=subprocess.run(['pnpm','--filter','web','exec','playwright','test','--config',str(config)],env=env,capture_output=True,text=True,timeout=60)
 (e/f'F11-browser-{sys.argv[1]}.log').write_text(r.stdout+r.stderr);print(r.stdout[-3000:]+r.stderr[-1000:]);print('exit',r.returncode)
finally:server.shutdown();server.server_close()
