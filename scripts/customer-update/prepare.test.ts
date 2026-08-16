import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Manifest, ReleaseEntry } from '../../packages/update-engine/src/types.js';
import {
  planCustomerUpdate,
  prepareCustomerUpdate,
  type VendorState,
} from './prepare.js';

const sha = (digit: string): string => digit.repeat(40);

function release(overrides: Partial<ReleaseEntry['customer_source_update']> = {}): ReleaseEntry {
  return {
    version: '0.22.0',
    released_at: '2026-08-17T00:00:00Z',
    worker_hash: 'worker',
    admin_hash: 'admin',
    liff_hash: 'liff',
    bundle_url: 'https://example.test/bundle.tar.gz',
    bundle_size_bytes: 1,
    required_secrets: [],
    new_required_secrets: [],
    migrations: [],
    changelog_url: 'https://example.test/release',
    min_from_version: '0.21.3',
    customer_source_update: {
      release_id: 'seller/pharmacy@pharmacy-v0.22.0',
      release_sequence: 2,
      repository: 'seller/pharmacy',
      commit: sha('2'),
      previous_commit: sha('1'),
      tag: 'pharmacy-v0.22.0',
      update_class: 'compatible',
      manual_reasons: [],
      required_configuration: [],
      privileged_paths: [],
      new_migrations: [],
      migration_digests: {},
      minimum_client_version: '0.21.3',
      rollback_compatible_from: '0.21.3',
      revoked: false,
      ...overrides,
    },
  };
}

function state(overrides: Partial<VendorState> = {}): VendorState {
  const value = {
    schema_version: 1,
    repository: 'seller/pharmacy',
    release_id: 'seller/pharmacy@pharmacy-v0.21.3',
    release_sequence: 1,
    commit: sha('1'),
    version: '0.21.3',
    ...overrides,
  };
  return {
    ...value,
    release: overrides.release ?? {
      ...release({
        release_id: value.release_id,
        release_sequence: value.release_sequence,
        repository: value.repository,
        commit: value.commit,
        previous_commit: sha('0'),
        tag: `pharmacy-v${value.version}`,
      }),
      version: value.version,
    },
  };
}

function manifest(entry: ReleaseEntry, revokedReleaseIds: string[] = []): Manifest {
  return {
    schema_version: 1,
    latest: entry.version,
    releases: [entry],
    revoked_release_ids: revokedReleaseIds,
  };
}

describe('planCustomerUpdate', () => {
  it('accepts the next exact seller release', () => {
    expect(planCustomerUpdate({
      manifest: manifest(release()),
      current: state(),
      expectedRepository: 'seller/pharmacy',
      isAncestor: () => true,
    })).toMatchObject({ kind: 'update', branch: 'vendor/update-pharmacy-v0.22.0' });
  });

  it.each([
    [
      'wrong seller',
      release({
        repository: 'attacker/pharmacy',
        release_id: 'attacker/pharmacy@pharmacy-v0.22.0',
      }),
      state(),
      [],
      /seller/i,
    ],
    ['rewritten predecessor', release({ previous_commit: sha('9') }), state(), [], /previous/i],
    ['replayed sequence', release({ release_sequence: 1 }), state(), [], /sequence/i],
    ['downgrade', release({ release_sequence: 0 }), state(), [], /sequence/i],
    [
      'release revoked in entry',
      release({ revoked: true, update_class: 'manual', manual_reasons: ['revoked'] }),
      state(),
      [],
      /revoked/i,
    ],
    [
      'release revoked after publication',
      release(),
      state(),
      ['seller/pharmacy@pharmacy-v0.22.0'],
      /revoked/i,
    ],
  ])('rejects %s', (_name, entry, current, revoked, error) => {
    expect(() => planCustomerUpdate({
      manifest: manifest(entry as ReleaseEntry, revoked as string[]),
      current: current as VendorState,
      expectedRepository: 'seller/pharmacy',
      isAncestor: () => true,
    })).toThrow(error as RegExp);
  });

  it('rejects seller history rewrites', () => {
    expect(() => planCustomerUpdate({
      manifest: manifest(release()),
      current: state(),
      expectedRepository: 'seller/pharmacy',
      isAncestor: () => false,
    })).toThrow(/ancestor/i);
  });

  it('rejects a malformed revocation list at the manifest boundary', () => {
    expect(() => planCustomerUpdate({
      manifest: { ...manifest(release()), revoked_release_ids: 'not-an-array' } as unknown as Manifest,
      current: state(),
      expectedRepository: 'seller/pharmacy',
      isAncestor: () => true,
    })).toThrow(/revoked_release_ids/i);
  });

  it('returns a clean no-op for the already accepted release', () => {
    const entry = release();
    const source = entry.customer_source_update!;
    expect(planCustomerUpdate({
      manifest: manifest(entry),
      current: state({
        release_id: source.release_id,
        release_sequence: source.release_sequence,
        commit: source.commit,
        version: entry.version,
      }),
      expectedRepository: 'seller/pharmacy',
      isAncestor: () => true,
    })).toEqual({ kind: 'noop', reason: 'already-current' });
  });
});

describe('prepareCustomerUpdate', () => {
  it('creates a merge candidate containing both customer main and the exact seller commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'customer-update-'));
    const seller = join(root, 'seller');
    const customer = join(root, 'customer');
    git(root, 'init', seller);
    configure(seller);
    writeFileSync(join(seller, 'app.txt'), 'v1\n');
    git(seller, 'add', 'app.txt');
    git(seller, 'commit', '-m', 'seller v1');
    const previous = git(seller, 'rev-parse', 'HEAD');
    writeFileSync(join(seller, 'app.txt'), 'v2\n');
    git(seller, 'commit', '-am', 'seller v2');
    const target = git(seller, 'rev-parse', 'HEAD');
    git(seller, 'tag', '-a', 'pharmacy-v0.22.0', '-m', 'release');

    git(root, 'clone', seller, customer);
    configure(customer);
    git(customer, 'switch', '-c', 'customer-main', previous);
    writeFileSync(join(customer, 'customer.txt'), 'local\n');
    git(customer, 'add', 'customer.txt');
    git(customer, 'commit', '-m', 'customer change');
    const base = git(customer, 'rev-parse', 'HEAD');
    const current = state({ commit: previous });
    writeFileSync(join(customer, '.line-harness-vendor.json'), `${JSON.stringify(current)}\n`);
    git(customer, 'add', '.line-harness-vendor.json');
    git(customer, 'commit', '--amend', '--no-edit');
    const actualBase = git(customer, 'rev-parse', 'HEAD');

    const entry = release({ commit: target, previous_commit: previous });
    const result = prepareCustomerUpdate({
      customerDir: customer,
      sellerDir: seller,
      manifest: manifest(entry),
      expectedRepository: 'seller/pharmacy',
      baseBranch: 'customer-main',
    });

    expect(result.kind).toBe('update');
    expect(git(customer, 'merge-base', '--is-ancestor', actualBase, 'HEAD')).toBe('');
    expect(git(customer, 'merge-base', '--is-ancestor', target, 'HEAD')).toBe('');
    expect(git(customer, 'rev-list', '--min-parents=2', '--count', `${actualBase}..HEAD`)).toBe('1');
    expect(JSON.parse(readFileSync(join(customer, '.line-harness-vendor.json'), 'utf8')))
      .toMatchObject({ commit: target, release_sequence: 2 });
    expect(base).not.toBe('');

    git(customer, 'switch', 'customer-main');
    expect(prepareCustomerUpdate({
      customerDir: customer,
      sellerDir: seller,
      manifest: manifest(entry),
      expectedRepository: 'seller/pharmacy',
      baseBranch: 'customer-main',
    })).toEqual({ kind: 'reuse', branch: 'vendor/update-pharmacy-v0.22.0' });

    writeFileSync(join(customer, 'customer-later.txt'), 'later\n');
    git(customer, 'add', 'customer-later.txt');
    git(customer, 'commit', '-m', 'customer main advanced');
    const advancedBase = git(customer, 'rev-parse', 'HEAD');
    expect(prepareCustomerUpdate({
      customerDir: customer,
      sellerDir: seller,
      manifest: manifest(entry),
      expectedRepository: 'seller/pharmacy',
      baseBranch: 'customer-main',
    })).toEqual({ kind: 'update', branch: 'vendor/update-pharmacy-v0.22.0' });
    expect(git(customer, 'merge-base', '--is-ancestor', advancedBase, 'HEAD')).toBe('');
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function configure(cwd: string): void {
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.test');
}
