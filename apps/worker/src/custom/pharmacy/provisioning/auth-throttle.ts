export type LoginThrottleKey = {
  realm: 'tenant' | 'platform_admin';
  authorityId: string;
  loginId: string;
};

const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;

export function normalizeLoginId(loginId: string): string {
  return loginId.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function normalizedKey(key: LoginThrottleKey) {
  return { ...key, loginId: normalizeLoginId(key.loginId) };
}

export async function claimLoginAttempt(
  db: D1Database,
  key: LoginThrottleKey,
  now = new Date(),
): Promise<
  { allowed: false } |
  { allowed: true; failureCount: number; lockedUntil: string | null }
> {
  const normalized = normalizedKey(key);
  const nowIso = now.toISOString();
  const windowCutoff = new Date(now.getTime() - WINDOW_MS).toISOString();
  const plus = (milliseconds: number) => new Date(now.getTime() + milliseconds).toISOString();
  const row = await db.prepare(
    `INSERT INTO admin_login_throttles
       (realm, authority_id, login_id_normalized, failure_count,
        window_started_at, next_allowed_at, locked_until, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, NULL, ?)
     ON CONFLICT (realm, authority_id, login_id_normalized) DO UPDATE SET
       failure_count = CASE
         WHEN admin_login_throttles.locked_until IS NOT NULL
           OR admin_login_throttles.window_started_at <= ? THEN 1
         ELSE admin_login_throttles.failure_count + 1
       END,
       window_started_at = CASE
         WHEN admin_login_throttles.locked_until IS NOT NULL
           OR admin_login_throttles.window_started_at <= ? THEN excluded.window_started_at
         ELSE admin_login_throttles.window_started_at
       END,
       next_allowed_at = CASE
         WHEN admin_login_throttles.locked_until IS NOT NULL
           OR admin_login_throttles.window_started_at <= ? THEN excluded.next_allowed_at
         WHEN admin_login_throttles.failure_count = 1 THEN ?
         WHEN admin_login_throttles.failure_count = 2 THEN ?
         WHEN admin_login_throttles.failure_count = 3 THEN ?
         ELSE ?
       END,
       locked_until = CASE
         WHEN admin_login_throttles.locked_until IS NOT NULL
           OR admin_login_throttles.window_started_at <= ? THEN NULL
         WHEN admin_login_throttles.failure_count >= 4 THEN ?
         ELSE NULL
       END,
       updated_at = excluded.updated_at
     WHERE (admin_login_throttles.locked_until IS NULL
            OR admin_login_throttles.locked_until <= ?)
       AND admin_login_throttles.next_allowed_at <= ?
     RETURNING failure_count, locked_until`,
  ).bind(
    normalized.realm,
    normalized.authorityId,
    normalized.loginId,
    nowIso,
    nowIso,
    nowIso,
    windowCutoff,
    windowCutoff,
    windowCutoff,
    plus(1000),
    plus(2000),
    plus(4000),
    plus(LOCK_MS),
    windowCutoff,
    plus(LOCK_MS),
    nowIso,
    nowIso,
  ).first<{ failure_count: number; locked_until: string | null }>();

  return row
    ? { allowed: true, failureCount: row.failure_count, lockedUntil: row.locked_until }
    : { allowed: false };
}

export function clearLoginThrottleStatement(db: D1Database, key: LoginThrottleKey) {
  const normalized = normalizedKey(key);
  return db.prepare(
    `DELETE FROM admin_login_throttles
      WHERE realm = ? AND authority_id = ? AND login_id_normalized = ?`,
  ).bind(normalized.realm, normalized.authorityId, normalized.loginId);
}

export async function clearLoginThrottle(db: D1Database, key: LoginThrottleKey): Promise<void> {
  await clearLoginThrottleStatement(db, key).run();
}
