import { Hono } from 'hono';
import {
  updateStaffMember,
} from '@line-crm/db';
import type { StaffMember } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';
import {
  generateTemporaryPassword,
  hashTenantPassword,
} from '../custom/pharmacy/provisioning/credentials.js';

const staff = new Hono<Env>();

type TenantStaffMember = StaffMember & { login_id: string | null };

async function getTenantStaffMembers(db: D1Database, tenantId: string): Promise<TenantStaffMember[]> {
  const result = await db.prepare(
    `SELECT member.id, member.name, member.email,
            membership.role, credential.login_id,
            membership.is_active, member.created_at, member.updated_at
       FROM tenant_staff_memberships AS membership
       INNER JOIN staff_members AS member ON member.id = membership.staff_id
       LEFT JOIN tenant_admin_credentials AS credential
              ON credential.tenant_id = membership.tenant_id
             AND credential.staff_id = membership.staff_id
      WHERE membership.tenant_id = ?
      ORDER BY member.created_at ASC`,
  ).bind(tenantId).all<TenantStaffMember>();
  return result.results;
}

async function getTenantStaffById(
  db: D1Database,
  tenantId: string,
  staffId: string,
): Promise<TenantStaffMember | null> {
  return db.prepare(
    `SELECT member.id, member.name, member.email,
            membership.role, credential.login_id,
            membership.is_active, member.created_at, member.updated_at
       FROM tenant_staff_memberships AS membership
       INNER JOIN staff_members AS member ON member.id = membership.staff_id
       LEFT JOIN tenant_admin_credentials AS credential
              ON credential.tenant_id = membership.tenant_id
             AND credential.staff_id = membership.staff_id
      WHERE membership.tenant_id = ? AND membership.staff_id = ?
      LIMIT 1`,
  ).bind(tenantId, staffId).first<TenantStaffMember>();
}

async function countActiveTenantOwners(db: D1Database, tenantId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM tenant_staff_memberships
      WHERE tenant_id = ? AND role = 'owner' AND is_active = 1`,
  ).bind(tenantId).first<{ count: number }>();
  return row?.count ?? 0;
}

function serializeStaff(row: TenantStaffMember) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    loginId: row.login_id,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/staff/me — any authenticated user (MUST be before /:id)
staff.get('/api/staff/me', async (c) => {
  try {
    const currentStaff = c.get('staff');
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);

    // env-owner: return minimal info
    if (currentStaff.id === 'env-owner') {
      return c.json({
        success: true,
        data: {
          id: 'env-owner',
          name: 'Owner',
          role: 'owner',
          email: null,
        },
      });
    }

    const member = await getTenantStaffById(c.env.DB, tenantId, currentStaff.id);
    if (!member) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        id: member.id,
        name: member.name,
        role: member.role,
        email: member.email,
      },
    });
  } catch (err) {
    console.error('GET /api/staff/me error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff — owner only. List tenant staff and login IDs.
staff.get('/api/staff', requireRole('owner'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const members = await getTenantStaffMembers(c.env.DB, tenantId);
    return c.json({ success: true, data: members.map(serializeStaff) });
  } catch (err) {
    console.error('GET /api/staff error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff/:id — owner only. Get tenant-scoped staff detail.
staff.get('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const id = c.req.param('id')!;
    const member = await getTenantStaffById(c.env.DB, tenantId, id);
    if (!member) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    return c.json({ success: true, data: serializeStaff(member) });
  } catch (err) {
    console.error('GET /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff — owner only. Create staff with a one-time temporary password.
staff.post('/api/staff', requireRole('owner'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const body = await c.req.json<{
      name: string;
      loginId: string;
      email?: string;
      role: string;
    }>().catch(() => null);
    if (!body) return c.json({ success: false, error: 'Invalid JSON body' }, 400);
    const name = body.name?.trim();
    const loginId = body.loginId?.trim();
    const email = body.email?.trim() || null;

    if (!name || name.length > 120) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }
    if (!loginId || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(loginId)) {
      return c.json({ success: false, error: 'loginId is invalid' }, 400);
    }
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))) {
      return c.json({ success: false, error: 'email is invalid' }, 400);
    }

    const validRoles = ['owner', 'admin', 'staff'] as const;
    if (!body.role || !validRoles.includes(body.role as (typeof validRoles)[number])) {
      return c.json({ success: false, error: 'role must be owner, admin, or staff' }, 400);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashTenantPassword(temporaryPassword);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO staff_members
           (id, name, email, role, api_key, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        id, name, email, body.role,
        `disabled:${crypto.randomUUID()}`, now, now,
      ),
      c.env.DB.prepare(
        `INSERT INTO tenant_staff_memberships
           (tenant_id, staff_id, role, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(
        tenantId, id, body.role, now, now,
      ),
      // Tenant staff are provisioned for each currently mapped pharmacy
      // account. Future account-level assignment management can narrow this
      // set without changing the authentication contract.
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO pharmacy_staff_accounts
          (line_account_id, staff_id, is_active, created_at, updated_at)
         SELECT line_account_id, ?, 1, ?, ?
           FROM tenant_line_accounts
          WHERE tenant_id = ?`,
      ).bind(id, now, now, tenantId),
      c.env.DB.prepare(
        `INSERT INTO tenant_admin_credentials
           (tenant_id, staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
      ).bind(tenantId, id, loginId, passwordHash, now, now),
    ]);

    const member = await getTenantStaffById(c.env.DB, tenantId, id);
    if (!member) throw new Error('Created staff member was not found');
    return c.json({
      success: true,
      data: { ...serializeStaff(member), temporaryPassword },
    }, 201);
  } catch (err) {
    console.error('POST /api/staff error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/staff/:id — owner only. Update staff.
staff.patch('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const id = c.req.param('id')!;
    const body = await c.req.json<{
      name?: string;
      email?: string | null;
      role?: string;
      isActive?: boolean;
    }>();

    const validRoles = ['owner', 'admin', 'staff'] as const;
    if (body.role !== undefined && !validRoles.includes(body.role as (typeof validRoles)[number])) {
      return c.json({ success: false, error: 'role must be owner, admin, or staff' }, 400);
    }

    // Prevent removing the last active owner
    const target = await getTenantStaffById(c.env.DB, tenantId, id);
    if (!target) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    if (target.role === 'owner' && target.is_active === 1) {
      const willLoseOwner =
        (body.role !== undefined && body.role !== 'owner') ||
        body.isActive === false;
      if (willLoseOwner) {
        const ownerCount = await countActiveTenantOwners(c.env.DB, tenantId);
        if (ownerCount <= 1) {
          return c.json({ success: false, error: 'オーナーは最低1人必要です' }, 400);
        }
      }
    }

    if (body.name !== undefined || body.email !== undefined) {
      const updatedProfile = await updateStaffMember(
        c.env.DB,
        id,
        { name: body.name, email: body.email },
        tenantId,
      );
      if (!updatedProfile) {
        return c.json({ success: false, error: 'Staff profile is shared across tenants' }, 409);
      }
    }
    if (body.role !== undefined || body.isActive !== undefined) {
      const sets = ['updated_at = ?'];
      const values: Array<string | number> = [new Date().toISOString()];
      if (body.role !== undefined) {
        sets.push('role = ?');
        values.push(body.role);
      }
      if (body.isActive !== undefined) {
        sets.push('is_active = ?');
        values.push(body.isActive ? 1 : 0);
      }
      await c.env.DB.prepare(
        `UPDATE tenant_staff_memberships
            SET ${sets.join(', ')}
          WHERE tenant_id = ? AND staff_id = ?`,
      ).bind(...values, tenantId, id).run();
    }

    const updated = await getTenantStaffById(c.env.DB, tenantId, id);

    if (!updated) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    return c.json({ success: true, data: serializeStaff(updated) });
  } catch (err) {
    console.error('PATCH /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/staff/:id — owner only. Cannot delete self. Must keep at least 1 owner.
staff.delete('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const id = c.req.param('id')!;
    const currentStaff = c.get('staff');

    if (id === currentStaff.id) {
      return c.json({ success: false, error: '自分自身は削除できません' }, 400);
    }

    const target = await getTenantStaffById(c.env.DB, tenantId, id);
    if (!target) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    if (target.role === 'owner' && target.is_active === 1) {
      const ownerCount = await countActiveTenantOwners(c.env.DB, tenantId);
      if (ownerCount <= 1) {
        return c.json({ success: false, error: 'オーナーは最低1人必要です' }, 400);
      }
    }

    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE tenant_staff_memberships
            SET is_active = 0, updated_at = ?
          WHERE tenant_id = ? AND staff_id = ?`,
      ).bind(now, tenantId, id),
      c.env.DB.prepare(
        `UPDATE tenant_admin_sessions
            SET revoked_at = ?
          WHERE tenant_id = ? AND staff_id = ? AND revoked_at IS NULL`,
      ).bind(now, tenantId, id),
    ]);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff/:id/reset-password — owner only. Return a one-time password.
staff.post('/api/staff/:id/reset-password', requireRole('owner'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const id = c.req.param('id')!;
    const member = await getTenantStaffById(c.env.DB, tenantId, id);
    if (!member) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    const body = await c.req.json<{ loginId?: string }>().catch(() => null);
    if (!body) return c.json({ success: false, error: 'Invalid JSON body' }, 400);
    const loginId = body.loginId?.trim() || member.login_id;
    if (!loginId || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(loginId)) {
      return c.json({ success: false, error: 'loginId is required' }, 400);
    }
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashTenantPassword(temporaryPassword);
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO tenant_admin_credentials
           (tenant_id, staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?)
         ON CONFLICT(tenant_id, staff_id) DO UPDATE SET
           login_id = excluded.login_id,
           password_hash = excluded.password_hash,
           must_change_password = 1,
           credential_version = tenant_admin_credentials.credential_version + 1,
           updated_at = excluded.updated_at`,
      ).bind(tenantId, id, loginId, passwordHash, now, now),
      c.env.DB.prepare(
        `UPDATE tenant_admin_sessions
            SET revoked_at = ?
          WHERE tenant_id = ? AND staff_id = ? AND revoked_at IS NULL`,
      ).bind(now, tenantId, id),
    ]);
    return c.json({ success: true, data: { loginId, temporaryPassword } });
  } catch (err) {
    console.error('POST /api/staff/:id/reset-password error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { staff };
