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
  const [transition] = await db.batch([
    db.prepare(
      `UPDATE pharmacy_continuity_obligations
          SET status = 'linked', candidate_submission_id = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = 'active'
          AND candidate_submission_id IS NULL`,
    ).bind(submissionId, now, obligation.id, lineAccountId),
    db.prepare(
      `INSERT INTO pharmacy_continuity_events
         (id, obligation_id, line_account_id, event_type, submission_id,
          actor_type, created_at)
       SELECT ?, o.id, o.line_account_id, 'linked', ?, ?, ?
         FROM pharmacy_continuity_obligations o
        WHERE o.id = ? AND o.line_account_id = ? AND o.status = 'linked'
          AND o.candidate_submission_id = ? AND o.updated_at = ?`,
    ).bind(
      crypto.randomUUID(), submissionId, actorType, now,
      obligation.id, lineAccountId, submissionId, now,
    ),
  ]);
  if ((transition?.meta?.changes ?? 0) !== 1) {
    return obligation.status === 'linked' && obligation.candidate_submission_id === submissionId
      ? obligation
      : null;
  }
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
    await db.batch([
      db.prepare(
        `UPDATE pharmacy_continuity_obligations
            SET status = 'fulfilled', updated_at = ?
          WHERE id = ? AND line_account_id = ? AND status = 'linked'`,
      ).bind(timestamp, linked.id, lineAccountId),
      db.prepare(
        `INSERT INTO pharmacy_continuity_events
           (id, obligation_id, line_account_id, event_type, submission_id,
            actor_type, actor_id, created_at)
         SELECT ?, o.id, o.line_account_id, 'fulfilled', ?, 'staff', ?, ?
           FROM pharmacy_continuity_obligations o
          WHERE o.id = ? AND o.line_account_id = ? AND o.status = 'fulfilled'
            AND NOT EXISTS (
              SELECT 1 FROM pharmacy_continuity_events existing
               WHERE existing.obligation_id = ? AND existing.line_account_id = ?
                 AND existing.event_type = 'fulfilled' AND existing.submission_id = ?
            )`,
      ).bind(
        crypto.randomUUID(), submissionId, actorId, timestamp,
        linked.id, lineAccountId,
        linked.id, lineAccountId, submissionId,
      ),
    ]);
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
  const [transition] = await db.batch([
    db.prepare(
      `UPDATE pharmacy_continuity_obligations
          SET status = 'paused', updated_at = ?
        WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?
          AND status IN ('active','linked')`,
    ).bind(now, obligationId, lineAccountId, ownerFriendId),
    db.prepare(
      `INSERT INTO pharmacy_continuity_events
         (id, obligation_id, line_account_id, event_type, actor_type, actor_id, created_at)
       SELECT ?, o.id, o.line_account_id, 'paused', 'patient', ?, ?
         FROM pharmacy_continuity_obligations o
        WHERE o.id = ? AND o.line_account_id = ? AND o.owner_friend_id = ?
          AND o.status = 'paused' AND o.updated_at = ?`,
    ).bind(
      crypto.randomUUID(), ownerFriendId, now,
      obligationId, lineAccountId, ownerFriendId, now,
    ),
  ]);
  if ((transition?.meta?.changes ?? 0) !== 1) throw new Error('continuity pause conflict');
}
