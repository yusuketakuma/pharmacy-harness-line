// Idempotency-Key store for booking request POSTs.
// Returns same response for repeated submissions within the TTL window.

export interface SaveIdempotencyParams {
  key: string;
  lineAccountId: string;
  friendId: string;
  status: number;
  body: unknown;
  ttlMinutes: number;
  now: Date;
}

export async function saveIdempotencyResponse(
  db: D1Database,
  params: SaveIdempotencyParams,
): Promise<void> {
  const expires = new Date(params.now.getTime() + params.ttlMinutes * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO booking_idempotency_keys
         (key, line_account_id, friend_id, response_status, response_body, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    )
    .bind(
      params.key,
      params.lineAccountId,
      params.friendId,
      params.status,
      JSON.stringify(params.body),
      expires,
    )
    .run();
}

export interface FindIdempotencyParams {
  key: string;
  lineAccountId: string;
  friendId: string;
  now: Date;
}

// caller(account+friend) と一致した行のみを返す。同じ key を別 caller が使った場合は
// nothing-cached 扱いとし、そちらは新規 INSERT で衝突 (PK重複) して別の handling 経路に流れる。
// global lookup にすると tenant 越しに booking_id が漏れるので必須。
export async function findIdempotencyResponse(
  db: D1Database,
  params: FindIdempotencyParams,
): Promise<{ status: number; body: unknown } | null> {
  // I20-R2: dual-read を1往復化。legacy(旧Workerの書込先)を先、scoped(現行)を後で
  // 順序付けし、期限判定は従来通りJS側で行う(legacy expired行は scoped 有効行へ
  // フォールスルー)。行数は最大2で bounded。
  const { results } = await db
    .prepare(
      `SELECT response_status, response_body, expires_at FROM (
           SELECT 0 AS source_order, response_status, response_body, expires_at
             FROM booking_idempotency_keys
            WHERE key = ? AND line_account_id = ? AND friend_id = ?
          UNION ALL
           SELECT 1 AS source_order, response_status, response_body, expires_at
             FROM booking_idempotency_scoped
            WHERE key = ? AND line_account_id = ? AND friend_id = ?
         ) ORDER BY source_order`,
    )
    .bind(
      params.key, params.lineAccountId, params.friendId,
      params.key, params.lineAccountId, params.friendId,
    )
    .all<{ response_status: number; response_body: string; expires_at: string }>();
  for (const row of results ?? []) {
    if (new Date(row.expires_at) > params.now) {
      return { status: row.response_status, body: JSON.parse(row.response_body) };
    }
  }
  return null;
}

export async function purgeExpiredIdempotency(db: D1Database, now: Date): Promise<number> {
  const legacy = await db
    .prepare(`DELETE FROM booking_idempotency_keys WHERE expires_at <= ?`)
    .bind(now.toISOString())
    .run();
  const scoped = await db
    .prepare(`DELETE FROM booking_idempotency_scoped WHERE expires_at <= ?`)
    .bind(now.toISOString())
    .run();
  return (legacy.meta?.changes ?? 0) + (scoped.meta?.changes ?? 0);
}
