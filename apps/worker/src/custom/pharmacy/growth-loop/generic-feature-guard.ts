import type { Context, Next } from 'hono';
import type { Env } from '../../../index.js';
import { isPharmacyModeAccount } from './access.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const PHARMACY_DISABLED_GENERIC_API_PREFIXES = [
  '/api/broadcasts',
  '/api/scenarios',
  '/api/automations',
  '/api/auto-replies',
  '/api/reminders',
  '/api/friend-reminders',
  '/api/mileage',
  '/api/scoring-rules',
  '/api/affiliates',
  '/api/affiliates-report',
  '/api/affiliate-offers',
  '/api/conversions',
  '/api/traffic-pools',
  '/api/webinars',
  '/api/liff/webinars',
  '/api/forms',
  '/api/meet-callback',
  '/api/booking',
  '/api/liff/booking',
  '/api/events',
  '/api/liff/events',
  '/api/liff/send-form-link',
] as const;

function addAccountIds(target: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value) target.add(value);
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === 'string' && item) target.add(item);
  }
}

function parseAccountIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function resourceAccountIds(c: Context<Env>, path: string): Promise<string[]> {
  const liffId = c.req.query('liffId');
  if (liffId) {
    const row = await c.env.DB.prepare(
      `SELECT id AS line_account_id FROM line_accounts WHERE liff_id = ? AND is_active = 1`,
    ).bind(liffId).first<{ line_account_id: string | null }>();
    if (row?.line_account_id) return [row.line_account_id];
  }

  const broadcast = /^\/api\/broadcasts\/([^/]+)/.exec(path);
  if (broadcast) {
    const row = await c.env.DB.prepare(
      `SELECT line_account_id, account_ids FROM broadcasts WHERE id = ?`,
    ).bind(broadcast[1]).first<{ line_account_id: string | null; account_ids: string | null }>();
    return row ? [row.line_account_id, ...parseAccountIds(row.account_ids)].filter((id): id is string => !!id) : [];
  }

  const scenario = /^\/api\/scenarios\/([^/]+)/.exec(path);
  if (scenario) {
    const row = await c.env.DB.prepare(
      `SELECT line_account_id FROM scenarios WHERE id = ?`,
    ).bind(scenario[1]).first<{ line_account_id: string | null }>();
    const ids = row?.line_account_id ? [row.line_account_id] : [];
    const enrollment = /^\/api\/scenarios\/[^/]+\/enroll\/([^/]+)/.exec(path);
    if (enrollment) {
      const friend = await c.env.DB.prepare(
        `SELECT line_account_id FROM friends WHERE id = ?`,
      ).bind(enrollment[1]).first<{ line_account_id: string | null }>();
      if (friend?.line_account_id) ids.push(friend.line_account_id);
    }
    return ids;
  }

  const automation = /^\/api\/automations\/([^/]+)/.exec(path);
  if (automation) {
    const row = await c.env.DB.prepare(
      `SELECT line_account_id FROM automations WHERE id = ?`,
    ).bind(automation[1]).first<{ line_account_id: string | null }>();
    return row?.line_account_id ? [row.line_account_id] : [];
  }

  const directResources: Array<[RegExp, string]> = [
    [/^\/api\/auto-replies\/([^/]+)/, `SELECT line_account_id FROM auto_replies WHERE id = ?`],
    [/^\/api\/affiliate-offers\/([^/]+)/, `SELECT line_account_id FROM affiliate_offers WHERE id = ?`],
    [/^\/api\/traffic-pools\/([^/]+)/, `SELECT active_account_id AS line_account_id FROM traffic_pools WHERE id = ?`],
    [/^\/api\/webinars\/([^/]+)/, `SELECT account_id AS line_account_id FROM webinars WHERE id = ?`],
    [/^\/api\/liff\/webinars\/([^/]+)/, `SELECT account_id AS line_account_id FROM webinars WHERE slug = ?`],
  ];
  for (const [pattern, sql] of directResources) {
    const match = pattern.exec(path);
    if (!match) continue;
    const row = await c.env.DB.prepare(sql).bind(match[1]).first<{ line_account_id: string | null }>();
    return row?.line_account_id ? [row.line_account_id] : [];
  }

  const reminderEnrollment = /^\/api\/reminders\/[^/]+\/enroll\/([^/]+)/.exec(path);
  if (reminderEnrollment) {
    const friend = await c.env.DB.prepare(
      `SELECT line_account_id FROM friends WHERE id = ?`,
    ).bind(reminderEnrollment[1]).first<{ line_account_id: string | null }>();
    return friend?.line_account_id ? [friend.line_account_id] : [];
  }

  const friendReminder = /^\/api\/friend-reminders\/([^/]+)/.exec(path);
  if (friendReminder) {
    const row = await c.env.DB.prepare(
      `SELECT f.line_account_id
         FROM friend_reminders fr INNER JOIN friends f ON f.id = fr.friend_id
        WHERE fr.id = ?`,
    ).bind(friendReminder[1]).first<{ line_account_id: string | null }>();
    return row?.line_account_id ? [row.line_account_id] : [];
  }
  return [];
}

export async function pharmacyGenericFeatureGuard(c: Context<Env>, next: Next): Promise<Response | void> {
  const path = new URL(c.req.url).pathname;
  const accountIds = new Set<string>();
  const friendIds = new Set<string>();
  const lineUserIds = new Set<string>();
  for (const key of ['lineAccountId', 'line_account_id', 'accountId', 'account_id']) {
    addAccountIds(accountIds, c.req.query(key));
  }

  if (!SAFE_METHODS.has(c.req.method.toUpperCase()) && c.req.header('content-type')?.includes('application/json')) {
    const body = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (body) {
      for (const key of ['lineAccountId', 'line_account_id', 'accountId', 'account_id', 'accountIds']) {
        addAccountIds(accountIds, body[key]);
      }
      addAccountIds(friendIds, body.friendId);
      addAccountIds(friendIds, body.friend_id);
      addAccountIds(lineUserIds, body.lineUserId);
      addAccountIds(lineUserIds, body.line_user_id);
    }
  }

  for (const friendId of friendIds) {
    const friend = await c.env.DB.prepare(
      `SELECT line_account_id FROM friends WHERE id = ?`,
    ).bind(friendId).first<{ line_account_id: string | null }>();
    if (friend?.line_account_id) accountIds.add(friend.line_account_id);
  }
  for (const lineUserId of lineUserIds) {
    const friend = await c.env.DB.prepare(
      `SELECT line_account_id FROM friends WHERE line_user_id = ?`,
    ).bind(lineUserId).first<{ line_account_id: string | null }>();
    if (friend?.line_account_id) accountIds.add(friend.line_account_id);
  }

  for (const accountId of await resourceAccountIds(c, path)) accountIds.add(accountId);

  if (accountIds.size === 0) {
    const account = await c.env.DB.prepare(
      `SELECT id FROM line_accounts WHERE channel_id = ? AND is_active = 1`,
    ).bind(c.env.LINE_CHANNEL_ID).first<{ id: string }>();
    if (account) accountIds.add(account.id);
  }

  if (accountIds.size === 0) {
    const pharmacyInstall = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM pharmacy_account_capabilities WHERE mode = 'pharmacy' LIMIT 1`,
    ).first<{ ok: number }>();
    if (pharmacyInstall) {
      return c.json({ success: false, error: 'generic feature account scope required' }, 403);
    }
  }

  for (const accountId of accountIds) {
    if (await isPharmacyModeAccount(c.env.DB, accountId)) {
      return c.json({ success: false, error: 'generic feature disabled for pharmacy account' }, 403);
    }
  }
  return next();
}
