#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';
import { join } from 'node:path';
import { validateReleaseEntry } from '../../packages/update-engine/src/manifest.js';
import type {
  CustomerSourceUpdate,
  CustomerUpdateClass,
  ReleaseEntry,
} from '../../packages/update-engine/src/types.js';

export interface CustomerReleasePolicy {
  schema_version: 1;
  version: string;
  release_sequence: number;
  previous_commit: string;
  update_class: CustomerUpdateClass;
  manual_reasons: string[];
  required_configuration: string[];
  minimum_client_version: string;
  rollback_compatible_from: string;
  revoked: boolean;
}

const PRIVILEGED_PATHS = [
  /^\.github\//,
  /(^|\/)CODEOWNERS$/,
  /^scripts\/(?:release|customer-update)\//,
  /^customer-release\.json$/,
  /^(?:package\.json|pnpm-lock\.yaml)$/,
  /^packages\/db\//,
  /^apps\/worker\/wrangler(?:\.|$)/,
  /^apps\/worker\/src\/middleware\/(?:auth|admin-auth-config)/,
  /^apps\/worker\/src\/routes\/admin-auth/,
];

export function findPrivilegedPaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => PRIVILEGED_PATHS.some((rule) => rule.test(path))))]
    .sort();
}

function requirePolicyStrings(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`invalid customer release policy ${field}`);
  }
}

export function validateCustomerReleasePolicy(policy: CustomerReleasePolicy): void {
  if (policy.schema_version !== 1) {
    throw new Error('unsupported customer release policy schema_version');
  }
  if (!/^\d+\.\d+\.\d+$/.test(policy.version)) {
    throw new Error('invalid customer release policy version');
  }
  if (!Number.isInteger(policy.release_sequence) || policy.release_sequence < 1) {
    throw new Error('invalid customer release policy release_sequence');
  }
  if (!/^[0-9a-f]{40}$/.test(policy.previous_commit)) {
    throw new Error('invalid customer release policy previous_commit');
  }
  if (policy.update_class !== 'compatible' && policy.update_class !== 'manual') {
    throw new Error('invalid customer release policy update_class');
  }
  requirePolicyStrings(policy.manual_reasons, 'manual_reasons');
  requirePolicyStrings(policy.required_configuration, 'required_configuration');
  if (policy.update_class === 'manual' && policy.manual_reasons.length === 0) {
    throw new Error('manual customer release policy requires a reason');
  }
  if (!/^\d+\.\d+\.\d+$/.test(policy.minimum_client_version)) {
    throw new Error('invalid customer release policy minimum_client_version');
  }
  if (!/^\d+\.\d+\.\d+$/.test(policy.rollback_compatible_from)) {
    throw new Error('invalid customer release policy rollback_compatible_from');
  }
  if (typeof policy.revoked !== 'boolean') {
    throw new Error('invalid customer release policy revoked');
  }
}

export function buildCustomerSourceUpdate(input: {
  release: ReleaseEntry;
  policy: CustomerReleasePolicy;
  repository: string;
  commit: string;
  tag: string;
  changedPaths: string[];
  migrationDigests: Record<string, string>;
}): CustomerSourceUpdate {
  validateCustomerReleasePolicy(input.policy);
  if (input.policy.version !== input.release.version) {
    throw new Error('customer release policy version must match release version');
  }

  const source: CustomerSourceUpdate = {
    release_id: `${input.repository}@${input.tag}`,
    release_sequence: input.policy.release_sequence,
    repository: input.repository,
    commit: input.commit,
    previous_commit: input.policy.previous_commit,
    tag: input.tag,
    update_class: input.policy.update_class,
    manual_reasons: input.policy.manual_reasons,
    required_configuration: input.policy.required_configuration,
    privileged_paths: findPrivilegedPaths(input.changedPaths),
    new_migrations: input.changedPaths
      .filter((path) => path.startsWith('packages/db/migrations/'))
      .map((path) => path.slice('packages/db/migrations/'.length))
      .sort(),
    migration_digests: input.migrationDigests,
    minimum_client_version: input.policy.minimum_client_version,
    rollback_compatible_from: input.policy.rollback_compatible_from,
    revoked: input.policy.revoked,
  };
  validateReleaseEntry({ ...input.release, customer_source_update: source });
  return source;
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('customer-source-update requires --key value arguments');
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

function migrationDigests(release: ReleaseEntry, migrationsDir: string): Record<string, string> {
  return Object.fromEntries(release.migrations.map((name) => {
    const bytes = readFileSync(join(migrationsDir, name));
    return [name, `sha256:${createHash('sha256').update(bytes).digest('hex')}`];
  }));
}

function main(): void {
  const args = parseArgs(argv.slice(2));
  const policy = JSON.parse(readFileSync(required(args, 'policy'), 'utf8')) as CustomerReleasePolicy;
  validateCustomerReleasePolicy(policy);
  if (args['validate-only'] === 'true') return;
  const releasePath = required(args, 'release');
  const release = JSON.parse(readFileSync(releasePath, 'utf8')) as ReleaseEntry;
  const changedPaths = readFileSync(required(args, 'changed-paths'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  const source = buildCustomerSourceUpdate({
    release,
    policy,
    repository: required(args, 'repository'),
    commit: required(args, 'commit'),
    tag: required(args, 'tag'),
    changedPaths,
    migrationDigests: migrationDigests(release, required(args, 'migrations-dir')),
  });
  writeFileSync(
    releasePath,
    `${JSON.stringify({ ...release, customer_source_update: source }, null, 2)}\n`,
  );
}

if (argv[1]?.endsWith('customer-source-update.ts')) {
  main();
}
