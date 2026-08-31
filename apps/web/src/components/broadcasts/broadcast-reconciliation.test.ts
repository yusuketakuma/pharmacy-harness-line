import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('broadcast reconciliation warning', () => {
  it('keeps failed accounts from progress polling visible to the operator', () => {
    const detail = readFileSync(new URL('./broadcast-detail.tsx', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../../lib/api.ts', import.meta.url), 'utf8');

    expect(api).toContain('failedAccountIds: string[] | null');
    expect(detail).toContain('failedAccountIds: res.data!.failedAccountIds');
    expect(detail).toContain('配信結果の確認が必要です');
    expect(detail).toContain('role="alert"');
  });
});
