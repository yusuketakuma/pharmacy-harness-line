export type NextIntakeExpectationStatus =
  | 'offered'
  | 'accepted'
  | 'active'
  | 'reminded'
  | 'linked'
  | 'fulfilled'
  | 'paused'
  | 'ended';

export interface NextIntakeExpectation {
  id: string;
  obligation_id: string;
  line_account_id: string;
  owner_friend_id: string;
  patient_id: string;
  status: NextIntakeExpectationStatus;
  timing_source: 'manual_supply_days' | 'manual_window';
  supply_days: number | null;
  expected_from: string;
  expected_to: string;
  reminder_at: string;
  reminded_at: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DueNextIntakeExpectation extends NextIntakeExpectation {
  line_user_id: string;
  channel_access_token: string;
}

type Timing =
  | { source: 'manual_supply_days'; supplyDays: number }
  | { source: 'manual_window'; expectedFrom: string; expectedTo: string; reminderAt: string };

const SELECT = `
  SELECT id, obligation_id, line_account_id, owner_friend_id, patient_id,
         status, timing_source, supply_days, expected_from, expected_to,
         reminder_at, reminded_at, version, created_by, created_at, updated_at
    FROM pharmacy_next_intake_expectations`;

function validOpaqueKey(value: string): boolean {
  return value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function tokyoDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('closed continuity source is invalid');
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function timingValues(
  timing: Timing,
  closedAt: string,
  now: Date,
): {
  timingSource: NextIntakeExpectation['timing_source'];
  supplyDays: number | null;
  expectedFrom: string;
  expectedTo: string;
  reminderAt: string;
} {
  if (timing.source === 'manual_supply_days') {
    if (!Number.isInteger(timing.supplyDays) || timing.supplyDays < 1 || timing.supplyDays > 365) {
      throw new Error('supply days must be between 1 and 365');
    }
    const expected = addDays(tokyoDate(closedAt), timing.supplyDays);
    const reminderAt = new Date(`${expected}T09:00:00+09:00`).toISOString();
    if (Date.parse(reminderAt) <= now.getTime()) throw new Error('reminder time must be in the future');
    return {
      timingSource: timing.source,
      supplyDays: timing.supplyDays,
      expectedFrom: expected,
      expectedTo: expected,
      reminderAt,
    };
  }

  if (!validDateOnly(timing.expectedFrom) || !validDateOnly(timing.expectedTo) ||
      timing.expectedTo < timing.expectedFrom) {
    throw new Error('expected window is invalid');
  }
  const reminder = new Date(timing.reminderAt);
  if (!Number.isFinite(reminder.getTime()) || reminder.getTime() <= now.getTime()) {
    throw new Error('reminder time must be in the future');
  }
  return {
    timingSource: timing.source,
    supplyDays: null,
    expectedFrom: timing.expectedFrom,
    expectedTo: timing.expectedTo,
    reminderAt: reminder.toISOString(),
  };
}

async function getExpectation(
  db: D1Database,
  lineAccountId: string,
  expectationId: string,
  friendId?: string,
): Promise<NextIntakeExpectation | null> {
  return db.prepare(
    `${SELECT} WHERE id = ? AND line_account_id = ?${friendId ? ' AND owner_friend_id = ?' : ''}`,
  ).bind(expectationId, lineAccountId, ...(friendId ? [friendId] : []))
    .first<NextIntakeExpectation>();
}

async function transitionExpectation(
  db: D1Database,
  input: {
    lineAccountId: string;
    expectationId: string;
    fromStatus: 'offered' | 'accepted' | 'active';
    toStatus: 'accepted' | 'active' | 'reminded' | 'ended';
    actorType: 'patient' | 'system';
    actorId: string;
    idempotencyKey: string;
    friendId?: string;
    now: Date;
  },
): Promise<{ expectation: NextIntakeExpectation; changed: boolean }> {
  const current = await getExpectation(
    db, input.lineAccountId, input.expectationId, input.friendId,
  );
  if (!current) throw new Error('expectation unavailable');
  const replay = await db.prepare(
    `SELECT 1 AS ok FROM pharmacy_next_intake_expectation_events
      WHERE expectation_id = ? AND line_account_id = ? AND idempotency_key = ?`,
  ).bind(input.expectationId, input.lineAccountId, input.idempotencyKey)
    .first<{ ok: number }>();
  if (replay) return { expectation: current, changed: false };
  if (current.status === input.toStatus) return { expectation: current, changed: false };
  if (current.status !== input.fromStatus) throw new Error('expectation transition conflict');

  const eventId = crypto.randomUUID();
  const timestamp = input.now.toISOString();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO pharmacy_next_intake_expectation_events
        (id, expectation_id, line_account_id, event_type, from_status, to_status,
         actor_type, actor_id, idempotency_key, occurred_at)
       SELECT ?, id, line_account_id, ?, status, ?, ?, ?, ?, ?
         FROM pharmacy_next_intake_expectations
        WHERE id = ? AND line_account_id = ? AND status = ? AND version = ?`,
    ).bind(
      eventId, input.toStatus, input.toStatus, input.actorType, input.actorId,
      input.idempotencyKey, timestamp, input.expectationId, input.lineAccountId,
      input.fromStatus, current.version,
    ),
    db.prepare(
      `UPDATE pharmacy_next_intake_expectations
          SET status = ?,
              reminded_at = CASE WHEN ? = 'reminded' THEN ? ELSE reminded_at END,
              version = version + 1,
              updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM pharmacy_next_intake_expectation_events
             WHERE id = ? AND expectation_id = ? AND line_account_id = ?
          )`,
    ).bind(
      input.toStatus, input.toStatus, timestamp, timestamp,
      input.expectationId, input.lineAccountId, input.fromStatus, current.version,
      eventId, input.expectationId, input.lineAccountId,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('expectation transition conflict');
  }
  const saved = await getExpectation(db, input.lineAccountId, input.expectationId, input.friendId);
  if (!saved) throw new Error('expectation unavailable');
  return { expectation: saved, changed: true };
}

export async function offerNextIntakeExpectation(
  db: D1Database,
  input: {
    lineAccountId: string;
    obligationId: string;
    timing: Timing;
    staffId: string;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<NextIntakeExpectation> {
  if (!input.lineAccountId || !input.obligationId || !input.staffId ||
      !validOpaqueKey(input.idempotencyKey)) {
    throw new Error('invalid next-intake offer');
  }
  const source = await db.prepare(
    `SELECT o.owner_friend_id, o.patient_id, s.closed_at
       FROM pharmacy_continuity_obligations o
       INNER JOIN pharmacy_prescription_submissions s
         ON s.id = o.source_submission_id AND s.line_account_id = o.line_account_id
        AND s.friend_id = o.owner_friend_id
      WHERE o.id = ? AND o.line_account_id = ? AND o.status = 'active'
        AND s.status = 'closed' AND s.closed_at IS NOT NULL`,
  ).bind(input.obligationId, input.lineAccountId).first<{
    owner_friend_id: string;
    patient_id: string;
    closed_at: string;
  }>();
  if (!source) throw new Error('continuity record not found');

  const now = input.now ?? new Date();
  const timing = timingValues(input.timing, source.closed_at, now);
  const existing = await db.prepare(
    `${SELECT} WHERE obligation_id = ? AND line_account_id = ?`,
  ).bind(input.obligationId, input.lineAccountId).first<NextIntakeExpectation>();
  if (existing) {
    if (existing.timing_source !== timing.timingSource ||
        existing.supply_days !== timing.supplyDays ||
        existing.expected_from !== timing.expectedFrom ||
        existing.expected_to !== timing.expectedTo ||
        existing.reminder_at !== timing.reminderAt) {
      throw new Error('next-intake expectation already offered');
    }
    return existing;
  }

  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const timestamp = now.toISOString();
  const eventKey = `offer:${input.idempotencyKey}`;
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO pharmacy_next_intake_expectations
        (id, obligation_id, line_account_id, owner_friend_id, patient_id,
         status, timing_source, supply_days, expected_from, expected_to,
         reminder_at, version, created_by, created_at, updated_at)
       SELECT ?, o.id, o.line_account_id, o.owner_friend_id, o.patient_id,
              'offered', ?, ?, ?, ?, ?, 1, ?, ?, ?
         FROM pharmacy_continuity_obligations o
        WHERE o.id = ? AND o.line_account_id = ? AND o.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM pharmacy_next_intake_expectation_events
             WHERE line_account_id = ? AND idempotency_key = ?
          )`,
    ).bind(
      id, timing.timingSource, timing.supplyDays, timing.expectedFrom,
      timing.expectedTo, timing.reminderAt, input.staffId, timestamp, timestamp,
      input.obligationId, input.lineAccountId, input.lineAccountId, eventKey,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO pharmacy_next_intake_expectation_events
        (id, expectation_id, line_account_id, event_type, to_status,
         actor_type, actor_id, idempotency_key, occurred_at)
       SELECT ?, e.id, e.line_account_id, 'offered', 'offered',
              'staff', ?, ?, ?
         FROM pharmacy_next_intake_expectations e
        WHERE e.obligation_id = ? AND e.line_account_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM pharmacy_next_intake_expectation_events existing_event
             WHERE existing_event.expectation_id = e.id
               AND existing_event.event_type = 'offered'
          )`,
    ).bind(
      eventId, input.staffId, eventKey, timestamp,
      input.obligationId, input.lineAccountId,
    ),
  ]);
  const saved = await db.prepare(
    `${SELECT} WHERE obligation_id = ? AND line_account_id = ?`,
  ).bind(input.obligationId, input.lineAccountId).first<NextIntakeExpectation>();
  if (!saved || saved.reminder_at !== timing.reminderAt) {
    throw new Error('next-intake expectation offer conflict');
  }
  return saved;
}

export async function respondToNextIntakeExpectation(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    expectationId: string;
    response: 'accepted' | 'ended';
    idempotencyKey: string;
    now?: Date;
  },
): Promise<NextIntakeExpectation> {
  if (!validOpaqueKey(input.idempotencyKey) ||
      (input.response !== 'accepted' && input.response !== 'ended')) {
    throw new Error('expectation unavailable');
  }
  const available = await db.prepare(
    `SELECT e.id
       FROM pharmacy_next_intake_expectations e
       INNER JOIN pharmacy_continuity_obligations o
         ON o.id = e.obligation_id AND o.line_account_id = e.line_account_id
        AND o.owner_friend_id = e.owner_friend_id AND o.patient_id = e.patient_id
      WHERE e.id = ? AND e.line_account_id = ? AND e.owner_friend_id = ?
        AND e.status IN ('offered', ?) AND o.status = 'active'`,
  ).bind(input.expectationId, input.lineAccountId, input.friendId, input.response)
    .first<{ id: string }>();
  if (!available) throw new Error('expectation unavailable');
  const result = await transitionExpectation(db, {
    lineAccountId: input.lineAccountId,
    expectationId: input.expectationId,
    fromStatus: 'offered',
    toStatus: input.response,
    actorType: 'patient',
    actorId: input.friendId,
    idempotencyKey: `patient:${input.idempotencyKey}`,
    friendId: input.friendId,
    now: input.now ?? new Date(),
  });
  return result.expectation;
}

export async function claimDueNextIntakeExpectations(
  db: D1Database,
  now = new Date(),
  limit = 50,
): Promise<DueNextIntakeExpectation[]> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const due = await db.prepare(
    `SELECT e.id, e.obligation_id, e.line_account_id, e.owner_friend_id,
            e.patient_id, e.status, e.timing_source, e.supply_days,
            e.expected_from, e.expected_to, e.reminder_at, e.reminded_at,
            e.version, e.created_by, e.created_at, e.updated_at,
            friend.line_user_id, account.channel_access_token
       FROM pharmacy_next_intake_expectations e
       INNER JOIN pharmacy_continuity_obligations o
         ON o.id = e.obligation_id AND o.line_account_id = e.line_account_id
        AND o.owner_friend_id = e.owner_friend_id
       INNER JOIN friends friend
         ON friend.id = e.owner_friend_id AND friend.line_account_id = e.line_account_id
       INNER JOIN line_accounts account ON account.id = e.line_account_id
       INNER JOIN pharmacy_account_capabilities capability
         ON capability.line_account_id = e.line_account_id AND capability.mode = 'pharmacy'
        AND EXISTS (
          SELECT 1 FROM json_each(capability.capabilities_json)
           WHERE json_each.value = 'continuity'
        )
      WHERE e.status IN ('accepted','active') AND e.reminder_at <= ?
        AND o.status = 'active' AND friend.is_following = 1 AND account.is_active = 1
      ORDER BY e.reminder_at, e.id
      LIMIT ?`,
  ).bind(now.toISOString(), boundedLimit).all<DueNextIntakeExpectation>();

  const claimed: DueNextIntakeExpectation[] = [];
  for (const row of due.results ?? []) {
    if (row.status === 'active') {
      claimed.push(row);
      continue;
    }
    try {
      const result = await transitionExpectation(db, {
        lineAccountId: row.line_account_id,
        expectationId: row.id,
        fromStatus: 'accepted',
        toStatus: 'active',
        actorType: 'system',
        actorId: 'continuity-cron',
        idempotencyKey: `activate:${row.id}`,
        now,
      });
      claimed.push({ ...row, ...result.expectation });
    } catch {
      // Another cron invocation owns this transition.
    }
  }
  return claimed;
}

export async function markNextIntakeExpectationReminded(
  db: D1Database,
  input: {
    lineAccountId: string;
    expectationId: string;
    expectedVersion: number;
    now?: Date;
  },
): Promise<NextIntakeExpectation> {
  const current = await getExpectation(db, input.lineAccountId, input.expectationId);
  if (current?.status === 'reminded') return current;
  if (!current || current.version !== input.expectedVersion) {
    throw new Error('expectation transition conflict');
  }
  const now = input.now ?? new Date();
  const result = await transitionExpectation(db, {
    lineAccountId: input.lineAccountId,
    expectationId: input.expectationId,
    fromStatus: 'active',
    toStatus: 'reminded',
    actorType: 'system',
    actorId: 'continuity-cron',
    idempotencyKey: `reminded:${input.expectationId}`,
    now,
  });
  return result.expectation;
}

export async function listNextIntakeExpectations(
  db: D1Database,
  lineAccountId: string,
  friendId?: string,
): Promise<NextIntakeExpectation[]> {
  const result = await db.prepare(
    `SELECT e.id, e.obligation_id, e.line_account_id, e.owner_friend_id,
            e.patient_id, e.status, e.timing_source, e.supply_days,
            e.expected_from, e.expected_to, e.reminder_at, e.reminded_at,
            e.version, e.created_by, e.created_at, e.updated_at,
            o.status AS continuity_status
       FROM pharmacy_next_intake_expectations e
       INNER JOIN pharmacy_continuity_obligations o
         ON o.id = e.obligation_id AND o.line_account_id = e.line_account_id
        AND o.owner_friend_id = e.owner_friend_id AND o.patient_id = e.patient_id
      WHERE e.line_account_id = ?${friendId ? ' AND e.owner_friend_id = ?' : ''}
      ORDER BY e.created_at DESC, e.id DESC`,
  ).bind(lineAccountId, ...(friendId ? [friendId] : [])).all<
    NextIntakeExpectation & { continuity_status: 'active' | 'linked' | 'fulfilled' | 'paused' | 'ended' }
  >();
  return (result.results ?? []).map(({ continuity_status: continuityStatus, ...item }) => ({
    ...item,
    status: item.status === 'ended'
      ? 'ended'
      : continuityStatus === 'active'
        ? item.status
        : continuityStatus,
  }));
}
