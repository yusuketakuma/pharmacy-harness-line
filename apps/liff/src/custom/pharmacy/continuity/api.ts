import { requestPharmacyLiff } from '../request.js';

export type ContinuityStatus = 'active' | 'linked' | 'fulfilled' | 'paused' | 'ended';
export interface ContinuityObligation {
  id: string;
  patient_id: string;
  status: ContinuityStatus;
  expected_next_from: string;
  expected_next_to: string;
  next_contact_at: string;
  candidate_submission_id: string | null;
}

export interface NextIntakeExpectation {
  id: string;
  obligation_id: string;
  patient_id: string;
  status: 'offered' | 'accepted' | 'active' | 'reminded' | 'linked' | 'fulfilled' | 'paused' | 'ended';
  timing_source: 'manual_supply_days' | 'manual_window';
  supply_days: number | null;
  expected_from: string;
  expected_to: string;
  reminder_at: string;
  reminded_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await requestPharmacyLiff(path, init);
  if (!response.ok) throw new Error(`Continuity API ${response.status}`);
  return response.json() as Promise<T>;
}

export const continuityApi = {
  list: () => request<{
    obligations: ContinuityObligation[];
    expectations: NextIntakeExpectation[];
  }>('/api/liff/pharmacy/continuity'),
  pause: (id: string) => request<{ status: 'paused' }>(`/api/liff/pharmacy/continuity/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  respond: (id: string, response: 'accepted' | 'ended') => request<{
    expectation: NextIntakeExpectation;
  }>(`/api/liff/pharmacy/continuity/expectations/${encodeURIComponent(id)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response, idempotencyKey: crypto.randomUUID() }),
  }),
};
