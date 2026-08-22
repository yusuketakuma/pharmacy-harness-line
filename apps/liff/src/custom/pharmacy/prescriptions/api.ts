import { requestPharmacyJson } from '../request.js';

export interface PrescriptionSubmission {
  id: string;
  status: string;
  active_revision: number | null;
  upload_revision: number;
  desired_pickup_at: string | null;
  desired_fulfillment_method: 'PICKUP' | 'DELIVERY' | null;
  arrival_reported_at: string | null;
  estimated_ready_at: string | null;
  requirements_json: string | null;
  fulfillment_method: string | null;
  resubmission_reason_code: string | null;
  requested_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return requestPharmacyJson<T>(path, init);
}

function json<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const prescriptionApi = {
  reserve: (body: {
    idempotencyKey: string;
    desiredPickupAt: string | null;
    desiredFulfillmentMethod: 'PICKUP' | 'DELIVERY' | null;
    originalPrescriptionConsent: boolean;
    readinessNoticeConsent: boolean;
    patientId?: string;
    intakeResponseId?: string;
  }) => json<{ submission: PrescriptionSubmission }>(
    '/api/liff/pharmacy/prescriptions', body,
  ),
  upload: (submissionId: string, position: number, image: Blob) =>
    request<{ file: { id: string; revision: number; position: number; state: 'ready' } }>(
      `/api/liff/pharmacy/prescriptions/${encodeURIComponent(submissionId)}/files/${position}`,
      { method: 'PUT', headers: { 'Content-Type': image.type }, body: image },
    ),
  submit: (submissionId: string, body: {
    expectedUpdatedAt: string;
    desiredPickupAt: string | null;
    desiredFulfillmentMethod: 'PICKUP' | 'DELIVERY' | null;
    originalPrescriptionConsent: boolean;
    readinessNoticeConsent: boolean;
  }) =>
    json<{ status: 'received' }>(
      `/api/liff/pharmacy/prescriptions/${encodeURIComponent(submissionId)}/submit`,
      body,
    ),
  history: () => request<{ submissions: PrescriptionSubmission[] }>(
    '/api/liff/pharmacy/prescriptions/me',
  ),
  cancel: (submissionId: string, expectedUpdatedAt: string) =>
    json<{ status: 'cancelled'; cleanupPending: boolean }>(
      `/api/liff/pharmacy/prescriptions/${encodeURIComponent(submissionId)}/cancel`,
      { expectedUpdatedAt },
    ),
  reserveResubmission: (submissionId: string, expectedUpdatedAt: string) =>
    json<{ status: 'needs_resubmission' }>(
      `/api/liff/pharmacy/prescriptions/${encodeURIComponent(submissionId)}/resubmission`,
      { expectedUpdatedAt },
    ),
  arrive: (submissionId: string, expectedUpdatedAt: string) =>
    json<{ arrivalReportedAt: string }>(
      `/api/liff/pharmacy/prescriptions/${encodeURIComponent(submissionId)}/arrival`,
      { expectedUpdatedAt },
    ),
};
