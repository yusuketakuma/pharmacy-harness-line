import {DatabaseSync} from 'node:sqlite';import {readFile,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const root=process.cwd(),e=root+'/docs/pharmacy/evidence/audit-20260922';
const src=await readFile(root+'/apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.ts','utf8');const key=src.match(/const CREATED_AT_ORDER_KEY = `([\s\S]*?)`;/)[1];
const db=new DatabaseSync(':memory:');const reports=[];
try{db.exec(`CREATE TABLE pharmacy_emergency_intakes(id TEXT PRIMARY KEY,line_account_id TEXT,owner_friend_id TEXT,status TEXT,expires_at TEXT,created_at TEXT);CREATE INDEX idx_owner ON pharmacy_emergency_intakes(line_account_id,owner_friend_id,created_at DESC,id DESC);CREATE INDEX idx_queue ON pharmacy_emergency_intakes(line_account_id,status,expires_at,created_at,id);`);
const insert=db.prepare('INSERT INTO pharmacy_emergency_intakes VALUES(?,?,?,?,?,?)');
const pSQL='SELECT id FROM pharmacy_emergency_intakes intake WHERE line_account_id=? AND created_at<? ORDER BY created_at,id LIMIT 100';const wSQL=`SELECT id FROM pharmacy_emergency_intakes intake WHERE line_account_id=? AND ${key}<? ORDER BY ${key},id LIMIT 100`;
const p=db.prepare(pSQL),w=db.prepare(wSQL);const pBind=['a','2023-01-01T00:00:00.000Z'],wBind=['a','2023-01-01T00:00:00.'];
let count=0;
for(const n of [500,5000,10000]){db.exec('BEGIN');for(;count<n;count++)insert.run(String(count),'a','owner-'+count%20,'completed','2099-01-01T00:00:00.000Z',new Date(Date.UTC(2020,0,1)+count*1234567).toISOString());db.exec('COMMIT');assert.deepEqual(w.all(...wBind),p.all(...pBind));for(let i=0;i<3;i++){p.all(...pBind);w.all(...wBind)}const times={p:[],w:[]};for(let i=0;i<9;i++)for(const label of i%2?['w','p']:['p','w']){const start=performance.now();(label==='p'?p:w).all(...(label==='p'?pBind:wBind));times[label].push(performance.now()-start)}const median=a=>[...a].sort((a,b)=>a-b)[4];const pm=median(times.p),wm=median(times.w);reports.push({n,times,medianP:pm,medianW:wm,threshold:Math.max(2*pm,pm+15),pass:wm<=Math.max(2*pm,pm+15)});}
const plans={p:db.prepare('EXPLAIN QUERY PLAN '+pSQL).all(...pBind),w:db.prepare('EXPLAIN QUERY PLAN '+wSQL).all(...wBind)};
await writeFile(e+'/F42-performance.json',JSON.stringify({reports,plans},null,2)+'\n');console.log(JSON.stringify(reports.map(({times,...r})=>r)));if(reports.some(r=>!r.pass))process.exitCode=1;
}finally{db.close()}
