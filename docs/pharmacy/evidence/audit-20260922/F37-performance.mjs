import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=process.cwd(),e=root+'/docs/pharmacy/evidence/audit-20260922',temp=await mkdtemp(e+'/.F37-perf-');
const wr=createRequire(createRequire(root+'/apps/worker/package.json').resolve('wrangler/package.json'));
const {build}=wr('esbuild');const Database=createRequire(root+'/packages/db/package.json')('better-sqlite3');
const source='apps/worker/src/custom/pharmacy/data-subject-requests/legal-hold.ts';
const modules={},artifacts={};
for(const key of ['P','W']) {
 const contents=key==='P'?execFileSync('git',['show','HEAD:'+source],{encoding:'utf8'}):await readFile(root+'/'+source,'utf8');
 const outfile=temp+'/'+key+'.mjs';await build({stdin:{contents,loader:'ts',resolveDir:root+'/apps/worker'},bundle:true,format:'esm',platform:'node',outfile,logLevel:'silent'});
 const bytes=await readFile(outfile);artifacts[key]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};modules[key]=await import(pathToFileURL(outfile));
}
assert.deepEqual(Object.keys(modules.P),Object.keys(modules.W));assert.deepEqual(modules.P.RETENTION_SOURCE_INVENTORY,modules.W.RETENTION_SOURCE_INVENTORY);
const db=new Database(':memory:');db.pragma('foreign_keys = ON');db.exec(await readFile(root+'/packages/db/bootstrap.sql','utf8'));
db.exec(`INSERT INTO tenants(id,tenant_code,display_name) VALUES('t','t','Synthetic');
INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','c','Synthetic','synthetic','synthetic');
INSERT INTO tenant_line_accounts(tenant_id,line_account_id) VALUES('t','a');
INSERT INTO friends(id,line_user_id,line_account_id,created_at,updated_at) VALUES('f','synthetic','a','2019-01-01T00:00:00.000Z','2019-01-01T00:00:00.000Z');
INSERT INTO pharmacy_patients(id,line_account_id,owner_friend_id,relationship,name,name_kana,birth_date,created_at,updated_at) VALUES('p','a','f','self','Synthetic','Synthetic','1990-01-01','2019-01-01T00:00:00.000Z','2019-01-01T00:00:00.000Z');`);
let lastSql='',lastValues=[],calls=0;
const d1 = {
 prepare(sql) {
  lastSql = sql; calls++;
  return {
   bind(...values) {
    lastValues = values;
    return { async all() { return { results: db.prepare(sql).all(...values) }; } };
   },
  };
 },
};
const results=[];let seeded=0;
const insert=db.prepare("INSERT INTO messages_log(id,friend_id,line_account_id,direction,message_type,content,created_at) VALUES(?,'f','a','incoming','text','synthetic',?)");
for(const count of [50,500,5000]) {
 db.transaction(()=>{for(let i=seeded;i<count;i++)insert.run('m'+i,new Date(Date.UTC(2020,0,1,0,0,i)).toISOString())})();seeded=count;
 const times={P:[],W:[]},queries={};const values={};
 for(let n=-3;n<9;n++)for(const key of (n%2===0?['P','W']:['W','P'])) {
  calls=0;const start=performance.now();const result=await modules[key].latestPhiRecordedAt(d1,'a','p','f');const elapsed=performance.now()-start;
  assert.equal(calls,1);assert.equal(result,new Date(Date.UTC(2020,0,1,0,0,count-1)).toISOString());if(n>=0)times[key].push(elapsed);
  queries[key]=lastSql;values[key]=lastValues;
 }
 assert.deepEqual(values.P,values.W);const median=x=>[...x].sort((a,b)=>a-b)[4];const P=median(times.P),W=median(times.W),limit=Math.max(2*P,P+15);assert.ok(W<=limit);
 results.push({rows:count,medianMs:{P,W},limitMs:limit,pass:true,samples:times,queryCount:1,bindings:values.P.length,queryBytes:{P:Buffer.byteLength(queries.P),W:Buffer.byteLength(queries.W)},plans:Object.fromEntries(['P','W'].map(k=>[k,db.prepare('EXPLAIN QUERY PLAN '+queries[k]).all(...values[k])]))});
}
db.close();const result={status:'PASS',exit:0,sourceCount:modules.W.RETENTION_SOURCE_INVENTORY.length,publicExports:Object.keys(modules.W),inventoryUnchanged:true,artifacts,results};await writeFile(e+'/F37-performance.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,results:results.map(({plans,samples,...r})=>r)}));
