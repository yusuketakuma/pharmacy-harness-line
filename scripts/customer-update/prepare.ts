#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';
import {
  compareSemver,
  validateManifest,
  validateReleaseEntry,
} from '../../packages/update-engine/src/manifest.js';
import type { Manifest } from '../../packages/update-engine/src/types.js';

export interface VendorState {
  schema_version: 1;
  repository: string;
  release_id: string;
  release_sequence: number;
  commit: string;
  version: string;
}

export type CustomerUpdatePlan =
  | { kind: 'noop'; reason: 'already-current' }
  | { kind: 'update'; branch: string };

export function planCustomerUpdate(input: {
  manifest: Manifest;
  current: VendorState;
  expectedRepository: string;
  isAncestor: (previous: string, target: string) => boolean;
}): CustomerUpdatePlan {
  validateManifest(input.manifest);
  const release = input.manifest.releases.find((item) => item.version === input.manifest.latest);
  const source = release?.customer_source_update;
  if (!release || !source) throw new Error('latest release has no customer source authority');
  if (source.repository !== input.expectedRepository) {
    throw new Error('release does not belong to the expected seller repository');
  }
  if (source.revoked || input.manifest.revoked_release_ids?.includes(source.release_id)) {
    throw new Error('target release is revoked');
  }
  validateReleaseEntry(release);
  validateVendorState(input.current);
  if (input.current.repository !== input.expectedRepository) {
    throw new Error('current state does not belong to the expected seller repository');
  }
  if (
    input.current.release_id === source.release_id &&
    input.current.release_sequence === source.release_sequence &&
    input.current.commit === source.commit &&
    input.current.version === release.version
  ) {
    return { kind: 'noop', reason: 'already-current' };
  }
  if (source.release_sequence <= input.current.release_sequence) {
    throw new Error('target release sequence is a replay or downgrade');
  }
  if (source.previous_commit !== input.current.commit) {
    throw new Error('target previous_commit does not match the accepted release');
  }
  if (!input.isAncestor(input.current.commit, source.commit)) {
    throw new Error('accepted seller commit is not an ancestor of the target');
  }
  if (compareSemver(input.current.version, source.minimum_client_version) < 0) {
    throw new Error('customer version is below the target minimum client version');
  }
  return { kind: 'update', branch: `vendor/update-${source.tag}` };
}

export function prepareCustomerUpdate(input: {
  customerDir: string;
  sellerDir: string;
  manifest: Manifest;
  expectedRepository: string;
  baseBranch?: string;
}): CustomerUpdatePlan | { kind: 'reuse'; branch: string } {
  const baseBranch = input.baseBranch ?? 'main';
  git(input.customerDir, 'switch', baseBranch);
  if (git(input.customerDir, 'status', '--porcelain')) {
    throw new Error('customer checkout must be clean before preparing an update');
  }
  const baseCommit = git(input.customerDir, 'rev-parse', 'HEAD');
  const statePath = join(input.customerDir, '.line-harness-vendor.json');
  const current = JSON.parse(readFileSync(statePath, 'utf8')) as VendorState;
  const release = input.manifest.releases.find((item) => item.version === input.manifest.latest);
  const source = release?.customer_source_update;
  if (!release || !source) throw new Error('latest release has no customer source authority');

  const taggedCommit = git(input.sellerDir, 'rev-parse', `refs/tags/${source.tag}^{commit}`);
  if (taggedCommit !== source.commit) throw new Error('seller tag does not resolve to declared commit');
  const plan = planCustomerUpdate({
    manifest: input.manifest,
    current,
    expectedRepository: input.expectedRepository,
    isAncestor: (previous, target) => isAncestor(input.sellerDir, previous, target),
  });
  if (plan.kind === 'noop') return plan;

  if (!isAncestor(input.customerDir, current.commit, 'HEAD')) {
    throw new Error('accepted seller commit is not an ancestor of customer main');
  }
  const next: VendorState = {
    schema_version: 1,
    repository: source.repository,
    release_id: source.release_id,
    release_sequence: source.release_sequence,
    commit: source.commit,
    version: release.version,
  };
  if (refExists(input.customerDir, `refs/heads/${plan.branch}`)) {
    verifyTargetAndState(input.customerDir, plan.branch, source.commit, next);
    if (isAncestor(input.customerDir, baseCommit, plan.branch)) {
      return { kind: 'reuse', branch: plan.branch };
    }
    git(input.customerDir, 'switch', plan.branch);
    git(input.customerDir, 'merge', '--no-ff', '--no-edit', baseCommit);
    verifyCandidate(input.customerDir, 'HEAD', baseCommit, source.commit, next);
    return plan;
  }

  git(input.customerDir, 'fetch', '--no-tags', input.sellerDir, source.commit);
  git(input.customerDir, 'switch', '-c', plan.branch);
  git(input.customerDir, 'merge', '--no-ff', '--no-edit', source.commit);
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  git(input.customerDir, 'add', '.line-harness-vendor.json');
  git(input.customerDir, 'commit', '-m', `chore: accept ${source.tag}`);
  verifyCandidate(input.customerDir, 'HEAD', baseCommit, source.commit, next);
  return plan;
}

function validateVendorState(state: VendorState): void {
  if (
    state.schema_version !== 1 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(state.repository) ||
    !/^[0-9a-f]{40}$/.test(state.commit) ||
    !Number.isInteger(state.release_sequence) ||
    state.release_sequence < 1 ||
    !/^\d+\.\d+\.\d+$/.test(state.version) ||
    state.release_id.length === 0
  ) {
    throw new Error('invalid customer vendor state');
  }
}

function verifyCandidate(
  cwd: string,
  candidate: string,
  base: string,
  target: string,
  expected: VendorState,
): void {
  if (!isAncestor(cwd, base, candidate)) {
    throw new Error('customer main is not an ancestor of update candidate');
  }
  verifyTargetAndState(cwd, candidate, target, expected);
}

function verifyTargetAndState(
  cwd: string,
  candidate: string,
  target: string,
  expected: VendorState,
): void {
  if (!isAncestor(cwd, target, candidate)) {
    throw new Error('target seller commit is not an ancestor of update candidate');
  }
  const actual = JSON.parse(git(cwd, 'show', `${candidate}:.line-harness-vendor.json`)) as VendorState;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('existing update branch has unexpected vendor state');
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

function isAncestor(cwd: string, previous: string, target: string): boolean {
  try {
    git(cwd, 'merge-base', '--is-ancestor', previous, target);
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
      throw new Error('prepare requires --key value arguments');
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
  const result = prepareCustomerUpdate({
    customerDir: required(args, 'customer-dir'),
    sellerDir: required(args, 'seller-dir'),
    manifest: JSON.parse(readFileSync(required(args, 'manifest'), 'utf8')) as Manifest,
    expectedRepository: required(args, 'seller-repository'),
    baseBranch: args['base-branch'] ?? 'main',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (argv[1]?.endsWith('prepare.ts')) main();
