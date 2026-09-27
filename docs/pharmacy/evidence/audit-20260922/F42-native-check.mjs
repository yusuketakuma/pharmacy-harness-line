import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=process.cwd(),e=root+'/docs/pharmacy/evidence/audit-20260922';
const wr=createRequire(createRequire(root+'/apps/worker/package.json').resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wr('miniflare');
const {build,transform}=wr('esbuild');
const {splitSqlStatements}=await import(pathToFileURL(root+'/packages/db/scripts/split-sql-statements.mjs'));
const sourceRoot=process.argv[2] || root;
const dir=await mkdtemp(e+'/.F42-native-');
await build({stdin:{contents:`export {purgeEmergencyIntakesPastRetention} from './apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.ts'; export {purgePrescriptionFilesPastRetention,UTC_TIMESTAMP_GLOB} from './apps/worker/src/custom/pharmacy/prescriptions/retention-purge.ts';`,resolveDir:sourceRoot},outfile:dir+'/consumers.mjs',bundle:true,platform:'node',format:'esm'});
const consumer=await import(pathToFileURL(dir+'/consumers.mjs'));
assert.equal(consumer.UTC_TIMESTAMP_GLOB,'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z');
const EXECUTION={operationId:'operation-retention-test',executionId:'execution-retention-test',fenceToken:'f'.repeat(32),executorSubject:'test-worker',tenantId:'tenant-a',lineAccountId:'account-a',environment:'test'};
let outbound=0;
const results=[];
for(const mode of (process.argv[3] ? [process.argv[3]] : ['emergency'])){
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:'export default {fetch(){return new Response("synthetic")}}',d1Databases:['DB'],outboundService:()=>{outbound++;return new Response('blocked',{status:503})}}));
 try {
  const db=await mf.getD1Database('DB');
  const schema=splitSqlStatements(await readFile(root+'/packages/db/bootstrap.sql','utf8'));
  for(let i=0;i<schema.length;i+=50) await db.batch(schema.slice(i,i+50).map(sql=>db.prepare(sql)));
  const recorded=[];
  const recorder={prepare:sql=>({run:(...params)=>recorded.push({sql,params})})};
  const file=mode==='emergency'?'emergency-contraception':'prescriptions';
  const source=await readFile(root+`/apps/worker/src/custom/pharmacy/${file}/retention-purge.test.ts`,'utf8');
  let fixture;
  if(mode==='emergency'){
   fixture=source.slice(source.indexOf('  function seedAccount('),source.indexOf('  function insertFriend('))
    +source.slice(source.indexOf('  let intakeSeq = 0;'),source.indexOf('  function insertLegalHold('));
   fixture+="seedAccount('a',30); seedAccount('b',365); insertIntake('a','2020-02-30T00:00:00.000Z'); insertIntake('a','2026-08-19T00:00:00.000Z'); insertIntake('a','2026-01-01T00:00:00+09:00'); insertIntake('b','2026-01-01T00:00:00.000Z');";
  } else {
   fixture=source.slice(source.indexOf('  function seed()'),source.indexOf('  const remainingFiles'));
   fixture+="seed(); insertFile('old','2020-01-01T00:00:00.000Z'); insertFile('recent','2026-08-19T00:00:00.000Z'); insertFile('offset','2020-01-01T00:00:00+09:00');";
  }
  // Execute only local, reviewed test fixture builders against a recording stub.
  const transformed=await transform(fixture,{loader:'ts',target:'es2022'});
  new Function('sqlite','EXECUTION',transformed.code)(recorder,EXECUTION);
  for(const {sql,params} of recorded) await db.prepare(sql).bind(...params).run();
  const now=new Date('2026-08-20T12:00:00.000Z');
  if(mode==='emergency'){
   const first=await consumer.purgeEmergencyIntakesPastRetention(db,{now});
   assert.deepEqual(first,{purged:0,failed:0,skippedFormat:2,skippedLegalHold:0});
   const rows=(await db.prepare('SELECT id,encrypted_payload FROM pharmacy_emergency_intakes ORDER BY id').all()).results;
   assert.equal(rows.filter(r=>r.encrypted_payload==='').length,0);
   assert.equal(rows.find(r=>r.id==='intake-b-4').encrypted_payload,'v1.nonce.ciphertext');
   const second=await consumer.purgeEmergencyIntakesPastRetention(db,{now});
   assert.equal(second.purged,0);assert.equal(second.failed,0);
   await db.prepare("UPDATE pharmacy_emergency_intakes SET created_at = '2026-07-21T12:00:00.0000Z' WHERE id = 'intake-a-1'").run();
   const fractional=await consumer.purgeEmergencyIntakesPastRetention(db,{now});
   assert.equal(fractional.purged,0);assert.equal(fractional.failed,0);
   await db.prepare("UPDATE pharmacy_emergency_intakes SET created_at = '2020-02-29T00:00:00Z' WHERE id = 'intake-a-2'").run();
   const seconds=await consumer.purgeEmergencyIntakesPastRetention(db,{now});
   assert.equal(seconds.purged,1);assert.equal(seconds.failed,0);
   results.push({mode,first,second,rows,fractional,seconds});
  } else {
   let r2Calls=0;const images={head:async()=>{r2Calls++;throw new Error('unexpected R2')},put:async()=>{r2Calls++;throw new Error('unexpected R2')},delete:async()=>{r2Calls++;throw new Error('unexpected R2')}};
   assert.deepEqual(await consumer.purgePrescriptionFilesPastRetention(db,images,{now}),{purged:0,failed:0,skipped:0});
   const first=await consumer.purgePrescriptionFilesPastRetention(db,images,{now,execution:EXECUTION});
   assert.deepEqual(first,{purged:0,failed:0,skipped:1});assert.equal(r2Calls,0);
   const rows=(await db.prepare('SELECT id,state FROM pharmacy_prescription_files ORDER BY id').all()).results;
   assert.equal(rows.length,3);assert(rows.every(r=>r.state==='ready'));
   results.push({mode,first,r2Calls,rows,limitation:'Unknown patient mapping intentionally blocks deletion; verifies actual candidate query and no-proof/unknown safeguards, not successful R2 deletion.'});
  }
 } finally {await mf.dispose()}
}
assert.equal(outbound,0);
await writeFile(e+'/F42-native-check-final.json',JSON.stringify({results,outbound,artifact:dir+'/consumers.mjs'},null,2)+'\n');
console.log(JSON.stringify({results,outbound}));
