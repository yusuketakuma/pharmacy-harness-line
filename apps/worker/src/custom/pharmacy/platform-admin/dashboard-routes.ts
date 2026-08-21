import { Hono } from 'hono';
import { toJstString } from '@line-crm/db';
import type { Env } from '../../../index.js';
import { recordPlatformAdminAccess } from './audit.js';
import { getPharmacyReadiness, type PharmacyReadinessStatus } from '../readiness.js';
import {
  ADMIN_HASH, BUNDLE_VERSION, LIFF_HASH, LIFF_PACKAGE_VERSION, RELEASED_AT,
  WEB_PACKAGE_VERSION, WORKER_HASH, WORKER_PACKAGE_VERSION,
} from '../../../_version.js';

/**
 * Read-only operational and health views for the platform admin. Mounted
 * under the same /api/platform-admin/* prefix as routes.ts, so
 * platformAdminAuthMiddleware already gates every route here.
 *
 * Nothing in this file reads patient PHI, so none of it requires a
 * support-mode access grant (see access-grant.ts) — tenant and system health
 * metrics are operational data, not medical records. Every route still writes
 * a platform_admin_access_events row: the audit trail covers the role, not
 * just the PHI.
 */
export const platformAdminDashboardRoutes = new Hono<Env>();

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_ACTIVITY_MS = 30 * DAY_MS;
const STALE_PENDING_WEBHOOK_MS = 60 * 60 * 1000;
const SAMPLE_LIMIT = 5;

type ReadinessCounts = Record<PharmacyReadinessStatus, number>;
type AccountReadinessRow = { tenant_id: string; line_account_id: string };

const emptyReadinessCounts = (): ReadinessCounts => ({ READY: 0, BLOCKED: 0, UNVERIFIED: 0 });

function addReadinessCounts(target: ReadinessCounts, source: ReadinessCounts): void {
  for (const status of ['READY', 'BLOCKED', 'UNVERIFIED'] as const) target[status] += source[status];
}

function sellerRelease(value: string | undefined): string | null {
  return value && /^pharmacy-v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(value) ? value : null;
}

// pharmacy_webhook_event_receipts.received_at is written with jstNow()
// (+09:00), while sessions and grants use toISOString() (Z). Both compare
// lexicographically only against a cutoff in their own format.
const jstCutoff = (ms: number) => toJstString(new Date(Date.now() - ms));
const utcCutoff = (ms: number) => new Date(Date.now() - ms).toISOString();

/**
 * GET /api/platform-admin/dashboard — platform-wide counters for the
 * top-level overview. Deliberately counts only; any list belongs on the
 * screen that owns it.
 */
platformAdminDashboardRoutes.get('/api/platform-admin/dashboard', async (c) => {
  const admin = c.get('platformAdmin');
  const [row, accountRows] = await Promise.all([c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tenants) AS total_tenants,
       (SELECT COUNT(*) FROM tenants WHERE status = 'active') AS active_tenants,
       (SELECT COUNT(*) FROM tenants WHERE status = 'suspended') AS suspended_tenants,
       (SELECT COUNT(*) FROM pharmacy_webhook_event_receipts
         WHERE received_at >= ?
           AND (status = 'failed' OR dead_lettered_at IS NOT NULL)) AS webhook_failures_24h,
       -- Backlog is age-independent: an old pending row is the worst kind.
       (SELECT COUNT(*) FROM pharmacy_webhook_event_receipts
         WHERE status IN ('pending', 'processing')) AS webhook_pending,
       (SELECT COUNT(*) FROM platform_admin_access_grants
         WHERE revoked_at IS NULL AND expires_at > ?) AS active_support_grants,
       -- A tenant with no admin session at all coalesces to '' and so counts
       -- as stale, which is the intended reading of "no recent activity".
       (SELECT COUNT(*) FROM tenants AS tenant
         WHERE COALESCE((SELECT MAX(session.created_at)
                           FROM tenant_admin_sessions AS session
                          WHERE session.tenant_id = tenant.id), '') < ?)
         AS tenants_with_stale_activity`,
  ).bind(jstCutoff(DAY_MS), new Date().toISOString(), utcCutoff(STALE_ACTIVITY_MS)).first<{
      total_tenants: number;
      active_tenants: number;
      suspended_tenants: number;
      webhook_failures_24h: number;
      webhook_pending: number;
      active_support_grants: number;
      tenants_with_stale_activity: number;
    }>(), c.env.DB.prepare(
    `SELECT mapping.tenant_id, mapping.line_account_id
       FROM tenant_line_accounts AS mapping
       INNER JOIN line_accounts AS account ON account.id = mapping.line_account_id
      ORDER BY mapping.tenant_id, mapping.line_account_id`,
  ).bind().all<AccountReadinessRow>()]);

  const checkedAt = new Date();
  const mappings = accountRows.results ?? [];
  const readinessResults = await Promise.allSettled(
    mappings.map((mapping) => getPharmacyReadiness(c.env.DB, mapping.line_account_id, checkedAt)),
  );
  const totalReadiness = emptyReadinessCounts();
  const tenants = new Map<string, {
    tenantId: string;
    statusCounts: ReadinessCounts;
    accounts: Array<{ accountId: string; checkedAt: string; statusCounts: ReadinessCounts }>;
  }>();
  for (const [index, mapping] of mappings.entries()) {
    const result = readinessResults[index];
    const readiness = result.status === 'fulfilled' ? result.value : null;
    const statusCounts = emptyReadinessCounts();
    if (readiness) {
      for (const status of [
        readiness.electronicPrescription.status,
        readiness.emergencyContraception.status,
        readiness.richMenu.status,
      ]) statusCounts[status] += 1;
    } else {
      statusCounts.UNVERIFIED = 3;
    }
    const tenant = tenants.get(mapping.tenant_id) ?? {
      tenantId: mapping.tenant_id, statusCounts: emptyReadinessCounts(), accounts: [],
    };
    addReadinessCounts(tenant.statusCounts, statusCounts);
    tenant.accounts.push({
      accountId: mapping.line_account_id,
      checkedAt: readiness?.checkedAt ?? checkedAt.toISOString(),
      statusCounts,
    });
    tenants.set(mapping.tenant_id, tenant);
    addReadinessCounts(totalReadiness, statusCounts);
  }

  await recordPlatformAdminAccess(c.env.DB, admin.id, null, 'list_dashboard');
  return c.json({
    success: true,
    data: {
      totalTenants: row?.total_tenants ?? 0,
      activeTenants: row?.active_tenants ?? 0,
      suspendedTenants: row?.suspended_tenants ?? 0,
      webhookFailures24h: row?.webhook_failures_24h ?? 0,
      webhookPending: row?.webhook_pending ?? 0,
      activeSupportGrants: row?.active_support_grants ?? 0,
      tenantsWithStaleActivity: row?.tenants_with_stale_activity ?? 0,
      pharmacyReadiness: {
        checkedAt: checkedAt.toISOString(),
        statusCounts: totalReadiness,
        tenants: [...tenants.values()],
      },
      versions: {
        sellerRelease: sellerRelease(c.env.PHARMACY_SELLER_RELEASE),
        liffPackageVersion: LIFF_PACKAGE_VERSION,
        liffArtifactHash: LIFF_HASH,
        webRuntime: {
          packageVersion: WEB_PACKAGE_VERSION,
          bundleVersion: BUNDLE_VERSION,
          artifactHash: ADMIN_HASH,
          releasedAt: RELEASED_AT,
        },
        workerRuntime: {
          packageVersion: WORKER_PACKAGE_VERSION,
          bundleVersion: BUNDLE_VERSION,
          artifactHash: WORKER_HASH,
          releasedAt: RELEASED_AT,
        },
      },
    },
  });
});

/** GET /api/platform-admin/tenants/:id/health — one tenant's operational snapshot. */
platformAdminDashboardRoutes.get('/api/platform-admin/tenants/:id/health', async (c) => {
  const admin = c.get('platformAdmin');
  const tenantId = c.req.param('id');
  const tenant = await c.env.DB.prepare(
    `SELECT id FROM tenants WHERE id = ? LIMIT 1`,
  ).bind(tenantId).first<{ id: string }>();
  if (!tenant) return c.json({ success: false, error: 'Tenant not found' }, 404);

  const webhookCutoff = jstCutoff(DAY_MS);
  const [accounts, totals] = await Promise.all([
    c.env.DB.prepare(
      `SELECT account.id, account.name, account.is_active,
              EXISTS (SELECT 1 FROM pharmacy_line_channel_identities AS identity
                       WHERE identity.line_account_id = account.id) AS has_channel_identity,
              (SELECT MAX(receipt.received_at)
                 FROM pharmacy_webhook_event_receipts AS receipt
                WHERE receipt.tenant_id = mapping.tenant_id
                  AND receipt.line_account_id = account.id) AS last_webhook_at
         FROM tenant_line_accounts AS mapping
         INNER JOIN line_accounts AS account ON account.id = mapping.line_account_id
        WHERE mapping.tenant_id = ?
        ORDER BY account.id`,
    ).bind(tenantId).all<{
      id: string;
      name: string;
      is_active: number;
      has_channel_identity: number;
      last_webhook_at: string | null;
    }>(),
    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM pharmacy_webhook_event_receipts
           WHERE tenant_id = ? AND received_at >= ? AND status = 'completed'
             AND dead_lettered_at IS NULL) AS webhook_success_24h,
         (SELECT COUNT(*) FROM pharmacy_webhook_event_receipts
           WHERE tenant_id = ? AND received_at >= ?
             AND (status = 'failed' OR dead_lettered_at IS NOT NULL)) AS webhook_failed_24h,
         (SELECT COUNT(*) FROM tenant_staff_memberships
           WHERE tenant_id = ? AND is_active = 1) AS active_staff_count,
         (SELECT COUNT(*) FROM tenant_admin_sessions
           WHERE tenant_id = ? AND revoked_at IS NULL AND expires_at > ?) AS active_session_count,
         (SELECT MAX(created_at) FROM tenant_admin_sessions
           WHERE tenant_id = ?) AS last_admin_login_at`,
    ).bind(
      tenantId, webhookCutoff, tenantId, webhookCutoff, tenantId,
      tenantId, new Date().toISOString(), tenantId,
    ).first<{
      webhook_success_24h: number;
      webhook_failed_24h: number;
      active_staff_count: number;
      active_session_count: number;
      last_admin_login_at: string | null;
    }>(),
  ]);

  await recordPlatformAdminAccess(
    c.env.DB, admin.id, tenantId, 'view_tenant_health', 'tenant', tenantId,
  );
  return c.json({
    success: true,
    data: {
      tenantId,
      lineAccounts: (accounts.results ?? []).map((account) => ({
        id: account.id,
        name: account.name,
        isActive: account.is_active === 1,
        hasChannelIdentity: account.has_channel_identity === 1,
        lastWebhookAt: account.last_webhook_at,
      })),
      webhook24h: {
        success: totals?.webhook_success_24h ?? 0,
        failed: totals?.webhook_failed_24h ?? 0,
      },
      activeStaffCount: totals?.active_staff_count ?? 0,
      activeSessionCount: totals?.active_session_count ?? 0,
      lastAdminLoginAt: totals?.last_admin_login_at ?? null,
    },
  });
});

/**
 * The fixed integrity checks. Named and hardcoded on purpose: this is a
 * health panel, not an SQL console — a platform admin must never be able to
 * shape a cross-tenant query from a request parameter.
 *
 * Each `select` yields one `id` column per violating row. `severity` is the
 * status reported when at least one row matches. A check whose ids identify a
 * patient must set `redactSamples`: this router runs on a platform-admin
 * session alone, with no support-mode grant (access-grant.ts), so it may
 * report how many patients are affected but never which ones.
 */
const INTEGRITY_CHECKS: Array<{
  name: string;
  severity: 'warn' | 'critical';
  select: string;
  binds?: () => unknown[];
  redactSamples?: true;
}> = [
  {
    // The FK on tenant_line_accounts.line_account_id only bites while the
    // connection has PRAGMA foreign_keys on — nothing in this repo sets it,
    // so this stays a real safety net rather than a formality.
    name: 'orphaned_tenant_line_accounts',
    severity: 'critical',
    select: `SELECT mapping.line_account_id AS id
               FROM tenant_line_accounts AS mapping
               LEFT JOIN line_accounts AS account ON account.id = mapping.line_account_id
              WHERE account.id IS NULL
              ORDER BY mapping.line_account_id`,
  },
  {
    // The ongoing counterpart of the line_accounts_default_pharmacy_capability
    // trigger (custom_017): an account with no capability row is outside the
    // fail-closed allowlist entirely.
    name: 'missing_capability_row',
    severity: 'critical',
    select: `SELECT account.id AS id
               FROM line_accounts AS account
               LEFT JOIN pharmacy_account_capabilities AS capability
                      ON capability.line_account_id = account.id
              WHERE capability.line_account_id IS NULL
              ORDER BY account.id`,
  },
  {
    // tenant_line_accounts carries no is_active column, so "no active
    // mapping" means exactly "not currently mapped to any tenant" — the
    // patient's data is reachable by no tenant admin.
    name: 'patients_without_active_account_mapping',
    severity: 'warn',
    redactSamples: true,
    select: `SELECT patient.id AS id
               FROM pharmacy_patients AS patient
               LEFT JOIN tenant_line_accounts AS mapping
                      ON mapping.line_account_id = patient.line_account_id
              WHERE mapping.line_account_id IS NULL
              ORDER BY patient.id`,
  },
  {
    // The cron sweep should have claimed these. If it has not, the sweep
    // itself is broken and events are silently not being handled.
    name: 'stale_pending_webhook_events',
    severity: 'warn',
    select: `SELECT receipt.webhook_event_id AS id
               FROM pharmacy_webhook_event_receipts AS receipt
              WHERE receipt.status = 'pending' AND receipt.received_at < ?
              ORDER BY receipt.received_at`,
    binds: () => [jstCutoff(STALE_PENDING_WEBHOOK_MS)],
  },
  {
    // custom_025 added triggers that prevent this going forward; anything
    // this surfaces predates them.
    name: 'dangling_source_handoff',
    severity: 'critical',
    select: `SELECT submission.id AS id
               FROM pharmacy_prescription_submissions AS submission
              WHERE submission.source_handoff_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM pharmacy_myna_handoffs AS handoff
                                 WHERE handoff.id = submission.source_handoff_id
                                   AND handoff.line_account_id = submission.line_account_id)
              ORDER BY submission.id`,
  },
];

/** GET /api/platform-admin/integrity — the fixed cross-tenant integrity checks. */
platformAdminDashboardRoutes.get('/api/platform-admin/integrity', async (c) => {
  const admin = c.get('platformAdmin');
  const checks = await Promise.all(INTEGRITY_CHECKS.map(async (check) => {
    // json_group_array rather than group_concat so an id containing a comma
    // cannot split into two fake samples. A redacted check selects no ids at
    // all, so a patient identifier never leaves SQLite.
    const sampleIds = check.redactSamples
      ? `'[]'`
      : `(SELECT json_group_array(id) FROM (SELECT id FROM violation LIMIT ${SAMPLE_LIMIT}))`;
    const row = await c.env.DB.prepare(
      `WITH violation AS (${check.select})
       SELECT (SELECT COUNT(*) FROM violation) AS affected_count,
              ${sampleIds} AS sample_ids`,
    ).bind(...(check.binds?.() ?? [])).first<{ affected_count: number; sample_ids: string }>();
    const affectedCount = row?.affected_count ?? 0;
    return {
      name: check.name,
      status: affectedCount === 0 ? 'ok' as const : check.severity,
      affectedCount,
      sampleIds: JSON.parse(row?.sample_ids ?? '[]') as string[],
    };
  }));

  await recordPlatformAdminAccess(
    c.env.DB, admin.id, null, 'run_integrity_check', undefined, undefined,
    { failing: checks.filter((check) => check.status !== 'ok').map((check) => check.name) },
  );
  return c.json({ success: true, data: checks });
});
