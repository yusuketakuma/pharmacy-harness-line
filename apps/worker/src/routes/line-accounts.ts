import { Hono, type Context } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import {
  getLineAccountsForTenant,
  getLineAccountByIdForTenant,
  updateLineAccountOrder,
  deleteLineAccount,
} from '@line-crm/db';
import type { LineAccount as DbLineAccount } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import {
  detectFollowerImportCapability,
  getFollowerImportState,
  processFollowerImportStep,
  startFollowerImport,
} from '../services/follower-import.js';
import type { FollowerImportClient } from '../services/follower-import.js';
import type { Env } from '../index.js';
import {
  isPharmacyModeAccount,
  isPharmacyTenant,
} from '../custom/pharmacy/growth-loop/access.js'; // custom:pharmacy-allowlist
import { accountResourceOwnedByStaff } from '../middleware/tenant-boundary.js';
import { requireLineBotUserId } from '../custom/pharmacy/provisioning/line-connection.js';
import {
  createEncryptedLineAccount,
  LINE_ACCOUNT_CONFLICT_ERROR,
  updateEncryptedLineAccount,
} from '../custom/pharmacy/provisioning/line-account-store.js';
import {
  readLineCredential,
} from '../custom/pharmacy/provisioning/line-credential-store.js';

const lineAccounts = new Hono<Env>();

async function requireAccountAccess(
  c: Context<Env>,
  lineAccountId: string,
): Promise<Response | null> {
  const tenantId = c.get('tenantId');
  if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
  if (!await accountResourceOwnedByStaff(c, tenantId, lineAccountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  return null;
}

async function accountAccessToken(c: Context<Env>, lineAccountId: string): Promise<string | null> {
  const rootSecret = c.env.LINE_CREDENTIAL_KEY_V1;
  if (!rootSecret) return null;
  return readLineCredential(c.env.DB, rootSecret, {
    tenantId: c.get('tenantId'),
    lineAccountId,
    kind: 'channel_access_token',
  });
}

function serializeLineAccount(row: DbLineAccount) {
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    isActive: Boolean(row.is_active),
    country: row.country,
    role: row.role,
    displayOrder: row.display_order,
    // login_channel_id and liff_id are non-secret identifiers (visible in
    // LINE Developers console, embedded in public LIFF URLs). Safe to expose
    // in list responses so the admin UI can show "Login/LIFF configured?"
    // without a separate fetch.
    loginChannelId: row.login_channel_id,
    liffId: row.liff_id,
    ogSiteName: row.og_site_name,
    ogDefaultImageUrl: row.og_default_image_url,
    ogDefaultDescription: row.og_default_description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Intentionally omit channelAccessToken / channelSecret / loginChannelSecret
    // from list responses (secrets).
  };
}

// Fetch bot profile (displayName, pictureUrl) from LINE API
async function fetchBotProfile(accessToken: string): Promise<{ displayName?: string; pictureUrl?: string; basicId?: string }> {
  try {
    const res = await fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return {};
    const data = await res.json() as { displayName?: string; pictureUrl?: string; basicId?: string };
    return { displayName: data.displayName, pictureUrl: data.pictureUrl, basicId: data.basicId };
  } catch {
    return {};
  }
}

function configuredWebhookUrl(env: Env['Bindings']): string | null {
  try {
    const url = new URL(env.WORKER_PUBLIC_URL ?? env.WORKER_URL);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local) return null;
    url.pathname = '/webhook';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

// GET /api/line-accounts - list all (with LINE profile + stats)
lineAccounts.get('/api/line-accounts', async (c) => {
  try {
    const db = c.env.DB;
    const tenantId = c.get('tenantId');
    const allItems = await getLineAccountsForTenant(db, tenantId);
    const pharmacyTenant = await isPharmacyTenant(db, tenantId);
    let items = allItems;
    if (pharmacyTenant) {
      const staff = c.get('staff');
      if (!staff || staff.id === 'env-owner') {
        items = [];
      } else {
        const assigned = await db.prepare(
          `SELECT assignment.line_account_id
             FROM pharmacy_staff_accounts AS assignment
             INNER JOIN tenant_line_accounts AS mapping
                     ON mapping.line_account_id = assignment.line_account_id
                    AND mapping.tenant_id = ?
            WHERE assignment.staff_id = ? AND assignment.is_active = 1`,
        ).bind(tenantId, staff.id).all<{ line_account_id: string }>();
        const assignedIds = new Set(assigned.results.map((row) => row.line_account_id));
        items = allItems.filter((item) => assignedIds.has(item.id));
      }
    }

    // Get stats for all accounts in parallel
    const results = await Promise.all(
      items.map(async (item) => {
        const [accessToken, friendCount, scenarioCount, msgCount, pharmacyMode] = await Promise.all([
          accountAccessToken(c, item.id),
          db.prepare(`SELECT COUNT(*) as count FROM friends WHERE is_following = 1 AND line_account_id = ?`).bind(item.id).first<{ count: number }>(),
          db.prepare(
            `SELECT COUNT(*) as count FROM friend_scenarios fs
             INNER JOIN friends f ON f.id = fs.friend_id
             WHERE fs.status = 'active' AND f.line_account_id = ?`,
          ).bind(item.id).first<{ count: number }>(),
          db.prepare(
            // 「今月送信」(messagesThisMonth) は LINE 公式ダッシュボードの「配信済みの無料メッセージ数」と
            // 揃える設計: push 系のみ + 当月 1 日 00:00 以降。reply API 経由 (1-on-1 chat) は LINE quota 外なので
            // delivery_type='push' で除外。以前は date('now', '-30 days') の rolling window で月初に bias 残って
            // 公式 dashboard と数桁ズレてた (例: 公式 10 通 vs UI 10,609 通) → start of month に揃えた。
            `SELECT COUNT(*) as count FROM messages_log ml
             INNER JOIN friends f ON f.id = ml.friend_id
             WHERE ml.direction = 'outgoing' AND (ml.delivery_type IS NULL OR ml.delivery_type = 'push') AND ml.created_at >= date('now', 'start of month') AND f.line_account_id = ?`,
          ).bind(item.id).first<{ count: number }>(),
          isPharmacyModeAccount(db, item.id),
        ]);
        const profile = accessToken ? await fetchBotProfile(accessToken) : {};

        return {
          ...serializeLineAccount(item),
          displayName: profile.displayName || item.name,
          pictureUrl: profile.pictureUrl || null,
          basicId: profile.basicId || null,
          pharmacyMode,
          stats: {
            friendCount: friendCount?.count ?? 0,
            activeScenarios: scenarioCount?.count ?? 0,
            messagesThisMonth: msgCount?.count ?? 0,
          },
        };
      }),
    );
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('GET /api/line-accounts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/line-accounts/:id - get single without returning stored credentials
lineAccounts.get('/api/line-accounts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const denied = await requireAccountAccess(c, id);
    if (denied) return denied;
    const account = await getLineAccountByIdForTenant(
      c.env.DB,
      c.get('tenantId'),
      id,
    );
    if (!account) {
      return c.json({ success: false, error: 'LINE account not found' }, 404);
    }
    return c.json({ success: true, data: serializeLineAccount(account) });
  } catch (err) {
    console.error('GET /api/line-accounts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/line-accounts/:id/follower-insight - compare DB state with LINE official follower stats
lineAccounts.get('/api/line-accounts/:id/follower-insight', async (c) => {
  try {
    const id = c.req.param('id');
    const denied = await requireAccountAccess(c, id);
    if (denied) return denied;
    const date = c.req.query('date');
    if (!date || !/^\d{8}$/.test(date)) {
      return c.json({ success: false, error: 'date query is required in yyyyMMdd format' }, 400);
    }

    const account = await getLineAccountByIdForTenant(
      c.env.DB,
      c.get('tenantId'),
      id,
    );
    if (!account) {
      return c.json({ success: false, error: 'LINE account not found' }, 404);
    }

    const accessToken = await accountAccessToken(c, account.id);
    if (!accessToken) {
      return c.json({ success: false, error: 'LINE account credentials unavailable' }, 503);
    }
    const client = new LineClient(accessToken);
    const insight = await client.getFollowersInsight(date);
    return c.json({
      success: true,
      data: {
        lineAccountId: account.id,
        date,
        status: insight.status,
        followers: typeof insight.followers === 'number' ? insight.followers : null,
        targetedReaches: typeof insight.targetedReaches === 'number' ? insight.targetedReaches : null,
        blocks: typeof insight.blocks === 'number' ? insight.blocks : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/line-accounts/:id/follower-insight error:', message);
    return c.json({ success: false, error: 'Failed to fetch LINE follower insight' }, 502);
  }
});

// Existing-follower migration is an explicit, persisted, one-time job.
// No cron polls LINE: connection/UI performs a one-item capability probe, then
// operator-approved step requests advance the D1 cursor until completion.
lineAccounts.get('/api/line-accounts/:id/follower-import', async (c) => {
  const id = c.req.param('id');
  const denied = await requireAccountAccess(c, id);
  if (denied) return denied;
  const account = await getLineAccountByIdForTenant(
    c.env.DB,
    c.get('tenantId'),
    id,
  );
  if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);
  const state = await getFollowerImportState(c.env.DB, account.id);
  return c.json({ success: true, data: state });
});

lineAccounts.post(
  '/api/line-accounts/:id/follower-import/detect',
  requireRole('owner', 'admin'),
  async (c) => {
    try {
      const id = c.req.param('id')!;
      const denied = await requireAccountAccess(c, id);
      if (denied) return denied;
      const account = await getLineAccountByIdForTenant(
        c.env.DB,
        c.get('tenantId'),
        id,
      );
      if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);
      const accessToken = await accountAccessToken(c, account.id);
      if (!accessToken) {
        return c.json({ success: false, error: 'LINE account credentials unavailable' }, 503);
      }
      const client = new LineClient(accessToken);
      const state = await detectFollowerImportCapability(
        c.env.DB,
        client as unknown as FollowerImportClient,
        account.id,
      );
      return c.json({ success: true, data: state });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('follower import capability detection error:', message);
      return c.json({ success: false, error: '利用可否の確認に失敗しました' }, 502);
    }
  },
);

lineAccounts.post(
  '/api/line-accounts/:id/follower-import/start',
  requireRole('owner', 'admin'),
  async (c) => {
    const id = c.req.param('id')!;
    const denied = await requireAccountAccess(c, id);
    if (denied) return denied;
    const account = await getLineAccountByIdForTenant(
      c.env.DB,
      c.get('tenantId'),
      id,
    );
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);
    try {
      const state = await startFollowerImport(c.env.DB, account.id);
      return c.json({ success: true, data: state });
    } catch (err) {
      if (err instanceof Error && err.message === 'FOLLOWER_IMPORT_NOT_AVAILABLE') {
        return c.json({ success: false, error: 'このアカウントでは既存友だち取得を利用できません' }, 409);
      }
      throw err;
    }
  },
);

lineAccounts.post(
  '/api/line-accounts/:id/follower-import/step',
  requireRole('owner', 'admin'),
  async (c) => {
    const id = c.req.param('id')!;
    const denied = await requireAccountAccess(c, id);
    if (denied) return denied;
    const account = await getLineAccountByIdForTenant(
      c.env.DB,
      c.get('tenantId'),
      id,
    );
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);
    const accessToken = await accountAccessToken(c, account.id);
    if (!accessToken) {
      return c.json({ success: false, error: 'LINE account credentials unavailable' }, 503);
    }
    const client = new LineClient(accessToken);
    const result = await processFollowerImportStep(
      c.env.DB,
      client as unknown as FollowerImportClient,
      account.id,
    );
    return c.json({ success: true, data: result });
  },
);

// Validate an existing account against LINE, bind its canonical bot identity,
// and point LINE at the shared multi-tenant webhook. Safe to retry.
lineAccounts.post(
  '/api/line-accounts/:id/connect',
  requireRole('owner'),
  async (c) => {
    const id = c.req.param('id')!;
    const denied = await requireAccountAccess(c, id);
    if (denied) return denied;
    const account = await getLineAccountByIdForTenant(
      c.env.DB,
      c.get('tenantId'),
      id,
    );
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);

    const webhookUrl = configuredWebhookUrl(c.env);
    if (!webhookUrl) {
      return c.json({ success: false, error: 'Public webhook URL is not configured' }, 503);
    }

    const accessToken = await accountAccessToken(c, account.id);
    if (!accessToken) {
      return c.json({ success: false, error: 'LINE account credentials unavailable' }, 503);
    }
    const client = new LineClient(accessToken);
    let botUserId = '';
    try {
      const response = await client.request('GET', '/v2/bot/info');
      botUserId = requireLineBotUserId(response.data);
    } catch {
      return c.json({ success: false, error: 'LINE access token validation failed' }, 400);
    }

    const now = new Date().toISOString();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO pharmacy_line_channel_identities
             (line_account_id, bot_user_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(line_account_id) DO UPDATE SET bot_user_id = excluded.bot_user_id`,
        ).bind(account.id, botUserId, now),
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO pharmacy_growth_events
             (id, line_account_id, event_type, aggregate_id, subject_key,
              schema_version, occurred_at, idempotency_key, metadata_json, created_at)
           VALUES (?, ?, 'line_account_connected', ?, NULL, 1, ?, ?, '{}', ?)`,
        ).bind(
          crypto.randomUUID(), account.id, account.id, now,
          `line-account-connected:${botUserId}`, now,
        ),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/constraint|unique/i.test(message)) {
        return c.json({ success: false, error: 'This LINE account is already connected to another tenant' }, 409);
      }
      return c.json({ success: false, error: 'LINE connection could not be saved' }, 500);
    }

    try {
      await client.request('PUT', '/v2/bot/channel/webhook/endpoint', { endpoint: webhookUrl });
    } catch {
      return c.json({
        success: false,
        error: 'LINE webhook configuration failed; retry connection',
        data: { lineAccountId: account.id, identityRegistered: true, webhookConfigured: false, webhookUrl },
      }, 502);
    }

    return c.json({
      success: true,
      data: {
        lineAccountId: account.id,
        identityRegistered: true,
        webhookConfigured: true,
        webhookUrl,
        channelSecretVerification: 'pending_first_webhook',
      },
    });
  },
);

// Normalize optional string inputs from the UI:
//   undefined → undefined (caller skips the column)
//   null      → null      (explicit clear)
//   ""        → null      (UI cleared the field)
//   non-string → undefined (defensive: silently drop bad input)
//
// Defined here (and in PATCH below) rather than shared, because the create
// path treats undefined and "" identically (both "no value provided"), while
// the partial-update path needs to distinguish "field absent" (no change)
// from "field cleared" (set to null). Keep the helper local so future
// behavior changes don't accidentally couple the two paths.
function normalizeOptionalString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

// Pair-validate Login Channel ID / Secret. Required because the OAuth flow
// asymmetrically gates on the two columns:
//   /auth/line       — switches to account-specific client_id as soon as
//                      login_channel_id is set (regardless of secret)
//   /auth/callback   — only uses account-specific creds when BOTH are set
// → an account with id-only or secret-only ends up half-configured: looks
// fine in the list, breaks token exchange for new friend-add flows.
//
// Rule: within a single request, the two fields must end up consistent.
// "current" reflects the state already stored (used on update paths so the
// caller can leave the secret unchanged when only renaming the ID).
function validateLoginChannelPair(
  next: { loginChannelId?: string | null | undefined; loginChannelSecret?: string | null | undefined },
  current: { login_channel_id: string | null; login_channel_secret: string | null } | null,
): string | null {
  // Resolve the post-update state for each field.
  // undefined = "not in request" → keep current value
  // null/string = "explicit set"  → use as-is
  const finalId =
    next.loginChannelId === undefined
      ? current?.login_channel_id ?? null
      : next.loginChannelId;
  const finalSecret =
    next.loginChannelSecret === undefined
      ? current?.login_channel_secret ?? null
      : next.loginChannelSecret;

  const idSet = finalId !== null && finalId !== '';
  const secretSet = finalSecret !== null && finalSecret !== '';

  if (idSet !== secretSet) {
    return idSet
      ? 'loginChannelSecret must be provided when loginChannelId is set'
      : 'loginChannelId must be provided when loginChannelSecret is set';
  }
  return null;
}

// Reject duplicate login_channel_id / liff_id across accounts.
// /auth/callback and /api/liff/config both resolve the row with `.first()`
// after a `WHERE col = ?` lookup, so duplicates would silently bind events
// to whichever row D1 happens to return first. App-level check (no DB UNIQUE
// constraint) so we can tighten without a migration on a busy production DB.
async function checkUniqueLoginAndLiff(
  db: D1Database,
  values: { loginChannelId?: string | null | undefined; liffId?: string | null | undefined },
  excludeId: string | null,
): Promise<string | null> {
  // Only check fields we're explicitly setting to non-null.
  const checks: Array<{ column: string; value: string; label: string }> = [];
  if (typeof values.loginChannelId === 'string' && values.loginChannelId !== '') {
    checks.push({ column: 'login_channel_id', value: values.loginChannelId, label: 'loginChannelId' });
  }
  if (typeof values.liffId === 'string' && values.liffId !== '') {
    checks.push({ column: 'liff_id', value: values.liffId, label: 'liffId' });
  }
  for (const { column, value, label } of checks) {
    const row = excludeId
      ? await db
          .prepare(`SELECT id FROM line_accounts WHERE ${column} = ? AND id != ? LIMIT 1`)
          .bind(value, excludeId)
          .first<{ id: string }>()
      : await db
          .prepare(`SELECT id FROM line_accounts WHERE ${column} = ? LIMIT 1`)
          .bind(value)
          .first<{ id: string }>();
    if (row) {
      return `${label} '${value}' is already assigned to another account`;
    }
  }
  return null;
}

function validatePharmacyLiffConfiguration(values: {
  loginChannelId: string | null | undefined;
  loginChannelSecret: string | null | undefined;
  liffId: string | null | undefined;
}): string | null {
  const { loginChannelId, loginChannelSecret, liffId } = values;
  if (!loginChannelId || !loginChannelSecret || !liffId) {
    return 'Pharmacy accounts require a LINE Login channel and LIFF ID';
  }
  if (!/^\d{6,32}$/u.test(loginChannelId) ||
      !/^\d{6,32}-[A-Za-z0-9_-]{8,64}$/u.test(liffId) ||
      !liffId.startsWith(`${loginChannelId}-`)) {
    return 'LIFF ID must belong to the LINE Login channel';
  }
  return null;
}

async function pharmacyLiffConfigurationError(
  db: D1Database,
  rootSecret: string | undefined,
  tenantId: string,
  lineAccountId: string,
  current: { login_channel_id: string | null; login_channel_secret: string | null; liff_id: string | null },
  next: { loginChannelId?: string | null; loginChannelSecret?: string | null; liffId?: string | null },
): Promise<string | null> {
  if (!await isPharmacyModeAccount(db, lineAccountId)) return null;

  let loginChannelSecret = next.loginChannelSecret === undefined
    ? current.login_channel_secret
    : next.loginChannelSecret;
  if (next.loginChannelSecret === undefined && loginChannelSecret) {
    if (!loginChannelSecret.startsWith('encrypted:')) {
      return 'Pharmacy accounts require encrypted credential migration before LIFF updates';
    }
    loginChannelSecret = rootSecret
      ? await readLineCredential(db, rootSecret, {
        tenantId,
        lineAccountId,
        kind: 'login_channel_secret',
      })
      : null;
  }

  return validatePharmacyLiffConfiguration({
    loginChannelId: next.loginChannelId === undefined
      ? current.login_channel_id
      : next.loginChannelId,
    loginChannelSecret,
    liffId: next.liffId === undefined ? current.liff_id : next.liffId,
  });
}

// POST /api/line-accounts - create
lineAccounts.post('/api/line-accounts', requireRole('owner'), async (c) => {
  try {
    const body = await c.req.json<{
      channelId: string;
      name: string;
      channelAccessToken: string;
      channelSecret: string;
      loginChannelId?: string | null;
      loginChannelSecret?: string | null;
      liffId?: string | null;
      ogSiteName?: string | null;
      ogDefaultImageUrl?: string | null;
      ogDefaultDescription?: string | null;
    }>();

    if (!body.channelId || !body.name || !body.channelAccessToken || !body.channelSecret) {
      return c.json(
        { success: false, error: 'channelId, name, channelAccessToken, and channelSecret are required' },
        400,
      );
    }
    const credentialRootSecret = c.env.LINE_CREDENTIAL_KEY_V1;
    if (!credentialRootSecret) {
      return c.json({ success: false, error: 'LINE credential encryption is not configured' }, 503);
    }

    // Optional fields: empty string from UI = "not provided" → store NULL.
    // Trim whitespace defensively (LINE IDs/secrets shouldn't have spaces;
    // accidental spaces from copy-paste would silently break OAuth otherwise).
    const loginChannelId = normalizeOptionalString(body.loginChannelId) ?? null;
    const loginChannelSecret = normalizeOptionalString(body.loginChannelSecret) ?? null;
    const liffId = normalizeOptionalString(body.liffId) ?? null;

    const pairError = validateLoginChannelPair(
      { loginChannelId, loginChannelSecret },
      null,
    );
    if (pairError) return c.json({ success: false, error: pairError }, 400);

    const pharmacyTenant = await isPharmacyTenant(c.env.DB, c.get('tenantId'));
    if (pharmacyTenant) {
      const pharmacyError = validatePharmacyLiffConfiguration({
        loginChannelId,
        loginChannelSecret,
        liffId,
      });
      if (pharmacyError) return c.json({ success: false, error: pharmacyError }, 400);
    }

    const dupError = await checkUniqueLoginAndLiff(c.env.DB, { loginChannelId, liffId }, null);
    if (dupError) return c.json({ success: false, error: dupError }, 409);

    const credentials = [
      { kind: 'channel_access_token' as const, credential: body.channelAccessToken },
      { kind: 'channel_secret' as const, credential: body.channelSecret },
      ...(loginChannelSecret
        ? [{ kind: 'login_channel_secret' as const, credential: loginChannelSecret }]
        : []),
    ];
    const account = await createEncryptedLineAccount(c.env.DB, credentialRootSecret, {
      tenantId: c.get('tenantId'),
      assignedStaffId: pharmacyTenant ? c.get('staff').id : undefined,
      channelId: body.channelId,
      name: body.name,
      credentials,
      loginChannelId,
      liffId,
      ogSiteName: normalizeOptionalString(body.ogSiteName) ?? null,
      ogDefaultImageUrl: normalizeOptionalString(body.ogDefaultImageUrl) ?? null,
      ogDefaultDescription: normalizeOptionalString(body.ogDefaultDescription) ?? null,
    });

    // One read-only request at connection time records whether this account
    // can use followers/ids. This never starts the migration and is non-fatal:
    // a temporary LINE outage must not roll back account registration.
    try {
      await detectFollowerImportCapability(
        c.env.DB,
        new LineClient(body.channelAccessToken) as unknown as FollowerImportClient,
        account.id,
      );
    } catch (err) {
      console.error('[line-accounts] follower import capability probe failed', err);
    }

    return c.json({ success: true, data: serializeLineAccount(account) }, 201);
  } catch (err) {
    // D1 surfaces UNIQUE-constraint violations as a thrown error. Surface
    // those as 409 so idempotent callers (e.g. create-line-harness retry
    // loop) can treat "already registered" as a non-fatal success.
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(message)) {
      return c.json({ success: false, error: 'channelId already registered' }, 409);
    }
    console.error('POST /api/line-accounts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Authorization split:
//   PUT  (credentials replace)                                       -> owner only
//   PATCH /:id   (metadata: country/role/is_active/display_order)    -> owner|admin
//   PATCH /order (display_order bulk reorder)                        -> owner|admin
// Rationale: PUT replaces channel_access_token / channel_secret which is high-risk
// (mistake or misuse can stop production). PATCH only edits display metadata that
// is operationally safe for admins to change without owner intervention.

// PATCH /api/line-accounts/order — bulk update display_order
// IMPORTANT: must be declared BEFORE /:id so Hono matches the literal "order" first.
lineAccounts.patch(
  '/api/line-accounts/order',
  requireRole('owner', 'admin'),
  async (c) => {
    try {
      const body = await c.req.json<{
        ordered: Array<{ id: string; displayOrder: number }>;
      }>();

      if (!Array.isArray(body.ordered)) {
        return c.json({ success: false, error: 'ordered: array required' }, 400);
      }
      for (const item of body.ordered) {
        if (typeof item.id !== 'string' || typeof item.displayOrder !== 'number') {
          return c.json(
            { success: false, error: 'ordered[].id (string) and displayOrder (number) required' },
            400,
          );
        }
      }

      const accountIds = new Set(
        (await getLineAccountsForTenant(c.env.DB, c.get('tenantId'))).map(({ id }) => id),
      );
      if (body.ordered.some(({ id }) => !accountIds.has(id))) {
        return c.json({ success: false, error: 'LINE account not found' }, 404);
      }

      await updateLineAccountOrder(c.env.DB, body.ordered);
      return c.json({ success: true });
    } catch (err) {
      console.error('PATCH /api/line-accounts/order error:', err);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  },
);

// PATCH /api/line-accounts/:id — partial update of metadata + optional Login/LIFF wiring.
// Scope: name, isActive, country, role, loginChannelId, loginChannelSecret, liffId.
// Out-of-scope (use PUT instead): channelAccessToken, channelSecret — those are
// production-impacting credentials and require owner-only PUT.
//
// Why loginChannelSecret is allowed via PATCH (admin) but channelSecret isn't:
// rotating the LINE Login secret only breaks the auth/friend-add flow for new
// users (recoverable). Rotating the Messaging channelSecret breaks webhook
// verification for *all* incoming events from LINE → silent message loss, no
// observability until users complain. Different blast radius, different role.
lineAccounts.patch(
  '/api/line-accounts/:id',
  requireRole('owner', 'admin'),
  async (c) => {
    try {
      const id = c.req.param('id')!;
      const denied = await requireAccountAccess(c, id);
      if (denied) return denied;
      const current = await getLineAccountByIdForTenant(c.env.DB, c.get('tenantId'), id);
      if (!current) return c.json({ success: false, error: 'not found' }, 404);
      const body = await c.req.json<{
        name?: string;
        isActive?: boolean;
        country?: string | null;
        role?: string | null;
        loginChannelId?: string | null;
        loginChannelSecret?: string | null;
        liffId?: string | null;
        ogSiteName?: string | null;
        ogDefaultImageUrl?: string | null;
        ogDefaultDescription?: string | null;
      }>();

      // Normalize: trim non-empty strings; treat empty/whitespace-only as null.
      // Empty-string-from-UI represents "user cleared the field" — store as NULL,
      // not as empty string, so countryFlag() lookup degrades gracefully.
      const country = normalizeOptionalString(body.country);
      const role = normalizeOptionalString(body.role);
      const loginChannelId = normalizeOptionalString(body.loginChannelId);
      const loginChannelSecret = normalizeOptionalString(body.loginChannelSecret);
      const liffId = normalizeOptionalString(body.liffId);
      const ogSiteName = normalizeOptionalString(body.ogSiteName);
      const ogDefaultImageUrl = normalizeOptionalString(body.ogDefaultImageUrl);
      const ogDefaultDescription = normalizeOptionalString(body.ogDefaultDescription);

      // Pre-validate Login pair + uniqueness against the tenant-scoped row so
      // the caller gets a clean error before we mutate.
      //
      // The pair check only runs when the request itself touches Login
      // fields. That matters because the setup CLI (packages/create-line-
      // harness/.../setup.ts:646-665) persists `login_channel_id` without
      // `login_channel_secret` as a best-effort step, so accounts in the
      // wild can have a half-set Login pair. A LIFF-only dashboard save
      // shouldn't be blocked by that pre-existing inconsistency.
      const touchesLogin =
        loginChannelId !== undefined || loginChannelSecret !== undefined;
      const touchesLoginOrLiff = touchesLogin || liffId !== undefined;
      if (touchesLoginOrLiff) {
        if (touchesLogin) {
          const pairError = validateLoginChannelPair(
            { loginChannelId, loginChannelSecret },
            current,
          );
          if (pairError) return c.json({ success: false, error: pairError }, 400);
        }
        const pharmacyError = await pharmacyLiffConfigurationError(
          c.env.DB,
          c.env.LINE_CREDENTIAL_KEY_V1,
          c.get('tenantId'),
          id,
          current,
          { loginChannelId, loginChannelSecret, liffId },
        );
        if (pharmacyError) return c.json({ success: false, error: pharmacyError }, 400);
        const dupError = await checkUniqueLoginAndLiff(
          c.env.DB,
          { loginChannelId, liffId },
          id,
        );
        if (dupError) return c.json({ success: false, error: dupError }, 409);
      }

      const updated = await updateEncryptedLineAccount(
        c.env.DB,
        c.env.LINE_CREDENTIAL_KEY_V1,
        {
          tenantId: c.get('tenantId'),
          lineAccountId: id,
          expectedUpdatedAt: current.updated_at,
          credentials: loginChannelSecret === undefined
            ? []
            : [{ kind: 'login_channel_secret', credential: loginChannelSecret }],
          metadata: {
            name: body.name,
            country,
            role,
            isActive: body.isActive,
            loginChannelId,
            liffId,
            ogSiteName,
            ogDefaultImageUrl,
            ogDefaultDescription,
          },
        },
      );
      return c.json({ success: true, data: serializeLineAccount(updated) });
    } catch (err) {
      console.error('PATCH /api/line-accounts/:id error:', err);
      if (err instanceof Error && err.message === LINE_ACCOUNT_CONFLICT_ERROR) {
        return c.json({ success: false, error: LINE_ACCOUNT_CONFLICT_ERROR }, 409);
      }
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  },
);

// PUT /api/line-accounts/:id - update
// Despite the verb, behaves as a partial update (only provided fields are
// touched). Kept on PUT + owner-only because it's the entry point for
// rotating Messaging credentials (channelAccessToken / channelSecret).
// Also accepts the metadata fields that PATCH handles so an owner can update
// "everything" in one call (e.g. AccountSettingsSection sends country/role
// through this same `api.lineAccounts.update` helper). Without this, country
// and role were silently dropped because PUT used to ignore them.
lineAccounts.put('/api/line-accounts/:id', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const denied = await requireAccountAccess(c, id);
    if (denied) return denied;
    const current = await getLineAccountByIdForTenant(c.env.DB, c.get('tenantId'), id);
    if (!current) {
      return c.json({ success: false, error: 'LINE account not found' }, 404);
    }
    const body = await c.req.json<{
      name?: string;
      channelAccessToken?: string;
      channelSecret?: string;
      loginChannelId?: string | null;
      loginChannelSecret?: string | null;
      liffId?: string | null;
      isActive?: boolean;
      country?: string | null;
      role?: string | null;
      ogSiteName?: string | null;
      ogDefaultImageUrl?: string | null;
      ogDefaultDescription?: string | null;
    }>();

    const country = normalizeOptionalString(body.country);
    const role = normalizeOptionalString(body.role);
    const loginChannelId = normalizeOptionalString(body.loginChannelId);
    const loginChannelSecret = normalizeOptionalString(body.loginChannelSecret);
    const liffId = normalizeOptionalString(body.liffId);
    const ogSiteName = normalizeOptionalString(body.ogSiteName);
    const ogDefaultImageUrl = normalizeOptionalString(body.ogDefaultImageUrl);
    const ogDefaultDescription = normalizeOptionalString(body.ogDefaultDescription);
    if (body.channelAccessToken !== undefined && !body.channelAccessToken.trim()) {
      return c.json({ success: false, error: 'channelAccessToken cannot be empty' }, 400);
    }
    if (body.channelSecret !== undefined && !body.channelSecret.trim()) {
      return c.json({ success: false, error: 'channelSecret cannot be empty' }, 400);
    }

    // Validate Login pair + uniqueness identically to PATCH. PUT is the
    // owner-only credential rotation endpoint, so the same correctness
    // guarantees should apply here.
    const putTouchesLogin =
      loginChannelId !== undefined || loginChannelSecret !== undefined;
    if (putTouchesLogin || liffId !== undefined) {
      if (putTouchesLogin) {
        const pairError = validateLoginChannelPair(
          { loginChannelId, loginChannelSecret },
          current,
        );
        if (pairError) return c.json({ success: false, error: pairError }, 400);
      }
    const pharmacyError = await pharmacyLiffConfigurationError(
      c.env.DB,
      c.env.LINE_CREDENTIAL_KEY_V1,
      c.get('tenantId'),
      id,
      current,
      { loginChannelId, loginChannelSecret, liffId },
      );
      if (pharmacyError) return c.json({ success: false, error: pharmacyError }, 400);
      const dupError = await checkUniqueLoginAndLiff(
        c.env.DB,
        { loginChannelId, liffId },
        id,
      );
      if (dupError) return c.json({ success: false, error: dupError }, 409);
    }

    const credentialChanges = [
      ...(body.channelAccessToken !== undefined
        ? [{ kind: 'channel_access_token' as const, credential: body.channelAccessToken }]
        : []),
      ...(body.channelSecret !== undefined
        ? [{ kind: 'channel_secret' as const, credential: body.channelSecret }]
        : []),
      ...(typeof loginChannelSecret === 'string'
        ? [{ kind: 'login_channel_secret' as const, credential: loginChannelSecret }]
        : []),
    ];
    const updated = await updateEncryptedLineAccount(
      c.env.DB,
      c.env.LINE_CREDENTIAL_KEY_V1,
      {
        tenantId: c.get('tenantId'),
        lineAccountId: id,
        expectedUpdatedAt: current.updated_at,
        credentials: [
          ...credentialChanges,
          ...(loginChannelSecret === null
            ? [{ kind: 'login_channel_secret' as const, credential: null }]
            : []),
        ],
        metadata: {
          name: body.name,
          isActive: body.isActive,
          country,
          role,
          loginChannelId,
          liffId,
          ogSiteName,
          ogDefaultImageUrl,
          ogDefaultDescription,
        },
      },
    );

    return c.json({ success: true, data: serializeLineAccount(updated) });
  } catch (err) {
    console.error('PUT /api/line-accounts/:id error:', err);
    if (err instanceof Error && err.message === LINE_ACCOUNT_CONFLICT_ERROR) {
      return c.json({ success: false, error: LINE_ACCOUNT_CONFLICT_ERROR }, 409);
    }
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/line-accounts/:id - delete
lineAccounts.delete('/api/line-accounts/:id', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const denied = await requireAccountAccess(c, id);
    if (denied) return denied;
    const account = await getLineAccountByIdForTenant(c.env.DB, c.get('tenantId'), id);
    if (!account) {
      return c.json({ success: false, error: 'LINE account not found' }, 404);
    }
    await deleteLineAccount(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/line-accounts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { lineAccounts };
