import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  ADMIN_AUTH_COOKIE,
  CSRF_COOKIE,
  TENANT_COOKIE,
  adminSessionCookie,
  adminSessionTokenFromCookie,
  csrfCookie,
  csrfTokenFromCookie,
  expiredCookie,
  tenantSessionCookie,
} from '../middleware/auth.js';
import { resolveAdminAuthConfig } from '../middleware/admin-auth-config.js';
import {
  generateTenantAdminSessionToken,
  hashTenantAdminSessionToken,
  hashTenantPassword,
  isTenantAdminSessionToken,
  isValidAdminPassword,
  verifyTenantPassword,
} from '../custom/pharmacy/provisioning/credentials.js';

export const adminAuth = new Hono<Env>();
const BOOTSTRAP_SESSION_MS = 30 * 60 * 1000;
const STANDARD_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const UNKNOWN_LOGIN_PASSWORD_HASH =
  'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$7_iN48HsHUxblOLkYfnRLpCrY7dUnWGcyeEpHR_jjFc';

async function newSession(kind: 'bootstrap' | 'standard') {
  const token = generateTenantAdminSessionToken();
  return {
    token,
    tokenHash: await hashTenantAdminSessionToken(token),
    kind,
    expiresAt: new Date(Date.now() +
      (kind === 'bootstrap' ? BOOTSTRAP_SESSION_MS : STANDARD_SESSION_MS)).toISOString(),
  };
}

/**
 * POST /api/auth/login
 *
 * Validates a tenant login/password, then issues:
 *   - lh_admin_session (HttpOnly) — an opaque session, never exposed to JS.
 *   - lh_csrf (readable) — the double-submit CSRF token, also returned in the
 *     body so a cross-site SPA (which cannot read the API's cookie) can echo it
 *     back via the X-CSRF-Token header.
 *
 * Refuses with a clear error when the topology cannot deliver the cookie,
 * turning the silent "login breaks after deploy" failure into an actionable
 * configuration error.
 */
adminAuth.post('/api/auth/login', async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  if (config.misconfigured) {
    console.error('[admin-auth] refused login — misconfigured topology:', config.misconfigured);
    return c.json({ success: false, error: config.misconfigured }, 500);
  }

  const body = await c.req
    .json<{ pharmacyCode?: string; loginId?: string; password?: string }>()
    .catch(() => ({}) as {
      pharmacyCode?: string;
      loginId?: string;
      password?: string;
    });
  const pharmacyCode = typeof body?.pharmacyCode === 'string' ? body.pharmacyCode.trim() : '';
  if (!pharmacyCode) {
    return c.json({ success: false, error: 'Pharmacy code is required' }, 400);
  }
  const loginId = typeof body?.loginId === 'string' ? body.loginId.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!loginId || !password) {
    return c.json({ success: false, error: 'Login ID and password are required' }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT tenant.id, tenant.tenant_code, tenant.display_name,
            credential.staff_id, credential.login_id, credential.password_hash,
            credential.must_change_password, credential.credential_version,
            staff.name, membership.role
       FROM tenant_admin_credentials AS credential
       INNER JOIN tenants AS tenant
               ON tenant.id = credential.tenant_id AND tenant.status = 'active'
       INNER JOIN staff_members AS staff
               ON staff.id = credential.staff_id AND staff.is_active = 1
       INNER JOIN tenant_staff_memberships AS membership
               ON membership.tenant_id = credential.tenant_id
              AND membership.staff_id = credential.staff_id
              AND membership.is_active = 1
      WHERE tenant.tenant_code = ? COLLATE NOCASE
        AND credential.login_id = ? COLLATE NOCASE
      LIMIT 1`,
  ).bind(pharmacyCode, loginId).first<{
    id: string;
    tenant_code: string;
    display_name: string;
    staff_id: string;
    login_id: string;
    password_hash: string;
    must_change_password: number;
    credential_version: number;
    name: string;
    role: 'owner' | 'admin' | 'staff';
  }>();
  const passwordValid = await verifyTenantPassword(
    password,
    row?.password_hash ?? UNKNOWN_LOGIN_PASSWORD_HASH,
  );
  if (!row || !passwordValid) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const csrfToken = crypto.randomUUID();
  const session = await newSession(row.must_change_password === 1 ? 'bootstrap' : 'standard');
  await c.env.DB.prepare(
    `INSERT INTO tenant_admin_sessions
      (token_hash, tenant_id, staff_id, credential_version, session_kind,
       expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(
    session.tokenHash, row.id, row.staff_id, row.credential_version,
    session.kind, session.expiresAt, new Date().toISOString(),
  ).run();
  c.header('Set-Cookie', adminSessionCookie(session.token, config.sameSite), { append: true });
  c.header('Set-Cookie', tenantSessionCookie(row.id, config.sameSite), { append: true });
  c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
  return c.json({
    success: true,
    data: {
      id: row.staff_id,
      name: row.name,
      role: row.role,
      tenantId: row.id,
      tenantCode: row.tenant_code,
      tenantName: row.display_name,
      mustChangePassword: row.must_change_password === 1,
    },
    csrfToken,
  });
});

adminAuth.post('/api/auth/change-password', async (c) => {
  if (c.get('authMethod') !== 'password') {
    return c.json({ success: false, error: 'Password session required' }, 403);
  }
  const body = await c.req
    .json<{ currentPassword?: string; newPassword?: string }>()
    .catch(() => ({}) as { currentPassword?: string; newPassword?: string });
  const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
  if (!isValidAdminPassword(newPassword)) {
    return c.json({ success: false, error: 'New password must be 12 to 128 characters' }, 400);
  }

  const tenantId = c.get('tenantId');
  const staffId = c.get('staff').id;
  const credentialVersion = c.get('credentialVersion');
  if (!credentialVersion) {
    return c.json({ success: false, error: 'Password session required' }, 403);
  }
  const credential = await c.env.DB.prepare(
    `SELECT credential.password_hash, credential.credential_version
       FROM tenant_admin_credentials AS credential
      WHERE credential.tenant_id = ?
        AND credential.staff_id = ?
        AND credential.credential_version = ?
      LIMIT 1`,
  ).bind(tenantId, staffId, credentialVersion).first<{
    password_hash: string;
    credential_version: number;
  }>();
  if (!credential || !(await verifyTenantPassword(currentPassword, credential.password_hash))) {
    return c.json({ success: false, error: 'Current password is incorrect' }, 401);
  }
  if (newPassword === currentPassword) {
    return c.json({ success: false, error: 'New password must differ from the temporary password' }, 400);
  }

  const now = new Date().toISOString();
  const passwordHash = await hashTenantPassword(newPassword);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE tenant_admin_credentials
          SET password_hash = ?, must_change_password = 0,
              credential_version = credential_version + 1, updated_at = ?
        WHERE tenant_id = ? AND staff_id = ? AND credential_version = ?`,
    ).bind(passwordHash, now, tenantId, staffId, credentialVersion),
    c.env.DB.prepare(
      `UPDATE tenant_admin_sessions
          SET revoked_at = ?
        WHERE tenant_id = ? AND staff_id = ? AND revoked_at IS NULL
          AND credential_version <= ?`,
    ).bind(now, tenantId, staffId, credentialVersion),
  ]);
  if (results[0].meta.changes !== 1) {
    return c.json({ success: false, error: 'Credential changed concurrently' }, 409);
  }

  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  const csrfToken = crypto.randomUUID();
  const session = await newSession('standard');
  await c.env.DB.prepare(
    `INSERT INTO tenant_admin_sessions
      (token_hash, tenant_id, staff_id, credential_version, session_kind,
       expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, 'standard', ?, NULL, ?)`,
  ).bind(
    session.tokenHash, tenantId, staffId, credentialVersion + 1,
    session.expiresAt, now,
  ).run();
  c.header('Set-Cookie', adminSessionCookie(session.token, config.sameSite), { append: true });
  c.header('Set-Cookie', tenantSessionCookie(tenantId, config.sameSite), { append: true });
  c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
  return c.json({ success: true, data: { mustChangePassword: false }, csrfToken });
});

/**
 * POST /api/auth/logout — clears both cookies. No CSRF required: clearing your
 * own session is not a meaningful CSRF target, and this keeps logout resilient
 * even if the CSRF token was lost client-side.
 */
adminAuth.post('/api/auth/logout', async (c) => {
  const { sameSite } = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  const session = adminSessionTokenFromCookie(c);
  if (session && isTenantAdminSessionToken(session)) {
    const tokenHash = await hashTenantAdminSessionToken(session);
    await c.env.DB.prepare(
      `UPDATE tenant_admin_sessions SET revoked_at = ?
        WHERE token_hash = ? AND revoked_at IS NULL`,
    ).bind(new Date().toISOString(), tokenHash).run().catch(() => undefined);
  }
  c.header('Set-Cookie', expiredCookie(ADMIN_AUTH_COOKIE, sameSite), { append: true });
  c.header('Set-Cookie', expiredCookie(TENANT_COOKIE, sameSite), { append: true });
  c.header('Set-Cookie', expiredCookie(CSRF_COOKIE, sameSite), { append: true });
  return c.json({ success: true, data: null });
});

/**
 * GET /api/auth/session — returns the authenticated staff (set by the auth
 * middleware) plus the current CSRF token, refreshing the CSRF cookie if it is
 * missing (e.g. after a reload that dropped the in-memory token). This lets the
 * SPA recover the CSRF token without forcing a re-login.
 */
adminAuth.get('/api/auth/session', async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  let csrfToken = csrfTokenFromCookie(c);
  if (!csrfToken) {
    csrfToken = crypto.randomUUID();
    c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
  }
  return c.json({
    success: true,
    data: {
      ...c.get('staff'),
      tenantId: c.get('tenantId'),
      tenantCode: c.get('tenantCode'),
      tenantName: c.get('tenantName'),
      mustChangePassword: c.get('mustChangePassword'),
    },
    csrfToken,
  });
});
