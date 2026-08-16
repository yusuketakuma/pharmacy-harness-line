import { describe, expect, it } from 'vitest';
import type { ReleaseEntry } from '../../packages/update-engine/src/types.js';
import {
  buildCustomerSourceUpdate,
  findPrivilegedPaths,
  validateCustomerReleasePolicy,
  type CustomerReleasePolicy,
} from './customer-source-update.js';

const release = (overrides: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  version: '0.22.0',
  released_at: '2026-08-17T00:00:00Z',
  worker_hash: 'sha256:worker',
  admin_hash: 'sha256:admin',
  liff_hash: 'sha256:liff',
  bundle_url: 'https://example.test/bundle.tar.gz',
  bundle_size_bytes: 1,
  required_secrets: [],
  new_required_secrets: [],
  migrations: [],
  changelog_url: 'https://example.test/changelog',
  min_from_version: '0.21.3',
  ...overrides,
});

const policy = (overrides: Partial<CustomerReleasePolicy> = {}): CustomerReleasePolicy => ({
  schema_version: 1,
  version: '0.22.0',
  release_sequence: 1,
  previous_commit: 'b'.repeat(40),
  update_class: 'compatible',
  manual_reasons: [],
  required_configuration: [],
  minimum_client_version: '0.21.3',
  rollback_compatible_from: '0.21.3',
  revoked: false,
  ...overrides,
});

describe('findPrivilegedPaths', () => {
  it('keeps ordinary pharmacy UI code eligible for compatible updates', () => {
    expect(findPrivilegedPaths([
      'apps/web/src/custom/pharmacy/prescriptions/Queue.tsx',
      'apps/liff/src/custom/pharmacy/prescriptions/Page.tsx',
    ])).toEqual([]);
  });

  it('detects workflow, migration, dependency, auth, binding, and release paths', () => {
    expect(findPrivilegedPaths([
      '.github/workflows/deploy.yml',
      'packages/db/migrations/070_custom.sql',
      'pnpm-lock.yaml',
      'apps/worker/src/middleware/auth.ts',
      'apps/worker/wrangler.toml',
      'scripts/release/update-manifest.ts',
    ])).toEqual([
      '.github/workflows/deploy.yml',
      'apps/worker/src/middleware/auth.ts',
      'apps/worker/wrangler.toml',
      'packages/db/migrations/070_custom.sql',
      'pnpm-lock.yaml',
      'scripts/release/update-manifest.ts',
    ]);
  });

  it('treats the customer release policy itself as privileged', () => {
    expect(findPrivilegedPaths(['customer-release.json'])).toEqual(['customer-release.json']);
  });
});

describe('validateCustomerReleasePolicy', () => {
  it.each([
    ['invalid version', { version: 'main' }, /version/i],
    ['invalid previous SHA', { previous_commit: 'main' }, /previous_commit/i],
    ['manual release without reason', { update_class: 'manual', manual_reasons: [] }, /reason/i],
  ])('rejects %s before an immutable tag is created', (_label, override, expected) => {
    expect(() => validateCustomerReleasePolicy(policy(override as Partial<CustomerReleasePolicy>)))
      .toThrow(expected);
  });
});

describe('buildCustomerSourceUpdate', () => {
  it('binds a compatible release to the exact seller repository, tag, and commit', () => {
    const result = buildCustomerSourceUpdate({
      release: release(),
      policy: policy(),
      repository: 'yusuketakuma/line-harness-pharmacy',
      commit: 'a'.repeat(40),
      tag: 'pharmacy-v0.22.0',
      changedPaths: ['apps/web/src/custom/pharmacy/prescriptions/Queue.tsx'],
      migrationDigests: {},
    });

    expect(result).toMatchObject({
      release_id: 'yusuketakuma/line-harness-pharmacy@pharmacy-v0.22.0',
      release_sequence: 1,
      repository: 'yusuketakuma/line-harness-pharmacy',
      commit: 'a'.repeat(40),
      previous_commit: 'b'.repeat(40),
      tag: 'pharmacy-v0.22.0',
      update_class: 'compatible',
      privileged_paths: [],
    });
  });

  it('rejects a compatible label when a privileged path changed', () => {
    expect(() => buildCustomerSourceUpdate({
      release: release(),
      policy: policy(),
      repository: 'yusuketakuma/line-harness-pharmacy',
      commit: 'a'.repeat(40),
      tag: 'pharmacy-v0.22.0',
      changedPaths: ['packages/db/schema.sql'],
      migrationDigests: {},
    })).toThrow(/compatible/i);
  });

  it('does not treat cumulative historical migrations as a new schema change', () => {
    const result = buildCustomerSourceUpdate({
      release: release({ migrations: ['069_existing.sql'] }),
      policy: policy(),
      repository: 'yusuketakuma/line-harness-pharmacy',
      commit: 'a'.repeat(40),
      tag: 'pharmacy-v0.22.0',
      changedPaths: ['apps/web/src/custom/pharmacy/prescriptions/Queue.tsx'],
      migrationDigests: {
        '069_existing.sql': `sha256:${'c'.repeat(64)}`,
      },
    });

    expect(result.new_migrations).toEqual([]);
    expect(result.update_class).toBe('compatible');
  });

  it('records newly changed migration files separately from cumulative migrations', () => {
    const result = buildCustomerSourceUpdate({
      release: release({ migrations: ['069_existing.sql', '070_custom.sql'] }),
      policy: policy({ update_class: 'manual', manual_reasons: ['database migration'] }),
      repository: 'yusuketakuma/line-harness-pharmacy',
      commit: 'a'.repeat(40),
      tag: 'pharmacy-v0.22.0',
      changedPaths: ['packages/db/migrations/070_custom.sql'],
      migrationDigests: {
        '069_existing.sql': `sha256:${'c'.repeat(64)}`,
        '070_custom.sql': `sha256:${'d'.repeat(64)}`,
      },
    });

    expect(result.new_migrations).toEqual(['070_custom.sql']);
  });

  it('requires migration digests to match the release migration list', () => {
    expect(() => buildCustomerSourceUpdate({
      release: release({ migrations: ['070_custom.sql'] }),
      policy: policy({ update_class: 'manual', manual_reasons: ['database migration'] }),
      repository: 'yusuketakuma/line-harness-pharmacy',
      commit: 'a'.repeat(40),
      tag: 'pharmacy-v0.22.0',
      changedPaths: ['packages/db/migrations/070_custom.sql'],
      migrationDigests: {},
    })).toThrow(/digest/i);
  });
});
