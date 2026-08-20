import { requestPharmacyLiff } from '../request.js';

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

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await requestPharmacyLiff(path, init);
  if (!response.ok) throw new Error(`服薬後フォローを更新できませんでした (${response.status})`);
  return response.json() as Promise<T>;
}

export const medicationFollowUpApi = {
  list: () => json<{ followUps: PatientMedicationFollowUp[] }>(
    '/api/liff/pharmacy/medication-followups',
  ),
  respond: (
    followUpId: string,
    response: PatientMedicationFollowUpResponse,
    expectedVersion: number,
    idempotencyKey: string,
  ) => json<{ followUp: PatientMedicationFollowUp }>(
    `/api/liff/pharmacy/medication-followups/${encodeURIComponent(followUpId)}/respond`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response, expectedVersion, idempotencyKey }),
    },
  ),
};
