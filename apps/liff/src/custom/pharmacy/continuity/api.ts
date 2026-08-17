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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await requestPharmacyLiff(path, init);
  if (!response.ok) throw new Error(`Continuity API ${response.status}`);
  return response.json() as Promise<T>;
}

export const continuityApi = {
  list: () => request<{ obligations: ContinuityObligation[] }>('/api/liff/pharmacy/continuity'),
  pause: (id: string) => request<{ status: 'paused' }>(`/api/liff/pharmacy/continuity/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
};
