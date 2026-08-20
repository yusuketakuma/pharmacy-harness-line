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

export const medicationFollowUpApi = {
  list: () => requestPharmacyJson<{ followUps: PatientMedicationFollowUp[] }>(
    '/api/liff/pharmacy/medication-followups',
    '服薬後フォローを取得できませんでした',
  ),
  respond: (
    followUpId: string,
    response: PatientMedicationFollowUpResponse,
    expectedVersion: number,
    idempotencyKey: string,
  ) => requestPharmacyJson<{ followUp: PatientMedicationFollowUp }>(
    `/api/liff/pharmacy/medication-followups/${encodeURIComponent(followUpId)}/respond`,
    '服薬後フォローを更新できませんでした',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response, expectedVersion, idempotencyKey }),
    },
  ),
};
