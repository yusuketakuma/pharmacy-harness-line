import { describe, expect, it } from 'vitest';
import { getStaffByApiKey } from '../src/staff.js';

describe('staff API key authentication', () => {
  it('never authenticates the disabled placeholder used by password-only staff', async () => {
    let prepared = '';
    const db = {
      prepare(sql: string) {
        prepared = sql;
        return {
          bind() {
            return { first: async () => null };
          },
        };
      },
    } as unknown as D1Database;

    await getStaffByApiKey(db, 'disabled:known-from-database');
    expect(prepared).toContain("api_key NOT LIKE 'disabled:%'");
  });
});
