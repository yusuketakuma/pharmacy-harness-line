import { requestPharmacyJson } from '../request.js';

export type PatientTimelineItem = {
  domain: string;
  status: string;
  nextAction: string;
  occurredAt: string;
  detailPath: string;
};

export const patientTimelineApi = {
  load: () => requestPharmacyJson<{ items: PatientTimelineItem[] }>(
    '/api/liff/pharmacy/timeline',
  ),
};
