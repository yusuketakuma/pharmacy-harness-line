import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),e=root+'/docs/pharmacy/evidence/audit-20260922';
const wr=createRequire(createRequire(root+'/apps/worker/package.json').resolve('wrangler/package.json'));
const {build}=wr('esbuild'),{Miniflare,convertV4MiniflareOptions}=wr('miniflare');
const t=await mkdtemp(e+'/.date-probe-');await build({entryPoints:[root+'/apps/worker/src/custom/pharmacy/data-subject-requests/legal-hold.ts'],bundle:true,platform:'node',format:'esm',outfile:t+'/module.mjs',logLevel:'silent'});
const mod=await import(pathToFileURL(t+'/module.mjs'));
const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:'export default {fetch(){return new Response("synthetic")}}',d1Databases:['DB'],outboundService:()=>new Response('blocked',{status:503})}));
const records=[];
try {const db=await mf.getD1Database('DB');for(const value of ['2020-02-29T00:00:00.000Z','2020-02-30T00:00:00.000Z','2020-99-99T00:00:00.000Z','2020-01-01T24:00:00.000Z','invalid']){
 let sql;try{sql=await db.prepare(`SELECT ${mod.ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQL} AS blocked FROM (SELECT 'legal_hold_assessed' AS status, 1 AS legal_hold, ? AS legal_hold_release_at) AS request`).bind('2026-08-20T00:00:00.000Z',value).first()}catch(e){sql={error:String(e)}}
 const normalized=await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+0 seconds') AS normalized").bind(value).first();records.push({value,js:mod.assessRetention(value,new Date('2026-08-20T00:00:00.000Z')),sql,normalized});}
 await writeFile(e+'/retention-date-probe.json',JSON.stringify(records,null,2)+'\n');console.log(JSON.stringify(records));
}finally{await mf.dispose()}
