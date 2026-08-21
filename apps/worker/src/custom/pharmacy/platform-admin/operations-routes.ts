import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../../../index.js';
import { requireLineBotUserId } from '../provisioning/line-connection.js';
import { readLineCredential } from '../provisioning/line-credential-store.js';
import { platformAdminAccessStatement, recordPlatformAdminAccess } from './audit.js';
import { getPharmacyReadiness } from '../readiness.js';
import { buildPharmacyConfigurationDoctor } from '../configuration-doctor.js';

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
const LIFF_VERIFY_TIMEOUT_MS = 5000;

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
 * member out of THIS tenant and kill their live sessions for it.
 *
 * The deactivation targets tenant_staff_memberships, the tenant-scoped table,
 * exactly as the tenant-facing console does (routes/staff.ts DELETE
 * /api/staff/:id). It must never touch staff_members, which is platform-wide:
 *   - platform_admins.staff_id references staff_members, and the platform-admin
 *     login INNER JOINs staff_members.is_active = 1, so clearing it here would
 *     lock a platform admin out of the platform console from a tenant-scoped
 *     route;
 *   - it would also disable the person in every other tenant they belong to.
 *     No current code path gives one staff row memberships in two tenants, so
 *     that second effect is latent rather than live — the membership-scoped
 *     UPDATE closes it before it can become live.
 *
 * Membership deactivation is sufficient to log them out: both auth paths in
 * middleware/auth.ts require membership.is_active = 1 — resolveAuthenticatedTenant
 * selects from tenant_staff_memberships with is_active = 1, and the opaque
 * session query INNER JOINs the same condition. The session revocation below is
 * the explicit, immediate half of the same result.
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
        `UPDATE tenant_staff_memberships SET is_active = 0, updated_at = ?
          WHERE tenant_id = ? AND staff_id = ?`,
      ).bind(now, tenantId, staffId),
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
  liff_id: string | null;
  login_channel_id: string | null;
  is_active: number;
  bot_identity_count: number;
  messaging_credential_count: number;
  login_credential_count: number;
  last_webhook_received_at: string | null;
  tenant_status: string;
  active_staff_assignment_count: number;
  capability_config_count: number;
};

function expectedLiffEndpoint(origin: string | undefined, liffId: string | null): string | null {
  if (!origin || !liffId) return null;
  try {
    const url = new URL('/', origin);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.searchParams.set('liffId', liffId);
    return url.toString();
  } catch {
    return null;
  }
}

type LiffEndpointEvidence =
  | { status: 'MATCH'; source: 'line_api'; checkedAt: string }
  | {
    status: 'MISMATCH'; source: 'line_api'; checkedAt: string;
    reason: 'LIFF_ID_NOT_FOUND' | 'ENDPOINT_URL_MISMATCH';
  }
  | {
    status: 'ERROR'; source: 'line_api'; checkedAt: string;
    reason: 'CONFIGURATION_UNAVAILABLE' | 'CREDENTIAL_UNAVAILABLE' |
      'TOKEN_REQUEST_FAILED' | 'TOKEN_RESPONSE_INVALID' |
      'APPS_REQUEST_FAILED' | 'APPS_RESPONSE_INVALID';
    upstreamStatus?: number;
  };

async function verifyLiffEndpoint(
  loginChannelId: string,
  loginChannelSecret: string,
  liffId: string,
  expectedEndpoint: string,
): Promise<LiffEndpointEvidence> {
  const checkedAt = new Date().toISOString();
  let requestStage: 'TOKEN' | 'APPS' = 'TOKEN';
  try {
    const tokenResponse = await fetch('https://api.line.me/oauth2/v3/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: loginChannelId,
        client_secret: loginChannelSecret,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(LIFF_VERIFY_TIMEOUT_MS),
    });
    if (!tokenResponse.ok) {
      return {
        status: 'ERROR', source: 'line_api', checkedAt,
        reason: 'TOKEN_REQUEST_FAILED', upstreamStatus: tokenResponse.status,
      };
    }
    const tokenPayload = await tokenResponse.json().catch(() => null) as {
      access_token?: unknown;
    } | null;
    if (typeof tokenPayload?.access_token !== 'string' || !tokenPayload.access_token) {
      return { status: 'ERROR', source: 'line_api', checkedAt, reason: 'TOKEN_RESPONSE_INVALID' };
    }

    requestStage = 'APPS';
    const appsResponse = await fetch('https://api.line.me/liff/v1/apps', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(LIFF_VERIFY_TIMEOUT_MS),
    });
    if (appsResponse.status === 404) {
      return { status: 'MISMATCH', source: 'line_api', checkedAt, reason: 'LIFF_ID_NOT_FOUND' };
    }
    if (!appsResponse.ok) {
      return {
        status: 'ERROR', source: 'line_api', checkedAt,
        reason: 'APPS_REQUEST_FAILED', upstreamStatus: appsResponse.status,
      };
    }
    const appsPayload = await appsResponse.json().catch(() => null) as { apps?: unknown } | null;
    if (!Array.isArray(appsPayload?.apps)) {
      return { status: 'ERROR', source: 'line_api', checkedAt, reason: 'APPS_RESPONSE_INVALID' };
    }
    const matches = appsPayload.apps.filter((app): app is { liffId: string; view?: { url?: unknown } } =>
      Boolean(app && typeof app === 'object' && (app as { liffId?: unknown }).liffId === liffId));
    if (matches.length === 0) {
      return { status: 'MISMATCH', source: 'line_api', checkedAt, reason: 'LIFF_ID_NOT_FOUND' };
    }
    const [match] = matches;
    if (matches.length !== 1 || !match || typeof match.view?.url !== 'string') {
      return { status: 'ERROR', source: 'line_api', checkedAt, reason: 'APPS_RESPONSE_INVALID' };
    }
    return match.view.url === expectedEndpoint
      ? { status: 'MATCH', source: 'line_api', checkedAt }
      : { status: 'MISMATCH', source: 'line_api', checkedAt, reason: 'ENDPOINT_URL_MISMATCH' };
  } catch {
    return {
      status: 'ERROR', source: 'line_api', checkedAt,
      reason: requestStage === 'TOKEN' ? 'TOKEN_REQUEST_FAILED' : 'APPS_REQUEST_FAILED',
    };
  }
}

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
  const verifyLiffAccountId = c.req.query('verifyLiffEndpoint')?.trim() || null;
  if (verifyLiffAccountId && !/^[A-Za-z0-9_-]{1,128}$/u.test(verifyLiffAccountId)) {
    return c.json({ success: false, error: 'Invalid LINE account id' }, 400);
  }
  if (!(await tenantExists(c.env.DB, tenantId))) {
    return c.json({ success: false, error: 'Tenant not found' }, 404);
  }

  const result = await c.env.DB.prepare(
    `SELECT account.id, account.name, account.channel_id, account.liff_id,
            account.login_channel_id, account.is_active,
            tenant.status AS tenant_status,
            (SELECT COUNT(*) FROM pharmacy_staff_accounts AS assignment
              INNER JOIN staff_members AS staff ON staff.id = assignment.staff_id
              INNER JOIN tenant_staff_memberships AS membership
                      ON membership.staff_id = assignment.staff_id
                     AND membership.tenant_id = mapping.tenant_id
               WHERE assignment.line_account_id = account.id AND assignment.is_active = 1
                 AND staff.is_active = 1 AND membership.is_active = 1) AS active_staff_assignment_count,
            (SELECT COUNT(*) FROM pharmacy_account_capabilities AS capability
              WHERE capability.line_account_id = account.id AND capability.mode = 'pharmacy') AS capability_config_count,
            (SELECT COUNT(*) FROM pharmacy_line_channel_identities AS identity
              WHERE identity.line_account_id = account.id) AS bot_identity_count,
            (SELECT COUNT(*) FROM pharmacy_line_credentials AS credential
              WHERE credential.tenant_id = mapping.tenant_id
                AND credential.line_account_id = account.id
                AND credential.credential_kind IN ('channel_access_token', 'channel_secret')) AS messaging_credential_count,
            (SELECT COUNT(*) FROM pharmacy_line_credentials AS credential
              WHERE credential.tenant_id = mapping.tenant_id
                AND credential.line_account_id = account.id
                AND credential.credential_kind = 'login_channel_secret') AS login_credential_count,
            (SELECT MAX(receipt.received_at) FROM pharmacy_webhook_event_receipts AS receipt
              WHERE receipt.tenant_id = mapping.tenant_id
                AND receipt.line_account_id = account.id) AS last_webhook_received_at
       FROM tenant_line_accounts AS mapping
       INNER JOIN tenants AS tenant ON tenant.id = mapping.tenant_id
       INNER JOIN line_accounts AS account ON account.id = mapping.line_account_id
      WHERE mapping.tenant_id = ?
      ORDER BY account.id`,
  ).bind(tenantId).all<LineStatusRow>();

  const rows = result.results ?? [];
  const verifyLiffRow = verifyLiffAccountId
    ? rows.find((row) => row.id === verifyLiffAccountId) : null;
  if (verifyLiffAccountId && !verifyLiffRow) {
    return c.json({ success: false, error: 'LINE account not found for this tenant' }, 404);
  }
  const readiness = await Promise.allSettled(
    rows.map((row) => getPharmacyReadiness(c.env.DB, row.id)),
  );
  const credentialStatus = await Promise.all(rows.map(async (row) => {
    if (row.messaging_credential_count !== 2 || row.login_credential_count !== 1 ||
        !c.env.LINE_CREDENTIAL_KEY_V1) return 'UNVERIFIED' as const;
    const values = await Promise.all([
      readLineCredential(c.env.DB, c.env.LINE_CREDENTIAL_KEY_V1, {
        tenantId, lineAccountId: row.id, kind: 'channel_access_token',
      }),
      readLineCredential(c.env.DB, c.env.LINE_CREDENTIAL_KEY_V1, {
        tenantId, lineAccountId: row.id, kind: 'channel_secret',
      }),
      readLineCredential(c.env.DB, c.env.LINE_CREDENTIAL_KEY_V1, {
        tenantId, lineAccountId: row.id, kind: 'login_channel_secret',
      }),
    ]);
    return values.every((value) => typeof value === 'string' && value.length > 0)
      ? 'READY' as const : 'UNVERIFIED' as const;
  }));

  let liveLiffEvidence: LiffEndpointEvidence | null = null;
  if (verifyLiffRow) {
    const endpoint = expectedLiffEndpoint(c.env.LIFF_PUBLIC_URL, verifyLiffRow.liff_id);
    if (!c.env.LINE_CREDENTIAL_KEY_V1 || !verifyLiffRow.login_channel_id ||
        !verifyLiffRow.liff_id || !endpoint) {
      liveLiffEvidence = {
        status: 'ERROR', source: 'line_api', checkedAt: new Date().toISOString(),
        reason: 'CONFIGURATION_UNAVAILABLE',
      };
    } else {
      try {
        const loginSecret = await readLineCredential(c.env.DB, c.env.LINE_CREDENTIAL_KEY_V1, {
          tenantId, lineAccountId: verifyLiffRow.id, kind: 'login_channel_secret',
        });
        liveLiffEvidence = loginSecret
          ? await verifyLiffEndpoint(
            verifyLiffRow.login_channel_id, loginSecret, verifyLiffRow.liff_id, endpoint,
          )
          : {
            status: 'ERROR', source: 'line_api', checkedAt: new Date().toISOString(),
            reason: 'CREDENTIAL_UNAVAILABLE',
          };
      } catch {
        liveLiffEvidence = {
          status: 'ERROR', source: 'line_api', checkedAt: new Date().toISOString(),
          reason: 'CREDENTIAL_UNAVAILABLE',
        };
      }
    }
  }

  await recordPlatformAdminAccess(
    c.env.DB,
    admin.id,
    tenantId,
    verifyLiffAccountId ? 'verify_liff_endpoint' : 'view_line_status',
    verifyLiffAccountId ? 'line_account' : undefined,
    verifyLiffAccountId ?? undefined,
    liveLiffEvidence
      ? {
        status: liveLiffEvidence.status,
        ...('reason' in liveLiffEvidence ? { reason: liveLiffEvidence.reason } : {}),
        ...('upstreamStatus' in liveLiffEvidence && liveLiffEvidence.upstreamStatus !== undefined
          ? { upstreamStatus: liveLiffEvidence.upstreamStatus }
          : {}),
      }
      : undefined,
  );
  return c.json({
    success: true,
    data: rows.map((row, index) => {
      const endpoint = expectedLiffEndpoint(c.env.LIFF_PUBLIC_URL, row.liff_id);
      const liffEvidence = row.id === verifyLiffAccountId && liveLiffEvidence
        ? liveLiffEvidence
        : { status: 'UNVERIFIED' as const, source: 'manual_console' as const, checkedAt: null };
      const liffEndpointReady = liffEvidence.status === 'MATCH';
      const liffReasonCodes = !row.liff_id
        ? ['LIFF_ID_MISSING']
        : endpoint
          ? liffEndpointReady ? [] : ['LIFF_ENDPOINT_UNVERIFIED']
          : ['LIFF_PUBLIC_ORIGIN_INVALID'];
      const readinessResult = readiness[index];
      const accountReadiness = readinessResult?.status === 'fulfilled'
        ? readinessResult.value : null;
      const configurationDoctor = buildPharmacyConfigurationDoctor({
        accountId: row.id,
        checkedAt: liffEvidence.checkedAt ?? accountReadiness?.checkedAt ?? new Date().toISOString(),
        tenantMapped: true,
        tenantActive: row.tenant_status === 'active',
        accountActive: row.is_active === 1,
        staffAssigned: row.active_staff_assignment_count > 0,
        capabilityConfigured: row.capability_config_count > 0,
        botIdentityConfigured: row.bot_identity_count > 0,
        liffIdConfigured: Boolean(row.liff_id),
        liffOriginValid: Boolean(endpoint),
        liffEndpointStatus: liffEndpointReady ? 'READY' : 'UNVERIFIED',
        loginChannelConfigured: Boolean(row.login_channel_id),
        messagingCredentialsConfigured: row.messaging_credential_count === 2,
        loginCredentialConfigured: row.login_credential_count === 1,
        credentialStatus: credentialStatus[index],
        readiness: accountReadiness,
      });
      return {
      id: row.id,
      name: row.name,
      channelId: row.channel_id,
      isActive: row.is_active === 1,
      hasBotIdentity: row.bot_identity_count > 0,
      hasEncryptedCredential: row.messaging_credential_count + row.login_credential_count > 0,
      liffIdConfigured: Boolean(row.liff_id),
      loginChannelConfigured: Boolean(row.login_channel_id),
      messagingCredentialsReady: row.messaging_credential_count === 2,
      loginCredentialReady: row.login_credential_count === 1,
      expectedLiffEndpoint: endpoint,
      liffEndpointEvidence: liffEvidence,
      liffReasonCodes,
      lastWebhookReceivedAt: row.last_webhook_received_at,
      readiness: accountReadiness,
      configurationDoctor,
      };
    }),
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
