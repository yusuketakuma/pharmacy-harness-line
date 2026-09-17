import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

export type ChatTemplateStatus = 'draft' | 'approved' | 'archived'

export type PharmacyChatTemplate = {
  id: string
  title: string
  body: string
  status: ChatTemplateStatus
  version: number
  approved_at: string | null
  created_at: string
  updated_at: string
}

export const chatTemplateApi = {
  list: (accountId: string, status?: ChatTemplateStatus | 'all') =>
    fetchApi<{ templates: PharmacyChatTemplate[] }>(
      `/api/custom/pharmacy/chat-templates?${accountQuery(accountId)}${status ? `&status=${status}` : ''}`,
    ),
  create: (accountId: string, input: { title: string; body: string }) =>
    fetchApi<{ template: PharmacyChatTemplate }>(
      `/api/custom/pharmacy/chat-templates?${accountQuery(accountId)}`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  update: (accountId: string, templateId: string, input: {
    title: string
    body: string
    expectedVersion: number
  }) => fetchApi<{ template: PharmacyChatTemplate }>(
    `/api/custom/pharmacy/chat-templates/${encodeURIComponent(templateId)}?${accountQuery(accountId)}`,
    { method: 'PUT', body: JSON.stringify(input) },
  ),
  approve: (accountId: string, templateId: string, expectedVersion: number) =>
    fetchApi<{ template: PharmacyChatTemplate }>(
      `/api/custom/pharmacy/chat-templates/${encodeURIComponent(templateId)}/approve?${accountQuery(accountId)}`,
      { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    ),
  archive: (accountId: string, templateId: string, expectedVersion: number) =>
    fetchApi<{ template: PharmacyChatTemplate }>(
      `/api/custom/pharmacy/chat-templates/${encodeURIComponent(templateId)}/archive?${accountQuery(accountId)}`,
      { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    ),
}
