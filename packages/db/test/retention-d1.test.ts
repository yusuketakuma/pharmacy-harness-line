import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQL,
  assessPatientRetention,
  latestPhiRecordedAt,
} from '../../../apps/worker/src/custom/pharmacy/data-subject-requests/legal-hold.js';
import { splitSqlStatements } from '../scripts/split-sql-statements.mjs';

// Use the D1 engine shipped with this workspace's Wrangler. Ordinary SQLite
// allows larger compound SELECTs and did not expose this regression.
const workerRequire = createRequire(new URL('../../../apps/worker/package.json', import.meta.url));
const wranglerRequire = createRequire(workerRequire.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const OLD = '2019-01-01T00:00:00.000Z';
const NOW = new Date('2026-08-20T00:00:00.000Z');

it('evaluates every retention source on native D1 while preserving scope and unknown sources', async () => {
  let outbound = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    modules: true,
    script: 'export default { fetch() { return new Response("synthetic"); } };',
    compatibilityDate: '2024-12-01',
    d1Databases: ['DB'],
    outboundService: () => { outbound++; return new Response('blocked', { status: 503 }); },
  }));
  try {
    const db = await mf.getD1Database('DB') as D1Database;
    const schema = splitSqlStatements(readFileSync(new URL('../bootstrap.sql', import.meta.url), 'utf8'));
    for (let i = 0; i < schema.length; i += 50) {
      await db.batch(schema.slice(i, i + 50).map((sql: string) => db.prepare(sql)));
    }
    for (const suffix of ['a', 'b']) {
      await db.batch([
        db.prepare(`INSERT INTO tenants(id, tenant_code, display_name)
          VALUES (?, ?, 'Synthetic')`).bind(`tenant-${suffix}`, `tenant-${suffix}`),
        db.prepare(`INSERT INTO line_accounts(id, channel_id, name, channel_access_token, channel_secret)
          VALUES (?, ?, 'Synthetic', 'synthetic-token', 'synthetic-secret')`).bind(`account-${suffix}`, `channel-${suffix}`),
        db.prepare(`INSERT INTO tenant_line_accounts(tenant_id, line_account_id)
          VALUES (?, ?)`).bind(`tenant-${suffix}`, `account-${suffix}`),
        db.prepare(`INSERT INTO friends(id, line_user_id, line_account_id, is_following, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?)`).bind(`friend-${suffix}`, `synthetic-user-${suffix}`, `account-${suffix}`, OLD, OLD),
        db.prepare(`INSERT INTO pharmacy_patients(id, line_account_id, owner_friend_id,
          relationship, name, name_kana, birth_date, created_at, updated_at)
          VALUES (?, ?, ?, 'self', 'Synthetic', 'Synthetic', '1990-01-01', ?, ?)`)
          .bind(`patient-${suffix}`, `account-${suffix}`, `friend-${suffix}`, OLD, OLD),
      ]);
    }
    const scope = { tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a', patientId: 'patient-a' };
    const latest = () => latestPhiRecordedAt(db, 'account-a', 'patient-a', 'friend-a');
    const assess = () => assessPatientRetention(db, scope, NOW);
    expect(await latest()).toBe(OLD);
    expect(await assess()).toEqual({ status: 'released', releaseAt: '2022-01-01T00:00:00.000Z' });

    // A more recent owner record from a different account must not enter scope.
    await db.prepare(`INSERT INTO messages_log(id, friend_id, line_account_id,
      direction, message_type, content, created_at)
      VALUES ('foreign', 'friend-b', 'account-b', 'incoming', 'text', 'synthetic', ?)`)
      .bind('2026-08-19T00:00:00.000Z').run();
    expect(await latest()).toBe(OLD);
    expect(await assessPatientRetention(db, { ...scope, ownerFriendId: 'friend-b' }, NOW))
      .toEqual({ status: 'unknown', releaseAt: null });

    // Owner-only LINE records still extend the patient's retention period.
    await db.prepare(`INSERT INTO messages_log(id, friend_id, line_account_id,
      direction, message_type, content, created_at)
      VALUES ('own', 'friend-a', 'account-a', 'incoming', 'text', 'synthetic', ?)`)
      .bind('2024-01-01T00:00:00.000Z').run();
    expect(await latest()).toBe('2024-01-01T00:00:00.000Z');
    expect(await assess()).toEqual({ status: 'held', releaseAt: '2027-01-01T00:00:00.000Z' });

    // Patient-specific PHI and then an invalid owner timestamp must both be read.
    await db.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key,
       representative_consent_at, privacy_consent_at, created_at)
      VALUES ('intake', 'account-a', 'friend-a', 'patient-a', 1, 1,
       '{}', '{}', 'synthetic-key', ?, ?, ?)`).bind(NOW.toISOString(), NOW.toISOString(), NOW.toISOString()).run();
    expect(await latest()).toBe(NOW.toISOString());
    expect(await assess()).toEqual({ status: 'held', releaseAt: '2029-08-20T00:00:00.000Z' });
    await db.prepare("UPDATE messages_log SET created_at = '2020-02-30T00:00:00.000Z' WHERE id = 'own'").run();
    expect(await latest()).toBeNull();
    expect(await assess()).toEqual({ status: 'unknown', releaseAt: null });
    await db.prepare("UPDATE messages_log SET created_at = 'invalid-source-date' WHERE id = 'own'").run();
    expect(await latest()).toBeNull();
    expect(await assess()).toEqual({ status: 'unknown', releaseAt: null });
    expect(outbound).toBe(0);
  } finally {
    await mf.dispose();
  }
}, 30_000);


it('evaluates active DSR dates on D1 without accepting invalid calendar dates', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    cf: false, modules: true,
    script: 'export default { fetch() { return new Response("synthetic"); } };',
    d1Databases: ['DB'],
    outboundService: () => new Response('blocked', { status: 503 }),
  }));
  try {
    const db = await mf.getD1Database('DB') as D1Database;
    const cases = [
      { date: '2020-02-29T00:00:00.000Z', blocked: 0 },
      { date: NOW.toISOString(), blocked: 0 },
      { date: '2026-08-20T00:00:00.001Z', blocked: 1 },
      { date: '2020-02-30T00:00:00.000Z', blocked: 1 },
      { date: '2021-02-29T00:00:00.000Z', blocked: 1 },
      { date: '2020-99-99T00:00:00.000Z', blocked: 1 },
      { date: '2020-01-01T24:00:00.000Z', blocked: 1 },
      { date: '2020-01-01T00:00:00.000+09:00', blocked: 1 },
      { date: '2020-01-01', blocked: 1 },
      { date: null, blocked: 1 },
    ];
    for (const { date, blocked } of cases) {
      const row = await db.prepare(`SELECT ${ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQL} AS blocked
        FROM (SELECT 'legal_hold_assessed' AS status, 1 AS legal_hold, ? AS legal_hold_release_at) AS request`)
        .bind(NOW.toISOString(), date).first<{ blocked: number }>();
      expect(row, String(date)).toEqual({ blocked });
    }
    for (const status of ['received', 'identity_verified', 'legal_hold_assessed']) {
      const row = await db.prepare(`SELECT ${ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQL} AS blocked
        FROM (SELECT ? AS status, 0 AS legal_hold, NULL AS legal_hold_release_at) AS request`)
        .bind(NOW.toISOString(), status).first<{ blocked: number }>();
      expect(row).toEqual({ blocked: status === 'legal_hold_assessed' ? 0 : 1 });
    }
  } finally {
    await mf.dispose();
  }
}, 30_000);
