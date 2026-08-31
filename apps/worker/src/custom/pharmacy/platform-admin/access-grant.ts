import { verifyTenantPassword } from '../provisioning/credentials.js';

export const MAX_GRANT_MINUTES = 60;
export const DEFAULT_GRANT_MINUTES = 15;
export const PHI_READ_SCOPE = 'phi:read';
const KNOWN_SCOPES = new Set([PHI_READ_SCOPE]);

export type AccessGrant = {
  id: string;
  platform_admin_id: string;
  tenant_id: string;
  scopes: string;
  reason: string;
  ticket_reference: string | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
};
// session_token_hash is deliberately absent: this shape is returned to the
// browser, and the hash is a server-side session identifier with no business
// meaning to the client. It is written and compared in SQL only.

export class AccessGrantError extends Error {
  readonly status: 400 | 401 | 403 | 404;
  constructor(status: 400 | 401 | 403 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Starts support mode for one tenant. Requires the platform admin's CURRENT
 * password again (step-up) even though they already hold a valid session —
 * a session alone must not be enough to open PHI access. There is no MFA
 * infrastructure in this deployment (no TOTP/WebAuthn enrollment and no
 * Cloudflare Access MFA). Password re-entry is the approved step-up control.
 *
 * The grant is bound to `sessionTokenHash`, the session that opened it, so
 * another live session for the same admin cannot use it.
 */
export async function createAccessGrant(
  db: D1Database,
  platformAdminId: string,
  tenantId: string,
  input: {
    reason: string;
    ticketReference?: string | null;
    scopes: string[];
    currentPassword: string;
    durationMinutes?: number;
    sessionTokenHash: string | null;
  },
): Promise<AccessGrant> {
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) {
    throw new AccessGrantError(400, 'reason must be 1 to 500 characters');
  }
  if (input.scopes.length === 0 || input.scopes.some((scope) => !KNOWN_SCOPES.has(scope))) {
    throw new AccessGrantError(400, `scopes must be a non-empty subset of ${[...KNOWN_SCOPES].join(', ')}`);
  }
  const minutes = input.durationMinutes ?? DEFAULT_GRANT_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_GRANT_MINUTES) {
    throw new AccessGrantError(400, `durationMinutes must be an integer from 1 to ${MAX_GRANT_MINUTES}`);
  }
  if (!input.sessionTokenHash) {
    throw new AccessGrantError(401, 'Platform admin session is invalid');
  }

  const credential = await db.prepare(
    `SELECT password_hash FROM platform_admin_credentials WHERE staff_id = ? LIMIT 1`,
  ).bind(platformAdminId).first<{ password_hash: string }>();
  if (!credential || !(await verifyTenantPassword(input.currentPassword, credential.password_hash))) {
    throw new AccessGrantError(403, 'Current password is incorrect');
  }

  const tenant = await db.prepare(`SELECT id FROM tenants WHERE id = ? LIMIT 1`)
    .bind(tenantId).first<{ id: string }>();
  if (!tenant) throw new AccessGrantError(404, 'Tenant not found');

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  const grant: AccessGrant = {
    id: crypto.randomUUID(),
    platform_admin_id: platformAdminId,
    tenant_id: tenantId,
    scopes: JSON.stringify(input.scopes),
    reason,
    ticket_reference: input.ticketReference?.trim() || null,
    issued_at: nowIso,
    expires_at: expiresAt,
    revoked_at: null,
  };
  const results = await db.batch([
    db.prepare(
      `INSERT INTO platform_admin_access_grants
        (id, platform_admin_id, tenant_id, scopes, reason, ticket_reference,
         reauth_verified_at, issued_at, expires_at, revoked_at, revoked_by,
         session_token_hash)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?
         FROM platform_admin_sessions AS current_session
         INNER JOIN platform_admin_credentials AS current_credential
                 ON current_credential.staff_id = current_session.staff_id
                AND current_credential.credential_version = current_session.credential_version
         INNER JOIN platform_admins AS current_admin
                 ON current_admin.staff_id = current_session.staff_id
                AND current_admin.is_active = 1
         INNER JOIN staff_members AS current_staff
                 ON current_staff.id = current_session.staff_id
                AND current_staff.is_active = 1
        WHERE current_session.token_hash = ?
          AND current_session.staff_id = ?
          AND current_session.revoked_at IS NULL
          AND current_session.expires_at > ?`,
    ).bind(
      grant.id, platformAdminId, tenantId, grant.scopes, reason, grant.ticket_reference,
      nowIso, nowIso, expiresAt, input.sessionTokenHash,
      input.sessionTokenHash, platformAdminId, nowIso,
    ),
    db.prepare(
      `INSERT INTO platform_admin_access_events
         (id, platform_admin_id, tenant_id, action, resource_type, resource_id,
          detail_json, created_at)
       SELECT ?, platform_admin_id, tenant_id, 'support_mode_started',
              'access_grant', id, ?, ?
         FROM platform_admin_access_grants
        WHERE id = ? AND platform_admin_id = ? AND tenant_id = ?
          AND session_token_hash = ? AND revoked_at IS NULL`,
    ).bind(
      crypto.randomUUID(), JSON.stringify({ scopes: input.scopes, expiresAt }), nowIso,
      grant.id, platformAdminId, tenantId, input.sessionTokenHash,
    ),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    throw new AccessGrantError(403, 'Platform admin session is no longer active');
  }
  return grant;
}

/** The caller session's active grants, for the UI's countdown banner. */
export async function listActiveGrants(
  db: D1Database,
  platformAdminId: string,
  sessionTokenHash: string | null,
): Promise<AccessGrant[]> {
  if (!sessionTokenHash) return [];
  const now = new Date().toISOString();
  const result = await db.prepare(
    `SELECT id, platform_admin_id, tenant_id, scopes, reason, ticket_reference,
            issued_at, expires_at, revoked_at
       FROM platform_admin_access_grants
      WHERE platform_admin_id = ? AND session_token_hash = ?
        AND revoked_at IS NULL AND expires_at > ?
      ORDER BY expires_at ASC`,
  ).bind(platformAdminId, sessionTokenHash, now).all<AccessGrant>();
  return result.results ?? [];
}

/**
 * Enforces that the caller holds an active grant for this exact tenant with
 * this exact scope. Throws AccessGrantError(403) otherwise. Every PHI route
 * must call this before touching patient data — it does not itself record
 * an access event; the caller's own recordPlatformAdminAccess call remains
 * the record of what was actually read.
 *
 * `sessionTokenHash` is the CALLER's session. A grant bound to a different
 * session does not count, so a second live session for the same admin (a
 * stolen cookie) cannot ride along on break-glass access it never
 * re-authenticated for.
 */
export async function requireActiveGrant(
  db: D1Database,
  platformAdminId: string,
  tenantId: string,
  scope: string,
  sessionTokenHash: string | null,
): Promise<AccessGrant> {
  if (!sessionTokenHash) {
    throw new AccessGrantError(403, 'No active support-mode grant for this session.');
  }
  const now = new Date().toISOString();
  const grant = await db.prepare(
    `SELECT access_grant.id, access_grant.platform_admin_id, access_grant.tenant_id,
            access_grant.scopes, access_grant.reason, access_grant.ticket_reference,
            access_grant.issued_at, access_grant.expires_at, access_grant.revoked_at
       FROM platform_admin_access_grants AS access_grant
       INNER JOIN platform_admin_sessions AS session
               ON session.token_hash = access_grant.session_token_hash
              AND session.staff_id = access_grant.platform_admin_id
       INNER JOIN platform_admins AS admin
               ON admin.staff_id = access_grant.platform_admin_id
              AND admin.is_active = 1
       INNER JOIN staff_members AS staff
               ON staff.id = admin.staff_id
              AND staff.is_active = 1
       INNER JOIN platform_admin_credentials AS credential
               ON credential.staff_id = admin.staff_id
              AND credential.credential_version = session.credential_version
      WHERE access_grant.platform_admin_id = ? AND access_grant.tenant_id = ?
        AND access_grant.revoked_at IS NULL AND access_grant.expires_at > ?
        AND access_grant.session_token_hash = ?
        AND session.revoked_at IS NULL AND session.expires_at > ?
      ORDER BY access_grant.expires_at DESC
      LIMIT 1`,
  ).bind(platformAdminId, tenantId, now, sessionTokenHash, now).first<AccessGrant>();
  if (!grant || !(JSON.parse(grant.scopes) as string[]).includes(scope)) {
    throw new AccessGrantError(
      403,
      'No active support-mode grant for this tenant. Start support mode before viewing patient data.',
    );
  }
  return grant;
}

export async function endAccessGrant(
  db: D1Database,
  platformAdminId: string,
  grantId: string,
  sessionTokenHash: string | null,
): Promise<boolean> {
  if (!sessionTokenHash) return false;
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO platform_admin_access_events
         (id, platform_admin_id, tenant_id, action, resource_type, resource_id, detail_json, created_at)
       SELECT ?, platform_admin_id, tenant_id, 'support_mode_ended', 'access_grant', id, NULL, ?
         FROM platform_admin_access_grants
        WHERE id = ? AND platform_admin_id = ? AND session_token_hash = ?
          AND revoked_at IS NULL`,
    ).bind(crypto.randomUUID(), now, grantId, platformAdminId, sessionTokenHash),
    db.prepare(
      `UPDATE platform_admin_access_grants
          SET revoked_at = ?, revoked_by = ?
        WHERE id = ? AND platform_admin_id = ? AND session_token_hash = ?
          AND revoked_at IS NULL`,
    ).bind(now, platformAdminId, grantId, platformAdminId, sessionTokenHash),
  ]);
  return results[0].meta.changes === 1 && results[1].meta.changes === 1;
}
