#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';
import { join } from 'node:path';
import { validateManifest } from '../../packages/update-engine/src/manifest.js';
import type { Manifest } from '../../packages/update-engine/src/types.js';
import { validateVendorState, type VendorState } from '../customer-update/prepare.js';

export function assertCredentialFreeUrl(value: string): void {
  if (!/^https?:\/\//i.test(value)) return;
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error('remote URLs persisted by onboarding cannot contain credentials');
  }
}

export function configureCustomerCheckout(input: {
  checkoutDir: string;
  sellerRepository: string;
  sellerUrl: string;
  customerUrl: string;
  manifest: Manifest;
  reviewer: string;
  push: boolean;
}): { kind: 'configured' | 'noop'; branch: 'main'; release: string } {
  assertCredentialFreeUrl(input.sellerUrl);
  assertCredentialFreeUrl(input.customerUrl);
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(input.reviewer)) {
    throw new Error('invalid GitHub CODEOWNERS reviewer');
  }
  validateManifest(input.manifest);
  const release = input.manifest.releases.find((item) => item.version === input.manifest.latest);
  const source = release?.customer_source_update;
  if (!release || !source) throw new Error('latest release has no customer source authority');
  if (source.repository !== input.sellerRepository) {
    throw new Error('release does not belong to the expected seller repository');
  }
  if (source.revoked || input.manifest.revoked_release_ids?.includes(source.release_id)) {
    throw new Error('cannot onboard a revoked release');
  }
  if (git(input.checkoutDir, 'cat-file', '-t', `refs/tags/${source.tag}`) !== 'tag') {
    throw new Error('customer onboarding requires an annotated seller release tag');
  }
  if (git(input.checkoutDir, 'rev-parse', `refs/tags/${source.tag}^{commit}`) !== source.commit) {
    throw new Error('seller release tag does not resolve to the declared commit');
  }
  if (git(input.checkoutDir, 'status', '--porcelain')) {
    throw new Error('customer onboarding requires a clean checkout');
  }

  const statePath = join(input.checkoutDir, '.line-harness-vendor.json');
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as VendorState;
    validateVendorState(state);
    if (state.release_id !== source.release_id || state.commit !== source.commit) {
      throw new Error('existing customer vendor state belongs to another release');
    }
    if (readFileSync(join(input.checkoutDir, '.github/CODEOWNERS'), 'utf8').trim() !== `* @${input.reviewer}`) {
      throw new Error('existing CODEOWNERS reviewer does not match onboarding');
    }
    verifyRemotes(input);
    if (input.push) git(input.checkoutDir, 'push', 'origin', 'main');
    return { kind: 'noop', branch: 'main', release: source.tag };
  }

  if (git(input.checkoutDir, 'rev-parse', 'HEAD') !== source.commit) {
    throw new Error('checkout HEAD must equal the exact seller release commit');
  }
  configureRemotes(input);
  switchToMain(input.checkoutDir, source.commit);

  const state: VendorState = {
    schema_version: 1,
    repository: source.repository,
    release_id: source.release_id,
    release_sequence: source.release_sequence,
    commit: source.commit,
    version: release.version,
    release,
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  mkdirSync(join(input.checkoutDir, '.github'), { recursive: true });
  writeFileSync(join(input.checkoutDir, '.github/CODEOWNERS'), `* @${input.reviewer}\n`);
  git(input.checkoutDir, 'add', '.line-harness-vendor.json', '.github/CODEOWNERS');
  git(input.checkoutDir, 'commit', '-m', `chore: initialize customer from ${source.tag}`);
  if (input.push) git(input.checkoutDir, 'push', '-u', 'origin', 'main');
  return { kind: 'configured', branch: 'main', release: source.tag };
}

function configureRemotes(input: {
  checkoutDir: string;
  sellerRepository: string;
  sellerUrl: string;
  customerUrl: string;
}): void {
  const remotes = git(input.checkoutDir, 'remote').split(/\r?\n/).filter(Boolean);
  if (remotes.includes('vendor')) {
    if (!remoteMatches(git(input.checkoutDir, 'remote', 'get-url', 'vendor'), input.sellerUrl, input.sellerRepository)) {
      throw new Error('existing vendor remote is unrelated');
    }
  } else {
    if (!remotes.includes('origin')) throw new Error('seller clone must have an origin remote');
    const origin = git(input.checkoutDir, 'remote', 'get-url', 'origin');
    assertCredentialFreeUrl(origin);
    if (!remoteMatches(origin, input.sellerUrl, input.sellerRepository)) {
      throw new Error('existing origin remote is unrelated to the seller');
    }
    git(input.checkoutDir, 'remote', 'rename', 'origin', 'vendor');
  }
  git(input.checkoutDir, 'remote', 'set-url', '--push', 'vendor', 'DISABLED');
  const after = git(input.checkoutDir, 'remote').split(/\r?\n/).filter(Boolean);
  if (after.includes('origin')) {
    if (git(input.checkoutDir, 'remote', 'get-url', 'origin') !== input.customerUrl) {
      throw new Error('existing origin remote is unrelated to the customer');
    }
  } else {
    git(input.checkoutDir, 'remote', 'add', 'origin', input.customerUrl);
  }
}

function verifyRemotes(input: {
  checkoutDir: string;
  sellerRepository: string;
  sellerUrl: string;
  customerUrl: string;
}): void {
  if (
    !remoteMatches(
      git(input.checkoutDir, 'remote', 'get-url', 'vendor'),
      input.sellerUrl,
      input.sellerRepository,
    ) ||
    git(input.checkoutDir, 'remote', 'get-url', '--push', 'vendor') !== 'DISABLED' ||
    git(input.checkoutDir, 'remote', 'get-url', 'origin') !== input.customerUrl
  ) {
    throw new Error('customer remotes do not match the onboarding contract');
  }
}

function remoteMatches(actual: string, expected: string, repository: string): boolean {
  if (actual === expected) return true;
  const escaped = repository.replace('/', '\\/');
  return new RegExp(`^(?:https://github\\.com/${escaped}|git@github\\.com:${escaped})(?:\\.git)?$`)
    .test(actual);
}

function switchToMain(cwd: string, sourceCommit: string): void {
  if (refExists(cwd, 'refs/heads/main')) {
    if (git(cwd, 'rev-parse', 'refs/heads/main') !== sourceCommit) {
      throw new Error('existing main branch does not match the seller release');
    }
    git(cwd, 'switch', 'main');
  } else {
    git(cwd, 'switch', '-c', 'main');
  }
}

function refExists(cwd: string, ref: string): boolean {
  try {
    git(cwd, 'show-ref', '--verify', '--quiet', ref);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim();
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('configure requires --key value arguments');
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function required(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function main(): void {
  const args = parseArgs(argv.slice(2));
  const result = configureCustomerCheckout({
    checkoutDir: required(args, 'checkout-dir'),
    sellerRepository: required(args, 'seller-repository'),
    sellerUrl: required(args, 'seller-url'),
    customerUrl: required(args, 'customer-url'),
    manifest: JSON.parse(readFileSync(required(args, 'manifest'), 'utf8')) as Manifest,
    reviewer: required(args, 'reviewer'),
    push: args.push === 'true',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (argv[1]?.endsWith('configure.ts')) main();
