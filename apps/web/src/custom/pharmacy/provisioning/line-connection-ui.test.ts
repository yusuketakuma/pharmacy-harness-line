import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8');

describe('LINE connection UI', () => {
  it('offers the tenant-scoped connection endpoint from the account screen', () => {
    const api = read('lib/api.ts');
    const page = read('app/accounts/page.tsx');

    expect(api).toContain('`/api/line-accounts/${id}/connect`');
    expect(page).toContain('api.lineAccounts.connect(accountId)');
    expect(page).toContain('LINE接続を確認・更新');
  });
});
