import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=process.cwd(), evidence=join(root,'docs/pharmacy/evidence/audit-20260922');
const temp=await mkdtemp(join(evidence,'.F30-artifact-'));
const realFetch=globalThis.fetch, realLog=console.log;
const env={LINE_HARNESS_API_URL:'https://harness.invalid',LINE_HARNESS_API_KEY:'synthetic',LINE_HARNESS_TENANT_ID:'synthetic-tenant',LINE_ACCOUNT_ID:'synthetic-account',EXTERNAL_API_KEY:'synthetic'};
const result={files:{},cases:[],externalNetworkCalls:0};
try {
 await writeFile(join(temp,'package.json'),JSON.stringify({type:'module'}));
 await cp(join(root,'packages/plugin-template/dist'),join(temp,'dist'),{recursive:true});
 const sdk=join(temp,'node_modules/@line-harness/sdk');await mkdir(sdk,{recursive:true});
 await cp(join(root,'packages/sdk/dist'),join(sdk,'dist'),{recursive:true});
 await cp(join(root,'packages/sdk/package.json'),join(sdk,'package.json'));
 for(const file of ['dist/index.js','node_modules/@line-harness/sdk/dist/index.mjs']) {
  const bytes=await readFile(join(temp,file));result.files[file]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 }
 const worker=(await import(pathToFileURL(join(temp,'dist/index.js')))).default;
 console.log=()=>{};
 for(const mode of ['success','step-failure']) {
  let failStep=mode==='step-failure';const scenarios=[],attached=new Set(),events=[];
  const tags=['free','basic','premium','appt-reminder','renewal-reminder'].map(tier=>({id:tier,name:'myservice:'+tier}));
  globalThis.fetch=async(input,init={})=>{
   const url=new URL(input),method=init.method??'GET',body=init.body?JSON.parse(String(init.body)):{};
   const ok=data=>Response.json({success:true,data});
   if(url.origin==='https://api.myservice.example.com') {
    if(url.pathname==='/v1/customers'||url.pathname==='/v1/memberships')return Response.json([]);
    if(url.pathname==='/v1/appointments')return Response.json([{id:'synthetic-appointment',lineHarnessFriendId:'synthetic-friend'}]);
   }
   assert.equal(url.origin,env.LINE_HARNESS_API_URL);
   assert.equal(new Headers(init.headers).get('X-Tenant-Id'),env.LINE_HARNESS_TENANT_ID);
   if(url.pathname==='/api/tags')return ok(tags);
   if(url.pathname==='/api/scenarios'&&method==='GET') {
    assert.equal(url.searchParams.get('lineAccountId'),env.LINE_ACCOUNT_ID);return ok(scenarios);
   }
   if(url.pathname==='/api/scenarios'&&method==='POST') {
    assert.equal(body.lineAccountId,env.LINE_ACCOUNT_ID);assert.equal(body.isActive,false);
    const s={...body,id:'scenario-'+scenarios.length,stepCount:0};scenarios.push(s);events.push('create-inactive');return ok(s);
   }
   const step=url.pathname.match(/^\/api\/scenarios\/([^/]+)\/steps$/);
   if(step) {
    const s=scenarios.find(s=>s.id===step[1]);assert.equal(s.isActive,false);events.push('step');
    if(failStep){failStep=false;return Response.json({error:'synthetic failure'},{status:503})}
    s.stepCount++;return ok({...body,id:'step'});
   }
   const update=url.pathname.match(/^\/api\/scenarios\/([^/]+)$/);
   if(update&&method==='PUT') {
    const s=scenarios.find(s=>s.id===update[1]);assert(s.stepCount>0);Object.assign(s,body);events.push('activate');return ok(s);
   }
   if(url.pathname==='/api/friends/synthetic-friend'&&method==='GET')return ok({tags:[...attached].map(id=>({id}))});
   if(url.pathname==='/api/friends/synthetic-friend/tags'&&method==='POST') {
    assert(scenarios.some(s=>s.isActive&&s.stepCount>0&&s.triggerTagId===body.tagId));attached.add(body.tagId);events.push('attach');return ok(null);
   }
   throw new Error('Unexpected synthetic request: '+method+' '+url.pathname);
  };
  if(mode==='success') {
   await worker.scheduled({},env,{});await worker.scheduled({},env,{});
   assert.deepEqual(events.slice(0,4),['create-inactive','step','activate','attach']);assert.equal(events.filter(x=>x==='attach').length,1);
  } else {
   await assert.rejects(worker.scheduled({},env,{}),/synthetic failure/);
   await assert.rejects(worker.scheduled({},env,{}),/Notification scenario is not ready/);
   assert.equal(scenarios.length,1);assert.equal(scenarios[0].isActive,false);assert.equal(scenarios[0].stepCount,0);assert.equal(attached.size,0);
  }
  result.cases.push({mode,status:'PASS',events});
 }
 result.exit=0;
} finally {globalThis.fetch=realFetch;console.log=realLog;await rm(temp,{recursive:true,force:true})}
await writeFile(join(evidence,'F30-artifact.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
