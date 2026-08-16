import { describe, expect, it } from 'vitest';
import { buildReleaseEvidence } from './record-release-evidence.js';

const state = (workerVersionId: string, adminDeploymentId: string) => ({
  workerVersionId,
  adminDeploymentId,
});

describe('buildReleaseEvidence', () => {
  it('allows code rollback only for a compatible release without schema changes', () => {
    const evidence = buildReleaseEvidence({
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
  });

  it.each([
    ['manual release', 'manual', []],
    ['schema change', 'compatible', ['070_demo.sql']],
  ] as const)('blocks rollback for %s', (_label, updateClass, appliedNames) => {
    const evidence = buildReleaseEvidence({
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
});
