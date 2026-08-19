import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'src');

function tsSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(dir, name));
}

// packages/db/migrations/custom_014_pharmacy_logical_tenants.sql backfills
// EVERY line_accounts row into pharmacy_account_capabilities with
// mode='pharmacy' unconditionally, and the pharmacyTenantApiAllowlistGuard
// (apps/worker/src/custom/pharmacy/growth-loop/generic-feature-guard.ts)
// only blocks tags.ts/webhooks.ts/broadcasts.ts's unscoped SQL for tenants
// classified as pharmacy. That makes "every tenant this product can ever
// create is pharmacy-mode" load-bearing: it is what keeps those unscoped
// generic-CRM routes unreachable. That in turn depends on there being
// exactly one production code path that can create a tenant at all (this
// provisioning route, which always creates pharmacy-mode tenants). If a
// second `INSERT INTO tenants` call site is ever added elsewhere, that
// guarantee silently breaks and the tags/webhooks/broadcasts gap becomes
// exploitable. This test forces a conscious review of that gap whenever a
// second tenant-creation path is introduced.
describe('tenant creation invariant', () => {
  it('has exactly one production call site that can INSERT INTO tenants', () => {
    const matches = tsSourceFiles(WORKER_SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('INSERT INTO tenants'));

    expect(matches).toEqual([join(WORKER_SRC, 'custom', 'pharmacy', 'provisioning', 'routes.ts')]);
  });
});
