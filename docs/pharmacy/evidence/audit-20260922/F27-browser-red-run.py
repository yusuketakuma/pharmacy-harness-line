from pathlib import Path
import tempfile,subprocess,json,os,shlex
root=Path.cwd(); app=root/'apps/liff'; e=root/'docs/pharmacy/evidence/audit-20260922'
env={k:os.environ[k] for k in ['PATH','LANG','TMPDIR'] if k in os.environ};env.update(CI='true',NO_COLOR='1')
with tempfile.TemporaryDirectory(prefix='.audit-draft-',dir=app) as td:
 t=Path(td)
 mock=(app/'e2e/liff.mock.ts').read_text()
 (t/'liff.mock.ts').write_text(mock)
 config={'root':str(app),'envDir':str(t),'resolve':{'alias':{'@line/liff':str(t/'liff.mock.ts')}}}
 (t/'vite.config.mts').write_text("import {defineConfig} from 'vite';import react from '@vitejs/plugin-react'; export default defineConfig({..."+json.dumps(config)+",plugins:[react(),{name:\"audit-old-page\",transform(code,id){if(id.endsWith(\"/src/App.tsx\"))return code.replace(\"PatientIntakePage.js\",\"audit-pre-f27.js\");}}]});")
 pc={'testDir':str(app/'e2e'),'testMatch':'patient-draft-scope.e2e.ts','workers':1,'retries':0,'reporter':'line','outputDir':str(t/'results'),'use':{'browserName':'chromium'},'webServer':{'command':'pnpm exec vite --host 127.0.0.1 --port 4303 --strictPort --config '+shlex.quote(str(t/'vite.config.mts')),'cwd':str(app),'port':4303,'reuseExistingServer':False}}
 (t/'playwright.config.mts').write_text("import {defineConfig} from '@playwright/test';export default defineConfig("+json.dumps(pc)+");")
 r=subprocess.run(['pnpm','--dir',str(app),'exec','playwright','test','--config',str(t/'playwright.config.mts')],env=env,capture_output=True,text=True,timeout=150)
 (e/'F27-browser-red.log').write_text(r.stdout+r.stderr)
 print('exit',r.returncode);print(r.stdout[-2500:]+r.stderr[-1000:])
