import { requestPharmacyJson } from '../request.js';

export type EmergencyIntakeStatus =
  | 'provisional' | 'reviewed' | 'completed' | 'cancelled' | 'expired';

export type EmergencySafeContactMode =
  | 'neutral_line' | 'no_notification' | 'phone' | 'none';

export type EmergencyServiceReason =
  | 'not_configured' | 'paused' | 'requirements_incomplete'
  | 'out_of_stock' | 'no_slots';

export interface EmergencyServiceOverview {
  ready: boolean;
  reason: EmergencyServiceReason | null;
  consent: {
    version: string;
    purpose: string;
    retention_days: number;
    privacy_policy_url: string;
    privacy_contact: string;
  } | null;
  manufacturer_check_url: string | null;
  partner_clinic_url: string | null;
  support_center_url: string | null;
  slots: Array<{
    id: string;
    starts_at: string;
    ends_at: string;
    remaining: number;
  }>;
}

export interface EmergencyIntake {
  id: string;
  reference_code: string;
  slot_id: string;
  status: EmergencyIntakeStatus;
  age_band: 'under_16' | '16_17' | 'adult';
  safe_contact_mode: EmergencySafeContactMode;
  consent_version: string;
  risk_flags: Array<'time_unknown' | 'under_16' | 'minor_review' | 'repeat_purchase_review' | 'notification_unavailable'>;
  expires_at: string;
  version: number;
  created_at: string;
  updated_at: string;
  slot_starts_at: string;
  slot_ends_at: string;
}

export interface CreateEmergencyIntakeInput {
  slotId: string;
  intercourseAt: string;
  intercourseTimeUnknown: boolean;
  age: number;
  recentPurchaseCount: number;
  patientWillVisit: boolean;
  acceptsInPersonDose: boolean;
  safeContactMode: EmergencySafeContactMode;
  consentVersion: string;
  manufacturerCheckAcknowledged: boolean;
  idempotencyKey: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestPharmacyJson<T>(path, 'Emergency contraception API', init);
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const emergencyContraceptionApi = {
  list: () => request<{
    service: EmergencyServiceOverview;
    intakes: EmergencyIntake[];
  }>('/api/liff/pharmacy/emergency-contraception'),

  create: (body: CreateEmergencyIntakeInput) => post<{ intake: EmergencyIntake }>(
    '/api/liff/pharmacy/emergency-contraception/intakes', body,
  ),

  cancel: (intakeId: string, expectedVersion: number, idempotencyKey: string) =>
    post<{ intake: EmergencyIntake }>(
      `/api/liff/pharmacy/emergency-contraception/intakes/${encodeURIComponent(intakeId)}/cancel`,
      { expectedVersion, idempotencyKey },
    ),
};
