import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const root=process.cwd(),e=root+'/docs/pharmacy/evidence/audit-20260922';
const emergency=await readFile(root+'/apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.ts','utf8');
const shared=await readFile(root+'/apps/worker/src/custom/pharmacy/data-subject-requests/legal-hold.ts','utf8');
const ep=emergency.match(/const ACTIVE_LEGAL_HOLD = `([\s\S]*?)`;/)[1];
const sp=shared.match(/const ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQL = `([\s\S]*?)`;/)[1];
const wr=createRequire(createRequire(root+'/apps/worker/package.json').resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wr('miniflare');let outbound=0;
const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:'export default {fetch(){return new Response("synthetic")}}',d1Databases:['DB'],outboundService:()=>{outbound++;return new Response('blocked',{status:503})}}));
try {
 const db=await mf.getD1Database('DB'),results=[];
 for(const date of ['2020-02-29T00:00:00.000Z','2020-02-30T00:00:00.000Z','2020-01-01T24:00:00.000Z','2020-01-01T00:00:00+09:00',null]){
  const row=await db.prepare(`WITH dsr AS (SELECT 'account-a' AS line_account_id,'friend-a' AS owner_friend_id,1 AS legal_hold,? AS legal_hold_release_at,'legal_hold_assessed' AS status), intake AS (SELECT 'account-a' AS line_account_id,'friend-a' AS owner_friend_id), request AS (SELECT * FROM dsr) SELECT (${ep}) AS emergencyBlocked, (${sp}) AS sharedBlocked FROM dsr,intake,request`).bind(date,'2026-08-20T12:00:00.000Z','2026-08-20T12:00:00.000Z').first();results.push({date,...row});
 }
 await writeFile(e+'/F40-hold-probe.json',JSON.stringify({results,outbound,limitation:'Actual source predicates on native D1, not full redaction workflow. Policy applicability to emergency domain requires document/caller review before repair.'},null,2)+'\n');console.log(JSON.stringify({results,outbound}));
} finally {await mf.dispose()}
