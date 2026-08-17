export type ContinuityStatus = 'active' | 'linked' | 'fulfilled' | 'paused' | 'ended';

export interface ContinuityObligation {
  id: string;
  line_account_id: string;
  owner_friend_id: string;
  patient_id: string;
  source_submission_id: string;
  candidate_submission_id: string | null;
  status: ContinuityStatus;
  expected_next_from: string;
  expected_next_to: string;
  next_contact_at: string;
  consent_at: string;
  last_reminded_at: string | null;
  reminder_count: number;
  created_at: string;
  updated_at: string;
}

export interface DueContinuityReminder extends ContinuityObligation {
  line_user_id: string;
  channel_access_token: string;
}

const OBLIGATION_SELECT = `
  SELECT id, line_account_id, owner_friend_id, patient_id, source_submission_id,
         candidate_submission_id, status, expected_next_from, expected_next_to,
         next_contact_at, consent_at, last_reminded_at, reminder_count,
         created_at, updated_at
    FROM pharmacy_continuity_obligations`;

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function rowWithStatus(
  row: Record<string, unknown>,
  status: ContinuityStatus,
  candidateSubmissionId: string | null = null,
): ContinuityObligation {
  return {
    ...(row as unknown as ContinuityObligation),
    id: String(row.id),
    status,
    candidate_submission_id: candidateSubmissionId ?? (row.candidate_submission_id as string | null) ?? null,
    patient_id: String(row.patient_id),
  };
}

export async function openContinuityObligation(
  db: D1Database,
  lineAccountId: string,
  sourceSubmissionId: string,
  actorId: string,
  now = new Date(),
): Promise<ContinuityObligation | null> {
  const source = await db.prepare(
    `SELECT pp.patient_id, pp.owner_friend_id,
            r.representative_consent_at AS consent_at
       FROM pharmacy_prescription_submissions s
       INNER JOIN pharmacy_prescription_patients pp
         ON pp.submission_id = s.id AND pp.line_account_id = s.line_account_id
       INNER JOIN pharmacy_patient_intake_responses r
         ON r.id = pp.intake_response_id
        AND r.patient_id = pp.patient_id
        AND r.line_account_id = pp.line_account_id
        AND r.owner_friend_id = pp.owner_friend_id
      WHERE s.id = ? AND s.line_account_id = ? AND s.status = 'closed'
      LIMIT 1`,
  ).bind(sourceSubmissionId, lineAccountId).first<{
    patient_id: string;
    owner_friend_id: string;
    consent_at: string;
  }>();
  if (!source?.consent_at) return null;

  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  const from = addDays(now, 28);
  const to = addDays(now, 90);
  const nextContactAt = addDays(now, 28).toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO pharmacy_continuity_obligations
         (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
          status, expected_next_from, expected_next_to, next_contact_at,
          consent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      id, lineAccountId, source.owner_friend_id, source.patient_id, sourceSubmissionId,
      dateOnly(from), dateOnly(to), nextContactAt, source.consent_at, createdAt, createdAt,
    ),
    db.prepare(
      `INSERT INTO pharmacy_continuity_events
         (id, obligation_id, line_account_id, event_type, submission_id,
          actor_type, actor_id, created_at)
       SELECT ?, o.id, o.line_account_id, 'opened', o.source_submission_id,
              'system', ?, ?
         FROM pharmacy_continuity_obligations o
        WHERE o.line_account_id = ? AND o.patient_id = ?
          AND o.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM pharmacy_continuity_events existing
             WHERE existing.obligation_id = o.id AND existing.event_type = 'opened'
          )`,
    ).bind(
      crypto.randomUUID(), actorId, createdAt, lineAccountId, source.patient_id,
    ),
  ]);
  return db.prepare(
    `${OBLIGATION_SELECT}
      WHERE line_account_id = ? AND source_submission_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(lineAccountId, sourceSubmissionId).first<ContinuityObligation>();
}

export async function linkContinuitySubmission(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
  ownerFriendId: string,
  actorType: 'system' | 'staff' | 'patient' = 'system',
): Promise<ContinuityObligation | null> {
  const patient = await db.prepare(
    `SELECT patient_id, owner_friend_id
       FROM pharmacy_prescription_patients
      WHERE submission_id = ? AND line_account_id = ? AND owner_friend_id = ?`,
  ).bind(submissionId, lineAccountId, ownerFriendId).first<{
    patient_id: string;
    owner_friend_id: string;
  }>();
  if (!patient) return null;
  const obligation = await db.prepare(
    `${OBLIGATION_SELECT}
      WHERE line_account_id = ? AND patient_id = ? AND owner_friend_id = ?
        AND status = 'active'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(lineAccountId, patient.patient_id, ownerFriendId).first<ContinuityObligation>();
  if (!obligation) return null;
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_continuity_obligations
        SET status = 'linked', candidate_submission_id = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'active'
        AND candidate_submission_id IS NULL`,
  ).bind(submissionId, now, obligation.id, lineAccountId).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    return obligation.status === 'linked' && obligation.candidate_submission_id === submissionId
      ? obligation
      : null;
  }
  await db.prepare(
    `INSERT INTO pharmacy_continuity_events
       (id, obligation_id, line_account_id, event_type, submission_id,
        actor_type, created_at)
     VALUES (?, ?, ?, 'linked', ?, ?, ?)`,
  ).bind(crypto.randomUUID(), obligation.id, lineAccountId, submissionId, actorType, now).run();
  return rowWithStatus(obligation as unknown as Record<string, unknown>, 'linked', submissionId);
}

export async function completeContinuityAfterClose(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
  actorId: string,
  now = new Date(),
): Promise<ContinuityObligation | null> {
  const linked = await db.prepare(
    `${OBLIGATION_SELECT}
      WHERE line_account_id = ? AND candidate_submission_id = ? AND status = 'linked'
      LIMIT 1`,
  ).bind(lineAccountId, submissionId).first<ContinuityObligation>();
  if (linked) {
    const timestamp = now.toISOString();
    await db.prepare(
      `UPDATE pharmacy_continuity_obligations
          SET status = 'fulfilled', updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = 'linked'`,
    ).bind(timestamp, linked.id, lineAccountId).run();
    await db.prepare(
      `INSERT INTO pharmacy_continuity_events
         (id, obligation_id, line_account_id, event_type, submission_id,
          actor_type, actor_id, created_at)
       VALUES (?, ?, ?, 'fulfilled', ?, 'staff', ?, ?)`,
    ).bind(crypto.randomUUID(), linked.id, lineAccountId, submissionId, actorId, timestamp).run();
  }
  return openContinuityObligation(db, lineAccountId, submissionId, actorId, now);
}

export async function listContinuityObligations(
  db: D1Database,
  lineAccountId: string,
): Promise<ContinuityObligation[]> {
  const result = await db.prepare(
    `${OBLIGATION_SELECT}
      WHERE line_account_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'linked' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
               next_contact_at, id`,
  ).bind(lineAccountId).all<ContinuityObligation>();
  return result.results;
}

export async function listPatientContinuity(
  db: D1Database,
  lineAccountId: string,
  ownerFriendId: string,
): Promise<ContinuityObligation[]> {
  const result = await db.prepare(
    `${OBLIGATION_SELECT}
      WHERE line_account_id = ? AND owner_friend_id = ?
        AND status IN ('active','linked','paused')
      ORDER BY next_contact_at, id`,
  ).bind(lineAccountId, ownerFriendId).all<ContinuityObligation>();
  return result.results;
}

export async function pausePatientContinuity(
  db: D1Database,
  lineAccountId: string,
  ownerFriendId: string,
  obligationId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_continuity_obligations
        SET status = 'paused', updated_at = ?
      WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?
        AND status IN ('active','linked')`,
  ).bind(now, obligationId, lineAccountId, ownerFriendId).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('continuity pause conflict');
  await db.prepare(
    `INSERT INTO pharmacy_continuity_events
       (id, obligation_id, line_account_id, event_type, actor_type, actor_id, created_at)
     VALUES (?, ?, ?, 'paused', 'patient', ?, ?)`,
  ).bind(crypto.randomUUID(), obligationId, lineAccountId, ownerFriendId, now).run();
}

export async function claimDueContinuityReminders(
  db: D1Database,
  now = new Date(),
  limit = 50,
): Promise<DueContinuityReminder[]> {
  const timestamp = now.toISOString();
  const staleBefore = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const due = await db.prepare(
    `SELECT o.id, o.line_account_id, o.owner_friend_id, o.patient_id,
            o.source_submission_id, o.candidate_submission_id, o.status,
            o.expected_next_from, o.expected_next_to, o.next_contact_at,
            o.consent_at, o.last_reminded_at, o.reminder_count,
            o.created_at, o.updated_at, f.line_user_id, la.channel_access_token
       FROM pharmacy_continuity_obligations o
       INNER JOIN friends f ON f.id = o.owner_friend_id AND f.line_account_id = o.line_account_id
       INNER JOIN line_accounts la ON la.id = o.line_account_id
      WHERE o.status = 'active' AND o.next_contact_at <= ?
        AND (o.last_reminded_at IS NULL OR o.last_reminded_at < ?)
        AND o.reminder_count < 3 AND f.is_following = 1 AND la.is_active = 1
      ORDER BY o.next_contact_at, o.id
      LIMIT ?`,
  ).bind(timestamp, staleBefore, boundedLimit).all<DueContinuityReminder>();
  const claimed: DueContinuityReminder[] = [];
  // ponytail: claim-before-send bounds duplicate reminders; add delivery retry events when retryability is required.
  for (const row of due.results ?? []) {
    const result = await db.prepare(
      `UPDATE pharmacy_continuity_obligations
          SET last_reminded_at = ?, reminder_count = reminder_count + 1, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = 'active'
          AND (last_reminded_at IS NULL OR last_reminded_at < ?)
          AND reminder_count < 3`,
    ).bind(timestamp, timestamp, row.id, row.line_account_id, staleBefore).run();
    if ((result.meta?.changes ?? 0) !== 1) continue;
    await db.prepare(
      `INSERT INTO pharmacy_continuity_events
         (id, obligation_id, line_account_id, event_type, actor_type, created_at)
       VALUES (?, ?, ?, 'reminded', 'system', ?)`,
    ).bind(crypto.randomUUID(), row.id, row.line_account_id, timestamp).run();
    claimed.push({ ...row, last_reminded_at: timestamp, reminder_count: row.reminder_count + 1 });
  }
  return claimed;
}
