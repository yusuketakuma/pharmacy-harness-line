import { describe, it, expect, vi } from 'vitest';
import { tagBelongsToTenant } from '../src/tags.js';

describe('tagBelongsToTenant', () => {
  it('binds tagId and tenantId and reports existence', async () => {
    const bind = vi.fn(() => ({ first: async () => ({ id: 'tag-1' }) }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;
    await expect(tagBelongsToTenant(db, 'tag-1', 'tenant-a')).resolves.toBe(true);
    expect(prepare.mock.calls[0][0]).toMatch(/tenant_id IS \?/);
    expect(bind).toHaveBeenCalledWith('tag-1', 'tenant-a');
  });
  it('returns false when no row', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;
    await expect(tagBelongsToTenant(db, 'tag-x', 'tenant-a')).resolves.toBe(false);
  });
});
