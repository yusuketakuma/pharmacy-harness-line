import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Manifest, ReleaseEntry } from '../../packages/update-engine/src/types.js';
import {
  assertCredentialFreeUrl,
  configureCustomerCheckout,
} from './configure.js';

describe('configureCustomerCheckout', () => {
  it('turns an exact seller tag clone into an idempotent customer checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'customer-onboarding-'));
    const seller = join(root, 'seller');
    const customerRemote = join(root, 'customer.git');
    const checkout = join(root, 'checkout');
    git(root, 'init', seller);
    configure(seller);
    writeFileSync(join(seller, 'app.txt'), 'program\n');
    git(seller, 'add', 'app.txt');
    git(seller, 'commit', '-m', 'seller release');
    const commit = git(seller, 'rev-parse', 'HEAD');
    git(seller, 'tag', '-a', 'pharmacy-v0.22.0', '-m', 'release');
    git(root, 'init', '--bare', customerRemote);
    git(root, 'clone', '--branch', 'pharmacy-v0.22.0', seller, checkout);
    configure(checkout);

    const result = configureCustomerCheckout({
      checkoutDir: checkout,
      sellerRepository: 'seller/pharmacy',
      sellerUrl: seller,
      customerUrl: customerRemote,
      manifest: manifest(commit),
      reviewer: 'customer-reviewer',
      push: true,
    });

    expect(result).toMatchObject({ kind: 'configured', branch: 'main' });
    expect(git(checkout, 'remote', 'get-url', 'vendor')).toBe(seller);
    expect(git(checkout, 'remote', 'get-url', '--push', 'vendor')).toBe('DISABLED');
    expect(git(checkout, 'remote', 'get-url', 'origin')).toBe(customerRemote);
    expect(git(checkout, 'merge-base', '--is-ancestor', commit, 'HEAD')).toBe('');
    expect(git(checkout, 'show', 'HEAD:.github/CODEOWNERS')).toBe('* @customer-reviewer');
    expect(git(customerRemote, 'rev-parse', 'refs/heads/main')).toBe(git(checkout, 'rev-parse', 'HEAD'));

    const head = git(checkout, 'rev-parse', 'HEAD');
    expect(configureCustomerCheckout({
      checkoutDir: checkout,
      sellerRepository: 'seller/pharmacy',
      sellerUrl: seller,
      customerUrl: customerRemote,
      manifest: manifest(commit),
      reviewer: 'customer-reviewer',
      push: true,
    })).toEqual({ kind: 'noop', branch: 'main', release: 'pharmacy-v0.22.0' });
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses dirty work and unrelated remotes', () => {
    const root = mkdtempSync(join(tmpdir(), 'customer-onboarding-refuse-'));
    const seller = join(root, 'seller');
    const checkout = join(root, 'checkout');
    git(root, 'init', seller);
    configure(seller);
    writeFileSync(join(seller, 'app.txt'), 'program\n');
    git(seller, 'add', 'app.txt');
    git(seller, 'commit', '-m', 'seller release');
    const commit = git(seller, 'rev-parse', 'HEAD');
    git(seller, 'tag', '-a', 'pharmacy-v0.22.0', '-m', 'release');
    git(root, 'clone', '--branch', 'pharmacy-v0.22.0', seller, checkout);
    writeFileSync(join(checkout, 'dirty.txt'), 'do not overwrite\n');

    expect(() => configureCustomerCheckout({
      checkoutDir: checkout,
      sellerRepository: 'seller/pharmacy',
      sellerUrl: seller,
      customerUrl: join(root, 'customer.git'),
      manifest: manifest(commit),
      reviewer: 'customer-reviewer',
      push: false,
    })).toThrow(/clean/i);

    const unrelated = join(root, 'unrelated');
    git(root, 'clone', '--branch', 'pharmacy-v0.22.0', seller, unrelated);
    git(unrelated, 'remote', 'set-url', 'origin', join(root, 'another-seller.git'));
    expect(() => configureCustomerCheckout({
      checkoutDir: unrelated,
      sellerRepository: 'seller/pharmacy',
      sellerUrl: seller,
      customerUrl: join(root, 'customer.git'),
      manifest: manifest(commit),
      reviewer: 'customer-reviewer',
      push: false,
    })).toThrow(/unrelated/i);
  });

  it('never accepts credentials embedded in persisted remote URLs', () => {
    expect(() => assertCredentialFreeUrl('https://user:token@github.com/seller/pharmacy.git'))
      .toThrow(/credential/i);
    expect(() => assertCredentialFreeUrl('https://github.com/seller/pharmacy.git')).not.toThrow();
    expect(() => assertCredentialFreeUrl('git@github.com:seller/pharmacy.git')).not.toThrow();
  });
});

function manifest(commit: string): Manifest {
  const entry: ReleaseEntry = {
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
      release_sequence: 1,
      repository: 'seller/pharmacy',
      commit,
      previous_commit: '0'.repeat(40),
      tag: 'pharmacy-v0.22.0',
      update_class: 'manual',
      manual_reasons: ['initial customer delivery'],
      required_configuration: [],
      privileged_paths: [],
      new_migrations: [],
      migration_digests: {},
      minimum_client_version: '0.21.3',
      rollback_compatible_from: '0.21.3',
      revoked: false,
    },
  };
  return { schema_version: 1, latest: entry.version, releases: [entry] };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function configure(cwd: string): void {
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.test');
}
