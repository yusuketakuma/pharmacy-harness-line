#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';
import {
  listWorkerBindings,
  type WorkerBinding,
} from '../../packages/update-engine/src/index.js';

interface WranglerD1Binding {
  binding: string;
  database_name?: string;
  database_id?: string;
  [key: string]: unknown;
}

interface WranglerR2Binding {
  binding: string;
  bucket_name?: string;
  [key: string]: unknown;
}

interface WranglerKvBinding {
  binding: string;
  id?: string;
  [key: string]: unknown;
}

export interface WranglerConfig {
  keep_vars?: boolean;
  vars?: Record<string, unknown>;
  d1_databases?: WranglerD1Binding[];
  r2_buckets?: WranglerR2Binding[];
  kv_namespaces?: WranglerKvBinding[];
  [key: string]: unknown;
}

export interface ExpectedCustomerConfig {
  workerName: string;
  adminPagesProject: string;
  d1DatabaseId: string;
  r2BucketName: string;
  adminOrigin: string;
  workerUrl: string;
  liffOrigin?: string;
}

export interface CustomerConfigSnapshot {
  schemaVersion: 1;
  digest: string;
  bindingNames: string[];
}

interface NormalizedBinding {
  type: string;
  name: string;
  value?: string;
}

const SUPPORTED_BINDING_TYPES = new Set([
  'plain_text',
  'secret_text',
  'secret_key',
  'd1',
  'r2_bucket',
  'kv_namespace',
  'assets',
]);

// These values describe the current deployment target. Render them from the
// deployment environment on every update instead of copying stale metadata
// from the previously deployed Worker.
const DEPLOYMENT_MANAGED_TEXT_BINDINGS = new Set([
  'WORKER_NAME',
  'ADMIN_PAGES_PROJECT',
  'ADMIN_ORIGIN',
  'WORKER_URL',
  'LIFF_ORIGIN',
]);

// Worker Assets installs no longer need the old Pages project variable.
const OPTIONAL_LEGACY_TEXT_BINDINGS = new Set(['LIFF_PAGES_PROJECT']);

function bindingValue(binding: WorkerBinding): string | undefined {
  switch (binding.type) {
    case 'plain_text':
      return binding.text;
    case 'd1':
      return binding.database_id;
    case 'r2_bucket':
      return binding.bucket_name;
    case 'kv_namespace':
      return binding.namespace_id;
    case 'secret_text':
    case 'secret_key':
    case 'assets':
      return undefined;
  }
}

function normalizeBindings(bindings: WorkerBinding[]): NormalizedBinding[] {
  const normalized = bindings.map((binding) => {
    const type = (binding as { type?: unknown }).type;
    if (typeof type !== 'string' || !SUPPORTED_BINDING_TYPES.has(type)) {
      throw new Error(`unsupported customer Worker binding type: ${String(type)}`);
    }
    if (!binding.name) throw new Error('customer Worker binding has no name');
    const value = DEPLOYMENT_MANAGED_TEXT_BINDINGS.has(binding.name)
      ? '<managed>'
      : bindingValue(binding);
    if (
      (type === 'plain_text' || type === 'd1' || type === 'r2_bucket' || type === 'kv_namespace') &&
      typeof value !== 'string'
    ) {
      throw new Error(`customer Worker binding ${type}:${binding.name} has no value`);
    }
    return {
      type,
      name: binding.name,
      ...(value === undefined ? {} : { value }),
    };
  }).sort((left, right) =>
    `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`),
  );

  const names = normalized.map((binding) => `${binding.type}:${binding.name}`);
  if (new Set(names).size !== names.length) {
    throw new Error('customer Worker has duplicate bindings');
  }
  return normalized;
}

function createSnapshot(bindings: WorkerBinding[]): CustomerConfigSnapshot {
  const normalized = normalizeBindings(bindings).filter(
    (binding) => !DEPLOYMENT_MANAGED_TEXT_BINDINGS.has(binding.name),
  );
  return {
    schemaVersion: 1,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`,
    bindingNames: normalized.map((binding) => `${binding.type}:${binding.name}`),
  };
}

function findBinding(bindings: WorkerBinding[], name: string): WorkerBinding {
  const matches = bindings.filter((binding) => binding.name === name);
  if (matches.length !== 1) throw new Error(`missing or duplicate customer binding ${name}`);
  return matches[0];
}

function assertResource(
  bindings: WorkerBinding[],
  type: 'd1' | 'r2_bucket',
  name: string,
  expected: string,
): void {
  const binding = findBinding(bindings, name);
  const actual = bindingValue(binding);
  const label = type === 'd1' ? 'D1' : 'R2';
  if (binding.type !== type || actual !== expected) {
    throw new Error(`${label} binding ${name} does not match the configured customer resource`);
  }
}

function assertConfiguredBindingsExist(
  wrangler: WranglerConfig,
  liveBindings: WorkerBinding[],
): void {
  const live = new Set(liveBindings.map((binding) => `${binding.type}:${binding.name}`));
  const liveNames = new Set(liveBindings.map((binding) => binding.name));
  for (const name of Object.keys(wrangler.vars ?? {})) {
    if (DEPLOYMENT_MANAGED_TEXT_BINDINGS.has(name) || OPTIONAL_LEGACY_TEXT_BINDINGS.has(name)) continue;
    if (!liveNames.has(name)) {
      throw new Error(`customer binding ${name} requires setup before update`);
    }
  }
  for (const binding of wrangler.d1_databases ?? []) {
    if (!live.has(`d1:${binding.binding}`)) {
      throw new Error(`customer D1 binding ${binding.binding} requires setup before update`);
    }
  }
  for (const binding of wrangler.r2_buckets ?? []) {
    if (!live.has(`r2_bucket:${binding.binding}`)) {
      throw new Error(`customer R2 binding ${binding.binding} requires setup before update`);
    }
  }
  for (const binding of wrangler.kv_namespaces ?? []) {
    if (!live.has(`kv_namespace:${binding.binding}`)) {
      throw new Error(`customer KV binding ${binding.binding} requires setup before update`);
    }
  }
}

function preserveBindings(
  wrangler: WranglerConfig,
  bindings: WorkerBinding[],
  expected: ExpectedCustomerConfig,
): WranglerConfig {
  const existingD1 = new Map(
    (wrangler.d1_databases ?? []).map((binding) => [binding.binding, binding]),
  );
  const existingR2 = new Map(
    (wrangler.r2_buckets ?? []).map((binding) => [binding.binding, binding]),
  );
  const existingKv = new Map(
    (wrangler.kv_namespaces ?? []).map((binding) => [binding.binding, binding]),
  );
  const plainText = bindings
    .filter((binding) => binding.type === 'plain_text')
    .sort((left, right) => left.name.localeCompare(right.name));
  const d1 = bindings
    .filter((binding) => binding.type === 'd1')
    .sort((left, right) => left.name.localeCompare(right.name));
  const r2 = bindings
    .filter((binding) => binding.type === 'r2_bucket')
    .sort((left, right) => left.name.localeCompare(right.name));
  const kv = bindings
    .filter((binding) => binding.type === 'kv_namespace')
    .sort((left, right) => left.name.localeCompare(right.name));
  const liveVars = Object.fromEntries(
    plainText
      .filter((binding) => !DEPLOYMENT_MANAGED_TEXT_BINDINGS.has(binding.name))
      .map((binding) => [binding.name, binding.text]),
  );
  const managedVars: Record<string, string> = {
    WORKER_NAME: expected.workerName,
    ADMIN_PAGES_PROJECT: expected.adminPagesProject,
    ADMIN_ORIGIN: expected.adminOrigin,
    WORKER_URL: expected.workerUrl,
  };
  if (expected.liffOrigin) {
    managedVars.LIFF_ORIGIN = expected.liffOrigin;
  } else {
    const existingLiffOrigin = plainText.find((binding) => binding.name === 'LIFF_ORIGIN');
    if (existingLiffOrigin) managedVars.LIFF_ORIGIN = existingLiffOrigin.text;
  }

  const preserved: WranglerConfig = {
    ...wrangler,
    keep_vars: true,
    vars: { ...liveVars, ...managedVars },
    d1_databases: d1.map((binding) => ({
      ...(existingD1.get(binding.name) ?? {}),
      binding: binding.name,
      database_id: binding.database_id,
    })),
    r2_buckets: r2.map((binding) => ({
      ...(existingR2.get(binding.name) ?? {}),
      binding: binding.name,
      bucket_name: binding.bucket_name,
    })),
  };
  if (kv.length > 0 || wrangler.kv_namespaces !== undefined) {
    preserved.kv_namespaces = kv.map((binding) => ({
      ...(existingKv.get(binding.name) ?? {}),
      binding: binding.name,
      id: binding.namespace_id,
    }));
  }
  return preserved;
}

export function prepareCustomerConfig(input: {
  wrangler: WranglerConfig;
  liveBindings: WorkerBinding[];
  expected: ExpectedCustomerConfig;
}): { wrangler: WranglerConfig; snapshot: CustomerConfigSnapshot } {
  normalizeBindings(input.liveBindings);
  assertResource(input.liveBindings, 'd1', 'DB', input.expected.d1DatabaseId);
  assertResource(input.liveBindings, 'r2_bucket', 'IMAGES', input.expected.r2BucketName);
  assertConfiguredBindingsExist(input.wrangler, input.liveBindings);
  return {
    wrangler: preserveBindings(input.wrangler, input.liveBindings, input.expected),
    snapshot: createSnapshot(input.liveBindings),
  };
}

export function verifyCustomerConfig(
  snapshot: CustomerConfigSnapshot,
  liveBindings: WorkerBinding[],
): void {
  if (snapshot.schemaVersion !== 1 || !/^sha256:[0-9a-f]{64}$/.test(snapshot.digest)) {
    throw new Error('invalid customer configuration snapshot');
  }
  const current = createSnapshot(liveBindings);
  if (current.digest !== snapshot.digest) {
    throw new Error('customer Worker bindings changed during deployment');
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`missing ${name}`);
  return value;
}

function expectedFromEnvironment(): ExpectedCustomerConfig {
  return {
    workerName: required('WORKER_NAME'),
    adminPagesProject: required('PAGES_PROJECT_NAME'),
    d1DatabaseId: required('D1_DATABASE_ID'),
    r2BucketName: required('R2_BUCKET_NAME'),
    adminOrigin: required('ADMIN_ORIGIN'),
    workerUrl: required('WORKER_URL'),
    ...(process.env.LIFF_ORIGIN?.trim()
      ? { liffOrigin: process.env.LIFF_ORIGIN }
      : {}),
  };
}

async function main(): Promise<void> {
  const mode = argv[2];
  if (mode !== 'prepare' && mode !== 'verify') {
    throw new Error('customer-config requires prepare or verify');
  }
  const creds = {
    accountId: required('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: required('CLOUDFLARE_API_TOKEN'),
  };
  const bindings = await listWorkerBindings({
    creds,
    scriptName: required('WORKER_NAME'),
  });
  const snapshotPath = required('CUSTOMER_CONFIG_SNAPSHOT');
  if (mode === 'prepare') {
    const wranglerPath = required('WRANGLER_CONFIG');
    const wrangler = JSON.parse(readFileSync(wranglerPath, 'utf8')) as WranglerConfig;
    const prepared = prepareCustomerConfig({
      wrangler,
      liveBindings: bindings,
      expected: expectedFromEnvironment(),
    });
    writeFileSync(wranglerPath, `${JSON.stringify(prepared.wrangler, null, 2)}\n`);
    writeFileSync(snapshotPath, `${JSON.stringify(prepared.snapshot)}\n`, { mode: 0o600 });
    console.log('Customer configuration preflight passed');
    return;
  }

  const snapshot = JSON.parse(
    readFileSync(snapshotPath, 'utf8'),
  ) as CustomerConfigSnapshot;
  verifyCustomerConfig(snapshot, bindings);
  console.log('Customer configuration postflight passed');
}

if (argv[1]?.endsWith('customer-config.ts')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
