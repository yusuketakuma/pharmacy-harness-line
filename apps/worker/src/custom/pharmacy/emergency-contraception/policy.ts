export type EmergencyRiskFlag =
  | 'time_unknown'
  | 'under_16'
  | 'minor_review'
  | 'repeat_purchase_review'
  | 'notification_unavailable'
  | 'pre_review_flagged';

// Detail flags for A3/A4/A5/A' (lng allergy, liver disease, current pregnancy,
// breastfeeding). These never change canCreateProvisional and are never stored
// in plaintext risk_flags_json — only the single pre_review_flagged summary is.
// The detailed breakdown lives inside the encrypted payload (schema_version 2).
export type EmergencyDetailFlag =
  | 'lng_allergy'
  | 'liver_disease'
  | 'pregnancy_reported'
  | 'breastfeeding_advice';

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
  now?: Date;
}

export interface EmergencyPrecheckAssessment {
  estimatedDoseAt: string;
  deadlineAt: string;
  canCreateProvisional: boolean;
  blockingReason: EmergencyBlockingReason | null;
  riskFlags: EmergencyRiskFlag[];
  detailFlags: EmergencyDetailFlag[];
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
  if (detailFlags.length > 0) riskFlags.push('pre_review_flagged');

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
  };
}
