import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd();
const evidence = join(root, 'docs/pharmacy/evidence/audit-20260922');
const require = createRequire(join(realpathSync(join(root, 'apps/worker/node_modules/wrangler')), 'package.json'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = readFileSync(join(root, 'apps/worker/src/custom/pharmacy/intake/migration.ts'), 'utf8');
const guardSql = source.match(/const guard = db\.prepare\(`([\s\S]*?)`\)\.bind/)[1]
  .replaceAll('${GUARD_FAIL_PHASE}', 'GUARD_FAIL').replaceAll('${GUARD_FAIL_DIGEST}', '0'.repeat(64));
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, modules: true, script: 'export default { fetch() { return new Response("local-only"); } };',
  compatibilityDate: '2024-12-01', d1Databases: ['DB'],
  outboundService: () => { throw new Error('Unexpected outbound request'); },
}));
try {
  const db = await mf.getD1Database('DB');
  const bootstrap = JSON.parse(readFileSync(join(evidence, 'F14-bootstrap-statements.json'), 'utf8'));
  for (let i = 0; i < bootstrap.length; i += 50) await db.batch(bootstrap.slice(i, i + 50).map(sql => db.prepare(sql)));
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const token = 'f'.repeat(32);
  await db.batch([
    db.prepare("INSERT INTO tenants (id,tenant_code,display_name) VALUES ('tenant-a','a','Synthetic')"),
    db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret) VALUES ('account-a','a','Before','synthetic','synthetic')"),
    db.prepare("INSERT INTO tenant_line_accounts (tenant_id,line_account_id) VALUES ('tenant-a','account-a')"),
    db.prepare(`INSERT INTO pharmacy_recovery_operations
      (id,tenant_id,line_account_id,environment,operation,status,requested_by_issuer,requested_by_subject,
       executor_subject,approval_expires_at,job_id,idempotency_key,execution_id,fence_id,fence_token,created_at,updated_at)
      VALUES ('op-a','tenant-a','account-a','test','plaintext_scrub','running','platform-admin','approver',
       'executor',?,'job-a','idem-a','exec-a','fence-a',?,?,?)`).bind(future, token, now, now),
    db.prepare(`INSERT INTO pharmacy_recovery_execution_fences
      (fence_id,operation_id,tenant_id,line_account_id,environment,execution_id,fence_token,
       owner_issuer,owner_subject,status,expires_at,created_at)
      VALUES ('fence-a','op-a','tenant-a','account-a','test','exec-a',?,'platform-admin','executor','active',?,?)`)
      .bind(token, future, now),
  ]);
  const guard = db.prepare(guardSql).bind('tenant-a','account-a','op-a','tenant-a','account-a','test',
    'plaintext_scrub','exec-a',token,'executor');
  const write = db.prepare("UPDATE line_accounts SET name = 'After' WHERE id = 'account-a'");
  const account = () => db.prepare("SELECT name FROM line_accounts WHERE id = 'account-a'").first();
  const results = await db.batch([guard, write, guard]);
  assert.equal(results.length, 3);
  assert.equal(results[1].meta.changes, 1);
  assert.equal((await account()).name, 'After');
  await db.prepare("UPDATE line_accounts SET name = 'Before' WHERE id = 'account-a'").run();
  const expire = db.prepare("UPDATE pharmacy_recovery_execution_fences SET expires_at = '2000-01-01T00:00:00.000Z' WHERE fence_id = 'fence-a'");
  await assert.rejects(db.batch([guard, write, expire, guard]));
  assert.equal((await account()).name, 'Before');
  assert.equal((await db.prepare("SELECT expires_at FROM pharmacy_recovery_execution_fences WHERE fence_id = 'fence-a'").first()).expires_at, future);
  await expire.run();
  await assert.rejects(db.batch([guard, write, guard]));
  assert.equal((await account()).name, 'Before');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM pharmacy_patient_intake_migration_state').first()).n, 0);
  const firstClock = (await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value").first()).value;
  await new Promise(resolve => setTimeout(resolve, 30));
  const secondClock = (await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value").first()).value;
  assert.ok(Date.parse(secondClock) > Date.parse(firstClock));
  console.log(JSON.stringify({ result: 'PASS', engine: 'local Miniflare D1',
    repeatedPreparedGuard: true, validWrite: true, expiredWriteRejected: true,
    lateGuardRollsBackAllWrites: true, guardLeavesNoRows: true, clockAdvances: true }));
} finally { await mf.dispose(); }
