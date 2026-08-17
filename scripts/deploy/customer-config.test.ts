import { describe, expect, test } from 'vitest';
import type { WorkerBinding } from '../../packages/update-engine/src/index.js';
import {
  prepareCustomerConfig,
  verifyCustomerConfig,
} from './customer-config.js';

const liveBindings: WorkerBinding[] = [
  { type: 'plain_text', name: 'WORKER_NAME', text: 'customer-worker' },
  { type: 'plain_text', name: 'ADMIN_PAGES_PROJECT', text: 'customer-admin' },
  { type: 'secret_text', name: 'ADMIN_ORIGIN' },
  { type: 'secret_text', name: 'WORKER_URL' },
  { type: 'secret_text', name: 'LINE_CHANNEL_SECRET' },
  { type: 'd1', name: 'DB', database_id: 'customer-d1' },
  { type: 'r2_bucket', name: 'IMAGES', bucket_name: 'customer-images' },
  { type: 'kv_namespace', name: 'CACHE', namespace_id: 'customer-kv' },
  { type: 'assets', name: 'ASSETS' },
];

const wrangler = {
  vars: {
    WORKER_NAME: 'source-default',
    ADMIN_ORIGIN: 'https://admin.example.test',
    WORKER_URL: 'https://worker.example.test',
  },
  d1_databases: [
    { binding: 'DB', database_name: 'customer-db', database_id: 'customer-d1' },
  ],
  r2_buckets: [{ binding: 'IMAGES', bucket_name: 'customer-images' }],
  assets: { binding: 'ASSETS', directory: '../client' },
};

const expected = {
  workerName: 'customer-worker',
  adminPagesProject: 'customer-admin',
  d1DatabaseId: 'customer-d1',
  r2BucketName: 'customer-images',
  adminOrigin: 'https://admin.example.test',
  workerUrl: 'https://worker.example.test',
};

describe('customer deployment configuration protection', () => {
  test('reuses live customer bindings without converting secrets to plain text', () => {
    const prepared = prepareCustomerConfig({ wrangler, liveBindings, expected });

    expect(prepared.wrangler.keep_vars).toBe(true);
    expect(prepared.wrangler.vars).toEqual({
      ADMIN_ORIGIN: 'https://admin.example.test',
      ADMIN_PAGES_PROJECT: 'customer-admin',
      WORKER_NAME: 'customer-worker',
      WORKER_URL: 'https://worker.example.test',
    });
    expect(prepared.wrangler.d1_databases).toEqual([
      { binding: 'DB', database_name: 'customer-db', database_id: 'customer-d1' },
    ]);
    expect(prepared.wrangler.r2_buckets).toEqual([
      { binding: 'IMAGES', bucket_name: 'customer-images' },
    ]);
    expect(prepared.wrangler.kv_namespaces).toEqual([
      { binding: 'CACHE', id: 'customer-kv' },
    ]);
    expect(JSON.stringify(prepared.snapshot)).not.toContain('customer-worker');
    expect(() => verifyCustomerConfig(prepared.snapshot, liveBindings)).not.toThrow();
  });

  test('repairs stale deployment metadata without treating it as customer drift', () => {
    const staleBindings = liveBindings.map((binding) => {
      if (binding.name === 'WORKER_NAME') return { ...binding, text: 'line-harness' };
      if (binding.name === 'ADMIN_PAGES_PROJECT') return { ...binding, text: 'line-harness-admin' };
      return binding;
    });

    const prepared = prepareCustomerConfig({
      wrangler,
      liveBindings: staleBindings,
      expected,
    });

    expect(prepared.wrangler.vars).toMatchObject({
      WORKER_NAME: expected.workerName,
      ADMIN_PAGES_PROJECT: expected.adminPagesProject,
      ADMIN_ORIGIN: expected.adminOrigin,
      WORKER_URL: expected.workerUrl,
    });
    expect(() => verifyCustomerConfig(prepared.snapshot, staleBindings)).not.toThrow();

    const repairedBindings = staleBindings.map((binding) => {
      if (binding.name === 'WORKER_NAME') return { ...binding, text: expected.workerName };
      if (binding.name === 'ADMIN_PAGES_PROJECT') return { ...binding, text: expected.adminPagesProject };
      return binding;
    });
    expect(() => verifyCustomerConfig(prepared.snapshot, repairedBindings)).not.toThrow();
  });

  test('allows a new managed LIFF origin binding during first update', () => {
    const liffOrigin = 'https://liff.example.test';
    const prepared = prepareCustomerConfig({
      wrangler: {
        ...wrangler,
        vars: { ...wrangler.vars, LIFF_ORIGIN: liffOrigin },
      },
      liveBindings,
      expected: { ...expected, liffOrigin },
    });

    expect(prepared.wrangler.vars).toMatchObject({ LIFF_ORIGIN: liffOrigin });
    expect(() => verifyCustomerConfig(prepared.snapshot, [
      ...liveBindings,
      { type: 'plain_text', name: 'LIFF_ORIGIN', text: liffOrigin },
    ])).not.toThrow();
  });

  test('stops before deployment when D1 or R2 differs', () => {
    expect(() => prepareCustomerConfig({
      wrangler,
      liveBindings,
      expected: { ...expected, d1DatabaseId: 'other-d1' },
    })).toThrow(/D1 binding DB/);
    expect(() => prepareCustomerConfig({
      wrangler,
      liveBindings,
      expected: { ...expected, r2BucketName: 'other-images' },
    })).toThrow(/R2 binding IMAGES/);
  });

  test('detects removal or changes after deployment without exposing values', () => {
    const { snapshot } = prepareCustomerConfig({ wrangler, liveBindings, expected });
    const removed = liveBindings.filter((binding) => binding.name !== 'LINE_CHANNEL_SECRET');
    const changed = liveBindings.map((binding) =>
      binding.name === 'CACHE'
        ? { ...binding, namespace_id: 'changed-kv' }
        : binding,
    );

    expect(() => verifyCustomerConfig(snapshot, removed)).toThrow(
      /customer Worker bindings changed during deployment/,
    );
    expect(() => verifyCustomerConfig(snapshot, changed)).toThrow(
      /customer Worker bindings changed during deployment/,
    );
  });
});
