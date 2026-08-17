#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { argv } from 'node:process';
import { validateReleaseEntry } from '../../packages/update-engine/src/manifest.js';
import { findPrivilegedPaths } from '../release/customer-source-update.js';
import { validateVendorState, type VendorState } from './prepare.js';

export function classifyVendorUpdate(input: {
  base: VendorState;
  target: VendorState;
  changedPaths: string[];
  candidateChangedPaths: string[];
  isAncestor: (previous: string, target: string) => boolean;
}): { classification: 'compatible' | 'manual' } {
  validateVendorState(input.base);
  validateVendorState(input.target);
  validateReleaseEntry(input.target.release, input.base.release);
  const baseSource = input.base.release.customer_source_update!;
  const targetSource = input.target.release.customer_source_update!;
  if (!input.isAncestor(baseSource.commit, targetSource.commit)) {
    throw new Error('accepted seller commit is not an ancestor of target release');
  }
  const computed = findPrivilegedPaths(input.changedPaths);
  const declared = [...targetSource.privileged_paths].sort();
  if (JSON.stringify(computed) !== JSON.stringify(declared)) {
    throw new Error('declared privileged paths do not match the seller commit diff');
  }
  const allowed = new Set([...input.changedPaths, '.line-harness-vendor.json']);
  if (input.candidateChangedPaths.some((path) => !allowed.has(path))) {
    throw new Error('update candidate changes files outside the seller release');
  }
  return { classification: targetSource.update_class };
}

function evaluateRepository(input: {
  repoDir: string;
  baseSha: string;
  headSha: string;
  headBranch: string;
}): { classification: 'ordinary' | 'compatible' | 'manual' } {
  if (!input.headBranch.startsWith('vendor/update-pharmacy-v')) {
    return { classification: 'ordinary' };
  }
  const base = readState(input.repoDir, input.baseSha);
  const target = readState(input.repoDir, input.headSha);
  if (!isAncestor(input.repoDir, input.baseSha, input.headSha)) {
    throw new Error('customer main is not an ancestor of update candidate');
  }
  if (!isAncestor(input.repoDir, base.commit, input.baseSha)) {
    throw new Error('accepted seller commit is not an ancestor of customer main');
  }
  if (!isAncestor(input.repoDir, target.commit, input.headSha)) {
    throw new Error('target seller commit is not an ancestor of update candidate');
  }
  const changedPaths = git(
    input.repoDir,
    'diff',
    '--name-only',
    base.commit,
    target.commit,
    '--',
  ).split(/\r?\n/).filter(Boolean);
  const candidateChangedPaths = git(
    input.repoDir,
    'diff',
    '--name-only',
    input.baseSha,
    input.headSha,
    '--',
  ).split(/\r?\n/).filter(Boolean);
  return classifyVendorUpdate({
    base,
    target,
    changedPaths,
    candidateChangedPaths,
    isAncestor: (previous, next) => isAncestor(input.repoDir, previous, next),
  });
}

function readState(cwd: string, commit: string): VendorState {
  return JSON.parse(git(cwd, 'show', `${commit}:.line-harness-vendor.json`)) as VendorState;
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
      throw new Error('policy requires --key value arguments');
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
  const result = evaluateRepository({
    repoDir: required(args, 'repo-dir'),
    baseSha: required(args, 'base-sha'),
    headSha: required(args, 'head-sha'),
    headBranch: required(args, 'head-branch'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (argv[1]?.endsWith('policy.ts')) main();
