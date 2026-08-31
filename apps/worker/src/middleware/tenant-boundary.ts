import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../index.js';
import { isPharmacyModeAccount } from '../custom/pharmacy/growth-loop/access.js';
import { deny } from './deny.js';

const ACCOUNT_KEYS = [
  'lineAccountId',
  'line_account_id',
  'accountId',
  'account_id',
  'accountIds',
  'account',
] as const;

function addAccountIds(target: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value) target.add(value);
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === 'string' && item) target.add(item);
  }
}

export async function accountResourceOwnedByStaff(
  c: Context<Env>,
  tenantId: string,
  accountId: string,
): Promise<boolean> {
  try {
    const platformAdmin = c.get('platformAdmin');
    if (platformAdmin?.id === c.get('staff')?.id) {
      const mapped = await c.env.DB.prepare(
        `SELECT 1 AS ok
           FROM tenant_line_accounts AS mapping
           INNER JOIN line_accounts AS account ON account.id = mapping.line_account_id
          WHERE account.is_active = 1
            AND mapping.tenant_id = ? AND mapping.line_account_id = ?
          LIMIT 1`,
      ).bind(tenantId, accountId).first<{ ok: number }>();
      return Boolean(mapped);
    }
    let pharmacyAccount = await isPharmacyModeAccount(c.env.DB, accountId);
    if (!pharmacyAccount) {
      // After the pharmacy migrations are installed, a missing capability row
      // is corruption, not proof that an account is generic. Keep legacy
      // pre-migration tenants working while failing closed in the live schema.
      const capabilityTable = await c.env.DB.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'pharmacy_account_capabilities'
          LIMIT 1`,
      ).bind().first<{ name: string }>();
      pharmacyAccount = Boolean(capabilityTable?.name);
    }
    if (pharmacyAccount) {
      const staff = c.get('staff');
      if (!staff || staff.id === 'env-owner') return false;
      const assigned = await c.env.DB.prepare(
        `SELECT 1 AS ok
           FROM tenant_line_accounts AS mapping
           INNER JOIN line_accounts AS account
                   ON account.id = mapping.line_account_id
           INNER JOIN tenant_staff_memberships AS membership
                   ON membership.tenant_id = mapping.tenant_id
                  AND membership.staff_id = ?
                  AND membership.is_active = 1
           INNER JOIN pharmacy_staff_accounts AS assignment
                   ON assignment.line_account_id = mapping.line_account_id
                  AND assignment.staff_id = membership.staff_id
                  AND assignment.is_active = 1
          WHERE account.id = mapping.line_account_id
            AND account.is_active = 1
            AND mapping.tenant_id = ? AND mapping.line_account_id = ?
          LIMIT 1`,
      ).bind(staff.id, tenantId, accountId).first<{ ok: number }>();
      return Boolean(assigned);
    }
    const mapped = await c.env.DB.prepare(
      `SELECT 1 AS ok
         FROM tenant_line_accounts AS mapping
         INNER JOIN line_accounts AS account ON account.id = mapping.line_account_id
        WHERE account.is_active = 1
          AND mapping.tenant_id = ? AND mapping.line_account_id = ?
        LIMIT 1`,
    ).bind(tenantId, accountId).first<{ ok: number }>();
    return Boolean(mapped);
  } catch {
    return false;
  }
}

export const tenantAccountSelectorGuard: MiddlewareHandler<Env> = async (c, next) => {
  const tenantId = c.get('tenantId');
  if (!tenantId) return next();

  const accountIds = new Set<string>();
  for (const key of ACCOUNT_KEYS) addAccountIds(accountIds, c.req.query(key));

  // Do not trust Content-Type for an authorization decision. Some clients
  // send JSON as text/plain (and an attacker can choose the header); parsing
  // a clone is safe for non-JSON bodies because failures are ignored.
  const body = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (body) for (const key of ACCOUNT_KEYS) addAccountIds(accountIds, body[key]);

  // Path-bound account routes cannot rely on a query/body selector. Exclude
  // the bulk order endpoint, whose path segment is not an account id.
  const pathAccountId = /^\/api\/line-accounts\/([^/]+)/.exec(c.req.path)?.[1];
  if (pathAccountId && pathAccountId !== 'order') accountIds.add(pathAccountId);

  for (const accountId of accountIds) {
    if (!await accountResourceOwnedByStaff(c, tenantId, accountId)) {
      return deny(c, 403, 'Forbidden');
    }
  }

  return next();
};

const FRIEND_COLLECTION_PATHS = new Set(['/api/friends/count', '/api/friends/ref-stats']);

export const tenantFriendResourceGuard: MiddlewareHandler<Env> = async (c, next) => {
  const tenantId = c.get('tenantId');
  if (!tenantId) return next();

  const path = c.req.path; // decoded path Hono routed on; raw pathname may be percent-encoded
  const bodyFriendIds = new Set<string>();
  const body = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (body) {
    for (const key of ['friendId', 'friend_id', 'friendIds', 'friend_ids']) {
      addAccountIds(bodyFriendIds, body[key]);
    }
  }
  let resourceId: string | null = null;
  let acceptsChatId = false;

  if (!FRIEND_COLLECTION_PATHS.has(path)) {
    resourceId = /^\/api\/friends\/([^/]+)/.exec(path)?.[1] ?? null;
  }
  resourceId ??= /^\/api\/conversations\/([^/]+)/.exec(path)?.[1] ?? null;
  resourceId ??= /^\/api\/scenarios\/[^/]+\/enroll\/([^/]+)/.exec(path)?.[1] ?? null;
  const chatMatch = /^\/api\/chats\/([^/]+)/.exec(path);
  if (chatMatch) {
    resourceId = chatMatch[1];
    acceptsChatId = true;
  }

  const isOwned = async (id: string, allowChatId = false): Promise<boolean> => {
    const row = await c.env.DB.prepare(
      `SELECT friend.line_account_id
         FROM friends AS friend
         INNER JOIN tenant_line_accounts AS mapping
                 ON mapping.line_account_id = friend.line_account_id
         ${allowChatId ? 'LEFT JOIN chats AS chat ON chat.friend_id = friend.id' : ''}
        WHERE mapping.tenant_id = ?
          AND ${allowChatId ? '(friend.id = ? OR chat.id = ?)' : 'friend.id = ?'}
        LIMIT 1`,
    ).bind(tenantId, id, ...(allowChatId ? [id] : [])).first<{ line_account_id: string | null }>();
    if (!row?.line_account_id) return false;
    const owned = await accountResourceOwnedByStaff(c, tenantId, row.line_account_id);
    return owned;
  };

  for (const friendId of bodyFriendIds) {
    if (!await isOwned(friendId)) return deny(c, 403, 'Forbidden');
  }
  if (resourceId && !await isOwned(resourceId, acceptsChatId)) {
    return deny(c, 403, 'Forbidden');
  }

  return next();
};

export const tenantScenarioResourceGuard: MiddlewareHandler<Env> = async (c, next) => {
  const tenantId = c.get('tenantId');
  if (!tenantId) return next();

  const scenarioId = /^\/api\/scenarios\/([^/]+)/.exec(c.req.path)?.[1];
  if (!scenarioId) return next();

  const scenario = await c.env.DB.prepare(
    `SELECT scenario.line_account_id
       FROM scenarios AS scenario
      WHERE scenario.id = ? AND scenario.tenant_id = ?
      LIMIT 1`,
  ).bind(scenarioId, tenantId).first<{ line_account_id: string | null }>();
  if (!scenario) return deny(c, 403, 'Forbidden');
  if (
    scenario.line_account_id &&
    !await accountResourceOwnedByStaff(c, tenantId, scenario.line_account_id)
  ) {
    return deny(c, 403, 'Forbidden');
  }

  return next();
};

export const tenantRichMenuResourceGuard: MiddlewareHandler<Env> = async (c, next) => {
  const tenantId = c.get('tenantId');
  if (!tenantId) return next();

  const path = c.req.path; // decoded path Hono routed on; raw pathname may be percent-encoded
  const groupId = /^\/api\/rich-menu-groups\/([^/]+)/.exec(path)?.[1];
  if (groupId && groupId !== 'external' && groupId !== 'import') {
    const group = await c.env.DB.prepare(
      `SELECT account_id
         FROM rich_menu_groups
        WHERE id = ?
        LIMIT 1`,
    ).bind(groupId).first<{ account_id: string }>();
    if (!group || !await accountResourceOwnedByStaff(c, tenantId, group.account_id)) {
      return deny(c, 403, 'Forbidden');
    }
  }

  let decodedPath = path;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return deny(c, 403, 'Forbidden');
  }
  const imageAccountId = /^\/api\/rich-menu-images\/rich-menus\/([^/]+)\//.exec(decodedPath)?.[1];
  if (path.startsWith('/api/rich-menu-images/') && !imageAccountId) {
    return deny(c, 403, 'Forbidden');
  }
  if (imageAccountId) {
    if (!await accountResourceOwnedByStaff(c, tenantId, imageAccountId)) {
      return deny(c, 403, 'Forbidden');
    }
  }

  return next();
};
