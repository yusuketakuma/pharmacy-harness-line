import { describe, expect, it } from 'vitest';
import type { ReleaseEntry } from '../../packages/update-engine/src/types.js';
import { classifyVendorUpdate } from './policy.js';
import type { VendorState } from './prepare.js';

const sha = (digit: string): string => digit.repeat(40);

function release(input: {
  version: string;
  sequence: number;
  commit: string;
  previous: string;
  updateClass?: 'compatible' | 'manual';
  privilegedPaths?: string[];
  manualReasons?: string[];
  newMigrations?: string[];
  requiredConfiguration?: string[];
  newRequiredSecrets?: string[];
}): ReleaseEntry {
  const tag = `pharmacy-v${input.version}`;
  return {
    version: input.version,
    released_at: '2026-08-17T00:00:00Z',
    worker_hash: 'worker',
    admin_hash: 'admin',
    liff_hash: 'liff',
    bundle_url: 'https://example.test/bundle.tar.gz',
    bundle_size_bytes: 1,
    required_secrets: input.newRequiredSecrets ?? [],
    new_required_secrets: input.newRequiredSecrets ?? [],
    migrations: input.newMigrations ?? [],
    changelog_url: 'https://example.test/release',
    min_from_version: '0.21.3',
    customer_source_update: {
      release_id: `seller/pharmacy@${tag}`,
      release_sequence: input.sequence,
      repository: 'seller/pharmacy',
      commit: input.commit,
      previous_commit: input.previous,
      tag,
      update_class: input.updateClass ?? 'compatible',
      manual_reasons: input.manualReasons ?? [],
      required_configuration: input.requiredConfiguration ?? [],
      privileged_paths: input.privilegedPaths ?? [],
      new_migrations: input.newMigrations ?? [],
      migration_digests: Object.fromEntries(
        (input.newMigrations ?? []).map((name) => [name, `sha256:${'a'.repeat(64)}`]),
      ),
      minimum_client_version: '0.21.3',
      rollback_compatible_from: '0.21.3',
      revoked: false,
    },
  };
}

function state(entry: ReleaseEntry): VendorState {
  const source = entry.customer_source_update!;
  return {
    schema_version: 1,
    repository: source.repository,
    release_id: source.release_id,
    release_sequence: source.release_sequence,
    commit: source.commit,
    version: entry.version,
    release: entry,
  };
}

const baseRelease = release({
  version: '0.21.3',
  sequence: 1,
  commit: sha('1'),
  previous: sha('0'),
});

describe('classifyVendorUpdate', () => {
  it('allows only a recomputed non-privileged compatible update', () => {
    const target = release({
      version: '0.22.0',
      sequence: 2,
      commit: sha('2'),
      previous: sha('1'),
    });
    expect(classifyVendorUpdate({
      base: state(baseRelease),
      target: state(target),
      changedPaths: [
        'apps/web/src/custom/pharmacy/prescriptions/Queue.tsx',
        'customer-release.json',
      ],
      candidateChangedPaths: [
        '.line-harness-vendor.json',
        'apps/web/src/custom/pharmacy/prescriptions/Queue.tsx',
        'customer-release.json',
      ],
      isAncestor: () => true,
    })).toEqual({ classification: 'compatible' });
  });

  it('rejects forged compatible metadata when a privileged path changed', () => {
    const target = release({
      version: '0.22.0',
      sequence: 2,
      commit: sha('2'),
      previous: sha('1'),
    });
    expect(() => classifyVendorUpdate({
      base: state(baseRelease),
      target: state(target),
      changedPaths: ['packages/db/migrations/070_custom.sql'],
      candidateChangedPaths: [
        '.line-harness-vendor.json',
        'packages/db/migrations/070_custom.sql',
      ],
      isAncestor: () => true,
    })).toThrow(/privileged/i);
  });

  it('keeps migrations, auth, dependencies, workflows, config, and egress manual', () => {
    const paths = [
      '.github/workflows/deploy.yml',
      'package.json',
      'packages/db/migrations/070_custom.sql',
      'apps/worker/src/middleware/auth.ts',
      'apps/worker/wrangler.toml',
      'apps/worker/src/services/outbound-http.ts',
    ];
    const target = release({
      version: '0.22.0',
      sequence: 2,
      commit: sha('2'),
      previous: sha('1'),
      updateClass: 'manual',
      privilegedPaths: paths,
      manualReasons: ['privileged update'],
      newMigrations: ['070_custom.sql'],
    });
    expect(classifyVendorUpdate({
      base: state(baseRelease),
      target: state(target),
      changedPaths: paths,
      candidateChangedPaths: ['.line-harness-vendor.json', ...paths],
      isAncestor: () => true,
    })).toEqual({ classification: 'manual' });
  });

  it('rejects a target whose seller ancestry is not preserved', () => {
    const target = release({
      version: '0.22.0',
      sequence: 2,
      commit: sha('2'),
      previous: sha('1'),
    });
    expect(() => classifyVendorUpdate({
      base: state(baseRelease),
      target: state(target),
      changedPaths: [],
      candidateChangedPaths: ['.line-harness-vendor.json'],
      isAncestor: () => false,
    })).toThrow(/ancestor/i);
  });

  it('rejects files injected outside the exact seller update', () => {
    const target = release({
      version: '0.22.0',
      sequence: 2,
      commit: sha('2'),
      previous: sha('1'),
    });
    expect(() => classifyVendorUpdate({
      base: state(baseRelease),
      target: state(target),
      changedPaths: ['apps/web/src/custom/pharmacy/prescriptions/Queue.tsx'],
      candidateChangedPaths: [
        '.line-harness-vendor.json',
        'apps/web/src/custom/pharmacy/prescriptions/Queue.tsx',
        'apps/worker/src/backdoor.ts',
      ],
      isAncestor: () => true,
    })).toThrow(/outside/i);
  });
});
