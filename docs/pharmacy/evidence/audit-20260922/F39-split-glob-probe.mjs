import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
const root=process.cwd(), evidence=root+'/docs/pharmacy/evidence/audit-20260922';
const source=await readFile(root+'/apps/worker/src/custom/pharmacy/prescriptions/retention-purge.ts','utf8');
const original=source.match(/const UTC_TIMESTAMP_GLOB =\s*'([^']+)'/)[1];
const boundary=original.indexOf('T'), date=original.slice(0,boundary), time=original.slice(boundary);
const wr=createRequire(createRequire(root+'/apps/worker/package.json').resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wr('miniflare');
let egress=0;
const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:'export default {fetch(){return new Response("synthetic")}}',d1Databases:['DB'],outboundService:()=>{egress++;return new Response('blocked',{status:503})}}));
const sqlite=new DatabaseSync(':memory:');
try {
 const db=await mf.getD1Database('DB');
 const cases=[null,'','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00Z','2020-02-30T24:99:99.xyzZ','2020-01-01T00:00:00.000+09:00','2020-01-01','２０２０-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Ztail','2020-01-01T00:00:00.000\0Z'];
 const base='2020-01-01T00:00:00.000Z';
 for(let i=0;i<base.length;i++) for(const char of ['0','9','x','-','T',':','Z','💊']) cases.push(base.slice(0,i)+char+base.slice(i+1));
 const old=sqlite.prepare('SELECT ? GLOB ? AS matched, ? NOT GLOB ? AS rejected');
 const results=[];
 for(const value of cases){
   const expected=old.get(value,original,value,original);
   const actual=await db.prepare('SELECT (substr(?,1,10) GLOB ? AND substr(?,11) GLOB ?) AS matched, NOT (substr(?,1,10) GLOB ? AND substr(?,11) GLOB ?) AS rejected').bind(value,date,value,time,value,date,value,time).first();
   results.push({value,expected,actual,equal:expected.matched===actual.matched && expected.rejected===actual.rejected});
 }
 const report={parent:'f6a88eedd15094ea52162ac168856647de0aedc8',originalBytes:Buffer.byteLength(original),splitBytes:[Buffer.byteLength(date),Buffer.byteLength(time)],caseCount:results.length,mismatches:results.filter(r=>!r.equal),egress,limitation:'Predicate equivalence only; production consumer queries, authorization gates and R2 actions not exercised. Invalid calendar dates retain previous predicate behavior and require separate assessment.'};
 await writeFile(evidence+'/F39-split-glob-probe.json',JSON.stringify({ ...report,results},null,2)+'\n');
 console.log(JSON.stringify(report));
 if(report.mismatches.length || egress) process.exitCode=1;
} finally {sqlite.close();await mf.dispose();}
