import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const [artifact, wranglerPackage] = process.argv.slice(2);
const require = createRequire(join(realpathSync(wranglerPackage), 'package.json'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const outbound = [];
writeFileSync(join(artifact, 'audit_worker/cron-entry.js'), `import worker from './index.js';
export default {async fetch(request,env,ctx){
if(new URL(request.url).pathname==='/__audit_cron'){
await worker.scheduled({cron:'0 */6 * * *',scheduledTime:Date.now()},env,ctx);
return new Response('done');}
return worker.fetch(request,env,ctx);}};`);
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false,
  modulesRoot: join(artifact, 'audit_worker'),
  modules: ['cron-entry.js', 'index.js', ...readdirSync(join(artifact, 'audit_worker/assets')).filter(name => name.endsWith('.js')).map(name => `assets/${name}`)]
    .map(name => ({ type: 'ESModule', path: join(artifact, 'audit_worker', name) })),
  compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], r2Buckets: ['IMAGES'],
  bindings: { API_KEY: 'unused-synthetic', WORKER_PUBLIC_URL: 'https://worker.synthetic.invalid',
    ADMIN_PUBLIC_URL: 'https://admin.synthetic.invalid', LIFF_PUBLIC_URL: 'https://liff.synthetic.invalid' },
  serviceBindings: { ASSETS: async (request) => {
    const pathname = new URL(request.url).pathname;
    const path = resolve(artifact, 'client', '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(resolve(artifact, 'client') + '/')) return new Response(null, { status: 400 });
    try { return new Response(readFileSync(path)); } catch { return new Response(null, { status: 404 }); }
  } },
  outboundService: async (request) => { outbound.push(new URL(request.url).origin); return new Response('blocked synthetic test egress', { status: 503 }); },
}));
try {
  const db = await mf.getD1Database('DB');
  const statements = JSON.parse(readFileSync(join(artifact, 'bootstrap-statements.json'), 'utf8'));
  for (let start = 0; start < statements.length; start += 50) {
    await db.batch(statements.slice(start, start + 50).map(sql => db.prepare(sql)));
  }
  await db.exec(`INSERT INTO tenants (id,tenant_code,display_name) VALUES ('tenant-a','a','Synthetic');
INSERT INTO staff_members (id,name,role,api_key) VALUES ('staff-a','Synthetic','admin','synthetic-staff-key');
INSERT INTO tenant_staff_memberships (tenant_id,staff_id,role) VALUES ('tenant-a','staff-a','admin');
INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret) VALUES ('account-a','synthetic-channel','Synthetic','synthetic-token','synthetic-secret');
INSERT INTO tenant_line_accounts (tenant_id,line_account_id) VALUES ('tenant-a','account-a');`);
  const denied = await mf.dispatchFetch('https://worker.synthetic.invalid/api/scenarios');
  assert.equal(denied.status, 401);
  const created = await mf.dispatchFetch('https://worker.synthetic.invalid/api/scenarios', {
    method: 'POST', headers: { authorization: 'Bearer synthetic-staff-key', 'x-tenant-id': 'tenant-a', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Synthetic draft', triggerType: 'friend_add', isActive: false, lineAccountId: 'account-a' }),
  });
  const payload = await created.json();
  assert.equal(created.status, 403, JSON.stringify(payload));
  assert.equal(payload.error, 'Feature disabled for pharmacy tenant');
  const count = await db.prepare('SELECT COUNT(*) AS count FROM scenarios').first();
  assert.equal(count.count, 0);
  const accounts = await mf.dispatchFetch('https://worker.synthetic.invalid/api/line-accounts', {
    headers: { authorization: 'Bearer synthetic-staff-key', 'x-tenant-id': 'tenant-a' },
  });
  const accountPayload = await accounts.json();
  assert.equal(accounts.status, 200, JSON.stringify(accountPayload));
  assert.deepEqual(accountPayload, { success: true, data: [] });
  const oversizedWebhook = await mf.dispatchFetch('https://worker.synthetic.invalid/webhook', {
    method: 'POST', body: 'x'.repeat(1024 * 1024 + 1),
  });
  assert.equal(oversizedWebhook.status, 413);
  assert.deepEqual(await oversizedWebhook.json(), { status: 'too_large' });
  const unsignedWebhook = await mf.dispatchFetch('https://worker.synthetic.invalid/webhook', {
    method: 'POST', body: JSON.stringify({ destination: 'synthetic', events: [] }),
  });
  assert.equal(unsignedWebhook.status, 200);
  assert.deepEqual(await unsignedWebhook.json(), { status: 'ok' });
  await db.exec(`UPDATE line_accounts SET token_expires_at='2099-01-01T00:00:00Z' WHERE id='account-a';
INSERT INTO friends (id,line_user_id,provider_line_user_id,line_account_id,display_name,is_following) VALUES ('friend-meet','synthetic-user','synthetic-provider','account-a','Synthetic',1);`);
  const future=new Date(Date.now()+2*60*60*1000).toISOString();
  const past=new Date(Date.now()-60*1000).toISOString();
  await db.prepare(`INSERT INTO meet_consultations (id,external_event_id,friend_id,title,starts_at,ends_at,meet_url)
VALUES ('meet-a','event-a','friend-meet','Synthetic',?,?, 'https://meet.google.com/aaa-bbbb-ccc')`).bind(future,future).run();
  await db.prepare(`INSERT INTO meet_consultation_reminders (id,consultation_id,kind,scheduled_at,delivery_id)
VALUES ('reminder-a','meet-a','hour_before',?,'delivery-a')`).bind(past).run();
 const now='2026-09-22T00:00:00.000Z';
 for(const x of ['a','b']) {
 await db.exec(`INSERT INTO tenants(id,tenant_code,display_name,outbound_messaging_paused_at) VALUES ('queue-tenant-${x}','queue-tenant-${x}','Synthetic',${x==='a'?"'2026-09-21T00:00:00.000Z'":'NULL'});
 INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('queue-account-${x}','queue-channel-${x}','Synthetic','synthetic','synthetic');
 INSERT INTO tenant_line_accounts(tenant_id,line_account_id) VALUES ('queue-tenant-${x}','queue-account-${x}');
 UPDATE pharmacy_account_capabilities SET capabilities_json='["prescription_intake"]' WHERE line_account_id='queue-account-${x}';
 INSERT INTO friends(id,line_user_id,provider_line_user_id,line_account_id,is_following) VALUES ('queue-friend-${x}','queue-user-${x}','queue-provider-${x}','queue-account-${x}',1);
 INSERT INTO pharmacy_patients(id,line_account_id,owner_friend_id,relationship,name,name_kana,birth_date,created_at,updated_at) VALUES ('queue-patient-${x}','queue-account-${x}','queue-friend-${x}','self','Synthetic','Synthetic','1990-01-01','${now}','${now}');
 INSERT INTO pharmacy_patient_intake_responses(id,line_account_id,owner_friend_id,patient_id,revision,schema_version,patient_snapshot_json,answers_json,idempotency_key,representative_consent_at,privacy_consent_at,created_at) VALUES ('queue-response-${x}','queue-account-${x}','queue-friend-${x}','queue-patient-${x}',1,1,'{}','{}','synthetic-key','${now}','${now}','${now}');`);
 }
 for(let i=0;i<51;i++) {
 const x=i<50?'a':'b'; const id=String(i).padStart(3,'0');
 await db.exec(`INSERT INTO pharmacy_prescription_submissions(id,line_account_id,friend_id,idempotency_key,status,created_at,updated_at) VALUES ('queue-sub-${id}','queue-account-${x}','queue-friend-${x}','synthetic-${id}','ready','${now}','${now}');
 INSERT INTO pharmacy_prescription_patients(submission_id,line_account_id,owner_friend_id,patient_id,intake_response_id,created_at) VALUES ('queue-sub-${id}','queue-account-${x}','queue-friend-${x}','queue-patient-${x}','queue-response-${x}','${now}');
 INSERT INTO pharmacy_prescription_validities(submission_id,line_account_id,issued_on,valid_until,validity_basis,verification_status,verified_by,verified_at,reminder_due_at,created_at,updated_at) VALUES ('queue-sub-${id}','queue-account-${x}','2026-09-21','2026-09-24','default_4_days','verified','synthetic-staff','${now}','2026-09-21T00:00:00.000Z','${now}','${now}');`);
 }

  const cron=await mf.dispatchFetch('https://worker.synthetic.invalid/__audit_cron');
  assert.equal(cron.status,200,await cron.text());
  const reminder=await db.prepare("SELECT status,retry_count,last_error FROM meet_consultation_reminders WHERE id='reminder-a'").first();
  assert.equal(reminder.status,'failed');
  assert.equal(reminder.retry_count,1);
  assert.equal(reminder.last_error,'meet reminder channel credential unavailable');
  console.log(JSON.stringify({cronReminder:reminder}));
  const checked = () => db.prepare("SELECT COUNT(*) AS count FROM pharmacy_prescription_validities WHERE notification_checked_at IS NOT NULL").first();
  assert.equal((await checked()).count,50);
  const secondCron = await mf.dispatchFetch('https://worker.synthetic.invalid/__audit_cron');
  assert.equal(secondCron.status,200);
  assert.equal((await checked()).count,51);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM pharmacy_prescription_validities WHERE verification_status='verified' AND valid_until='2026-09-24'").first()).count,51);
  console.log(JSON.stringify({queueFirstTickChecked:50,queueSecondTickChecked:51,clinicalStatePreserved:true}));
  assert.deepEqual(outbound, []);
  console.log(JSON.stringify({ result: 'PASS', unauthenticated: denied.status,
    pharmacyGenericWriteDenied: created.status, scenarioCount: count.count,
    unassignedAccountList: accounts.status, accountPayload, oversizedWebhook: oversizedWebhook.status, unsignedWebhook: unsignedWebhook.status, outbound }, null, 2));
} finally { await mf.dispose(); }
