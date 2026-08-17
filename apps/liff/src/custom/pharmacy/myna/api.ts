import { requestPharmacyLiff } from '../request.js';

export type MynaMethod = 'E_PRESCRIPTION' | 'PAPER' | 'MEDICAL_INSTITUTION_SENT';
export type MynaPatientReport = 'COMPLETED' | 'NO_PRESCRIPTION_FOUND' | 'FAILED' | 'SWITCH_TO_PAPER';

export interface MynaHandoff {
  id: string;
  method: MynaMethod;
  status: string;
  expires_at: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await requestPharmacyLiff(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(
    body && typeof body.error === 'string' ? body.error : `Myna受付 API ${response.status}`,
  );
  return body as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export const mynaApi = {
  create: (method: MynaMethod, correlationId: string, patientId?: string) =>
    post<{ handoff: MynaHandoff; launchUrl: string | null }>(
      '/api/liff/pharmacy/myna-handoffs',
      { method, correlationId, ...(patientId ? { patientId } : {}) },
    ),
  launch: (handoffId: string) => post<{ handoff: MynaHandoff; launchUrl: string }>(
    `/api/liff/pharmacy/myna-handoffs/${encodeURIComponent(handoffId)}/launch`, {},
  ),
  report: (handoffId: string, result: MynaPatientReport) => post<{ handoff: MynaHandoff }>(
    `/api/liff/pharmacy/myna-handoffs/${encodeURIComponent(handoffId)}/patient-report`, { result },
  ),
};
