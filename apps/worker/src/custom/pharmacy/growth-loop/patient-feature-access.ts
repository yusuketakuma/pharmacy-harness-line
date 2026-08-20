import type { PrescriptionPatient } from '../prescriptions/patient.js';
import type { PharmacyCapability } from './access.js';

const EXISTING_FEATURES = [
  'prescription_intake',
  'electronic_prescription',
  'patient_intake',
  'continuity',
  'medication_followup',
  'emergency_contraception',
] as const satisfies readonly PharmacyCapability[];

type ExistingFeature = (typeof EXISTING_FEATURES)[number];
type ExistingFeatureRow = Record<ExistingFeature, number>;

export async function listExistingPatientFeatures(
  db: D1Database,
  patient: PrescriptionPatient,
): Promise<ExistingFeature[]> {
  const row = await db.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM pharmacy_prescription_submissions
                WHERE line_account_id = ? AND friend_id = ?) AS prescription_intake,
       EXISTS (SELECT 1 FROM pharmacy_myna_handoffs
                WHERE line_account_id = ? AND friend_id = ?) AS electronic_prescription,
       EXISTS (SELECT 1 FROM pharmacy_patients
                WHERE line_account_id = ? AND owner_friend_id = ?) AS patient_intake,
       EXISTS (SELECT 1 FROM pharmacy_next_intake_expectations
                WHERE line_account_id = ? AND owner_friend_id = ?) AS continuity,
       EXISTS (SELECT 1 FROM pharmacy_medication_followups
                WHERE line_account_id = ? AND owner_friend_id = ?) AS medication_followup,
       EXISTS (SELECT 1 FROM pharmacy_emergency_intakes
                WHERE line_account_id = ? AND owner_friend_id = ?) AS emergency_contraception`,
  ).bind(
    patient.lineAccountId, patient.friendId,
    patient.lineAccountId, patient.friendId,
    patient.lineAccountId, patient.friendId,
    patient.lineAccountId, patient.friendId,
    patient.lineAccountId, patient.friendId,
    patient.lineAccountId, patient.friendId,
  ).first<ExistingFeatureRow>();
  return EXISTING_FEATURES.filter((feature) => row?.[feature] === 1);
}
