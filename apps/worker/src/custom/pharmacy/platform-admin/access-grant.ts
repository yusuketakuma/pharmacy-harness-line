import { verifyTenantPassword } from '../provisioning/credentials.js';
import { platformAdminAccessStatement } from './audit.js';

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
 * infrastructure in this deployment yet (no TOTP/WebAuthn enrollment, no
 * Cloudflare Access in front of this origin); password re-entry is the
 * practical stand-in until one of those is wired up. This is weaker than
 * true MFA and should be treated as an interim measure, not a substitute.
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

  const credential = await db.prepare(
    `SELECT password_hash FROM platform_admin_credentials WHERE staff_id = ? LIMIT 1`,
  ).bind(platformAdminId).first<{ password_hash: string }>();
  if (!credential || !(await verifyTenantPassword(input.currentPassword, credential.password_hash))) {
    throw new AccessGrantError(401, 'Current password is incorrect');
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
  await db.batch([
    db.prepare(
      `INSERT INTO platform_admin_access_grants
        (id, platform_admin_id, tenant_id, scopes, reason, ticket_reference,
         reauth_verified_at, issued_at, expires_at, revoked_at, revoked_by,
         session_token_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).bind(
      grant.id, platformAdminId, tenantId, grant.scopes, reason, grant.ticket_reference,
      nowIso, nowIso, expiresAt, input.sessionTokenHash,
    ),
    platformAdminAccessStatement(
      db, platformAdminId, tenantId, 'support_mode_started', 'access_grant', grant.id,
      { reason, ticketReference: grant.ticket_reference, scopes: input.scopes, expiresAt },
    ),
  ]);
  return grant;
}

/** The caller's currently active (unexpired, unrevoked) grants, for the UI's countdown banner. */
export async function listActiveGrants(db: D1Database, platformAdminId: string): Promise<AccessGrant[]> {
  const now = new Date().toISOString();
  const result = await db.prepare(
    `SELECT id, platform_admin_id, tenant_id, scopes, reason, ticket_reference,
            issued_at, expires_at, revoked_at
       FROM platform_admin_access_grants
      WHERE platform_admin_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY expires_at ASC`,
  ).bind(platformAdminId, now).all<AccessGrant>();
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
 * re-authenticated for. Grants issued before custom_031 have no binding and
 * still count; passing null matches only those, which is the safe direction.
 * The IS NULL branch can be dropped once every deployment has been on
 * custom_031 for longer than MAX_GRANT_MINUTES — no unbound grant can exist
 * after that.
 */
export async function requireActiveGrant(
  db: D1Database,
  platformAdminId: string,
  tenantId: string,
  scope: string,
  sessionTokenHash: string | null,
): Promise<AccessGrant> {
  const now = new Date().toISOString();
  const grant = await db.prepare(
    `SELECT id, platform_admin_id, tenant_id, scopes, reason, ticket_reference,
            issued_at, expires_at, revoked_at
       FROM platform_admin_access_grants
      WHERE platform_admin_id = ? AND tenant_id = ?
        AND revoked_at IS NULL AND expires_at > ?
        AND (session_token_hash IS NULL OR session_token_hash = ?)
      ORDER BY expires_at DESC
      LIMIT 1`,
  ).bind(platformAdminId, tenantId, now, sessionTokenHash).first<AccessGrant>();
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
): Promise<boolean> {
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE platform_admin_access_grants
          SET revoked_at = ?, revoked_by = ?
        WHERE id = ? AND platform_admin_id = ? AND revoked_at IS NULL`,
    ).bind(now, platformAdminId, grantId, platformAdminId),
    platformAdminAccessStatement(
      db, platformAdminId, null, 'support_mode_ended', 'access_grant', grantId,
    ),
  ]);
  return (results[0] as { meta: { changes: number } }).meta.changes === 1;
}

/** Called when a platform admin's password changes: an old, possibly-compromised session must not keep an open grant either. */
export function revokeAllGrantsForAdminStatement(db: D1Database, platformAdminId: string): D1PreparedStatement {
  return db.prepare(
    `UPDATE platform_admin_access_grants
        SET revoked_at = ?, revoked_by = ?
      WHERE platform_admin_id = ? AND revoked_at IS NULL`,
  ).bind(new Date().toISOString(), platformAdminId, platformAdminId);
}
