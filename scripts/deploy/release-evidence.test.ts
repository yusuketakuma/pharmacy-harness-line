import { describe, expect, it } from 'vitest';
import { buildReleaseEvidence, fingerprintD1Schema } from './record-release-evidence.js';

const digest = (char: string) => `sha256:${char.repeat(64)}`;

const manifestIdentity = {
  packageVersion: '0.31.0',
  sellerTag: 'pharmacy-v0.31.0',
  environment: 'beta' as const,
  stage: 'stage-0',
  schemaFingerprint: digest('d'),
  artifactHashes: {
    worker: digest('1'),
    workerAssets: digest('2'),
    admin: digest('3'),
    liff: digest('4'),
  },
};

const state = (workerVersionId: string, adminDeploymentId: string) => ({
  workerVersionId,
  adminDeploymentId,
});

describe('buildReleaseEvidence', () => {
  it('allows code rollback only for a compatible release without schema changes', () => {
    const evidence = buildReleaseEvidence({
      ...manifestIdentity,
      sourceSha: 'a'.repeat(40),
      vendorSha: 'b'.repeat(40),
      updateClass: 'compatible',
      before: { ...state('worker-old', 'admin-old'), d1Bookmark: 'bookmark-old' },
      after: state('worker-new', 'admin-new'),
      migrations: [],
      appliedNames: [],
    });

    expect(evidence.rollbackEligible).toBe(true);
    expect(evidence.smokeResults).toEqual({ worker: 'passed', admin: 'passed' });
    expect(evidence).toMatchObject({ schemaVersion: 1, ...manifestIdentity });
  });

  it.each([
    ['manual release', 'manual', []],
    ['schema change', 'compatible', ['070_demo.sql']],
  ] as const)('blocks rollback for %s', (_label, updateClass, appliedNames) => {
    const evidence = buildReleaseEvidence({
      ...manifestIdentity,
      sourceSha: 'a'.repeat(40),
      vendorSha: 'b'.repeat(40),
      updateClass,
      before: { ...state('worker-old', 'admin-old'), d1Bookmark: 'bookmark-old' },
      after: state('worker-new', 'admin-new'),
      migrations: [{ name: '070_demo.sql', checksum: 'sha256:' + 'c'.repeat(64) }],
      appliedNames: [...appliedNames],
    });

    expect(evidence.rollbackEligible).toBe(false);
  });

  it('rejects an untrusted source identity', () => {
    expect(() =>
      buildReleaseEvidence({
        ...manifestIdentity,
        sourceSha: 'main',
        vendorSha: 'b'.repeat(40),
        updateClass: 'manual',
        before: { ...state('worker-old', 'admin-old'), d1Bookmark: 'bookmark-old' },
        after: state('worker-new', 'admin-new'),
        migrations: [],
        appliedNames: [],
      }),
    ).toThrow(/source SHA/);
  });

  it('fingerprints the actual D1 schema independently of API row order', () => {
    const rows = [
      { type: 'table', name: 'b', tableName: 'b', sql: 'CREATE TABLE b (id TEXT)' },
      { type: 'index', name: 'a_idx', tableName: 'a', sql: 'CREATE INDEX a_idx ON a(id)' },
      { type: 'table', name: 'a', tableName: 'a', sql: 'CREATE TABLE a (id TEXT)' },
    ];

    const fingerprint = fingerprintD1Schema(rows);

    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprintD1Schema([...rows].reverse())).toBe(fingerprint);
  });
});
