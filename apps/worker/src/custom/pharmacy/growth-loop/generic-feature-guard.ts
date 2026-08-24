import type { Context, Next } from 'hono';
import type { Env } from '../../../index.js';
import {
  hasPharmacyCapability,
  hasPharmacyModeAccount,
  isPharmacyModeAccount,
  isPharmacyTenant,
} from './access.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const PHARMACY_ALLOWED_API_PREFIXES = [
  '/api/auth',
  '/api/custom/pharmacy',
  '/api/liff/pharmacy',
  '/api/capabilities',
  '/api/line-accounts',
  '/api/staff',
  '/api/chats',
  '/api/conversations',
  '/api/inbox',
  '/api/images',
  '/api/meet-consultations',
  '/api/rich-menu-groups',
  '/api/rich-menu-images',
  '/api/tags',
] as const;

const PHARMACY_UNSCOPED_GLOBAL_API_PREFIXES = [
  '/api/webhooks',
  '/api/integrations/stripe',
  '/api/qr',
  '/api/public/media-inquiries',
] as const;

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
  '/api/liff/affiliate',
  '/api/liff/mileage',
  '/api/liff/link',
  '/api/tags',
  '/api/operators',
  '/api/rich-menus',
  ...PHARMACY_UNSCOPED_GLOBAL_API_PREFIXES,
] as const;

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isAllowedPharmacyApi(path: string): boolean {
  if (PHARMACY_ALLOWED_API_PREFIXES.some((prefix) => matchesPrefix(path, prefix))) return true;
  if (path === '/api/account-settings/test-recipients') return true;
  if (path === '/api/friends' || path === '/api/friends/count') return true;
  if (/^\/api\/friends\/[^/]+\/(messages|rich-menu)$/.test(path)) return true;
  return /^\/api\/friends\/(?!count$|ref-stats$)[^/]+$/.test(path);
}

export async function pharmacyTenantApiAllowlistGuard(
  c: Context<Env>,
  next: Next,
): Promise<Response | void> {
  const tenantId = c.get('tenantId');
  if (!tenantId) return next();

  if (!await isPharmacyTenant(c.env.DB, tenantId)) return next();

  const path = new URL(c.req.url).pathname;
  if (!isAllowedPharmacyApi(path)) {
    return c.json({ success: false, error: 'Feature disabled for pharmacy tenant' }, 403);
  }
  return next();
}

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
  if (path === '/api/tags' && c.get('tenantId') && SAFE_METHODS.has(c.req.method.toUpperCase())) {
    return next();
  }
  if (!c.get('tenantId') &&
      PHARMACY_UNSCOPED_GLOBAL_API_PREFIXES.some((prefix) => matchesPrefix(path, prefix)) &&
      await hasPharmacyModeAccount(c.env.DB)) {
    return c.json({ success: false, error: 'generic feature disabled for pharmacy install' }, 403);
  }
  const identityLineUserField = path === '/api/meet-callback'
    ? 'line_user_id'
    : path === '/api/liff/send-form-link' ? 'lineUserId' : null;
  const requiresOwnedIdentity = identityLineUserField !== null;
  const accountIds = new Set<string>();
  const friendIds = new Set<string>();
  const lineUserIds = new Set<string>();
  if (!requiresOwnedIdentity) {
    for (const key of ['lineAccountId', 'line_account_id', 'accountId', 'account_id']) {
      addAccountIds(accountIds, c.req.query(key));
    }
  }

  if (!SAFE_METHODS.has(c.req.method.toUpperCase())) {
    // Content-Type is client-controlled; parse a clone so a JSON body marked
    // as text/plain cannot bypass the account resolver.
    const body = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (body) {
      if (identityLineUserField) {
        const lineUserId = body[identityLineUserField];
        if (typeof lineUserId !== 'string' || !lineUserId) {
          return c.json({ success: false, error: 'generic feature account scope required' }, 403);
        }
        lineUserIds.add(lineUserId);
      } else {
        for (const key of ['lineAccountId', 'line_account_id', 'accountId', 'account_id', 'accountIds']) {
          addAccountIds(accountIds, body[key]);
        }
        addAccountIds(friendIds, body.friendId);
        addAccountIds(friendIds, body.friend_id);
        addAccountIds(lineUserIds, body.lineUserId);
        addAccountIds(lineUserIds, body.line_user_id);
      }
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
      `SELECT f.line_account_id
         FROM friends f
         LEFT JOIN pharmacy_account_capabilities capability
           ON capability.line_account_id = f.line_account_id
        WHERE f.provider_line_user_id = ? AND f.line_account_id IS NOT NULL
        ORDER BY CASE WHEN capability.mode = 'pharmacy' THEN 0 ELSE 1 END, f.line_account_id
        LIMIT 1`,
    ).bind(lineUserId).first<{ line_account_id: string }>();
    if (friend?.line_account_id) accountIds.add(friend.line_account_id);
  }

  if (!requiresOwnedIdentity) {
    for (const accountId of await resourceAccountIds(c, path)) accountIds.add(accountId);
  }

  const tenantId = c.get('tenantId');
  if (accountIds.size === 0 && !requiresOwnedIdentity && tenantId) {
    const tenantAccounts = await c.env.DB.prepare(
      `SELECT line_account_id
         FROM tenant_line_accounts
        WHERE tenant_id = ?`,
    ).bind(tenantId).all<{ line_account_id: string }>();
    for (const account of tenantAccounts.results) accountIds.add(account.line_account_id);
    if (accountIds.size === 0) {
      return c.json({ success: false, error: 'generic feature account scope required' }, 403);
    }
  }

  if (accountIds.size === 0 && !requiresOwnedIdentity && !tenantId) {
    const account = await c.env.DB.prepare(
      `SELECT id FROM line_accounts WHERE channel_id = ? AND is_active = 1`,
    ).bind(c.env.LINE_CHANNEL_ID).first<{ id: string }>();
    if (account) accountIds.add(account.id);
  }

  if (accountIds.size === 0) {
    if (await hasPharmacyModeAccount(c.env.DB)) {
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

export async function pharmacyManualChatMutationGuard(
  c: Context<Env>,
  next: Next,
): Promise<Response | void> {
  const method = c.req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return next();

  const path = c.req.path;
  let resourceId: string | null = null;
  if (method === 'POST' && path === '/api/chats') {
    const body = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
    resourceId = typeof body?.friendId === 'string' ? body.friendId : null;
  } else if (method === 'PUT') {
    resourceId = /^\/api\/chats\/([^/]+)$/.exec(path)?.[1] ?? null;
  } else if (method === 'POST') {
    resourceId = /^\/api\/chats\/([^/]+)\/(?:loading|send)$/.exec(path)?.[1]
      ?? /^\/api\/friends\/([^/]+)\/messages$/.exec(path)?.[1]
      ?? null;
  }
  if (!resourceId) {
    return path === '/api/chats' || path.startsWith('/api/chats/') || path.endsWith('/messages')
      ? c.json({ success: false, error: 'pharmacy capability account scope required' }, 403)
      : next();
  }

  const tenantId = c.get('tenantId');
  if (!tenantId) return c.json({ success: false, error: 'pharmacy capability account scope required' }, 403);
  const row = await c.env.DB.prepare(
    `SELECT friend.line_account_id
       FROM friends AS friend
       INNER JOIN tenant_line_accounts AS mapping
               ON mapping.line_account_id = friend.line_account_id
       LEFT JOIN chats AS chat ON chat.friend_id = friend.id
      WHERE mapping.tenant_id = ?
        AND (friend.id = ? OR chat.id = ?)
      LIMIT 1`,
  ).bind(tenantId, resourceId, resourceId).first<{ line_account_id: string | null }>();
  if (!row?.line_account_id) {
    return c.json({ success: false, error: 'pharmacy capability account scope required' }, 403);
  }
  if (!await isPharmacyModeAccount(c.env.DB, row.line_account_id)) return next();
  if (await hasPharmacyCapability(c.env.DB, row.line_account_id, 'manual_chat')) return next();
  return c.json({ success: false, error: 'pharmacy capability is not enabled' }, 403);
}
