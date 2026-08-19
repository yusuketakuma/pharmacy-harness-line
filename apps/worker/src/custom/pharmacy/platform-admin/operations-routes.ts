import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../../../index.js';
import { requireLineBotUserId } from '../provisioning/line-connection.js';
import { readLineCredential } from '../provisioning/line-credential-store.js';
import { platformAdminAccessStatement, recordPlatformAdminAccess } from './audit.js';

/**
 * Tenant operations for the platform admin: staff roster, session revocation
 * and LINE connectivity diagnostics.
 *
 * None of this is patient PHI, so none of it requires a support-mode access
 * grant (access-grant.ts) — that gate belongs to the prescription/intake/
 * myna/continuity routes in routes.ts. Every route here still writes a
 * platform_admin_access_events row, because crossing a tenant boundary at all
 * is what that table exists to record.
 */
export const platformAdminOperationsRoutes = new Hono<Env>();

const LINE_PROBE_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_ERROR = 'LINE API request timed out';

async function tenantExists(db: D1Database, tenantId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT id FROM tenants WHERE id = ? LIMIT 1`)
    .bind(tenantId).first<{ id: string }>();
  return Boolean(row);
}

type StaffRow = {
  staff_id: string;
  name: string;
  email: string | null;
  role: string;
  staff_active: number;
  membership_active: number;
  active_session_count: number;
};

/**
 * GET /api/platform-admin/tenants/:id/staff — who can log into this tenant,
 * and how many live admin sessions each of them currently holds.
 */
platformAdminOperationsRoutes.get('/api/platform-admin/tenants/:id/staff', async (c) => {
  const admin = c.get('platformAdmin');
  const tenantId = c.req.param('id');
  if (!(await tenantExists(c.env.DB, tenantId))) {
    return c.json({ success: false, error: 'Tenant not found' }, 404);
  }

  const result = await c.env.DB.prepare(
    `SELECT staff.id AS staff_id, staff.name, staff.email, membership.role,
            staff.is_active AS staff_active,
            membership.is_active AS membership_active,
            (SELECT COUNT(*) FROM tenant_admin_sessions AS session
              WHERE session.staff_id = staff.id
                AND session.tenant_id = membership.tenant_id
                AND session.revoked_at IS NULL
                AND session.expires_at > ?) AS active_session_count
       FROM tenant_staff_memberships AS membership
       INNER JOIN staff_members AS staff ON staff.id = membership.staff_id
      WHERE membership.tenant_id = ?
      ORDER BY staff.name, staff.id`,
  ).bind(new Date().toISOString(), tenantId).all<StaffRow>();

  await recordPlatformAdminAccess(c.env.DB, admin.id, tenantId, 'list_staff');
  return c.json({
    success: true,
    data: (result.results ?? []).map((row) => ({
      staffId: row.staff_id,
      name: row.name,
      email: row.email,
      // The tenant-scoped membership role, not the platform-wide
      // staff_members.role — this is a roster for one tenant.
      role: row.role,
      isActive: row.staff_active === 1,
      membershipActive: row.membership_active === 1,
      activeSessionCount: row.active_session_count,
    })),
  });
});

/**
 * POST /api/platform-admin/tenants/:id/staff/:staffId/disable — lock a staff
 * member out and kill their live sessions for this tenant.
 *
 * CAUTION: staff_members is platform-wide, not per-tenant. Setting
 * is_active = 0 disables this person EVERYWHERE they hold a membership, not
 * just in :id — only the session revocation below is scoped to this tenant.
 * An operator reaching for this on a multi-tenant staff member is doing
 * something wider than the tenant page they are looking at suggests.
 */
platformAdminOperationsRoutes.post(
  '/api/platform-admin/tenants/:id/staff/:staffId/disable',
  async (c) => {
    const admin = c.get('platformAdmin');
    const tenantId = c.req.param('id');
    const staffId = c.req.param('staffId');

    // Membership is the authorization check, not just an existence check: a
    // staff id that is valid for some other tenant must not be disabled from
    // this tenant's page. No membership row implies no tenant/staff pair.
    const membership = await c.env.DB.prepare(
      `SELECT staff_id FROM tenant_staff_memberships
        WHERE tenant_id = ? AND staff_id = ? LIMIT 1`,
    ).bind(tenantId, staffId).first<{ staff_id: string }>();
    if (!membership) {
      return c.json({ success: false, error: 'Staff member not found for this tenant' }, 404);
    }

    const now = new Date().toISOString();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE staff_members SET is_active = 0, updated_at = ? WHERE id = ?`,
      ).bind(now, staffId),
      c.env.DB.prepare(
        `UPDATE tenant_admin_sessions SET revoked_at = ?
          WHERE tenant_id = ? AND staff_id = ? AND revoked_at IS NULL`,
      ).bind(now, tenantId, staffId),
      platformAdminAccessStatement(
        c.env.DB, admin.id, tenantId, 'disable_staff', 'staff', staffId,
      ),
    ]);

    return c.json({
      success: true,
      data: { staffId, sessionsRevoked: results[1].meta.changes ?? 0 },
    });
  },
);

/** POST /api/platform-admin/tenants/:id/revoke-sessions — log every tenant admin out. */
platformAdminOperationsRoutes.post('/api/platform-admin/tenants/:id/revoke-sessions', async (c) => {
  const admin = c.get('platformAdmin');
  const tenantId = c.req.param('id');
  if (!(await tenantExists(c.env.DB, tenantId))) {
    return c.json({ success: false, error: 'Tenant not found' }, 404);
  }

  // The audit detail needs the count, and the count is only known after the
  // UPDATE — so it is measured immediately before the batch. The returned
  // count is what the UPDATE actually revoked; the two differ only if someone
  // logged out in between.
  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM tenant_admin_sessions
      WHERE tenant_id = ? AND revoked_at IS NULL`,
  ).bind(tenantId).first<{ count: number }>();

  const now = new Date().toISOString();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE tenant_admin_sessions SET revoked_at = ?
        WHERE tenant_id = ? AND revoked_at IS NULL`,
    ).bind(now, tenantId),
    platformAdminAccessStatement(
      c.env.DB, admin.id, tenantId, 'revoke_tenant_sessions', 'tenant', tenantId,
      { revoked: pending?.count ?? 0 },
    ),
  ]);

  return c.json({ success: true, data: { revoked: results[0].meta.changes ?? 0 } });
});

type LineStatusRow = {
  id: string;
  name: string;
  channel_id: string;
  is_active: number;
  bot_identity_count: number;
  credential_count: number;
  last_webhook_received_at: string | null;
};

/**
 * GET /api/platform-admin/tenants/:id/line-status — is this tenant's LINE
 * wiring complete and receiving traffic?
 *
 * Presence booleans only. The channel secret, the access token and any
 * decrypted credential material never leave the Worker through this route —
 * an operator needs to know whether a credential exists, never what it is.
 */
platformAdminOperationsRoutes.get('/api/platform-admin/tenants/:id/line-status', async (c) => {
  const admin = c.get('platformAdmin');
  const tenantId = c.req.param('id');
  if (!(await tenantExists(c.env.DB, tenantId))) {
    return c.json({ success: false, error: 'Tenant not found' }, 404);
  }

  const result = await c.env.DB.prepare(
    `SELECT account.id, account.name, account.channel_id, account.is_active,
            (SELECT COUNT(*) FROM pharmacy_line_channel_identities AS identity
              WHERE identity.line_account_id = account.id) AS bot_identity_count,
            (SELECT COUNT(*) FROM pharmacy_line_credentials AS credential
              WHERE credential.tenant_id = mapping.tenant_id
                AND credential.line_account_id = account.id) AS credential_count,
            (SELECT MAX(receipt.received_at) FROM pharmacy_webhook_event_receipts AS receipt
              WHERE receipt.tenant_id = mapping.tenant_id
                AND receipt.line_account_id = account.id) AS last_webhook_received_at
       FROM tenant_line_accounts AS mapping
       INNER JOIN line_accounts AS account ON account.id = mapping.line_account_id
      WHERE mapping.tenant_id = ?
      ORDER BY account.id`,
  ).bind(tenantId).all<LineStatusRow>();

  await recordPlatformAdminAccess(c.env.DB, admin.id, tenantId, 'view_line_status');
  return c.json({
    success: true,
    data: (result.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      channelId: row.channel_id,
      isActive: row.is_active === 1,
      hasBotIdentity: row.bot_identity_count > 0,
      hasEncryptedCredential: row.credential_count > 0,
      lastWebhookReceivedAt: row.last_webhook_received_at,
    })),
  });
});

// LineClient.request takes no AbortSignal, so this race only stops US waiting;
// the subrequest itself is left to the runtime to reap.
// ponytail: race-based timeout — thread a signal through LineClient if a
// dangling subrequest ever costs anything.
function probeTimeout(): Promise<never> {
  const signal = AbortSignal.timeout(LINE_PROBE_TIMEOUT_MS);
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error(PROBE_TIMEOUT_ERROR)));
  });
}

type ProbeOutcome =
  | { ok: true; botUserId: string; displayName: string | null }
  | { ok: false; error: string };

/**
 * POST /api/platform-admin/tenants/:id/line-accounts/:lineAccountId/test-connection
 *
 * Live connectivity probe against LINE's bot-info endpoint using the tenant's
 * own stored credential. A failed probe is the normal negative result of a
 * diagnostic, so it returns 200 with ok:false — non-2xx is reserved for a bad
 * tenant/account pair or an auth failure. Error strings are fixed and short so
 * no upstream response body (and therefore no credential material) can ride
 * out in them.
 */
platformAdminOperationsRoutes.post(
  '/api/platform-admin/tenants/:id/line-accounts/:lineAccountId/test-connection',
  async (c) => {
    const admin = c.get('platformAdmin');
    const tenantId = c.req.param('id');
    const lineAccountId = c.req.param('lineAccountId');

    // Scope check before the probe: this must never reach an account that
    // belongs to a different tenant than the one being operated on.
    const mapping = await c.env.DB.prepare(
      `SELECT line_account_id FROM tenant_line_accounts
        WHERE tenant_id = ? AND line_account_id = ? LIMIT 1`,
    ).bind(tenantId, lineAccountId).first<{ line_account_id: string }>();
    if (!mapping) {
      return c.json({ success: false, error: 'LINE account not found for this tenant' }, 404);
    }

    // Same decrypt path every outbound pharmacy LINE call uses.
    const accessToken = c.env.LINE_CREDENTIAL_KEY_V1
      ? await readLineCredential(c.env.DB, c.env.LINE_CREDENTIAL_KEY_V1, {
        tenantId,
        lineAccountId,
        kind: 'channel_access_token',
      })
      : null;

    let outcome: ProbeOutcome;
    if (!accessToken) {
      outcome = { ok: false, error: 'LINE credential unavailable' };
    } else {
      try {
        const { data } = await Promise.race([
          new LineClient(accessToken).request('GET', '/v2/bot/info'),
          probeTimeout(),
        ]);
        const info = data as { displayName?: unknown };
        outcome = {
          ok: true,
          botUserId: requireLineBotUserId(data),
          displayName: typeof info.displayName === 'string' ? info.displayName : null,
        };
      } catch (error) {
        outcome = {
          ok: false,
          error: error instanceof Error && error.message === PROBE_TIMEOUT_ERROR
            ? PROBE_TIMEOUT_ERROR
            : 'LINE API request failed',
        };
      }
    }

    await recordPlatformAdminAccess(
      c.env.DB, admin.id, tenantId, 'test_line_connection', 'line_account', lineAccountId,
      outcome.ok ? { ok: true } : { ok: false, error: outcome.error },
    );
    return c.json({ success: true, data: outcome });
  },
);
