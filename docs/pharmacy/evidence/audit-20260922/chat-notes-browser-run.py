from pathlib import Path
import os,json,subprocess,shutil
root=Path.cwd();e=root/'docs/pharmacy/evidence/audit-20260922';w=Path(json.loads((e/'chat-notes-browser-work.json').read_text())['temporary_root']);web=w/'apps/web'
shutil.copy2(e/'chat-notes-race.e2e.ts',web/'e2e/chat-notes-race.e2e.ts')
config={'testDir':str(web/'e2e'),'testMatch':'chat-notes-race.e2e.ts','workers':1,'timeout':60000,'reporter':'line','outputDir':str(e/'chat-notes-browser-results-final'),'use':{'browserName':'chromium','baseURL':'http://127.0.0.1:4314','screenshot':'only-on-failure','trace':'retain-on-failure'},'webServer':{'command':'pnpm exec next dev --webpack --hostname 127.0.0.1 --port 4314','cwd':str(web),'url':'http://127.0.0.1:4314/login','reuseExistingServer':False,'timeout':120000,'env':{'NEXT_PUBLIC_API_URL':'http://127.0.0.1:4314','NEXT_TELEMETRY_DISABLED':'1'}}}
(web/'notes.playwright.config.mts').write_text("import { defineConfig } from '@playwright/test';export default defineConfig("+json.dumps(config)+');\n')
env={k:os.environ[k] for k in ['PATH','TMPDIR'] if k in os.environ};env.update(LANG='C.UTF-8',CI='true',NO_COLOR='1',NEXT_TELEMETRY_DISABLED='1',NEXT_PUBLIC_API_URL='http://127.0.0.1:4314',APP_COMMIT_SHA='abda3847979e19b906ebe3f81c61cfac03cf901c',APP_BUILD_TIME='2026-09-22T00:00:00Z')
with (e/'chat-notes-browser-final-red.log').open('w') as f:r=subprocess.run(['pnpm','exec','playwright','test','--config',str(web/'notes.playwright.config.mts')],cwd=web,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=180)
print('browser exit',r.returncode)
