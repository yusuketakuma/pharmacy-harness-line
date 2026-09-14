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
import {
  isAllowedAdminRequestOrigin,
  resolveAdminAuthConfig,
} from '../../middleware/admin-auth-config.js';
import {
  generateTenantAdminSessionToken,
  hashTenantAdminSessionToken,
  hashTenantPassword,
  isTenantAdminSessionToken,
  isValidAdminPassword,
  verifyTenantPassword,
} from '../../custom/pharmacy/provisioning/credentials.js';
import { log } from '../../lib/log.js';
import { tenantAuditStatement } from '../../lib/tenant-audit.js';
import {
  sessionExpiresAt,
  sessionMaxAgeSeconds,
  type AdminSessionKind,
} from '../../custom/pharmacy/provisioning/auth-policy.js';
import {
  claimLoginAttempt,
  clearLoginThrottleStatement,
} from '../../custom/pharmacy/provisioning/auth-throttle.js';

export const adminAuth = new Hono<Env>();
adminAuth.use('/api/auth/*', async (c, next) => {
  c.header('Cache-Control', 'no-store, private');
  await next();
});
const UNKNOWN_LOGIN_PASSWORD_HASH =
  'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$7_iN48HsHUxblOLkYfnRLpCrY7dUnWGcyeEpHR_jjFc';

type PharmacyAuthAudit = {
  actorKind: 'pharmacy_shared' | 'platform_admin' | 'human' | 'unauthenticated' | 'system';
  actorStaffId?: string | null;
  targetTenantId?: string | null;
  targetStaffId?: string | null;
  action: string;
  outcome: 'success' | 'failure' | 'denied' | 'unavailable';
  reasonCode: string;
  requestId: string;
};

function pharmacyAuthAuditStatement(db: D1Database, event: PharmacyAuthAudit): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO pharmacy_auth_audit_events
       (id, actor_kind, actor_staff_id, target_tenant_id, target_staff_id,
        action, outcome, reason_code, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), event.actorKind, event.actorStaffId ?? null,
    event.targetTenantId ?? null, event.targetStaffId ?? null, event.action,
    event.outcome, event.reasonCode, event.requestId, new Date().toISOString(),
  );
}

async function recordPharmacyAuthAudit(
  db: D1Database,
  event: PharmacyAuthAudit,
): Promise<boolean> {
  try {
    await pharmacyAuthAuditStatement(db, event).run();
    return true;
  } catch {
    return false;
  }
}

async function newSession(kind: AdminSessionKind) {
  const token = generateTenantAdminSessionToken();
  const now = new Date();
  return {
    token,
    tokenHash: await hashTenantAdminSessionToken(token),
    kind,
    expiresAt: sessionExpiresAt(kind, now),
    issuedAt: now.toISOString(),
    maxAgeSeconds: sessionMaxAgeSeconds(kind),
  };
}

/**
 * POST /api/auth/login
 *
 * Validates a pharmacy-code/password pair, then issues:
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
  if (!isAllowedAdminRequestOrigin(c.env, c.req.header('Origin'), c.req.url)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  if (config.misconfigured) {
    console.error('[admin-auth] refused login — misconfigured topology:', config.misconfigured);
    return c.json({ success: false, error: config.misconfigured }, 500);
  }

  const parsedBody = await c.req.json().catch(() => null);
  const body = parsedBody !== null && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
    ? parsedBody as Record<string, unknown>
    : {};
  // NFKC folds full-width ０-９ to ASCII. Pharmacy codes are digits and a Japanese IME
  // left in full-width mode produces ００４８２１, which would otherwise never match.
  // The pharmacy code is the only identifier. Individual staff login IDs are
  // historical data and are deliberately not accepted by this endpoint.
  const pharmacyCode = typeof body?.pharmacyCode === 'string'
    ? body.pharmacyCode.normalize('NFKC').trim()
    : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if ('loginId' in body || 'apiKey' in body || !pharmacyCode || !password) {
    return c.json({ success: false, error: 'Pharmacy code and password are required' }, 400);
  }
  const requestId = crypto.randomUUID();
  const row = await c.env.DB.prepare(
    `SELECT tenant.id, tenant.tenant_code, tenant.display_name,
            credential.staff_id, credential.login_id, credential.password_hash,
            credential.must_change_password, credential.credential_version,
            staff.name, staff.principal_kind, membership.role
       FROM tenant_admin_credentials AS credential
       INNER JOIN tenants AS tenant
               ON tenant.id = credential.tenant_id AND tenant.status = 'active'
       INNER JOIN staff_members AS staff
               ON staff.id = credential.staff_id
              AND staff.is_active = 1
              AND staff.principal_kind = 'pharmacy_shared'
              AND staff.shared_tenant_id = tenant.id
       INNER JOIN tenant_staff_memberships AS membership
              ON membership.tenant_id = credential.tenant_id
              AND membership.staff_id = credential.staff_id
              AND membership.role = 'admin'
              AND membership.is_active = 1
      WHERE tenant.tenant_code = ? COLLATE NOCASE
        AND credential.login_id = tenant.tenant_code COLLATE NOCASE
        AND credential.auth_enabled = 1
      LIMIT 1`,
  ).bind(pharmacyCode).first<{
    id: string;
    tenant_code: string;
    display_name: string;
    staff_id: string;
    login_id: string;
    password_hash: string;
    must_change_password: number;
    credential_version: number;
    name: string;
    principal_kind: 'human' | 'pharmacy_shared';
    role: 'owner' | 'admin' | 'staff';
  }>();
  const throttleKey = row ? {
    realm: 'tenant' as const,
    authorityId: row.id,
    loginId: pharmacyCode,
  } : null;
  let attemptAllowed = false;
  if (throttleKey) {
    try {
      attemptAllowed = (await claimLoginAttempt(c.env.DB, throttleKey)).allowed;
    } catch {
      log('auth.login_failed', {
        realm: 'tenant', tenant_id: throttleKey.authorityId, reason: 'throttle_unavailable',
      }, 'error');
      return c.json({ success: false, error: 'Authentication temporarily unavailable' }, 503);
    }
  }
  const passwordValid = await verifyTenantPassword(
    password,
    row?.password_hash ?? UNKNOWN_LOGIN_PASSWORD_HASH,
  );
  if (!row || !throttleKey || !attemptAllowed || !passwordValid) {
    const auditSaved = await recordPharmacyAuthAudit(c.env.DB, {
      actorKind: 'unauthenticated',
      targetTenantId: row?.id,
      targetStaffId: row?.staff_id,
      action: 'login',
      outcome: 'failure',
      reasonCode: row ? (attemptAllowed ? 'bad_password' : 'throttled') : 'unknown_pharmacy_code',
      requestId,
    });
    log('auth.login_failed', {
      realm: 'tenant',
      ip: c.req.header('cf-connecting-ip'),
      reason: row ? (attemptAllowed ? 'bad_password' : 'throttled') : 'unknown_pharmacy_code',
      tenant_id: row?.id,
    }, 'warn');
    if (!auditSaved) {
      return c.json({ success: false, error: 'Authentication temporarily unavailable' }, 503);
    }
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const csrfToken = crypto.randomUUID();
  const session = await newSession(row.must_change_password === 1 ? 'bootstrap' : 'standard');
  try {
    const results = await c.env.DB.batch([
      clearLoginThrottleStatement(c.env.DB, throttleKey),
      c.env.DB.prepare(
        `INSERT INTO tenant_admin_sessions
          (token_hash, tenant_id, staff_id, credential_version, session_kind,
           expires_at, last_seen_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).bind(
        session.tokenHash, row.id, row.staff_id, row.credential_version,
        session.kind, session.expiresAt, session.issuedAt, session.issuedAt,
      ),
      pharmacyAuthAuditStatement(c.env.DB, {
        actorKind: 'pharmacy_shared',
        actorStaffId: row.staff_id,
        targetTenantId: row.id,
        targetStaffId: row.staff_id,
        action: 'login',
        outcome: 'success',
        reasonCode: 'password_verified',
        requestId,
      }),
    ]);
    if ((results[1].meta.changes ?? 0) === 0 || (results[2].meta.changes ?? 0) === 0) {
      throw new Error('login persistence conflict');
    }
  } catch {
    log('auth.login_failed', {
      realm: 'tenant', tenant_id: row.id, reason: 'session_persistence_failed',
    }, 'error');
    return c.json({ success: false, error: 'Authentication temporarily unavailable' }, 503);
  }
  c.header('Set-Cookie', adminSessionCookie(
    session.token, config.sameSite, session.maxAgeSeconds,
  ), { append: true });
  c.header('Set-Cookie', tenantSessionCookie(
    row.id, config.sameSite, session.maxAgeSeconds,
  ), { append: true });
  c.header('Set-Cookie', csrfCookie(
    csrfToken, config.sameSite, session.maxAgeSeconds,
  ), { append: true });
  return c.json({
    success: true,
    data: {
      id: row.staff_id,
      name: row.name,
      role: row.role,
      principalKind: row.principal_kind,
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
    return c.json({
      success: false,
      error: 'New password must be 15 to 128 characters and not commonly compromised',
    }, 400);
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
       INNER JOIN staff_members AS staff
               ON staff.id = credential.staff_id
              AND staff.principal_kind = 'pharmacy_shared'
              AND staff.shared_tenant_id = credential.tenant_id
              AND staff.is_active = 1
      WHERE credential.tenant_id = ?
        AND credential.staff_id = ?
        AND credential.credential_version = ?
        AND credential.auth_enabled = 1
      LIMIT 1`,
  ).bind(tenantId, staffId, credentialVersion).first<{
    password_hash: string;
    credential_version: number;
  }>();
  if (!credential || !(await verifyTenantPassword(currentPassword, credential.password_hash))) {
    const auditSaved = await recordPharmacyAuthAudit(c.env.DB, {
      actorKind: 'unauthenticated',
      targetTenantId: tenantId,
      targetStaffId: staffId,
      action: 'password_change',
      outcome: 'failure',
      reasonCode: 'bad_current_password',
      requestId: crypto.randomUUID(),
    });
    log('auth.password_change_failed', {
      realm: 'tenant', tenant_id: tenantId, staff_id: staffId, reason: 'bad_current_password',
    }, 'warn');
    if (!auditSaved) {
      return c.json({ success: false, error: 'Authentication temporarily unavailable' }, 503);
    }
    return c.json({ success: false, error: 'Current password is incorrect' }, 401);
  }
  if (newPassword === currentPassword) {
    return c.json({ success: false, error: 'New password must differ from the temporary password' }, 400);
  }

  const passwordHash = await hashTenantPassword(newPassword);
  const now = new Date().toISOString();
  const requestId = crypto.randomUUID();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE tenant_admin_credentials
            SET password_hash = ?, must_change_password = 0,
                credential_version = credential_version + 1, updated_at = ?
          WHERE tenant_id = ? AND staff_id = ? AND credential_version = ?
            AND auth_enabled = 1
            AND EXISTS (
              SELECT 1 FROM tenants AS tenant
               WHERE tenant.id = ? AND tenant.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM staff_members AS staff
               WHERE staff.id = ? AND staff.principal_kind = 'pharmacy_shared'
                 AND staff.shared_tenant_id = ? AND staff.is_active = 1
            )
            AND EXISTS (
              SELECT 1 FROM tenant_staff_memberships AS membership
               WHERE membership.tenant_id = ? AND membership.staff_id = ?
                 AND membership.role = 'admin' AND membership.is_active = 1
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
        passwordHash, now, tenantId, staffId, credentialVersion,
        tenantId, staffId, tenantId, tenantId, staffId,
        sessionTokenHash, tenantId, staffId, credentialVersion, now,
      ),
      // `changes()` is evaluated immediately after the credential UPDATE.
      // A NULL outcome violates NOT NULL when the CAS matched zero rows, so
      // D1 rolls back the credential change and its revocations.
      c.env.DB.prepare(
        `INSERT INTO pharmacy_auth_audit_events
          (id, actor_kind, actor_staff_id, target_tenant_id, target_staff_id,
           action, outcome, reason_code, request_id, created_at)
         VALUES (?, 'pharmacy_shared', ?, ?, ?, 'password_change',
                 CASE WHEN changes() = 1 THEN 'success' ELSE NULL END,
                 'credential_rotated', ?, ?)`,
      ).bind(crypto.randomUUID(), staffId, tenantId, staffId, requestId, now),
      tenantAuditStatement(c.env.DB, {
        tenantId,
        actorStaffId: staffId,
        action: 'staff.password_changed',
        resourceType: 'staff',
        resourceId: staffId,
      }),
    ]);
  } catch (error) {
    log('auth.password_change_failed', {
      realm: 'tenant', tenant_id: tenantId, staff_id: staffId, reason: 'persistence_failed',
    }, 'error');
    const message = error instanceof Error ? error.message : String(error);
    return c.json({
      success: false,
      error: /constraint|concurrent|PHARMACY_/iu.test(message)
        ? 'Credential changed concurrently'
        : 'Authentication temporarily unavailable',
    }, /constraint|concurrent|PHARMACY_/iu.test(message) ? 409 : 503);
  }
  log('auth.password_changed', { realm: 'tenant', tenant_id: tenantId, staff_id: staffId });

  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  c.header('Set-Cookie', expiredCookie(ADMIN_AUTH_COOKIE, config.sameSite), { append: true });
  c.header('Set-Cookie', expiredCookie(TENANT_COOKIE, config.sameSite), { append: true });
  c.header('Set-Cookie', expiredCookie(CSRF_COOKIE, config.sameSite), { append: true });
  return c.json({
    success: true,
    data: { mustChangePassword: false, reauthenticationRequired: true },
  });
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
