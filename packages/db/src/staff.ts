import { jstNow } from './utils.js';

export interface StaffMember {
  id: string;
  name: string;
  email: string | null;
  role: 'owner' | 'admin' | 'staff';
  api_key: string;
  /** HMAC-SHA-256 of `api_key`. NULL for keys issued before custom_027. */
  api_key_hash: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CreateStaffInput {
  name: string;
  email?: string | null;
  role: 'owner' | 'admin' | 'staff';
}

export interface UpdateStaffInput {
  name?: string;
  email?: string | null;
  role?: 'owner' | 'admin' | 'staff';
  is_active?: number;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `lh_${hex}`;
}

const STAFF_API_KEY_LABEL = 'staff-api-key:v1';

/**
 * Keyed hash for staff API keys. A key is a 128-bit CSPRNG token, not a
 * human-chosen password, so a slow KDF buys nothing; the server-side secret is
 * what stops a D1 read leak from yielding replayable bearer tokens. Same
 * HMAC-SHA-256 shape as the LINE credential lookup digest.
 */
export async function hashStaffApiKey(secret: string, apiKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${STAFF_API_KEY_LABEL}:${apiKey}`),
  );
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Dual-read lookup. `api_key_hash` is authoritative for keys issued after
 * custom_027; older keys only exist in plaintext, so a miss falls back to the
 * legacy column and opportunistically backfills the hash. Without a secret the
 * behaviour is exactly the pre-custom_027 plaintext lookup.
 */
export async function getStaffByApiKey(
  db: D1Database,
  apiKey: string,
  hashSecret?: string,
): Promise<StaffMember | null> {
  const hash = hashSecret ? await hashStaffApiKey(hashSecret, apiKey) : null;

  if (hash) {
    const hashed = await db
      .prepare('SELECT * FROM staff_members WHERE api_key_hash = ? AND is_active = 1')
      .bind(hash)
      .first<StaffMember>();
    if (hashed) return hashed;
  }

  const legacy = await db
    .prepare(`SELECT * FROM staff_members
              WHERE api_key = ? AND is_active = 1
                AND api_key NOT LIKE 'disabled:%'`)
    .bind(apiKey)
    .first<StaffMember>();

  if (legacy && hash && !legacy.api_key_hash) {
    // Best effort: a failed backfill must never turn a valid key into a 401.
    await db
      .prepare('UPDATE staff_members SET api_key_hash = ? WHERE id = ? AND api_key_hash IS NULL')
      .bind(hash, legacy.id)
      .run()
      .catch(() => undefined);
  }

  return legacy;
}

export async function getStaffMembers(db: D1Database): Promise<StaffMember[]> {
  const result = await db
    .prepare('SELECT * FROM staff_members ORDER BY created_at ASC')
    .all<StaffMember>();
  return result.results;
}

export async function getStaffById(
  db: D1Database,
  id: string,
): Promise<StaffMember | null> {
  return db
    .prepare('SELECT * FROM staff_members WHERE id = ?')
    .bind(id)
    .first<StaffMember>();
}

export async function createStaffMember(
  db: D1Database,
  input: CreateStaffInput,
  hashSecret?: string,
): Promise<StaffMember> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const apiKey = generateApiKey();
  const apiKeyHash = hashSecret ? await hashStaffApiKey(hashSecret, apiKey) : null;

  await db
    .prepare(
      `INSERT INTO staff_members
         (id, name, email, role, api_key, api_key_hash, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, input.name, input.email ?? null, input.role, apiKey, apiKeyHash, now, now)
    .run();

  return (await db
    .prepare('SELECT * FROM staff_members WHERE id = ?')
    .bind(id)
    .first<StaffMember>())!;
}

export async function updateStaffMember(
  db: D1Database,
  id: string,
  input: UpdateStaffInput,
  tenantId: string,
): Promise<StaffMember | null> {
  const now = jstNow();
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [now];

  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  if (input.email !== undefined) { sets.push('email = ?'); values.push(input.email ?? null); }
  if (input.role !== undefined) { sets.push('role = ?'); values.push(input.role); }
  if (input.is_active !== undefined) { sets.push('is_active = ?'); values.push(input.is_active); }

  values.push(id, id, tenantId);
  const result = await db
    .prepare(`UPDATE staff_members SET ${sets.join(', ')}
               WHERE id = ?
                 AND NOT EXISTS (
                   SELECT 1
                     FROM tenant_staff_memberships AS other
                    WHERE other.staff_id = ?
                      AND other.tenant_id != ?
                 )`)
    .bind(...values)
    .run();

  if (result.meta.changes === 0) return null;

  return db.prepare('SELECT * FROM staff_members WHERE id = ?').bind(id).first<StaffMember>();
}

export async function deleteStaffMember(_db: D1Database, _id: string): Promise<void> {
  throw new Error(
    'Physical staff deletion is disabled; deactivate the tenant membership instead',
  );
}

export async function regenerateStaffApiKey(
  db: D1Database,
  id: string,
  hashSecret?: string,
): Promise<string> {
  const newKey = generateApiKey();
  const now = jstNow();
  const result = await db
    .prepare('UPDATE staff_members SET api_key = ?, api_key_hash = ?, updated_at = ? WHERE id = ?')
    .bind(newKey, hashSecret ? await hashStaffApiKey(hashSecret, newKey) : null, now, id)
    .run();
  if (result.meta.changes === 0) {
    throw new Error(`Staff member not found: ${id}`);
  }
  return newKey;
}

export async function countStaffByRole(db: D1Database, role: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM staff_members WHERE role = ?')
    .bind(role)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function countActiveStaffByRole(db: D1Database, role: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM staff_members WHERE role = ? AND is_active = 1')
    .bind(role)
    .first<{ count: number }>();
  return result?.count ?? 0;
}
