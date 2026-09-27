import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const root=process.cwd(),e=root+'/docs/pharmacy/evidence/audit-20260922';
const wr=createRequire(createRequire(root+'/apps/worker/package.json').resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wr('miniflare');
const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:'export default {fetch(){return new Response("synthetic")}}',d1Databases:['DB'],outboundService:()=>new Response('blocked',{status:503})}));
try{const db=await mf.getD1Database('DB');const results=[];
for(const path of ['apps/worker/src/custom/pharmacy/prescriptions/retention-purge.ts','apps/worker/src/custom/pharmacy/retention/preflight.ts']){
const source=await readFile(root+'/'+path,'utf8');const pattern=source.match(/const UTC_TIMESTAMP_GLOB =\s*'([^']+)'/)[1];
try{results.push({path,patternBytes:Buffer.byteLength(pattern),result:await db.prepare('SELECT ? GLOB ? AS matches').bind('2020-01-01T00:00:00.000Z',pattern).first()})}catch(err){results.push({path,patternBytes:Buffer.byteLength(pattern),error:String(err)})}}
await writeFile(e+'/retention-selection-glob-probe.json',JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
}finally{await mf.dispose()}
