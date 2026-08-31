import { jstNow } from './utils.js';
// =============================================================================
// Traffic Pools — instant account switching via /pool/:slug
// =============================================================================

export interface TrafficPool {
  id: string;
  tenant_id: string | null;
  slug: string;
  name: string;
  active_account_id: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface TrafficPoolWithAccount extends TrafficPool {
  account_name: string;
  liff_id: string | null;
  login_channel_id: string | null;
  login_channel_secret: string | null;
  channel_access_token: string | null;
  channel_id: string | null;
}

// ── Queries ─────────────────────────────────────────────────────────────────

export async function getTrafficPools(
  db: D1Database,
  tenantId: string | null = null,
): Promise<TrafficPoolWithAccount[]> {
  const result = await db
    .prepare(
      `SELECT tp.*, la.name as account_name, la.liff_id, la.login_channel_id, la.login_channel_secret, la.channel_access_token, la.channel_id
       FROM traffic_pools tp
       JOIN line_accounts la ON la.id = tp.active_account_id
       WHERE tp.tenant_id IS ?
       ORDER BY tp.created_at DESC`,
    )
    .bind(tenantId)
    .all<TrafficPoolWithAccount>();
  return result.results;
}

export async function getTrafficPoolById(
  db: D1Database,
  id: string,
  tenantId?: string | null,
): Promise<TrafficPoolWithAccount | null> {
  const scoped = tenantId !== undefined;
  return db
    .prepare(
      `SELECT tp.*, la.name as account_name, la.liff_id, la.login_channel_id, la.login_channel_secret, la.channel_access_token, la.channel_id
       FROM traffic_pools tp
       JOIN line_accounts la ON la.id = tp.active_account_id
       WHERE tp.id = ?${scoped ? ' AND tp.tenant_id IS ?' : ''}`,
    )
    .bind(...(scoped ? [id, tenantId] : [id]))
    .first<TrafficPoolWithAccount>();
}

export async function getTrafficPoolBySlug(
  db: D1Database,
  slug: string,
): Promise<TrafficPoolWithAccount | null> {
  return db
    .prepare(
      `SELECT tp.*, la.name as account_name, la.liff_id, la.login_channel_id, la.login_channel_secret, la.channel_access_token, la.channel_id
       FROM traffic_pools tp
       JOIN line_accounts la ON la.id = tp.active_account_id
       WHERE tp.slug = ? AND tp.is_active = 1`,
    )
    .bind(slug)
    .first<TrafficPoolWithAccount>();
}

// ── Mutations ───────────────────────────────────────────────────────────────

export interface CreateTrafficPoolInput {
  slug: string;
  name: string;
  activeAccountId: string;
  tenantId?: string | null;
}

export async function createTrafficPool(
  db: D1Database,
  input: CreateTrafficPoolInput,
): Promise<TrafficPoolWithAccount> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO traffic_pools
         (id, tenant_id, slug, name, active_account_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, input.tenantId ?? null, input.slug, input.name, input.activeAccountId, now, now)
    .run();

  // Mirror the chosen active account into pool_accounts so the new pool isn't
  // empty in the admin UI and getRandomPoolAccount() includes it on first use.
  // INSERT OR IGNORE because pool_accounts.UNIQUE(pool_id, line_account_id)
  // makes a follow-up explicit add idempotent.
  await db
    .prepare(
      `INSERT OR IGNORE INTO pool_accounts (id, pool_id, line_account_id, is_active, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .bind(crypto.randomUUID(), id, input.activeAccountId, now)
    .run();

  return (await getTrafficPoolById(db, id, input.tenantId ?? null))!;
}

export interface UpdateTrafficPoolInput {
  name?: string;
  activeAccountId?: string;
  isActive?: boolean;
}

export async function updateTrafficPool(
  db: D1Database,
  id: string,
  updates: UpdateTrafficPoolInput,
  tenantId: string | null = null,
): Promise<TrafficPoolWithAccount | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.activeAccountId !== undefined) {
    fields.push('active_account_id = ?');
    values.push(updates.activeAccountId);
  }
  if (updates.isActive !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.isActive ? 1 : 0);
  }

  if (fields.length === 0) return getTrafficPoolById(db, id, tenantId);

  fields.push('updated_at = ?');
  values.push(jstNow());
  values.push(id, tenantId);

  await db
    .prepare(`UPDATE traffic_pools SET ${fields.join(', ')} WHERE id = ? AND tenant_id IS ?`)
    .bind(...values)
    .run();

  return getTrafficPoolById(db, id, tenantId);
}

export async function deleteTrafficPool(
  db: D1Database,
  id: string,
  tenantId: string | null = null,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM traffic_pools WHERE id = ? AND tenant_id IS ?`)
    .bind(id, tenantId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

// =============================================================================
// Pool Accounts — multiple LINE accounts per pool for distribution
// =============================================================================

export interface PoolAccount {
  id: string;
  pool_id: string;
  line_account_id: string;
  is_active: number;
  created_at: string;
}

export interface PoolAccountWithDetails extends PoolAccount {
  account_name: string;
  liff_id: string | null;
  login_channel_id: string | null;
  login_channel_secret: string | null;
  channel_access_token: string | null;
  channel_id: string | null;
}

const POOL_ACCOUNT_JOIN = `
  SELECT pa.*, la.name as account_name, la.liff_id, la.login_channel_id, la.login_channel_secret, la.channel_access_token, la.channel_id
  FROM pool_accounts pa
  JOIN line_accounts la ON la.id = pa.line_account_id`;

export async function getPoolAccounts(
  db: D1Database,
  poolId: string,
  tenantId?: string | null,
): Promise<PoolAccountWithDetails[]> {
  const scoped = tenantId !== undefined;
  const result = await db
    .prepare(
      `${POOL_ACCOUNT_JOIN}
       JOIN traffic_pools tp ON tp.id = pa.pool_id
       WHERE pa.pool_id = ?${scoped ? ' AND tp.tenant_id IS ?' : ''}
       ORDER BY pa.created_at ASC`,
    )
    .bind(...(scoped ? [poolId, tenantId] : [poolId]))
    .all<PoolAccountWithDetails>();
  return result.results;
}

export async function getRandomPoolAccount(db: D1Database, poolId: string): Promise<PoolAccountWithDetails | null> {
  return db
    .prepare(`${POOL_ACCOUNT_JOIN} WHERE pa.pool_id = ? AND pa.is_active = 1 ORDER BY RANDOM() LIMIT 1`)
    .bind(poolId)
    .first<PoolAccountWithDetails>();
}

export async function addPoolAccount(
  db: D1Database,
  poolId: string,
  lineAccountId: string,
  tenantId: string | null = null,
): Promise<PoolAccount | null> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const result = await db
    .prepare(
      `INSERT INTO pool_accounts (id, pool_id, line_account_id, is_active, created_at)
       SELECT ?, id, ?, 1, ? FROM traffic_pools WHERE id = ? AND tenant_id IS ?
       RETURNING *`,
    )
    .bind(id, lineAccountId, now, poolId, tenantId)
    .first<PoolAccount>();
  return result!;
}

export async function removePoolAccount(
  db: D1Database,
  poolId: string,
  id: string,
  tenantId: string | null = null,
): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM pool_accounts
      WHERE id = ? AND pool_id = ?
        AND pool_id IN (SELECT id FROM traffic_pools WHERE tenant_id IS ?)`,
  ).bind(id, poolId, tenantId).run();
  return result.meta.changes > 0;
}

export async function togglePoolAccount(
  db: D1Database,
  poolId: string,
  id: string,
  isActive: boolean,
  tenantId: string | null = null,
): Promise<PoolAccount | null> {
  return db
    .prepare(
      `UPDATE pool_accounts SET is_active = ?
        WHERE id = ? AND pool_id = ?
          AND pool_id IN (SELECT id FROM traffic_pools WHERE tenant_id IS ?)
        RETURNING *`,
    )
    .bind(isActive ? 1 : 0, id, poolId, tenantId)
    .first<PoolAccount>();
}
