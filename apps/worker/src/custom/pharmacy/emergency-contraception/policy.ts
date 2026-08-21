export type EmergencyRiskFlag =
  | 'time_unknown'
  | 'under_16'
  | 'minor_review'
  | 'repeat_purchase_review'
  | 'notification_unavailable'
  | 'pre_review_flagged';

// Detail flags for A3/A4/A5/A' (lng allergy, liver disease, current pregnancy,
// breastfeeding) and B1-B4 (medical treatment, drug allergy history,
// heart/kidney/GI disease, St John's wort). These never change
// canCreateProvisional and are never stored in plaintext risk_flags_json —
// only the single pre_review_flagged summary is. The detailed breakdown lives
// inside the encrypted payload (schema_version 2).
export type EmergencyDetailFlag =
  | 'lng_allergy'
  | 'liver_disease'
  | 'pregnancy_reported'
  | 'breastfeeding_advice'
  | 'under_medical_treatment'
  | 'drug_allergy_history'
  | 'heart_kidney_gi_disease'
  | 'st_johns_wort';

// C1/C2: last menstruation date and signals. pregnancy_test_recommended is
// computed from these but never enters risk_flags_json — it stays inside the
// encrypted payload (self_reported only, shown to pharmacists, never to the
// patient — see docs/pharmacy/EC_PREVISIT_FORM.md §3 row C2).
export interface EmergencyMenstruationSignals {
  noneApply: boolean;
  unknown: boolean;
  overOneMonthNoPeriod: boolean;
  notRecoveredAfterBirth: boolean;
  lastPeriodDifferent: boolean;
  earlierConcernOver3Weeks: boolean;
}

// noneApply/unknown are mutually exclusive with each other and with any of the
// four signals. Returns false when the input violates that exclusivity.
export function validMenstruationSignals(signals: EmergencyMenstruationSignals): boolean {
  const anySignal = signals.overOneMonthNoPeriod || signals.notRecoveredAfterBirth ||
    signals.lastPeriodDifferent || signals.earlierConcernOver3Weeks;
  if (signals.noneApply && signals.unknown) return false;
  if (signals.noneApply && anySignal) return false;
  if (signals.unknown && anySignal) return false;
  return true;
}

export type EmergencyBlockingReason =
  | 'patient_presence_required'
  | 'in_person_dose_required'
  | 'outside_72_hours';

export interface EmergencyPrecheckInput {
  intercourseAt: string;
  intercourseTimeUnknown: boolean;
  slotStartsAt: string;
  consultationMinutes: number;
  age: number;
  recentPurchaseCount: number;
  patientWillVisit: boolean;
  acceptsInPersonDose: boolean;
  safeContactAvailable: boolean;
  lngAllergy: boolean;
  liverDisease: boolean;
  currentlyPregnant: boolean;
  breastfeeding: boolean;
  underMedicalTreatment: boolean;
  drugAllergyHistory: boolean;
  heartKidneyGiDisease: boolean;
  stJohnsWort: boolean;
  lastMenstruationDate: string | null;
  menstruationSignals: EmergencyMenstruationSignals;
  now?: Date;
}

export interface EmergencyPrecheckAssessment {
  estimatedDoseAt: string;
  deadlineAt: string;
  canCreateProvisional: boolean;
  blockingReason: EmergencyBlockingReason | null;
  riskFlags: EmergencyRiskFlag[];
  detailFlags: EmergencyDetailFlag[];
  pregnancyTestRecommended: boolean;
}

// product_code -> manufacturer checklist version. Copied into the intake payload
// at creation time and defaults to the current single-product checklist when a
// product has no explicit entry yet.
const CHECKLIST_VERSIONS: Record<string, string> = {};
const DEFAULT_CHECKLIST_VERSION = 'lng-2026-08';

export function getChecklistVersion(productCode: string): string {
  return CHECKLIST_VERSIONS[productCode] ?? DEFAULT_CHECKLIST_VERSION;
}

const HOUR_MS = 60 * 60_000;
const JST_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIntercourseAt(value: string, timeUnknown: boolean): Date {
  if (timeUnknown && JST_DATE.test(value)) return new Date(`${value}T00:00:00+09:00`);
  if (!timeUnknown && ISO_WITH_ZONE.test(value)) return new Date(value);
  return new Date(Number.NaN);
}

export function assessEmergencyPrecheck(
  input: EmergencyPrecheckInput,
): EmergencyPrecheckAssessment {
  const now = input.now ?? new Date();
  const intercourseAt = parseIntercourseAt(input.intercourseAt, input.intercourseTimeUnknown);
  const slotStartsAt = ISO_WITH_ZONE.test(input.slotStartsAt)
    ? new Date(input.slotStartsAt)
    : new Date(Number.NaN);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(intercourseAt.getTime()) ||
      intercourseAt.getTime() > now.getTime()) {
    throw new Error('invalid intercourse time');
  }
  if (!Number.isFinite(slotStartsAt.getTime()) || slotStartsAt.getTime() < now.getTime() ||
      !Number.isInteger(input.consultationMinutes) || input.consultationMinutes < 1 ||
      input.consultationMinutes > 180) {
    throw new Error('invalid service slot');
  }
  if (!Number.isInteger(input.age) || input.age < 0 || input.age > 120 ||
      !Number.isInteger(input.recentPurchaseCount) || input.recentPurchaseCount < 0) {
    throw new Error('invalid review input');
  }

  const estimatedDoseAt = new Date(
    slotStartsAt.getTime() + input.consultationMinutes * 60_000,
  );
  const deadlineAt = new Date(intercourseAt.getTime() + 72 * HOUR_MS);
  const riskFlags: EmergencyRiskFlag[] = [];
  if (input.intercourseTimeUnknown) riskFlags.push('time_unknown');
  if (input.age < 16) riskFlags.push('under_16');
  else if (input.age < 18) riskFlags.push('minor_review');
  if (input.recentPurchaseCount >= 1) riskFlags.push('repeat_purchase_review');
  if (!input.safeContactAvailable) riskFlags.push('notification_unavailable');

  const detailFlags: EmergencyDetailFlag[] = [];
  if (input.lngAllergy) detailFlags.push('lng_allergy');
  if (input.liverDisease) detailFlags.push('liver_disease');
  if (input.currentlyPregnant) detailFlags.push('pregnancy_reported');
  if (input.breastfeeding) detailFlags.push('breastfeeding_advice');
  if (input.underMedicalTreatment) detailFlags.push('under_medical_treatment');
  if (input.drugAllergyHistory) detailFlags.push('drug_allergy_history');
  if (input.heartKidneyGiDisease) detailFlags.push('heart_kidney_gi_disease');
  if (input.stJohnsWort) detailFlags.push('st_johns_wort');
  if (detailFlags.length > 0) riskFlags.push('pre_review_flagged');

  // C1/C2: pharmacist-only signal, never mirrored into risk_flags_json.
  const signals = input.menstruationSignals;
  const pregnancyTestRecommended = input.lastMenstruationDate === null || signals.unknown ||
    signals.overOneMonthNoPeriod || signals.notRecoveredAfterBirth ||
    signals.lastPeriodDifferent || signals.earlierConcernOver3Weeks;

  const blockingReason = !input.patientWillVisit
    ? 'patient_presence_required'
    : !input.acceptsInPersonDose
      ? 'in_person_dose_required'
      : estimatedDoseAt.getTime() > deadlineAt.getTime()
        ? 'outside_72_hours'
        : null;

  return {
    estimatedDoseAt: estimatedDoseAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    canCreateProvisional: blockingReason === null,
    blockingReason,
    riskFlags,
    detailFlags,
    pregnancyTestRecommended,
  };
}
