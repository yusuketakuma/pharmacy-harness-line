import type { PharmacyCapability } from './access.js';

export type ActivePatientWorkCounts = Pick<Record<PharmacyCapability, number>,
  'prescription_intake' | 'electronic_prescription' | 'patient_intake' | 'continuity' |
  'medication_followup' | 'emergency_contraception' | 'manual_chat' | 'pharmacy_info'>;

export async function getActivePatientWorkCounts(
  db: D1Database,
  lineAccountId: string,
  at = new Date(),
): Promise<ActivePatientWorkCounts> {
  const row = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM pharmacy_prescription_submissions
         WHERE line_account_id = ? AND status NOT IN ('closed', 'cancelled')) AS prescription_intake,
       (SELECT COUNT(*) FROM pharmacy_myna_handoffs
         WHERE line_account_id = ? AND status NOT IN ('PAPER_FALLBACK', 'ABANDONED', 'EXPIRED', 'CLOSED')) AS electronic_prescription,
       (SELECT COUNT(*) FROM pharmacy_patients
         WHERE line_account_id = ? AND archived_at IS NULL) AS patient_intake,
       (SELECT COUNT(*) FROM pharmacy_next_intake_expectations
         WHERE line_account_id = ? AND status NOT IN ('linked', 'fulfilled', 'ended')) AS continuity,
       (SELECT COUNT(*) FROM pharmacy_medication_followups
         WHERE line_account_id = ? AND status NOT IN ('closed', 'cancelled')) AS medication_followup,
       (SELECT COUNT(*) FROM pharmacy_emergency_intakes
         WHERE line_account_id = ? AND status IN ('provisional', 'reviewed')
           AND expires_at > ?) AS emergency_contraception,
       (SELECT COUNT(*) FROM chats AS chat
          INNER JOIN friends AS friend ON friend.id = chat.friend_id
         WHERE friend.line_account_id = ? AND chat.status != 'resolved') AS manual_chat,
       EXISTS (SELECT 1 FROM pharmacy_public_profiles
                WHERE line_account_id = ?) AS pharmacy_info`,
  ).bind(
    lineAccountId, lineAccountId, lineAccountId, lineAccountId, lineAccountId, lineAccountId,
    at.toISOString(), lineAccountId, lineAccountId,
  ).first<Partial<ActivePatientWorkCounts>>();
  return {
    prescription_intake: row?.prescription_intake ?? 0,
    electronic_prescription: row?.electronic_prescription ?? 0,
    patient_intake: row?.patient_intake ?? 0,
    continuity: row?.continuity ?? 0,
    medication_followup: row?.medication_followup ?? 0,
    emergency_contraception: row?.emergency_contraception ?? 0,
    manual_chat: row?.manual_chat ?? 0,
    pharmacy_info: row?.pharmacy_info ?? 0,
  };
}
