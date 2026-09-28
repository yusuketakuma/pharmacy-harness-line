import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=process.cwd(),evidence=join(root,'docs/pharmacy/evidence/audit-20260922');
const req=createRequire(join(await realpath(join(root,'apps/worker/node_modules/wrangler')),'package.json'));
const {Miniflare,convertV4MiniflareOptions}=req('miniflare'),{build}=req('esbuild');
const temp=await mkdtemp(join(evidence,'.F31-native-'));let mf;
try {
 const output=join(temp,'index.mjs');
 const entry=`import { Hono } from 'hono';
import { scenarios } from ${JSON.stringify(join(root,'apps/worker/src/routes/messaging/scenarios.ts'))};
import { tenantScenarioResourceGuard } from ${JSON.stringify(join(root,'apps/worker/src/middleware/tenant-boundary.ts'))};
const app = new Hono();
// Synthetic authenticated fixture only: tests the resource guard/router, not full auth.
app.use('*',async(c,next)=>{c.set('tenantId','tenant-a');await next()});
app.use('*',tenantScenarioResourceGuard);
app.route('/',scenarios);
export default app;`;
 await build({stdin:{contents:entry,resolveDir:join(root,'apps/worker'),sourcefile:'synthetic-scope.ts',loader:'ts'},bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],outfile:output,logLevel:'silent'});
 const bytes=await readFile(output);let outbound=0;
 mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,scriptPath:output,compatibilityDate:'2024-12-01',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],outboundService:()=>{outbound++;return new Response('blocked',{status:503})}}));
 const db=await mf.getD1Database('DB');
 const split=`import sqlite3,json,sys\npending='';statements=[]\nfor line in open(sys.argv[1]):\n pending+=line\n if sqlite3.complete_statement(pending):statements.append(pending);pending=''\nassert not pending.strip()\nprint(json.dumps(statements))`;
 const statements=JSON.parse(execFileSync('python3',['-c',split,join(root,'packages/db/bootstrap.sql')],{encoding:'utf8'}));
 for(let i=0;i<statements.length;i+=50)await db.batch(statements.slice(i,i+50).map(sql=>db.prepare(sql)));
 await db.exec(`INSERT INTO tenants(id,tenant_code,display_name) VALUES('tenant-a','a','A'),('tenant-b','b','B');
INSERT INTO scenarios(id,name,trigger_type,tenant_id) VALUES('parent-a','A','manual','tenant-a'),('parent-b','B','manual','tenant-b');
INSERT INTO scenario_steps(id,scenario_id,step_order,delay_minutes,message_type,message_content) VALUES('step-a','parent-a',1,0,'text','original-a'),('step-b','parent-b',1,0,'text','original-b');`);
 const call=(method,step,body)=>mf.dispatchFetch('https://synthetic.invalid/api/scenarios/parent-a/steps/'+step,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
 const statuses=[];
 for(const body of [{messageContent:'foreign',tenantId:'tenant-b',scenarioId:'parent-b'},{}]) {
  const response=await call('PUT','step-b',body);assert.equal(response.status,404);assert.deepEqual(await response.json(),{success:false,error:'Step not found'});statuses.push(response.status);
 }
 const deleted=await call('DELETE','step-b');assert.equal(deleted.status,200);statuses.push(deleted.status);
 assert.equal((await db.prepare("SELECT message_content FROM scenario_steps WHERE id='step-b'").first()).message_content,'original-b');
 const own=await call('PUT','step-a',{messageContent:'updated-a'});assert.equal(own.status,200);assert.equal((await own.json()).data.messageContent,'updated-a');statuses.push(own.status);
 assert.equal((await call('DELETE','step-a')).status,200);assert.equal(await db.prepare("SELECT id FROM scenario_steps WHERE id='step-a'").first(),null);
 assert.equal(outbound,0);
 const result={status:'PASS',exit:0,artifact:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},statuses,outbound,scope:'Synthetic fixed tenant identity + actual compiled tenant guard/router/DB helpers on local Miniflare D1. Not a full authentication or pharmacy generic allowlist bypass test.'};
 await writeFile(join(evidence,'F31-native-scope.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {if(mf)await mf.dispose();await rm(temp,{recursive:true,force:true})}
