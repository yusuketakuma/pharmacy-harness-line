import { fetchApi } from '../../../lib/api';
import { accountQuery } from '../api';

export interface PharmacyPrintTask {
  id: string;
  submission_id: string;
  revision: number;
  status: 'pending' | 'handling' | 'acknowledged' | 'cancelled';
  lease_until: string | null;
  acknowledged_at: string | null;
}

const action = (accountId: string, path: string, operationId?: string) =>
  fetchApi<{ task: PharmacyPrintTask }>(`${path}?${accountQuery(accountId)}`, {
    method: 'POST',
    ...(operationId ? { body: JSON.stringify({ operationId }) } : {}),
  });

export const pharmacyPrintApi = {
  prepare: (accountId: string, submissionId: string) => action(
    accountId,
    `/api/custom/pharmacy/print/submissions/${encodeURIComponent(submissionId)}/prepare`,
  ),
  claim: (accountId: string, taskId: string, operationId: string) => action(
    accountId,
    `/api/custom/pharmacy/print/tasks/${encodeURIComponent(taskId)}/claim`,
    operationId,
  ),
  acknowledge: (accountId: string, taskId: string, operationId: string) => action(
    accountId,
    `/api/custom/pharmacy/print/tasks/${encodeURIComponent(taskId)}/ack`,
    operationId,
  ),
};
