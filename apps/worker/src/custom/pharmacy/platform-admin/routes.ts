import { Hono } from 'hono';
import type { Env } from '../../../index.js';
import { resolveAdminAuthConfig } from '../../../middleware/admin-auth-config.js';
import {
  generatePlatformAdminSessionToken,
  hashTenantAdminSessionToken,
  hashTenantPassword,
  isPlatformAdminSessionToken,
  isValidAdminPassword,
  verifyTenantPassword,
} from '../provisioning/credentials.js';
import { listAccountExpectations } from '../continuity/next-intake.js';
import {
  getAdminPharmacyPatientHistory,
  listAdminPharmacyPatients,
} from '../intake/repository.js';
import { resolvePatientIntakeCryptoScope } from '../intake/envelopes.js';
import { listMynaHandoffs } from '../myna/repository.js';
import { runWebhookInboxEvent } from '../../../routes/integrations/webhook.js';
import { platformAdminAccessStatement, recordPlatformAdminAccess } from './audit.js';
import { log } from '../../../lib/log.js';
import {
  AccessGrantError,
  createAccessGrant,
  endAccessGrant,
  listActiveGrants,
  PHI_READ_SCOPE,
  requireActiveGrant,
} from './access-grant.js';
import {
  PLATFORM_ADMIN_AUTH_COOKIE,
  PLATFORM_ADMIN_CSRF_COOKIE,
  expiredPlatformAdminCookie,
  platformAdminCsrfCookie,
  platformAdminCsrfTokenFromCookie,
  platformAdminSessionCookie,
  platformAdminSessionHash,
  platformAdminSessionTokenFromCookie,
} from './auth.js';

export const platformAdminRoutes = new Hono<Env>();

// Cache-Control: no-store is set once in platformAdminAuthMiddleware, which is
// mounted on the whole /api/platform-admin/* prefix, so it covers this router
// and its two siblings (dashboard-routes.ts, operations-routes.ts) alike.

const BOOTSTRAP_SESSION_MS = 30 * 60 * 1000;
const STANDARD_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
// Same constant-shape hash the tenant login uses so an unknown login costs the
// same PBKDF2 work as a known one and cannot be distinguished by timing.
const UNKNOWN_LOGIN_PASSWORD_HASH =
  'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$7_iN48HsHUxblOLkYfnRLpCrY7dUnWGcyeEpHR_jjFc';
const TENANT_STATUSES = new Set(['active', 'suspended']);
const LOG_TYPES = ['prescription_events', 'webhook_receipts', 'platform_admin_access'] as const;
type LogType = (typeof LOG_TYPES)[number];

const TENANT_SELECT = `
  SELECT tenant.id, tenant.tenant_code, tenant.display_name, tenant.status,
         tenant.outbound_messaging_paused_at,
         (SELECT COUNT(*) FROM tenant_line_accounts AS mapping
           WHERE mapping.tenant_id = tenant.id) AS line_account_count,
         (SELECT COUNT(*) FROM tenant_staff_memberships AS membership
           WHERE membership.tenant_id = tenant.id AND membership.is_active = 1) AS staff_count,
         (SELECT COUNT(*) FROM pharmacy_webhook_event_receipts AS receipt
           WHERE receipt.tenant_id = tenant.id
             AND (receipt.status = 'failed' OR receipt.dead_lettered_at IS NOT NULL))
           AS webhook_failure_count,
         (SELECT COUNT(*) FROM tenant_line_accounts AS mapping
            INNER JOIN line_accounts AS account ON account.id = mapping.line_account_id
           WHERE mapping.tenant_id = tenant.id AND account.is_active = 1
             AND NOT EXISTS (
               SELECT 1 FROM pharmacy_line_channel_identities AS identity
                WHERE identity.line_account_id = account.id
             )) AS line_config_issue_count
    FROM tenants AS tenant`;

type TenantRow = {
  id: string;
  tenant_code: string;
  display_name: string;
  status: string;
  outbound_messaging_paused_at: string | null;
  line_account_count: number;
  staff_count: number;
  webhook_failure_count: number;
  line_config_issue_count: number;
};

function toTenant(row: TenantRow) {
  return {
    id: row.id,
    tenantCode: row.tenant_code,
    displayName: row.display_name,
    status: row.status,
    outboundMessagingPausedAt: row.outbound_messaging_paused_at,
    lineAccountCount: row.line_account_count,
    staffCount: row.staff_count,
    webhookFailureCount: row.webhook_failure_count,
    lineConfigIssueCount: row.line_config_issue_count,
  };
}

async function newSession(kind: 'bootstrap' | 'standard') {
  const token = generatePlatformAdminSessionToken();
  return {
    token,
    tokenHash: await hashTenantAdminSessionToken(token),
    kind,
    expiresAt: new Date(Date.now() +
      (kind === 'bootstrap' ? BOOTSTRAP_SESSION_MS : STANDARD_SESSION_MS)).toISOString(),
  };
}

async function lineAccountIds(db: D1Database, tenantId: string): Promise<string[]> {
  const result = await db.prepare(
    `SELECT line_account_id FROM tenant_line_accounts WHERE tenant_id = ? ORDER BY line_account_id`,
  ).bind(tenantId).all<{ line_account_id: string }>();
  return (result.results ?? []).map((row) => row.line_account_id);
}

function stringBody(value: unknown, key: string): string {
  const record = value as Record<string, unknown> | null;
  return record && typeof record[key] === 'string' ? record[key] : '';
}

function redactPatientAudit(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => row.resource_type === 'patient'
    ? { ...row, resource_id: null, detail_json: null }
    : row);
}

/**
 * POST /api/platform-admin/login — the only route the platform-admin auth
 * middleware lets through unauthenticated. Structurally identical to the
 * tenant admin login (routes/admin-auth.ts) minus the pharmacyCode selector:
 * a platform admin's login_id is globally unique because the role is not
 * scoped to a tenant.
 */
platformAdminRoutes.post('/api/platform-admin/login', async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  if (config.misconfigured) {
    console.error('[platform-admin] refused login — misconfigured topology:', config.misconfigured);
    return c.json({ success: false, error: config.misconfigured }, 500);
  }

  const body = await c.req.json().catch(() => null);
  const loginId = stringBody(body, 'loginId').trim();
  const password = stringBody(body, 'password');
  if (!loginId || !password) {
    return c.json({ success: false, error: 'Login ID and password are required' }, 400);
  }

  // is_active on both platform_admins and staff_members is part of the WHERE:
  // a revoked platform admin or a deactivated staff member simply has no row,
  // and falls into the same timing-safe rejection as an unknown login.
  const row = await c.env.DB.prepare(
    `SELECT credential.staff_id, credential.password_hash,
            credential.must_change_password, credential.credential_version,
            staff.name
       FROM platform_admin_credentials AS credential
       INNER JOIN platform_admins AS admin
               ON admin.staff_id = credential.staff_id AND admin.is_active = 1
       INNER JOIN staff_members AS staff
               ON staff.id = credential.staff_id AND staff.is_active = 1
      WHERE credential.login_id = ? COLLATE NOCASE
      LIMIT 1`,
  ).bind(loginId).first<{
    staff_id: string;
    password_hash: string;
    must_change_password: number;
    credential_version: number;
    name: string;
  }>();
  const passwordValid = await verifyTenantPassword(
    password,
    row?.password_hash ?? UNKNOWN_LOGIN_PASSWORD_HASH,
  );
  if (!row || !passwordValid) {
    log('auth.login_failed', {
      realm: 'platform_admin',
      ip: c.req.header('cf-connecting-ip'),
      reason: row ? 'bad_password' : 'unknown_login',
      platform_admin_id: row?.staff_id,
    }, 'warn');
    // The audit table requires a real platform_admin_id, so only a known
    // admin's failed attempt can be recorded there; unknown logins stay log-only.
    if (row) await recordPlatformAdminAccess(c.env.DB, row.staff_id, null, 'login_failed');
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const csrfToken = crypto.randomUUID();
  const session = await newSession(row.must_change_password === 1 ? 'bootstrap' : 'standard');
  await c.env.DB.prepare(
    `INSERT INTO platform_admin_sessions
      (token_hash, staff_id, credential_version, session_kind,
       expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(
    session.tokenHash, row.staff_id, row.credential_version,
    session.kind, session.expiresAt, new Date().toISOString(),
  ).run();
  await recordPlatformAdminAccess(c.env.DB, row.staff_id, null, 'login');

  c.header('Set-Cookie', platformAdminSessionCookie(session.token, config.sameSite), { append: true });
  c.header('Set-Cookie', platformAdminCsrfCookie(csrfToken, config.sameSite), { append: true });
  return c.json({
    success: true,
    data: {
      id: row.staff_id,
      name: row.name,
      mustChangePassword: row.must_change_password === 1,
    },
    csrfToken,
  });
});

platformAdminRoutes.post('/api/platform-admin/logout', async (c) => {
  const { sameSite } = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  const admin = c.get('platformAdmin');
  const token = platformAdminSessionTokenFromCookie(c);
  if (token && isPlatformAdminSessionToken(token)) {
    const tokenHash = await hashTenantAdminSessionToken(token);
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE platform_admin_sessions SET revoked_at = ?
          WHERE token_hash IN (
            SELECT family_session.token_hash
              FROM platform_admin_sessions AS current_session
              INNER JOIN platform_admin_sessions AS family_session
                      ON family_session.staff_id = current_session.staff_id
                     AND COALESCE(family_session.session_family_hash, family_session.token_hash) =
                         COALESCE(current_session.session_family_hash, current_session.token_hash)
             WHERE current_session.token_hash = ?
          )
            AND revoked_at IS NULL`,
      ).bind(now, tokenHash),
      // Logging out must not leave break-glass PHI access open behind you —
      // an open grant otherwise survives the session by up to MAX_GRANT_MINUTES.
      c.env.DB.prepare(
        `UPDATE platform_admin_access_grants
            SET revoked_at = ?, revoked_by = ?
          WHERE platform_admin_id = ?
            AND session_token_hash IN (
              SELECT family_session.token_hash
                FROM platform_admin_sessions AS current_session
                INNER JOIN platform_admin_sessions AS family_session
                        ON family_session.staff_id = current_session.staff_id
                       AND COALESCE(family_session.session_family_hash, family_session.token_hash) =
                           COALESCE(current_session.session_family_hash, current_session.token_hash)
               WHERE current_session.token_hash = ?
            )
            AND revoked_at IS NULL`,
      ).bind(now, admin.id, admin.id, tokenHash),
      platformAdminAccessStatement(c.env.DB, admin.id, null, 'logout'),
    ]);
    // Deliberately NOT best-effort any more: swallowing a failure here would
    // clear the cookies and answer "logged out" while the session and its
    // open PHI grant both stayed live. A 500 the operator can retry is the
    // safer answer.
  }
  c.header('Set-Cookie', expiredPlatformAdminCookie(PLATFORM_ADMIN_AUTH_COOKIE, sameSite), { append: true });
  c.header('Set-Cookie', expiredPlatformAdminCookie(PLATFORM_ADMIN_CSRF_COOKIE, sameSite), { append: true });
  return c.json({ success: true, data: null });
});

/**
 * GET /api/platform-admin/session — self-check only. Deliberately writes no
 * access event: reading your own identity is not tenant-data access.
 */
platformAdminRoutes.get('/api/platform-admin/session', async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  let csrfToken = platformAdminCsrfTokenFromCookie(c);
  if (!csrfToken) {
    csrfToken = crypto.randomUUID();
    c.header('Set-Cookie', platformAdminCsrfCookie(csrfToken, config.sameSite), { append: true });
  }
  const admin = c.get('platformAdmin');
  const credential = await c.env.DB.prepare(
    `SELECT must_change_password FROM platform_admin_credentials WHERE staff_id = ? LIMIT 1`,
  ).bind(admin.id).first<{ must_change_password: number }>();
  return c.json({
    success: true,
    data: { ...admin, mustChangePassword: credential?.must_change_password === 1 },
    csrfToken,
  });
});

platformAdminRoutes.post('/api/platform-admin/change-password', async (c) => {
  const admin = c.get('platformAdmin');
  const sessionTokenHash = await platformAdminSessionHash(c);
  if (!sessionTokenHash) {
    return c.json({ success: false, error: 'Password session required' }, 403);
  }
  const body = await c.req.json().catch(() => null);
  const currentPassword = stringBody(body, 'currentPassword');
  const newPassword = stringBody(body, 'newPassword');
  if (!isValidAdminPassword(newPassword)) {
    return c.json({ success: false, error: 'New password must be 12 to 128 characters' }, 400);
  }
  if (newPassword === currentPassword) {
    return c.json({ success: false, error: 'New password must differ from the current password' }, 400);
  }

  const credential = await c.env.DB.prepare(
    `SELECT password_hash, credential_version
       FROM platform_admin_credentials WHERE staff_id = ? LIMIT 1`,
  ).bind(admin.id).first<{ password_hash: string; credential_version: number }>();
  if (!credential || !(await verifyTenantPassword(currentPassword, credential.password_hash))) {
    log('auth.password_change_failed', {
      realm: 'platform_admin', platform_admin_id: admin.id, reason: 'bad_current_password',
    }, 'warn');
    return c.json({ success: false, error: 'Current password is incorrect' }, 401);
  }

  const passwordHash = await hashTenantPassword(newPassword);
  const nextCredentialVersion = credential.credential_version + 1;
  const session = await newSession('standard');
  const now = new Date().toISOString();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE platform_admin_credentials
          SET password_hash = ?, must_change_password = 0,
              credential_version = credential_version + 1, updated_at = ?
        WHERE staff_id = ? AND credential_version = ?
          AND EXISTS (
            SELECT 1
              FROM platform_admins AS platform_admin
              INNER JOIN staff_members AS staff
                      ON staff.id = platform_admin.staff_id
             WHERE platform_admin.staff_id = ?
               AND platform_admin.is_active = 1
               AND staff.is_active = 1
          )
          AND EXISTS (
            SELECT 1 FROM platform_admin_sessions AS current_session
             WHERE current_session.token_hash = ?
               AND current_session.staff_id = ?
               AND current_session.credential_version = ?
               AND current_session.revoked_at IS NULL
               AND current_session.expires_at > ?
          )`,
    ).bind(
      passwordHash, now, admin.id, credential.credential_version, admin.id,
      sessionTokenHash, admin.id, credential.credential_version, now,
    ),
    c.env.DB.prepare(
      `INSERT INTO platform_admin_sessions
         (token_hash, session_family_hash, staff_id, credential_version, session_kind,
          expires_at, revoked_at, created_at)
       SELECT ?, COALESCE(current_session.session_family_hash, current_session.token_hash),
              ?, ?, 'standard', ?, NULL, ?
         FROM platform_admin_sessions AS current_session
        WHERE current_session.token_hash = ?
          AND current_session.staff_id = ?
          AND current_session.credential_version = ?
          AND current_session.revoked_at IS NULL
          AND current_session.expires_at > ?
          AND EXISTS (
          SELECT 1 FROM platform_admin_credentials AS current_credential
           WHERE current_credential.staff_id = ?
             AND current_credential.credential_version = ?
             AND current_credential.password_hash = ?
             AND current_credential.updated_at = ?
          )`,
    ).bind(
      session.tokenHash, admin.id, nextCredentialVersion,
      session.expiresAt, now,
      sessionTokenHash, admin.id, credential.credential_version, now,
      admin.id, nextCredentialVersion, passwordHash, now,
    ),
    // Every session issued against the old credential version dies with it.
    c.env.DB.prepare(
      `UPDATE platform_admin_sessions
          SET revoked_at = ?
        WHERE staff_id = ? AND revoked_at IS NULL AND credential_version <= ?
          AND EXISTS (
            SELECT 1 FROM platform_admin_credentials AS current_credential
             WHERE current_credential.staff_id = ?
               AND current_credential.credential_version = ?
               AND current_credential.password_hash = ?
               AND current_credential.updated_at = ?
          )`,
    ).bind(
      now, admin.id, credential.credential_version,
      admin.id, nextCredentialVersion, passwordHash, now,
    ),
    // A stale session must not keep an open support-mode grant alive either.
    c.env.DB.prepare(
      `UPDATE platform_admin_access_grants
          SET revoked_at = ?, revoked_by = ?
        WHERE platform_admin_id = ? AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM platform_admin_credentials AS current_credential
             WHERE current_credential.staff_id = ?
               AND current_credential.credential_version = ?
               AND current_credential.password_hash = ?
               AND current_credential.updated_at = ?
          )`,
    ).bind(
      now, admin.id, admin.id,
      admin.id, nextCredentialVersion, passwordHash, now,
    ),
    c.env.DB.prepare(
      `INSERT INTO platform_admin_access_events
         (id, platform_admin_id, tenant_id, action, resource_type, resource_id,
          detail_json, created_at)
       SELECT ?, ?, NULL, 'change_password', NULL, NULL, NULL, ?
        WHERE EXISTS (
          SELECT 1 FROM platform_admin_credentials AS current_credential
           WHERE current_credential.staff_id = ?
             AND current_credential.credential_version = ?
             AND current_credential.password_hash = ?
             AND current_credential.updated_at = ?
        )`,
    ).bind(
      crypto.randomUUID(), admin.id, now,
      admin.id, nextCredentialVersion, passwordHash, now,
    ),
  ]);
  if (results[0].meta.changes !== 1) {
    return c.json({ success: false, error: 'Credential changed concurrently' }, 409);
  }
  log('auth.password_changed', { realm: 'platform_admin', platform_admin_id: admin.id });

  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  const csrfToken = crypto.randomUUID();
  c.header('Set-Cookie', platformAdminSessionCookie(session.token, config.sameSite), { append: true });
  c.header('Set-Cookie', platformAdminCsrfCookie(csrfToken, config.sameSite), { append: true });
  return c.json({ success: true, data: { mustChangePassword: false }, csrfToken });
});

platformAdminRoutes.get('/api/platform-admin/tenants', async (c) => {
  const admin = c.get('platformAdmin');
  const result = await c.env.DB.prepare(
    `${TENANT_SELECT} ORDER BY tenant.tenant_code`,
  ).all<TenantRow>();
  await recordPlatformAdminAccess(c.env.DB, admin.id, null, 'list_tenants');
  return c.json({ success: true, data: (result.results ?? []).map(toTenant) });
});

platformAdminRoutes.get('/api/platform-admin/tenants/:id', async (c) => {
  const admin = c.get('platformAdmin');
  const tenantId = c.req.param('id');
  const tenant = await c.env.DB.prepare(
    `${TENANT_SELECT} WHERE tenant.id = ? LIMIT 1`,
  ).bind(tenantId).first<TenantRow>();
  if (!tenant) return c.json({ success: false, error: 'Tenant not found' }, 404);

  const accounts = await c.env.DB.prepare(
    `SELECT account.id, account.name, account.channel_id, account.is_active
       FROM tenant_line_accounts AS mapping
       INNER JOIN line_accounts AS account ON account.id = mapping.line_account_id
      WHERE mapping.tenant_id = ?
      ORDER BY account.id`,
  ).bind(tenantId).all<{ id: string; name: string; channel_id: string; is_active: number }>();
  await recordPlatformAdminAccess(c.env.DB, admin.id, tenantId, 'view_tenant', 'tenant', tenantId);
  return c.json({
    success: true,
    data: { ...toTenant(tenant), lineAccounts: accounts.results ?? [] },
  });
});

/**
 * PATCH /api/platform-admin/tenants/:id — displayName and status only.
 * tenant_code is the immutable tenant identifier every scoping query and
 * every operator runbook keys off, so it is not editable here.
 */
platformAdminRoutes.patch('/api/platform-admin/tenants/:id', async (c) => {
  const admin = c.get('platformAdmin');
  const tenantId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ success: false, error: 'Invalid tenant update' }, 400);
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length === 0 || keys.some((key) => key !== 'displayName' && key !== 'status')) {
    return c.json({ success: false, error: 'Only displayName and status can be edited' }, 400);
  }
  const record = body as { displayName?: unknown; status?: unknown };
  const displayName = 'displayName' in record
    ? (typeof record.displayName === 'string' ? record.displayName.trim() : '')
    : null;
  if (displayName !== null && (!displayName || displayName.length > 120)) {
    return c.json({ success: false, error: 'displayName must be 1 to 120 characters' }, 400);
  }
  const status = 'status' in record
    ? (typeof record.status === 'string' ? record.status : '')
    : null;
  if (status !== null && !TENANT_STATUSES.has(status)) {
    return c.json({ success: false, error: 'status must be active or suspended' }, 400);
  }

  const current = await c.env.DB.prepare(
    `SELECT display_name, status FROM tenants WHERE id = ? LIMIT 1`,
  ).bind(tenantId).first<{ display_name: string; status: string }>();
  if (!current) return c.json({ success: false, error: 'Tenant not found' }, 404);

  const after = {
    displayName: displayName ?? current.display_name,
    status: status ?? current.status,
  };
  const before = {
    ...(displayName === null ? {} : { displayName: current.display_name }),
    ...(status === null ? {} : { status: current.status }),
  };
  const changed = {
    ...(displayName === null ? {} : { displayName: after.displayName }),
    ...(status === null ? {} : { status: after.status }),
  };
  const now = new Date().toISOString();
  // One batch so the edit and its access event commit together — an edit that
  // survives without its audit row is exactly what this table exists to prevent.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE tenants SET display_name = ?, status = ?, updated_at = ? WHERE id = ?`,
    ).bind(after.displayName, after.status, now, tenantId),
    platformAdminAccessStatement(
      c.env.DB, admin.id, tenantId, 'edit_tenant', 'tenant', tenantId,
      { before, after: changed },
    ),
  ]);
  if (results[0].meta.changes !== 1) {
    return c.json({ success: false, error: 'Tenant changed concurrently' }, 409);
  }
  return c.json({ success: true, data: { id: tenantId, ...after } });
});

/**
 * POST /api/platform-admin/tenants/:id/outbound-messaging — hold or resume
 * every proactive LINE push to this tenant's patients ("LINE送信一時停止").
 * Inbound webhook processing is deliberately untouched: a paused tenant still
 * receives and stores messages and events, it just stops sending. The single
 * enforcement point is sendPharmacyAutomatedPush() in growth-loop/sender.ts.
 */
platformAdminRoutes.post('/api/platform-admin/tenants/:id/outbound-messaging', async (c) => {
  const admin = c.get('platformAdmin');
  const tenantId = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { paused?: unknown } | null;
  if (typeof body?.paused !== 'boolean') {
    return c.json({ success: false, error: 'paused must be a boolean' }, 400);
  }
  // Existence is checked before the batch, not from meta.changes: D1 rolls a
  // batch back on SQL error only, so an UPDATE that matches no row would still
  // commit its audit event and leave a record of a tenant that never existed.
  const exists = await c.env.DB.prepare(`SELECT id FROM tenants WHERE id = ? LIMIT 1`)
    .bind(tenantId).first<{ id: string }>();
  if (!exists) return c.json({ success: false, error: 'Tenant not found' }, 404);

  const now = new Date().toISOString();
  const pausedAt = body.paused ? now : null;
  // Same batch as the audit event, like every other tenant mutation here.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE tenants SET outbound_messaging_paused_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(pausedAt, now, tenantId),
    platformAdminAccessStatement(
      c.env.DB, admin.id, tenantId,
      body.paused ? 'pause_outbound_messaging' : 'resume_outbound_messaging',
      'tenant', tenantId,
    ),
  ]);
  if (results[0].meta.changes !== 1) {
    return c.json({ success: false, error: 'Tenant changed concurrently' }, 409);
  }
  return c.json({ success: true, data: { id: tenantId, outboundMessagingPausedAt: pausedAt } });
});

/**
 * POST /api/platform-admin/tenants/:id/webhook-events/:webhookEventId/retry —
 * manual replay for a durable-inbox row the automation has given up on.
 * Only `failed`/dead-lettered rows are eligible: `pending` and lease-expired
 * rows are already owned by the cron sweep, and replaying a `completed` row
 * would re-apply side effects the dedup claim exists to prevent.
 */
platformAdminRoutes.post(
  '/api/platform-admin/tenants/:id/webhook-events/:webhookEventId/retry',
  async (c) => {
    const admin = c.get('platformAdmin');
    const tenantId = c.req.param('id');
    const webhookEventId = c.req.param('webhookEventId');

    // tenant_id is part of the WHERE, so a receipt belonging to another tenant
    // is indistinguishable from one that does not exist.
    const receipt = await c.env.DB.prepare(
      `SELECT tenant_id, line_account_id, webhook_event_id, payload, status, dead_lettered_at
         FROM pharmacy_webhook_event_receipts
        WHERE tenant_id = ? AND webhook_event_id = ?
        LIMIT 1`,
    ).bind(tenantId, webhookEventId).first<{
      tenant_id: string;
      line_account_id: string;
      webhook_event_id: string;
      payload: string | null;
      status: string;
      dead_lettered_at: string | null;
    }>();
    if (!receipt) return c.json({ success: false, error: 'Webhook event not found' }, 404);
    if (receipt.status !== 'failed' && !receipt.dead_lettered_at) {
      return c.json({
        success: false,
        error: `Only failed or dead-lettered events can be retried by hand (status: ${receipt.status})`,
      }, 400);
    }

    // The eligibility check above reads; this claims. Repeating the predicate
    // in the UPDATE is what makes the claim atomic: a duplicate retry, or one
    // racing the cron sweep, matches 0 rows and 409s instead of clearing a
    // lease somebody else already holds.
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE pharmacy_webhook_event_receipts
            SET status = 'pending', retry_count = 0,
                dead_lettered_at = NULL, claim_token = NULL, lease_until = NULL
          WHERE tenant_id = ? AND line_account_id = ? AND webhook_event_id = ?
            AND (status = 'failed' OR dead_lettered_at IS NOT NULL)`,
      ).bind(receipt.tenant_id, receipt.line_account_id, receipt.webhook_event_id),
      platformAdminAccessStatement(
        c.env.DB, admin.id, tenantId, 'retry_webhook_event', 'webhook_event', webhookEventId,
        { lineAccountId: receipt.line_account_id, previousStatus: receipt.status },
      ),
    ]);
    if (results[0].meta.changes !== 1) {
      return c.json({ success: false, error: 'Webhook event changed concurrently' }, 409);
    }

    // Reuse the one processing path the request handler and cron sweep share;
    // it re-leases the row and settles it as completed or failed on its own.
    const outcome = await runWebhookInboxEvent({
      db: c.env.DB,
      credentialRootSecret: c.env.LINE_CREDENTIAL_KEY_V1 ?? '',
      workerUrl: c.env.WORKER_URL || new URL(c.req.url).origin,
      liffUrl: c.env.LIFF_URL,
      r2: c.env.IMAGES,
    }, {
      tenant_id: receipt.tenant_id,
      line_account_id: receipt.line_account_id,
      webhook_event_id: receipt.webhook_event_id,
      payload: receipt.payload,
    });
    return c.json({ success: true, data: { webhookEventId, outcome } });
  },
);

/**
 * POST /api/platform-admin/tenants/:id/support-grants — start support mode
 * for one tenant. Requires the caller's CURRENT password again (step-up)
 * even with a valid session; see access-grant.ts for why this is a stand-in
 * for MFA rather than MFA itself.
 */
platformAdminRoutes.post('/api/platform-admin/tenants/:id/support-grants', async (c) => {
  const admin = c.get('platformAdmin');
  const tenantId = c.req.param('id');
  const body = await c.req.json().catch(() => null) as {
    reason?: unknown; ticketReference?: unknown; scopes?: unknown;
    currentPassword?: unknown; durationMinutes?: unknown;
  } | null;
  try {
    const grant = await createAccessGrant(c.env.DB, admin.id, tenantId, {
      reason: typeof body?.reason === 'string' ? body.reason : '',
      ticketReference: typeof body?.ticketReference === 'string' ? body.ticketReference : null,
      scopes: Array.isArray(body?.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [],
      currentPassword: typeof body?.currentPassword === 'string' ? body.currentPassword : '',
      durationMinutes: typeof body?.durationMinutes === 'number' ? body.durationMinutes : undefined,
      sessionTokenHash: await platformAdminSessionHash(c),
    });
    return c.json({ success: true, data: grant }, 201);
  } catch (error) {
    if (error instanceof AccessGrantError) return c.json({ success: false, error: error.message }, error.status);
    throw error;
  }
});

platformAdminRoutes.post('/api/platform-admin/support-grants/:grantId/end', async (c) => {
  const admin = c.get('platformAdmin');
  const ended = await endAccessGrant(
    c.env.DB, admin.id, c.req.param('grantId'), await platformAdminSessionHash(c),
  );
  if (!ended) return c.json({ success: false, error: 'Grant not found or already ended' }, 404);
  return c.json({ success: true, data: null });
});

/** The caller session's active grants — drives the UI countdown banner. */
platformAdminRoutes.get('/api/platform-admin/support-grants/active', async (c) => {
  const admin = c.get('platformAdmin');
  return c.json({
    success: true,
    data: await listActiveGrants(c.env.DB, admin.id, await platformAdminSessionHash(c)),
  });
});

platformAdminRoutes.get('/api/platform-admin/tenants/:id/patients', async (c) => {
  const admin = c.get('platformAdmin');
  const tenantId = c.req.param('id');
  try {
    await requireActiveGrant(
      c.env.DB, admin.id, tenantId, PHI_READ_SCOPE, await platformAdminSessionHash(c),
    );
  } catch (error) {
    if (error instanceof AccessGrantError) return c.json({ success: false, error: error.message }, error.status);
    throw error;
  }
  const accounts = await lineAccountIds(c.env.DB, tenantId);
  const perAccount = await Promise.all(accounts.map(async (lineAccountId) =>
    (await listAdminPharmacyPatients(c.env.DB, lineAccountId))
      .map((patient) => ({ lineAccountId, ...patient }))));
  await recordPlatformAdminAccess(c.env.DB, admin.id, tenantId, 'list_patients');
  return c.json({ success: true, data: perAccount.flat() });
});

/**
 * GET /api/platform-admin/tenants/:id/patients/:patientId — full PHI view.
 * Pure orchestration over the existing account-scoped admin repositories; the
 * account is resolved from the tenant mapping, never from a request parameter.
 * Requires an active support-mode grant for :id with phi:read — a valid
 * platform-admin session alone is no longer sufficient to reach this data.
 */
platformAdminRoutes.get('/api/platform-admin/tenants/:id/patients/:patientId', async (c) => {
  const admin = c.get('platformAdmin');
  const tenantId = c.req.param('id');
  const patientId = c.req.param('patientId');
  try {
    await requireActiveGrant(
      c.env.DB, admin.id, tenantId, PHI_READ_SCOPE, await platformAdminSessionHash(c),
    );
  } catch (error) {
    if (error instanceof AccessGrantError) return c.json({ success: false, error: error.message }, error.status);
    throw error;
  }
  const cryptoScope = resolvePatientIntakeCryptoScope(c.env, tenantId);
  if (!cryptoScope) {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }

  let lineAccountId: string | null = null;
  let history: Awaited<ReturnType<typeof getAdminPharmacyPatientHistory>> = null;
  for (const candidate of await lineAccountIds(c.env.DB, tenantId)) {
    history = await getAdminPharmacyPatientHistory(c.env.DB, candidate, patientId, cryptoScope);
    if (history) {
      lineAccountId = candidate;
      break;
    }
  }
  if (!history || !lineAccountId) {
    return c.json({ success: false, error: 'Patient not found' }, 404);
  }

  // The patient filter goes into the SQL, not a .filter() on the result:
  // listMynaHandoffs pages at LIMIT 100, so filtering afterwards silently
  // drops this patient's handoffs on a busy account — an incomplete clinical
  // record rather than a cosmetic bug.
  const [expectations, handoffs] = await Promise.all([
    listAccountExpectations(c.env.DB, lineAccountId),
    listMynaHandoffs(c.env.DB, lineAccountId, undefined, patientId),
  ]);
  await recordPlatformAdminAccess(
    c.env.DB, admin.id, tenantId, 'view_patient', 'patient', null,
  );
  return c.json({
    success: true,
    data: {
      lineAccountId,
      ...history,
      nextIntakeExpectations: expectations.filter((item) => item.patient_id === patientId),
      mynaHandoffs: handoffs,
    },
  });
});

platformAdminRoutes.get('/api/platform-admin/logs', async (c) => {
  const admin = c.get('platformAdmin');
  const type = c.req.query('type') ?? null;
  if (type !== null && !LOG_TYPES.includes(type as LogType)) {
    return c.json({ success: false, error: 'Unknown log type' }, 400);
  }
  const tenantId = c.req.query('tenantId') || null;
  const since = c.req.query('since') || null;
  const limit = Math.min(200, Math.max(1, Number.parseInt(c.req.query('limit') ?? '', 10) || 50));
  const wanted = type ? [type as LogType] : LOG_TYPES;
  const filters = [tenantId, tenantId, since, since, limit];

  const data: Record<string, unknown> = {};
  if (wanted.includes('prescription_events')) {
    const result = await c.env.DB.prepare(
      `SELECT event.id, event.submission_id, event.event_type, event.actor_type,
              event.from_status, event.to_status, event.created_at,
              mapping.tenant_id, submission.line_account_id
         FROM pharmacy_prescription_events AS event
         INNER JOIN pharmacy_prescription_submissions AS submission
                 ON submission.id = event.submission_id
         INNER JOIN tenant_line_accounts AS mapping
                 ON mapping.line_account_id = submission.line_account_id
        WHERE (? IS NULL OR mapping.tenant_id = ?)
          AND (? IS NULL OR event.created_at >= ?)
        ORDER BY event.created_at DESC, event.id DESC
        LIMIT ?`,
    ).bind(...filters).all();
    data.prescriptionEvents = result.results ?? [];
  }
  if (wanted.includes('webhook_receipts')) {
    const result = await c.env.DB.prepare(
      `SELECT tenant_id, line_account_id, webhook_event_id, received_at,
              status, retry_count, dead_lettered_at
         FROM pharmacy_webhook_event_receipts
        WHERE (? IS NULL OR tenant_id = ?)
          AND (? IS NULL OR received_at >= ?)
        ORDER BY received_at DESC
        LIMIT ?`,
    ).bind(...filters).all();
    data.webhookReceipts = result.results ?? [];
  }
  if (wanted.includes('platform_admin_access')) {
    const result = await c.env.DB.prepare(
      `SELECT id, platform_admin_id, tenant_id, action, resource_type,
              resource_id, detail_json, created_at
         FROM platform_admin_access_events
        WHERE (? IS NULL OR tenant_id = ?)
          AND (? IS NULL OR created_at >= ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...filters).all<Record<string, unknown>>();
    data.platformAdminAccess = redactPatientAudit(result.results ?? []);
  }

  await recordPlatformAdminAccess(
    c.env.DB, admin.id, tenantId, 'view_logs', undefined, undefined,
    { type: type ?? 'all', since, limit },
  );
  return c.json({ success: true, data });
});

/**
 * GET /api/platform-admin/audit — the caller's own access history, or every
 * platform admin's with ?all=true (more than one platform admin may exist and
 * they oversee each other). Viewing your OWN trail records no event of its
 * own (appending to the trail you are reading makes the trail unreadable,
 * and it exposes no tenant data). Viewing ?all=true DOES record an event —
 * who is watching whom is itself accountability-relevant.
 */
platformAdminRoutes.get('/api/platform-admin/audit', async (c) => {
  const admin = c.get('platformAdmin');
  const all = c.req.query('all') === 'true';
  const limit = Math.min(200, Math.max(1, Number.parseInt(c.req.query('limit') ?? '', 10) || 50));
  if (all) {
    await recordPlatformAdminAccess(c.env.DB, admin.id, null, 'view_audit_all');
  }
  const result = await c.env.DB.prepare(
    `SELECT id, platform_admin_id, tenant_id, action, resource_type,
            resource_id, detail_json, created_at
       FROM platform_admin_access_events
      WHERE (? = 1 OR platform_admin_id = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  ).bind(all ? 1 : 0, admin.id, limit).all<Record<string, unknown>>();
  return c.json({ success: true, data: redactPatientAudit(result.results ?? []) });
});
