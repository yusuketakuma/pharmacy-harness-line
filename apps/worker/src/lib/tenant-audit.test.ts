import { describe, expect, it } from 'vitest';
import { recordTenantAudit, tenantAuditStatement } from './tenant-audit.js';

function fakeDb() {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return { async run() { writes.push({ sql, params }); return { meta: { changes: 1 } }; } };
        },
      };
    },
  } as unknown as D1Database;
  return { db, writes };
}

describe('tenant audit', () => {
  it('writes scope, actor, action and resource ids only', async () => {
    const { db, writes } = fakeDb();
    await recordTenantAudit(db, {
      tenantId: 'tenant-a', actorStaffId: 'staff-a', action: 'staff.reset_password',
      resourceType: 'staff', resourceId: 'staff-b',
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain('INSERT INTO tenant_admin_audit_events');
    expect(writes[0].params.slice(1, 7)).toEqual([
      'tenant-a', null, 'staff-a', 'staff.reset_password', 'staff', 'staff-b',
    ]);
  });

  it('refuses an unscoped event', () => {
    const { db } = fakeDb();
    expect(() => tenantAuditStatement(db, { actorStaffId: 'staff-a', action: 'x' }))
      .toThrow(/scope/);
  });
});
