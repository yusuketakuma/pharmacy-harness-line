import { requestPharmacyJson } from '../request.js';

export type PatientMedicationFollowUpStatus =
  | 'scheduled' | 'due' | 'delivered' | 'no_issue' | 'concern'
  | 'pharmacist_requested' | 'assigned' | 'responded' | 'escalated'
  | 'closed' | 'cancelled';

export type PatientMedicationFollowUpResponse = 'no_issue' | 'concern' | 'pharmacist_requested';

export interface PatientMedicationFollowUp {
  id: string;
  patient_name: string;
  status: PatientMedicationFollowUpStatus;
  due_at: string;
  delivered_at: string | null;
  responded_at: string | null;
  closed_at: string | null;
  version: number;
}

export type FollowUpOperationsMessageCode = 'contact_pharmacy_during_hours' | 'seek_urgent_care';

export interface MedicationFollowUpOperationsOutlook {
  serviceHoursText: string;
  responseEstimateMinutes: number | null;
  afterHoursMessageCode: FollowUpOperationsMessageCode;
  emergencyMessageCode: FollowUpOperationsMessageCode;
}

export const medicationFollowUpApi = {
  list: () => requestPharmacyJson<{ followUps: PatientMedicationFollowUp[] }>(
    '/api/liff/pharmacy/medication-followups',
  ),
  outlook: () => requestPharmacyJson<{ outlook: MedicationFollowUpOperationsOutlook | null }>(
    '/api/liff/pharmacy/medication-followups/outlook',
  ),
  respond: (
    followUpId: string,
    response: PatientMedicationFollowUpResponse,
    expectedVersion: number,
    idempotencyKey: string,
  ) => requestPharmacyJson<{ followUp: PatientMedicationFollowUp }>(
    `/api/liff/pharmacy/medication-followups/${encodeURIComponent(followUpId)}/respond`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response, expectedVersion, idempotencyKey }),
    },
  ),
};
