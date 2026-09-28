import { createRequire } from 'node:module';
import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const [artifact, wranglerPackage] = process.argv.slice(2);
const require = createRequire(join(realpathSync(wranglerPackage), 'package.json'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const outbound = [];
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false,
  modulesRoot: join(artifact, 'audit_worker'),
  modules: ['index.js', ...readdirSync(join(artifact, 'audit_worker/assets')).filter(name => name.endsWith('.js')).map(name => `assets/${name}`)]
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
  assert.deepEqual(outbound, []);
  console.log(JSON.stringify({ result: 'PASS', unauthenticated: denied.status,
    pharmacyGenericWriteDenied: created.status, scenarioCount: count.count,
    unassignedAccountList: accounts.status, accountPayload, oversizedWebhook: oversizedWebhook.status, unsignedWebhook: unsignedWebhook.status, outbound }, null, 2));
} finally { await mf.dispose(); }
