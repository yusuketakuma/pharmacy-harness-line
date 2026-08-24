import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeCommonGeneration,
  captureCommonGeneration,
  createCommonGenerationSigner,
  createNoSendIsolatedRestoreTarget,
  runIsolatedRestoreRehearsal,
  sha256CommonGeneration,
  validateCapturedArtifacts,
  verifyCommonGenerationManifest,
  type CapturedArtifactsForValidation,
  type CommonGenerationManifest,
} from './common-generation.js';
import { sealPatientIntakeField } from '../../apps/worker/src/custom/pharmacy/intake/encryption.js';

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const r2Objects = [{
  key: 'generation/g-1/object',
  contentSha256: digest('0'),
  byteLength: 1,
  embeddedGeneration: 'g-1',
  embeddedFenceId: 'fence-1',
  embeddedFenceEpoch: 1,
  embeddedCutId: 'cut-1',
}];
const r2InventoryCanonical = canonicalizeCommonGeneration(
  r2Objects.map(({ key, contentSha256, byteLength }) => ({ key, contentSha256, byteLength })),
);

const payload: CommonGenerationManifest = {
  manifestId: 'manifest-1',
  manifestVersion: 1,
  generation: 'g-1',
  scope: { accountId: 'account-1', tenantId: 'tenant-1', lineAccountId: 'line-account-1' },
  source: { environmentId: 'source-dev', bindingFingerprint: 'source-fingerprint', production: false },
  fence: {
    id: 'fence-1',
    epoch: 1,
    cutId: 'cut-1',
    startedAt: '2026-08-24T00:00:00.000Z',
    completedAt: '2026-08-24T00:01:00.000Z',
    activeJobDigest: digest('a'),
  },
  d1: {
    export: {
      byteLength: 1,
      sha256: digest('b'),
      embeddedGeneration: 'g-1',
      embeddedFenceId: 'fence-1',
      embeddedFenceEpoch: 1,
      embeddedCutId: 'cut-1',
    },
    schema: { version: 1, fingerprint: digest('c') },
    orderedMigrations: [{ order: 1, name: '001.sql', checksum: digest('d') }],
    logicalInventory: {
      rootSha256: sha256CommonGeneration('{"patients":1}'),
      tableCounts: { patients: 1 },
    },
  },
  r2: {
    namespace: 'bucket',
    prefix: 'generation/g-1/',
    inventory: {
      sha256: sha256CommonGeneration(r2InventoryCanonical),
      byteLength: Buffer.byteLength(r2InventoryCanonical),
      objectCount: 1,
      totalBytes: 1,
      embeddedGeneration: 'g-1',
      embeddedFenceId: 'fence-1',
      embeddedFenceEpoch: 1,
      embeddedCutId: 'cut-1',
      objects: r2Objects,
    },
  },
  fle: {
    fieldInventory: [
      { field: 'pharmacy_patient_intake_responses.patient_snapshot_json', encrypted: true, envelopeVersion: 1, keyVersion: 1, referenceCount: 1 },
      { field: 'pharmacy_patient_intake_responses.answers_json', encrypted: true, envelopeVersion: 1, keyVersion: 1, referenceCount: 1 },
    ],
    envelopeVersions: [1],
    keyVersions: [1],
    pinnedKeyFingerprint: digest('1'),
    referenceCounts: {
      'pharmacy_patient_intake_responses.patient_snapshot_json': 1,
      'pharmacy_patient_intake_responses.answers_json': 1,
    },
  },
  watermarks: {
    outbox: { maxCommitted: 1, maxProcessed: 1, pendingCount: 0, pendingSetDigest: digest('2') },
    webhook: { maxCommitted: 1, maxProcessed: 1, pendingCount: 0, pendingSetDigest: digest('3') },
  },
  restorePolicy: { mode: 'isolated-only', production_side_effects_allowed: false },
};

const clone = <T>(value: T): T => structuredClone(value);

function testSigner(signingKeyId = 'test-key') {
  const pair = generateKeyPairSync('ed25519');
  return createCommonGenerationSigner({
    signingKeyId,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  });
}

function signedFixture() {
  const signer = testSigner();
  const signed = signer.sign(clone(payload));
  const trustStore = { [signer.signingKeyId]: signer.publicKey };
  return { signer, signed, trustStore };
}

async function captureFixture() {
  const d1Bytes = Uint8Array.from([1, 2, 3]);
  const objectBytes = Uint8Array.from([4, 5]);
  const artifacts: CapturedArtifactsForValidation = {
    d1: {
      bytes: d1Bytes,
      embeddedGeneration: payload.generation,
      embeddedFenceId: payload.fence.id,
      embeddedFenceEpoch: payload.fence.epoch,
      embeddedCutId: payload.fence.cutId,
      schema: payload.d1.schema,
      orderedMigrations: payload.d1.orderedMigrations,
      logicalInventory: payload.d1.logicalInventory,
    },
    r2: {
      namespace: payload.r2.namespace,
      prefix: payload.r2.prefix,
      embeddedGeneration: payload.generation,
      embeddedFenceId: payload.fence.id,
      embeddedFenceEpoch: payload.fence.epoch,
      embeddedCutId: payload.fence.cutId,
      objects: [{
        key: `${payload.r2.prefix}object`,
        bytes: objectBytes,
        embeddedGeneration: payload.generation,
        embeddedFenceId: payload.fence.id,
        embeddedFenceEpoch: payload.fence.epoch,
        embeddedCutId: payload.fence.cutId,
      }],
    },
    fle: payload.fle,
    watermarks: payload.watermarks,
  };
  const manifest = await captureCommonGeneration({
    manifestId: payload.manifestId,
    generation: payload.generation,
    scope: payload.scope,
    source: payload.source,
    fence: payload.fence,
    readers: {
      readFence: () => payload.fence,
      readD1: () => artifacts.d1,
      readR2: () => artifacts.r2,
      readFle: () => artifacts.fle,
      readWatermarks: () => artifacts.watermarks,
    },
  });
  return { manifest, artifacts };
}

const SYNTHETIC_FLE_SECRET = `synthetic-only-${'x'.repeat(32)}`;

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function schemaFingerprint(sql: string): `sha256:${string}` {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql);
    const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
    return sha256CommonGeneration(canonicalizeCommonGeneration(rows));
  } finally {
    db.close();
  }
}

async function syntheticRestoreFixture(now = Date.now(), includeWatermarkTables = true) {
  const generation = 'g-restore-1';
  const lineAccountId = 'line-account-1';
  const tenantId = 'tenant-1';
  const fence = {
    id: 'fence-restore-1',
    epoch: 4,
    cutId: 'cut-restore-1',
    startedAt: new Date(now - 120_000).toISOString(),
    completedAt: new Date(now - 60_000).toISOString(),
    activeJobDigest: digest('a'),
  };
  const baseContext = {
    tenantId,
    lineAccountId,
    ownerFriendId: 'friend-1',
    patientId: 'patient-1',
    responseId: 'intake-1',
    schemaVersion: 1,
    sourceRevision: 1,
    envelopeVersion: 1 as const,
    keyVersion: 1 as const,
  };
  const snapshot = '{"name":"synthetic patient"}';
  const answers = '{"allergiesStatus":"none"}';
  const [snapshotEnvelope, answersEnvelope] = await Promise.all([
    sealPatientIntakeField(snapshot, SYNTHETIC_FLE_SECRET, {
      ...baseContext,
      fieldName: 'patient_snapshot_json',
    }),
    sealPatientIntakeField(answers, SYNTHETIC_FLE_SECRET, {
      ...baseContext,
      fieldName: 'answers_json',
    }),
  ]);
  const r2Key = `custom/pharmacy/prescriptions/${lineAccountId}/rx-1/1/1`;
  const r2Bytes = new TextEncoder().encode('synthetic prescription image');
  const outboxPending = [
    { id: 'outbox-2', idempotencyKey: 'retry-2', occurredAt: fence.completedAt, outcome: 'attempted' },
    { id: 'outbox-3', idempotencyKey: 'retry-3', occurredAt: fence.completedAt, outcome: 'attempted' },
  ];
  const webhookPending = [{
    webhookEventId: 'webhook-2', status: 'pending', retryCount: 0, deadLetteredAt: null,
  }];
  const watermarkSql = includeWatermarkTables ? `
    CREATE TABLE pharmacy_notification_events (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE pharmacy_webhook_event_receipts (
      tenant_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL,
      webhook_event_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL,
      dead_lettered_at TEXT,
      PRIMARY KEY (tenant_id, line_account_id, webhook_event_id)
    );
    INSERT INTO pharmacy_notification_events VALUES
      ('outbox-1', ${sqlString(lineAccountId)}, 'sent', ${sqlString(fence.startedAt)}, 'retry-1', ${sqlString(fence.startedAt)}),
      ('outbox-2', ${sqlString(lineAccountId)}, 'attempted', ${sqlString(fence.completedAt)}, 'retry-2', ${sqlString(fence.completedAt)}),
      ('outbox-3', ${sqlString(lineAccountId)}, 'attempted', ${sqlString(fence.completedAt)}, 'retry-3', ${sqlString(fence.completedAt)});
    INSERT INTO pharmacy_webhook_event_receipts VALUES
      (${sqlString(tenantId)}, ${sqlString(lineAccountId)}, 'webhook-1', ${sqlString(fence.startedAt)}, 'completed', 0, NULL),
      (${sqlString(tenantId)}, ${sqlString(lineAccountId)}, 'webhook-2', ${sqlString(fence.completedAt)}, 'pending', 0, NULL);
  ` : '';
  const sql = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE pharmacy_prescription_submissions (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL
    );
    CREATE TABLE pharmacy_prescription_files (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES pharmacy_prescription_submissions(id),
      r2_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE pharmacy_patient_intake_responses (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      owner_friend_id TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      patient_snapshot_json TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      UNIQUE (id, patient_id, line_account_id, owner_friend_id, schema_version, revision)
    );
    CREATE TABLE pharmacy_patient_intake_envelopes (
      response_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL,
      owner_friend_id TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      source_revision INTEGER NOT NULL,
      envelope_version INTEGER NOT NULL,
      key_version INTEGER NOT NULL,
      nonce TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      PRIMARY KEY (response_id, field_name),
      FOREIGN KEY (response_id, patient_id, line_account_id, owner_friend_id, schema_version, source_revision)
        REFERENCES pharmacy_patient_intake_responses
          (id, patient_id, line_account_id, owner_friend_id, schema_version, revision)
    );
    CREATE TABLE pharmacy_medication_followups (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      source_submission_id TEXT NOT NULL REFERENCES pharmacy_prescription_submissions(id)
    );
    INSERT INTO pharmacy_prescription_submissions VALUES ('rx-1', ${sqlString(lineAccountId)});
    INSERT INTO pharmacy_prescription_files VALUES ('file-1', 'rx-1', ${sqlString(r2Key)});
    INSERT INTO pharmacy_patient_intake_responses VALUES (
      'intake-1', ${sqlString(lineAccountId)}, 'friend-1', 'patient-1', 1, 1,
      ${sqlString(snapshot)}, ${sqlString(answers)}
    );
    INSERT INTO pharmacy_patient_intake_envelopes VALUES (
      'intake-1', ${sqlString(tenantId)}, ${sqlString(lineAccountId)}, 'friend-1', 'patient-1',
      'patient_snapshot_json', 1, 1, 1, 1,
      ${sqlString(snapshotEnvelope.nonce)}, ${sqlString(snapshotEnvelope.ciphertext)}
    );
    INSERT INTO pharmacy_patient_intake_envelopes VALUES (
      'intake-1', ${sqlString(tenantId)}, ${sqlString(lineAccountId)}, 'friend-1', 'patient-1',
      'answers_json', 1, 1, 1, 1,
      ${sqlString(answersEnvelope.nonce)}, ${sqlString(answersEnvelope.ciphertext)}
    );
    INSERT INTO pharmacy_medication_followups VALUES ('followup-1', ${sqlString(lineAccountId)}, 'rx-1');
    ${watermarkSql}
  `;
  const tableCounts = {
    pharmacy_prescription_submissions: 1,
    pharmacy_prescription_files: 1,
    pharmacy_patient_intake_responses: 1,
    pharmacy_patient_intake_envelopes: 2,
    pharmacy_medication_followups: 1,
    ...(includeWatermarkTables ? {
      pharmacy_notification_events: 3,
      pharmacy_webhook_event_receipts: 2,
    } : {}),
  };
  const artifacts: CapturedArtifactsForValidation = {
    d1: {
      bytes: new TextEncoder().encode(sql),
      embeddedGeneration: generation,
      embeddedFenceId: fence.id,
      embeddedFenceEpoch: fence.epoch,
      embeddedCutId: fence.cutId,
      schema: { version: 1, fingerprint: schemaFingerprint(sql) },
      orderedMigrations: [{ order: 58, name: 'custom_058.sql', checksum: digest('d') }],
      logicalInventory: {
        rootSha256: sha256CommonGeneration(canonicalizeCommonGeneration(tableCounts)),
        tableCounts,
      },
    },
    r2: {
      namespace: 'synthetic-memory-r2',
      prefix: 'custom/pharmacy/prescriptions/',
      embeddedGeneration: generation,
      embeddedFenceId: fence.id,
      embeddedFenceEpoch: fence.epoch,
      embeddedCutId: fence.cutId,
      objects: [{
        key: r2Key,
        bytes: r2Bytes,
        embeddedGeneration: generation,
        embeddedFenceId: fence.id,
        embeddedFenceEpoch: fence.epoch,
        embeddedCutId: fence.cutId,
      }],
    },
    fle: {
      fieldInventory: [
        { field: 'pharmacy_patient_intake_responses.patient_snapshot_json', encrypted: true, envelopeVersion: 1, keyVersion: 1, referenceCount: 1 },
        { field: 'pharmacy_patient_intake_responses.answers_json', encrypted: true, envelopeVersion: 1, keyVersion: 1, referenceCount: 1 },
      ],
      envelopeVersions: [1],
      keyVersions: [1],
      pinnedKeyFingerprint: sha256CommonGeneration(SYNTHETIC_FLE_SECRET),
      referenceCounts: {
        'pharmacy_patient_intake_responses.patient_snapshot_json': 1,
        'pharmacy_patient_intake_responses.answers_json': 1,
      },
    },
    watermarks: {
      outbox: {
        maxCommitted: fence.completedAt,
        maxProcessed: fence.startedAt,
        pendingCount: outboxPending.length,
        pendingSetDigest: sha256CommonGeneration(canonicalizeCommonGeneration({ kind: 'outbox', rows: outboxPending })),
      },
      webhook: {
        maxCommitted: fence.completedAt,
        maxProcessed: fence.startedAt,
        pendingCount: webhookPending.length,
        pendingSetDigest: sha256CommonGeneration(canonicalizeCommonGeneration({ kind: 'webhook', rows: webhookPending })),
      },
    },
  };
  const manifest = await captureCommonGeneration({
    manifestId: 'manifest-restore-1',
    generation,
    scope: { accountId: 'account-1', tenantId, lineAccountId },
    source: { environmentId: 'source-dev', bindingFingerprint: 'source-binding', production: false },
    fence,
    readers: {
      readFence: () => fence,
      readD1: () => artifacts.d1,
      readR2: () => artifacts.r2,
      readFle: () => artifacts.fle,
      readWatermarks: () => artifacts.watermarks,
    },
  });
  const signer = testSigner('restore-test-key');
  const signedManifest = signer.sign(manifest);
  const pinnedTrustStore = { [signer.signingKeyId]: signer.publicKey };
  const retainedGenerations = [
    {
      generation,
      completedAt: fence.completedAt,
      location: { provider: 'cloudflare-r2', accountId: 'backup-a', container: 'archive-a', failureDomain: 'account-a' },
    },
    {
      generation: 'g-restore-2',
      completedAt: new Date(now - 86_400_000).toISOString(),
      location: { provider: 'cloudflare-r2', accountId: 'backup-a', container: 'archive-a', failureDomain: 'account-a' },
    },
    {
      generation: 'g-restore-3',
      completedAt: new Date(now - 172_800_000).toISOString(),
      location: { provider: 'cloudflare-r2', accountId: 'backup-b', container: 'archive-b', failureDomain: 'account-b' },
    },
  ];
  return { artifacts, fence, manifest, pinnedTrustStore, retainedGenerations, signedManifest, signer };
}

describe('common-generation signing', () => {
  it('signs a canonical payload and verifies it with caller-pinned trust', () => {
    const signer = testSigner('generated-test-key');

    const signed = signer.sign(payload);

    expect(signer.verify(signed, { [signed.signingKeyId]: signer.publicKey })).toMatchObject({
      valid: true,
      payload,
    });
  });

  it('rejects tampering, untrusted keys, algorithms, versions, and unknown fields', () => {
    const { signer, signed, trustStore } = signedFixture();
    const tampered = clone(signed);
    tampered.payload.generation = 'g-tampered';
    expect(signer.verify(tampered, trustStore).valid).toBe(false);
    expect(signer.verify(signed, {}).valid).toBe(false);

    expect(verifyCommonGenerationManifest({ ...signed, algorithm: 'none' } as never, trustStore).valid).toBe(false);
    expect(verifyCommonGenerationManifest({ ...signed, schemaVersion: 2 } as never, trustStore).valid).toBe(false);
    expect(verifyCommonGenerationManifest({ ...signed, publicKey: signer.publicKey } as never, trustStore).valid).toBe(false);
    expect(verifyCommonGenerationManifest({
      ...signed,
      payload: { ...signed.payload, unexpected: true },
    } as never, trustStore).valid).toBe(false);
  });

  it('rejects duplicate and non-canonical raw JSON before signature verification', () => {
    const { signed, trustStore } = signedFixture();
    const canonical = canonicalizeCommonGeneration(signed);
    expect(verifyCommonGenerationManifest(canonical, trustStore).valid).toBe(true);
    expect(verifyCommonGenerationManifest(JSON.stringify(signed), trustStore).valid).toBe(false);
    expect(verifyCommonGenerationManifest('{"algorithm":"ed25519","algorithm":"none"}', trustStore).valid).toBe(false);
  });

  it('rejects a mixed generation or unsafe restore policy at signing time', () => {
    const signer = testSigner();
    const mixed = clone(payload);
    mixed.d1.export.embeddedGeneration = 'g-2';
    expect(() => signer.sign(mixed)).toThrow(/mixed generation or fence/);
    const unsafe = clone(payload);
    unsafe.restorePolicy.production_side_effects_allowed = true as never;
    expect(() => signer.sign(unsafe)).toThrow(/production side effects/);
    const plaintext = clone(payload);
    plaintext.fle.fieldInventory[0].encrypted = false as never;
    expect(() => signer.sign(plaintext)).toThrow(/plaintext fallback/);
  });

  it('requires the complete canonical FLE field inventory', () => {
    const signer = testSigner();
    const missing = clone(payload);
    missing.fle.fieldInventory = [];
    missing.fle.referenceCounts = {};

    expect(() => signer.sign(missing)).toThrow(/FLE field inventory/);
  });

  it('derives the signed R2 inventory hash and byte length from its objects', () => {
    const signer = testSigner();
    const mismatched = clone(payload);
    mismatched.r2.inventory.sha256 = digest('9');
    mismatched.r2.inventory.byteLength = 999;

    expect(() => signer.sign(mismatched)).toThrow(/R2 inventory/);
  });

  it('uses caller-supplied stable Ed25519 keys instead of generating a new trust anchor', () => {
    const pair = generateKeyPairSync('ed25519');
    const first = createCommonGenerationSigner({
      signingKeyId: 'stable-key',
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    });
    const second = createCommonGenerationSigner({
      signingKeyId: 'stable-key',
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    });

    expect(first.publicKey).toBe(second.publicKey);
    expect(second.verify(first.sign(payload), { 'stable-key': second.publicKey }).valid).toBe(true);
  });
});

describe('common-generation artifact producer and validator', () => {
  it('captures one fenced cut and hashes D1 bytes plus every R2 object', async () => {
    const { manifest, artifacts } = await captureFixture();
    expect(manifest.d1.export.byteLength).toBe(3);
    expect(manifest.d1.export.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.r2.inventory.objectCount).toBe(1);
    expect(manifest.r2.inventory.objects[0].contentSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => validateCapturedArtifacts(manifest, artifacts)).not.toThrow();
  });

  it.each([
    ['one-byte D1 export change', (artifacts: CapturedArtifactsForValidation) => {
      artifacts.d1.bytes = Uint8Array.from([1, 2, 4]);
    }, /D1 export/],
    ['D1 schema change', (artifacts: CapturedArtifactsForValidation) => {
      artifacts.d1.schema = { ...artifacts.d1.schema, version: 2 };
    }, /D1 schema/],
    ['D1 migration change', (artifacts: CapturedArtifactsForValidation) => {
      artifacts.d1.orderedMigrations = [{ ...artifacts.d1.orderedMigrations[0], checksum: digest('9') }];
    }, /D1 ordered migration/],
    ['R2 missing object', (artifacts: CapturedArtifactsForValidation) => {
      artifacts.r2.objects = [];
    }, /R2 inventory/],
    ['R2 extra object', (artifacts: CapturedArtifactsForValidation) => {
      artifacts.r2.objects.push({
        key: `${payload.r2.prefix}extra`,
        bytes: Uint8Array.from([9]),
        embeddedGeneration: payload.generation,
        embeddedFenceId: payload.fence.id,
        embeddedFenceEpoch: payload.fence.epoch,
        embeddedCutId: payload.fence.cutId,
      });
    }, /R2 inventory/],
    ['R2 modified content', (artifacts: CapturedArtifactsForValidation) => {
      artifacts.r2.objects[0].bytes = Uint8Array.from([4, 9]);
    }, /R2 inventory/],
    ['R2 changed key', (artifacts: CapturedArtifactsForValidation) => {
      artifacts.r2.objects[0].key = `${payload.r2.prefix}changed`;
    }, /R2 inventory/],
    ['FLE key fingerprint change', (artifacts: CapturedArtifactsForValidation) => {
      artifacts.fle = { ...artifacts.fle, pinnedKeyFingerprint: digest('9') };
    }, /FLE/],
    ['watermark change', (artifacts: CapturedArtifactsForValidation) => {
      artifacts.watermarks = {
        ...artifacts.watermarks,
        outbox: { ...artifacts.watermarks.outbox, maxProcessed: 99 },
      };
    }, /watermark/],
  ])('rejects %s', async (_label, mutate, message) => {
    const { manifest, artifacts } = await captureFixture();
    const changed = clone(artifacts);
    mutate(changed);
    expect(() => validateCapturedArtifacts(manifest, changed)).toThrow(message);
  });

  it('rejects an artifact from another fence during capture', async () => {
    const { artifacts } = await captureFixture();
    artifacts.r2.objects[0].embeddedFenceEpoch = 2;
    await expect(captureCommonGeneration({
      manifestId: payload.manifestId,
      generation: payload.generation,
      scope: payload.scope,
      source: payload.source,
      fence: payload.fence,
      readers: {
        readFence: () => payload.fence,
        readD1: () => artifacts.d1,
        readR2: () => artifacts.r2,
        readFle: () => artifacts.fle,
        readWatermarks: () => artifacts.watermarks,
      },
    })).rejects.toThrow(/common generation fence/);
  });

  it('rejects a fence or active-job change that occurs while artifacts are read', async () => {
    const { artifacts } = await captureFixture();
    let read = 0;
    await expect(captureCommonGeneration({
      manifestId: payload.manifestId,
      generation: payload.generation,
      scope: payload.scope,
      source: payload.source,
      fence: payload.fence,
      readers: {
        readFence: () => read++ === 0 ? payload.fence : { ...payload.fence, epoch: payload.fence.epoch + 1 },
        readD1: () => artifacts.d1,
        readR2: () => artifacts.r2,
        readFle: () => artifacts.fle,
        readWatermarks: () => artifacts.watermarks,
      },
    } as never)).rejects.toThrow(/fence|active job/i);
  });
});

describe('isolated restore rehearsal', () => {
  it('fails closed when the restored D1 has no canonical outbox or webhook state to reconcile', async () => {
    const fixture = await syntheticRestoreFixture(Date.now(), false);

    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signedManifest,
      pinnedTrustStore: fixture.pinnedTrustStore,
      target: createNoSendIsolatedRestoreTarget(),
      artifacts: fixture.artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
    })).rejects.toThrow(/outbox|webhook|watermark/i);
  });

  it('rejects a restored pending set that differs from the signed watermark', async () => {
    const fixture = await syntheticRestoreFixture();
    const artifacts = clone(fixture.artifacts);
    artifacts.d1.bytes = new TextEncoder().encode(
      new TextDecoder().decode(artifacts.d1.bytes).replace("'outbox-3'", "'outbox-drift'"),
    );
    const manifest = await captureCommonGeneration({
      manifestId: 'manifest-watermark-drift',
      generation: fixture.manifest.generation,
      scope: fixture.manifest.scope,
      source: fixture.manifest.source,
      fence: fixture.fence,
      readers: {
        readFence: () => fixture.fence,
        readD1: () => artifacts.d1,
        readR2: () => artifacts.r2,
        readFle: () => artifacts.fle,
        readWatermarks: () => artifacts.watermarks,
      },
    });

    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signer.sign(manifest),
      pinnedTrustStore: fixture.pinnedTrustStore,
      target: createNoSendIsolatedRestoreTarget(),
      artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
    })).rejects.toThrow(/outbox|watermark/i);
  });

  it('restores real SQL and R2 bytes into an opaque no-send memory target and reads every critical path back', async () => {
    const fixture = await syntheticRestoreFixture();
    const target = createNoSendIsolatedRestoreTarget();
    const report = await runIsolatedRestoreRehearsal({
      signedManifest: fixture.signedManifest,
      pinnedTrustStore: fixture.pinnedTrustStore,
      target,
      artifacts: fixture.artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
    });

    expect(report).toMatchObject({
      manifestHash: expect.stringMatching(/^sha256:/),
      readbackResult: 'passed',
      outboundAttemptCount: 0,
      productionBindingCount: 0,
      quarantinedOutboxCount: 2,
      quarantinedWebhookCount: 1,
      retainedGenerationCount: 3,
      independentBackupLocationCount: 2,
    });
    expect(report.rpoHours).toBeGreaterThanOrEqual(0);
    expect(report.rpoHours).toBeLessThanOrEqual(24);
    expect(report.rtoHours).toBeLessThanOrEqual(4);
    expect(Object.keys(target).sort()).toEqual(['bindingFingerprint', 'environmentId', 'production']);
  });

  it('rejects caller-created targets and hidden adapters before any callback can run', async () => {
    const fixture = await syntheticRestoreFixture();
    let sent = false;
    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signedManifest,
      pinnedTrustStore: fixture.pinnedTrustStore,
      target: { environmentId: 'isolated', bindingFingerprint: 'fake', production: false },
      artifacts: fixture.artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
      d1: { importGeneration: () => { sent = true; } },
    } as never)).rejects.toThrow(/no-send|unknown field|factory/i);
    expect(sent).toBe(false);
  });

  it('decrypts every FLE envelope and fails closed with a wrong key', async () => {
    const fixture = await syntheticRestoreFixture();
    const target = createNoSendIsolatedRestoreTarget();
    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signedManifest,
      pinnedTrustStore: fixture.pinnedTrustStore,
      target,
      artifacts: fixture.artifacts,
      fleRootSecret: `wrong-${'z'.repeat(32)}`,
      retainedGenerations: fixture.retainedGenerations,
    })).rejects.toThrow(/FLE|envelope|readback/i);
    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signedManifest,
      pinnedTrustStore: fixture.pinnedTrustStore,
      target,
      artifacts: fixture.artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
    })).rejects.toThrow(/fresh target/i);
  });

  it('rejects a signed FLE fingerprint that does not identify the supplied root secret', async () => {
    const fixture = await syntheticRestoreFixture();
    const manifest = clone(fixture.manifest);
    const artifacts = clone(fixture.artifacts);
    manifest.fle.pinnedKeyFingerprint = digest('9');
    artifacts.fle.pinnedKeyFingerprint = digest('9');

    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signer.sign(manifest),
      pinnedTrustStore: fixture.pinnedTrustStore,
      target: createNoSendIsolatedRestoreTarget(),
      artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
    })).rejects.toThrow(/fingerprint|FLE/i);
  });

  it('rejects a signed inventory that omits envelopes for restored intake rows', async () => {
    const fixture = await syntheticRestoreFixture();
    const artifacts = clone(fixture.artifacts);
    const sql = `${new TextDecoder().decode(artifacts.d1.bytes)}\nDELETE FROM pharmacy_patient_intake_envelopes;`;
    artifacts.d1.bytes = new TextEncoder().encode(sql);
    artifacts.d1.schema.fingerprint = schemaFingerprint(sql);
    artifacts.d1.logicalInventory.tableCounts.pharmacy_patient_intake_envelopes = 0;
    artifacts.d1.logicalInventory.rootSha256 = sha256CommonGeneration(
      canonicalizeCommonGeneration(artifacts.d1.logicalInventory.tableCounts),
    );
    artifacts.fle.fieldInventory = artifacts.fle.fieldInventory.map((field) => ({
      ...field, referenceCount: 0,
    }));
    artifacts.fle.referenceCounts = Object.fromEntries(
      Object.keys(artifacts.fle.referenceCounts).map((field) => [field, 0]),
    );
    const manifest = await captureCommonGeneration({
      manifestId: 'manifest-missing-fle-coverage',
      generation: fixture.manifest.generation,
      scope: fixture.manifest.scope,
      source: fixture.manifest.source,
      fence: fixture.fence,
      readers: {
        readFence: () => fixture.fence,
        readD1: () => artifacts.d1,
        readR2: () => artifacts.r2,
        readFle: () => artifacts.fle,
        readWatermarks: () => artifacts.watermarks,
      },
    });

    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signer.sign(manifest),
      pinnedTrustStore: fixture.pinnedTrustStore,
      target: createNoSendIsolatedRestoreTarget(),
      artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
    })).rejects.toThrow(/FLE.*coverage|coverage.*FLE/i);
  });

  it('rejects a signed schema fingerprint that does not match restored D1', async () => {
    const fixture = await syntheticRestoreFixture();
    const artifacts = clone(fixture.artifacts);
    artifacts.d1.schema.fingerprint = digest('9');
    const manifest = await captureCommonGeneration({
      manifestId: 'manifest-schema-mismatch',
      generation: fixture.manifest.generation,
      scope: fixture.manifest.scope,
      source: fixture.manifest.source,
      fence: fixture.fence,
      readers: {
        readFence: () => fixture.fence,
        readD1: () => artifacts.d1,
        readR2: () => artifacts.r2,
        readFle: () => artifacts.fle,
        readWatermarks: () => artifacts.watermarks,
      },
    });

    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signer.sign(manifest),
      pinnedTrustStore: fixture.pinnedTrustStore,
      target: createNoSendIsolatedRestoreTarget(),
      artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
    })).rejects.toThrow(/schema fingerprint/i);
  });

  it('derives RPO from signed completion time instead of accepting a caller number', async () => {
    const now = Date.now();
    const fixture = await syntheticRestoreFixture(now);
    const stale = clone(fixture.manifest);
    stale.fence.startedAt = new Date(now - 26 * 3_600_000).toISOString();
    stale.fence.completedAt = new Date(now - 25 * 3_600_000).toISOString();
    const signedManifest = fixture.signer.sign(stale);
    await expect(runIsolatedRestoreRehearsal({
      signedManifest,
      pinnedTrustStore: fixture.pinnedTrustStore,
      target: createNoSendIsolatedRestoreTarget(),
      artifacts: fixture.artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations.map((item) =>
        item.generation === stale.generation ? { ...item, completedAt: stale.fence.completedAt } : item),
    })).rejects.toThrow(/RPO/);
  });

  it('derives RTO from the actual clock and rejects a rehearsal exceeding four hours', async () => {
    const now = Date.now();
    const fixture = await syntheticRestoreFixture(now);
    const clock = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now + 5 * 3_600_000);
    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signedManifest,
      pinnedTrustStore: fixture.pinnedTrustStore,
      target: createNoSendIsolatedRestoreTarget(),
      artifacts: fixture.artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
    })).rejects.toThrow(/RTO/);
    clock.mockRestore();
  });

  it('requires three generations across physically independent failure domains', async () => {
    const fixture = await syntheticRestoreFixture();
    const sameFailureDomain = fixture.retainedGenerations.map((item, index) => ({
      ...item,
      location: {
        provider: 'cloudflare-r2',
        accountId: 'same-account',
        container: `alias-${index}`,
        failureDomain: 'same-account',
      },
    }));

    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signedManifest,
      pinnedTrustStore: fixture.pinnedTrustStore,
      target: createNoSendIsolatedRestoreTarget(),
      artifacts: fixture.artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: sameFailureDomain,
    })).rejects.toThrow(/independent backup|failure domain/i);
  });

  it('clears a partial import and requires a fresh target after failure', async () => {
    const fixture = await syntheticRestoreFixture();
    const brokenArtifacts = clone(fixture.artifacts);
    brokenArtifacts.d1.bytes = new TextEncoder().encode(
      `${new TextDecoder().decode(brokenArtifacts.d1.bytes)}\nTHIS IS NOT SQL;`,
    );
    const brokenManifest = await captureCommonGeneration({
      manifestId: 'manifest-broken',
      generation: fixture.manifest.generation,
      scope: fixture.manifest.scope,
      source: fixture.manifest.source,
      fence: fixture.fence,
      readers: {
        readFence: () => fixture.fence,
        readD1: () => brokenArtifacts.d1,
        readR2: () => brokenArtifacts.r2,
        readFle: () => brokenArtifacts.fle,
        readWatermarks: () => brokenArtifacts.watermarks,
      },
    });
    const target = createNoSendIsolatedRestoreTarget();
    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signer.sign(brokenManifest),
      pinnedTrustStore: fixture.pinnedTrustStore,
      target,
      artifacts: brokenArtifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
    })).rejects.toThrow(/D1|SQL|syntax/i);
    await expect(runIsolatedRestoreRehearsal({
      signedManifest: fixture.signedManifest,
      pinnedTrustStore: fixture.pinnedTrustStore,
      target,
      artifacts: fixture.artifacts,
      fleRootSecret: SYNTHETIC_FLE_SECRET,
      retainedGenerations: fixture.retainedGenerations,
    })).rejects.toThrow(/fresh target/i);
  });
});
