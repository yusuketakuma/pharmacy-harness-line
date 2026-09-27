import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
const root=process.cwd(),e=root+'/docs/pharmacy/evidence/audit-20260922';
const wr=createRequire(createRequire(root+'/apps/worker/package.json').resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wr('miniflare');
let outbound=0;
const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:'export default {fetch(){return new Response("synthetic")}}',d1Databases:['DB'],outboundService:()=>{outbound++;return new Response('blocked',{status:503})}}));
const key="substr(value,1,19) || '.' || rtrim(CASE WHEN length(value)=20 THEN '' ELSE substr(value,21,length(value)-21) END,'0')";
try {
 const db=await mf.getD1Database('DB');
 const fractions=['','0','000','0000','000001','09','0900','099999','1','100','1000','100001','999999','10000000000000000000000000000000001'];
 const prefixes=['2026-07-21T11:59:59','2026-07-21T12:00:00','2026-07-21T12:00:01'];
 const cases=[];
 for(const prefix of prefixes) for(const fraction of fractions) cases.push({value:prefix+(fraction?'.'+fraction:'')+'Z',prefix,fraction});
 const keys=[];
 for(const c of cases){ const result=await db.prepare(`WITH input(value) AS (VALUES (?)) SELECT ${key} AS sortKey FROM input`).bind(c.value).first();keys.push({...c,key:result.sortKey}); }
 const sign=x=>x<0?-1:x>0?1:0;const mismatches=[];
 for(const a of keys) for(const b of keys){
  const width=Math.max(a.fraction.length,b.fraction.length,1);
  const expected=a.prefix===b.prefix?sign(BigInt(a.fraction.padEnd(width,'0'))-BigInt(b.fraction.padEnd(width,'0'))):sign(a.prefix<b.prefix?-1:1);
  const actual=a.key===b.key?0:sign(a.key<b.key?-1:1);
  if(actual!==expected)mismatches.push({a:a.value,b:b.value,actual,expected});
 }
 const report={caseCount:keys.length,pairCount:keys.length**2,mismatches,outbound,key,keys,limitation:'Valid timestamps only; validation remains prerequisite. SQL builds keys on D1; pair ordering compared as binary ASCII strings against BigInt fractional oracle.'};
 await writeFile(e+'/F42-order-key-probe.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({caseCount:report.caseCount,pairCount:report.pairCount,mismatches,outbound}));if(mismatches.length||outbound)process.exitCode=1;
}finally{await mf.dispose()}
