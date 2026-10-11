// Queue leases reduce duplicate work; the existing sender claim and LINE retry
// key remain the authority for external idempotency, including response loss.
export interface StatusNotificationWork {
  line_account_id: string;
  work_retry_key: string;
  work_attempt_count: number;
  work_expires_at: string;
}
const TICK_MS = 5 * 60_000;

/** Expired backlog must not consume the live notification LIMIT. Keep an
 * active lease until its boundary; no source or notification data is deleted. */
export async function expireStatusNotificationWorks(db: D1Database, kind: 'myna' | 'emergency', now: Date) {
  await db
    .prepare(`UPDATE pharmacy_status_notification_work
      SET state = 'expired', claim_token = NULL
      WHERE kind = ? AND state = 'pending' AND expires_at < ? AND due_at <= ?`)
    .bind(kind, now.toISOString(), now.toISOString())
    .run();
}

function prepareClaim(db: D1Database, row: StatusNotificationWork, now: Date) {
  const token = crypto.randomUUID();
  const expired = row.work_expires_at < now.toISOString();
  const statement = db
    .prepare(`UPDATE pharmacy_status_notification_work
      SET due_at = ?, claim_token = ?, attempt_count = attempt_count + 1, state = ?
      WHERE line_account_id = ? AND retry_key = ? AND state = 'pending' AND due_at <= ? AND expires_at = ?`)
    .bind(
      new Date(now.getTime() + TICK_MS).toISOString(),
      token,
      expired ? 'expired' : 'pending',
      row.line_account_id,
      row.work_retry_key,
      now.toISOString(),
      row.work_expires_at,
    );
  return { token, expired, statement };
}

export async function claimStatusNotificationWork(
  db: D1Database,
  row: StatusNotificationWork,
  now: Date,
): Promise<string | null> {
  const claim = prepareClaim(db, row, now);
  const result = await claim.statement.run();
  return !claim.expired && result.meta?.changes === 1 ? claim.token : null;
}

/** One atomic round trip for a cron-sized batch; no external send inside it. */
export async function claimStatusNotificationWorks(
  db: D1Database,
  rows: StatusNotificationWork[],
  now: Date,
): Promise<Array<string | null>> {
  if (rows.length === 0) return [];
  const claims = rows.map((row) => prepareClaim(db, row, now));
  const results = await db.batch(claims.map((claim) => claim.statement));
  return claims.map((claim, index) => (!claim.expired && results[index]?.meta?.changes === 1 ? claim.token : null));
}

export interface StatusWorkSettlement {
  row: StatusNotificationWork;
  token: string;
  outcome: 'sent' | 'failed' | 'skipped';
}

function prepareFinish(db: D1Database, { row, token, outcome }: StatusWorkSettlement, now: Date) {
  // The existing five-minute retry cadence is the service contract for both
  // status types. Do not introduce a longer outage recovery delay. The cron
  // tick itself is the bounded backoff; no immediate loop or stale cache.
  const delay = TICK_MS;
  return db
    .prepare(`UPDATE pharmacy_status_notification_work
      SET state = ?, due_at = ?, claim_token = NULL
      WHERE line_account_id = ? AND retry_key = ? AND state = 'pending' AND claim_token = ?`)
    .bind(
      outcome === 'sent' ? 'done' : 'pending',
      new Date(now.getTime() + delay).toISOString(),
      row.line_account_id,
      row.work_retry_key,
      token,
    );
}

export async function finishStatusNotificationWork(
  db: D1Database,
  row: StatusNotificationWork,
  token: string,
  outcome: 'sent' | 'failed' | 'skipped',
  now: Date,
): Promise<void> {
  await prepareFinish(db, { row, token, outcome }, now).run();
}

export async function finishStatusNotificationWorks(
  db: D1Database,
  settlements: StatusWorkSettlement[],
  now: Date,
): Promise<void> {
  if (settlements.length > 0) await db.batch(settlements.map((settlement) => prepareFinish(db, settlement, now)));
}
