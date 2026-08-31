import { Hono } from 'hono';
import type { Env } from '../../index.js';
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
} from '../../middleware/auth.js';
import { resolveAdminAuthConfig } from '../../middleware/admin-auth-config.js';
import {
  generateTenantAdminSessionToken,
  hashTenantAdminSessionToken,
  hashTenantPassword,
  isTenantAdminSessionToken,
  isValidAdminPassword,
  verifyTenantPassword,
} from '../../custom/pharmacy/provisioning/credentials.js';
import { log } from '../../lib/log.js';

export const adminAuth = new Hono<Env>();
adminAuth.use('/api/auth/*', async (c, next) => {
  c.header('Cache-Control', 'no-store, private');
  await next();
});
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
  // NFKC folds full-width ０-９ to ASCII. Pharmacy codes are digits and a Japanese IME
  // left in full-width mode produces ００４８２１, which would otherwise never match.
  // Deliberately no format check here: legacy tenants still hold long slug codes and
  // must keep logging in.
  const pharmacyCode = typeof body?.pharmacyCode === 'string'
    ? body.pharmacyCode.normalize('NFKC').trim()
    : '';
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
    log('auth.login_failed', {
      realm: 'tenant',
      ip: c.req.header('cf-connecting-ip'),
      reason: row ? 'bad_password' : 'unknown_login',
      tenant_id: row?.id,
    }, 'warn');
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
  const sessionToken = adminSessionTokenFromCookie(c);
  if (!sessionToken || !isTenantAdminSessionToken(sessionToken)) {
    return c.json({ success: false, error: 'Password session required' }, 403);
  }
  const sessionTokenHash = await hashTenantAdminSessionToken(sessionToken);
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
    log('auth.password_change_failed', {
      realm: 'tenant', tenant_id: tenantId, staff_id: staffId, reason: 'bad_current_password',
    }, 'warn');
    return c.json({ success: false, error: 'Current password is incorrect' }, 401);
  }
  if (newPassword === currentPassword) {
    return c.json({ success: false, error: 'New password must differ from the temporary password' }, 400);
  }

  const passwordHash = await hashTenantPassword(newPassword);
  const nextCredentialVersion = credentialVersion + 1;
  const session = await newSession('standard');
  const now = new Date().toISOString();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE tenant_admin_credentials
          SET password_hash = ?, must_change_password = 0,
              credential_version = credential_version + 1, updated_at = ?
        WHERE tenant_id = ? AND staff_id = ? AND credential_version = ?
          AND EXISTS (
            SELECT 1
              FROM tenants AS tenant
              INNER JOIN tenant_staff_memberships AS membership
                      ON membership.tenant_id = tenant.id
                     AND membership.staff_id = ?
              INNER JOIN staff_members AS staff
                      ON staff.id = membership.staff_id
             WHERE tenant.id = ?
               AND tenant.status = 'active'
               AND membership.is_active = 1
               AND staff.is_active = 1
          )
          AND EXISTS (
            SELECT 1 FROM tenant_admin_sessions AS current_session
             WHERE current_session.token_hash = ?
               AND current_session.tenant_id = ?
               AND current_session.staff_id = ?
               AND current_session.credential_version = ?
               AND current_session.revoked_at IS NULL
               AND current_session.expires_at > ?
          )`,
    ).bind(
      passwordHash, now, tenantId, staffId, credentialVersion, staffId, tenantId,
      sessionTokenHash, tenantId, staffId, credentialVersion, now,
    ),
    c.env.DB.prepare(
      `INSERT INTO tenant_admin_sessions
         (token_hash, session_family_hash, tenant_id, staff_id, credential_version, session_kind,
          expires_at, revoked_at, created_at)
       SELECT ?, COALESCE(current_session.session_family_hash, current_session.token_hash),
              ?, ?, ?, 'standard', ?, NULL, ?
         FROM tenant_admin_sessions AS current_session
        WHERE current_session.token_hash = ?
          AND current_session.tenant_id = ?
          AND current_session.staff_id = ?
          AND current_session.credential_version = ?
          AND current_session.revoked_at IS NULL
          AND current_session.expires_at > ?
          AND EXISTS (
          SELECT 1 FROM tenant_admin_credentials AS current_credential
           WHERE current_credential.tenant_id = ? AND current_credential.staff_id = ?
             AND current_credential.credential_version = ?
             AND current_credential.password_hash = ?
             AND current_credential.updated_at = ?
          )`,
    ).bind(
      session.tokenHash, tenantId, staffId, nextCredentialVersion,
      session.expiresAt, now,
      sessionTokenHash, tenantId, staffId, credentialVersion, now,
      tenantId, staffId, nextCredentialVersion, passwordHash, now,
    ),
    c.env.DB.prepare(
      `UPDATE tenant_admin_sessions
          SET revoked_at = ?
        WHERE tenant_id = ? AND staff_id = ? AND revoked_at IS NULL
          AND credential_version <= ?
          AND EXISTS (
            SELECT 1 FROM tenant_admin_credentials AS credential
             WHERE credential.tenant_id = ? AND credential.staff_id = ?
               AND credential.credential_version = ?
               AND credential.password_hash = ? AND credential.updated_at = ?
          )`,
    ).bind(
      now, tenantId, staffId, credentialVersion,
      tenantId, staffId, nextCredentialVersion, passwordHash, now,
    ),
    c.env.DB.prepare(
      `INSERT INTO tenant_admin_audit_events
         (id, tenant_id, line_account_id, actor_staff_id, action, resource_type,
          resource_id, detail_json, created_at)
       SELECT ?, ?, NULL, ?, 'staff.password_changed', 'staff', ?, NULL, ?
        WHERE EXISTS (
          SELECT 1 FROM tenant_admin_credentials AS credential
           WHERE credential.tenant_id = ? AND credential.staff_id = ?
             AND credential.credential_version = ?
             AND credential.password_hash = ? AND credential.updated_at = ?
        )`,
    ).bind(
      crypto.randomUUID(), tenantId, staffId, staffId, now,
      tenantId, staffId, nextCredentialVersion, passwordHash, now,
    ),
  ]);
  if (results[0].meta.changes !== 1) {
    return c.json({ success: false, error: 'Credential changed concurrently' }, 409);
  }
  log('auth.password_changed', { realm: 'tenant', tenant_id: tenantId, staff_id: staffId });

  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  const csrfToken = crypto.randomUUID();
  c.header('Set-Cookie', adminSessionCookie(session.token, config.sameSite), { append: true });
  c.header('Set-Cookie', tenantSessionCookie(tenantId, config.sameSite), { append: true });
  c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
  return c.json({ success: true, data: { mustChangePassword: false }, csrfToken });
});

adminAuth.get('/api/auth/sessions', async (c) => {
  if (c.get('authMethod') !== 'password') {
    return c.json({ success: false, error: 'Password session required' }, 403);
  }
  const token = adminSessionTokenFromCookie(c);
  if (!token || !isTenantAdminSessionToken(token)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  const currentTokenHash = await hashTenantAdminSessionToken(token);
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `SELECT session_kind, expires_at, created_at,
            CASE WHEN token_hash = ? THEN 1 ELSE 0 END AS is_current
       FROM tenant_admin_sessions
      WHERE tenant_id = ? AND staff_id = ?
        AND revoked_at IS NULL AND expires_at > ?
        AND credential_version = ?
      ORDER BY created_at DESC`,
  ).bind(
    currentTokenHash,
    c.get('tenantId'),
    c.get('staff').id,
    now,
    c.get('credentialVersion'),
  ).all<{
    session_kind: 'bootstrap' | 'standard';
    expires_at: string;
    created_at: string;
    is_current: number;
  }>();
  return c.json({
    success: true,
    data: {
      sessions: (result.results ?? []).map((session) => ({
        current: session.is_current === 1,
        sessionKind: session.session_kind,
        expiresAt: session.expires_at,
        createdAt: session.created_at,
      })),
    },
  });
});

adminAuth.post('/api/auth/sessions/revoke-others', async (c) => {
  if (c.get('authMethod') !== 'password') {
    return c.json({ success: false, error: 'Password session required' }, 403);
  }
  const token = adminSessionTokenFromCookie(c);
  if (!token || !isTenantAdminSessionToken(token)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  const body = await c.req.json<{ currentPassword?: unknown }>().catch(() => null);
  const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
  const tenantId = c.get('tenantId');
  const staffId = c.get('staff').id;
  const credentialVersion = c.get('credentialVersion');
  const credential = await c.env.DB.prepare(
    `SELECT password_hash FROM tenant_admin_credentials
      WHERE tenant_id = ? AND staff_id = ? AND credential_version = ?
      LIMIT 1`,
  ).bind(tenantId, staffId, credentialVersion).first<{ password_hash: string }>();
  if (!credential || !(await verifyTenantPassword(currentPassword, credential.password_hash))) {
    return c.json({ success: false, error: 'Current password is incorrect' }, 403);
  }

  const now = new Date().toISOString();
  const currentTokenHash = await hashTenantAdminSessionToken(token);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE tenant_admin_sessions SET revoked_at = ?
        WHERE tenant_id = ? AND staff_id = ? AND token_hash != ?
          AND revoked_at IS NULL AND expires_at > ?
          AND credential_version <= ?
          AND EXISTS (
            SELECT 1 FROM tenant_admin_sessions AS current_session
             WHERE current_session.token_hash = ?
               AND current_session.tenant_id = ?
               AND current_session.staff_id = ?
               AND current_session.credential_version = ?
               AND current_session.revoked_at IS NULL
               AND current_session.expires_at > ?
          )`,
    ).bind(
      now, tenantId, staffId, currentTokenHash, now, credentialVersion,
      currentTokenHash, tenantId, staffId, credentialVersion, now,
    ),
    c.env.DB.prepare(
      `INSERT INTO tenant_admin_audit_events
         (id, tenant_id, line_account_id, actor_staff_id, action, resource_type,
          resource_id, detail_json, created_at)
       SELECT ?, ?, NULL, ?, 'staff.other_sessions_revoked', 'staff', ?, NULL, ?
        WHERE changes() > 0`,
    ).bind(crypto.randomUUID(), tenantId, staffId, staffId, now),
  ]);
  if ((results[0].meta.changes ?? 0) === 0) {
    const caller = await c.env.DB.prepare(
      `SELECT 1 AS present FROM tenant_admin_sessions
        WHERE token_hash = ? AND tenant_id = ? AND staff_id = ?
          AND credential_version = ? AND revoked_at IS NULL AND expires_at > ?
        LIMIT 1`,
    ).bind(currentTokenHash, tenantId, staffId, credentialVersion, now)
      .first<{ present: number }>();
    if (!caller) {
      return c.json({ success: false, error: 'Session changed concurrently' }, 409);
    }
  }
  return c.json({ success: true, data: { revoked: results[0].meta.changes ?? 0 } });
});

/**
 * POST /api/auth/logout — clears both cookies. No CSRF required: clearing your
 * own session is not a meaningful CSRF target, and this keeps logout resilient
 * even if the CSRF token was lost client-side.
 */
adminAuth.post('/api/auth/logout', async (c) => {
  const { sameSite } = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  const session = adminSessionTokenFromCookie(c);
  let revokeFailed = false;
  if (session && isTenantAdminSessionToken(session)) {
    const tokenHash = await hashTenantAdminSessionToken(session);
    try {
      await c.env.DB.prepare(
        `UPDATE tenant_admin_sessions SET revoked_at = ?
          WHERE token_hash IN (
            SELECT family_session.token_hash
              FROM tenant_admin_sessions AS current_session
              INNER JOIN tenant_admin_sessions AS family_session
                      ON family_session.tenant_id = current_session.tenant_id
                     AND family_session.staff_id = current_session.staff_id
                     AND COALESCE(family_session.session_family_hash, family_session.token_hash) =
                         COALESCE(current_session.session_family_hash, current_session.token_hash)
             WHERE current_session.token_hash = ?
          )
            AND revoked_at IS NULL`,
      ).bind(new Date().toISOString(), tokenHash).run();
    } catch {
      revokeFailed = true;
      log('auth.logout_failed', { realm: 'tenant', reason: 'session_revoke_failed' }, 'error');
    }
  }
  c.header('Set-Cookie', expiredCookie(ADMIN_AUTH_COOKIE, sameSite), { append: true });
  c.header('Set-Cookie', expiredCookie(TENANT_COOKIE, sameSite), { append: true });
  c.header('Set-Cookie', expiredCookie(CSRF_COOKIE, sameSite), { append: true });
  if (revokeFailed) {
    return c.json({ success: false, error: 'Failed to revoke session' }, 503);
  }
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
