import { getIdToken, getLiffId } from '../../../lib/liff-auth.js';

const BASE = import.meta.env.VITE_API_BASE ?? '';

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
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const url = new URL(`${BASE}${path}`, origin);
  url.searchParams.set('liffId', getLiffId());
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${getIdToken()}`, ...init.headers } });
  if (!response.ok) throw new Error(`Continuity API ${response.status}`);
  return response.json() as Promise<T>;
}

export const continuityApi = {
  list: () => request<{ obligations: ContinuityObligation[] }>('/api/liff/pharmacy/continuity'),
  pause: (id: string) => request<{ status: 'paused' }>(`/api/liff/pharmacy/continuity/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
};
