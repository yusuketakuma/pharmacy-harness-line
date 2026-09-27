import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
const r=createRequire(process.cwd()+'/apps/worker/package.json');const wr=createRequire(r.resolve('wrangler/package.json'));const {Miniflare,convertV4MiniflareOptions}=wr('miniflare');
const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:'export default {fetch(){return new Response("synthetic")}}',d1Databases:['DB'],outboundService:()=>new Response('blocked',{status:503})}));
const records=[];
try {
 const db=await mf.getD1Database('DB');
 for(const count of [2,5,10,11,20,23,30,31,34]) {
  try{const result=await db.prepare(Array.from({length:count},()=>"SELECT 'synthetic' AS recorded_at").join(' UNION ALL ')).all();records.push({count,pass:true,rows:result.results.length})}
  catch(e){records.push({count,pass:false,error:String(e)})}
 }
 const group=Array.from({length:5},()=>"SELECT 'synthetic' AS recorded_at").join(' UNION ALL ');
 for(const groups of [2,4,7]){try{const result=await db.prepare(Array.from({length:groups},()=>`SELECT recorded_at FROM (${group})`).join(' UNION ALL ')).all();records.push({groups,termsPerGroup:5,pass:true,rows:result.results.length})}catch(e){records.push({groups,termsPerGroup:5,pass:false,error:String(e)})}}
 await writeFile('docs/pharmacy/evidence/audit-20260922/F37-limit-probe.json',JSON.stringify(records,null,2)+'\n');console.log(JSON.stringify(records));
}finally{await mf.dispose()}
