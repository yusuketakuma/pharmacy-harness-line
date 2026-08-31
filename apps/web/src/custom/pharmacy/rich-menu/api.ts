import type { ApiResponse } from '@line-crm/shared'
import { API_URL, fetchApi } from '../../../lib/api'

export type PharmacyRichMenuVersionDiff = {
  status: 'UNVERIFIED'
  accountId: string
  checkedAt: string
  freshnessHours: 24
  reasonCode: 'CURRENT_DEFAULT_EVIDENCE_STALE' | 'CURRENT_DEFAULT_VERSION_MISSING' |
    'CURRENT_DEFAULT_MANIFEST_UNAVAILABLE'
} | {
  status: 'VERIFIED'
  accountId: string
  checkedAt: string
  freshnessHours: 24
  verifiedAt: string
  current: {
    groupId: string
    layoutRevision: number
    capabilityRevision: number
    manifestHash: string
    imageHash: string
  }
  draft: {
    groupId: string
    layoutRevision: number
    capabilityRevision: number
    manifestHash: string
    imageHash: string
  }
  imageChanged: boolean
  slots: Array<{
    kind: 'same' | 'added' | 'removed' | 'moved' | 'action_changed' | 'image_changed'
    currentIndex: number | null
    draftIndex: number | null
  }>
}

export type PharmacyRichMenuCandidate = {
  accountId: string
  preferredOrder: string[]
  effectiveOrder: string[]
  layoutRevision: number
  capabilityRevision: number
  catalogVersion: string
  variantKey: string
  menuSize: 'large' | 'compact'
  width: 2500
  height: 843 | 1686
  imageHash: string
  slots: Array<{
    actionKey: string
    label: string
    actionType: 'uri' | 'message'
    boundsX: number
    boundsY: number
    boundsWidth: number
    boundsHeight: number
  }>
} & ({
  syncStatus: 'UNVERIFIED'
  reasonCode: 'CURRENT_DEFAULT_EVIDENCE_STALE' | 'CURRENT_DEFAULT_VERSION_MISSING' |
    'CURRENT_DEFAULT_MANIFEST_UNAVAILABLE'
} | {
  syncStatus: 'CURRENT' | 'STALE'
  verifiedAt: string
  imageChanged: boolean
  changes: Array<{
    kind: 'same' | 'added' | 'removed' | 'moved' | 'action_changed' | 'image_changed'
    currentIndex: number | null
    draftIndex: number | null
  }>
})

export const pharmacyRichMenuApi = {
  pharmacyCandidate: (accountId: string) =>
    fetchApi<ApiResponse<PharmacyRichMenuCandidate>>(
      `/api/custom/pharmacy/rich-menus/candidate?accountId=${encodeURIComponent(accountId)}`,
    ),
  pharmacyCandidateImageUrl: (
    accountId: string,
    candidate: Pick<PharmacyRichMenuCandidate, 'layoutRevision' | 'capabilityRevision' | 'imageHash'>,
  ) => `${API_URL}/api/custom/pharmacy/rich-menus/candidate/image?${new URLSearchParams({
    accountId,
    layoutRevision: String(candidate.layoutRevision),
    capabilityRevision: String(candidate.capabilityRevision),
    imageHash: candidate.imageHash,
  })}`,
  pharmacyLayout: (accountId: string) =>
    fetchApi<ApiResponse<{
      preferredOrder: string[]
      effectiveOrder: string[]
      variantKey: string
      revision: number
      capabilityRevision: number
      updatedAt: string | null
    }>>(`/api/custom/pharmacy/rich-menus/layout?accountId=${encodeURIComponent(accountId)}`),
  pharmacyLifecycle: (accountId: string) =>
    fetchApi<ApiResponse<{
      lineAccountId: string
      state: 'inactive' | 'active' | 'frozen'
      revision: number
      updatedAt: string | null
    }>>(`/api/custom/pharmacy/rich-menus/lifecycle?accountId=${encodeURIComponent(accountId)}`),
  savePharmacyLifecycle: (
    accountId: string,
    input: { state: 'inactive' | 'active' | 'frozen'; expectedRevision: number },
  ) => fetchApi<ApiResponse<{
    lineAccountId: string
    state: 'inactive' | 'active' | 'frozen'
    revision: number
    updatedAt: string | null
  }>>(`/api/custom/pharmacy/rich-menus/lifecycle?accountId=${encodeURIComponent(accountId)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
  savePharmacyLayout: (
    accountId: string,
    input: { preferredOrder: string[]; expectedRevision: number },
  ) => fetchApi<ApiResponse<{
    preferredOrder: string[]
    effectiveOrder: string[]
    variantKey: string
    revision: number
    capabilityRevision: number
    updatedAt: string | null
  }>>(`/api/custom/pharmacy/rich-menus/layout?accountId=${encodeURIComponent(accountId)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
  pharmacyVersions: (accountId: string) =>
    fetchApi<ApiResponse<Array<{
      groupId: string
      lineAccountId: string
      name: string
      status: 'draft' | 'published'
      currentDefault: boolean
      knownGood: boolean
      unverified: boolean
      unresolvedOperationId: string | null
      unresolvedOperationKind: 'publish' | 'set_default' | 'rollback' | null
      lineRichMenuId: string | null
      imageR2Key: string
      imageContentType: string
      menuSize: 'large' | 'compact'
      layoutRevision: number
      capabilityRevision: number
      catalogVersion: string
      catalogVariantKey: string
      manifestHash: string
      imageHash: string
      createdAt: string
      updatedAt: string
    }>>>(`/api/custom/pharmacy/rich-menus/versions?accountId=${encodeURIComponent(accountId)}`),
  pharmacyVersionDiff: (accountId: string, groupId: string) =>
    fetchApi<ApiResponse<PharmacyRichMenuVersionDiff>>(
      `/api/custom/pharmacy/rich-menus/versions/${encodeURIComponent(groupId)}/diff?accountId=${encodeURIComponent(accountId)}`,
    ),
  createPharmacyVersion: (accountId: string, input: {
    name: string
    expectedLayoutRevision: number
    expectedCapabilityRevision: number
  }) => fetchApi<ApiResponse<{
    groupId: string
    name: string
    status: 'draft'
    catalogVersion: string
    menuSize: 'large' | 'compact'
    catalogVariantKey: string
    imageHash: string
    manifestHash: string
    layoutRevision: number
    capabilityRevision: number
    imageR2Key: string
  }>>(`/api/custom/pharmacy/rich-menus/versions?accountId=${encodeURIComponent(accountId)}`, {
    method: 'POST', body: JSON.stringify(input),
  }),
  renamePharmacyVersion: (
    accountId: string,
    groupId: string,
    input: { name: string; expectedUpdatedAt: string },
  ) => fetchApi<ApiResponse<{ groupId: string; name: string; updatedAt: string }>>(
    `/api/custom/pharmacy/rich-menus/versions/${encodeURIComponent(groupId)}?accountId=${encodeURIComponent(accountId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  ),
  deletePharmacyVersion: (
    accountId: string,
    groupId: string,
    expectedUpdatedAt: string,
  ) => fetchApi<ApiResponse<{ cleanupPending: boolean }>>(
    `/api/custom/pharmacy/rich-menus/versions/${encodeURIComponent(groupId)}?accountId=${encodeURIComponent(accountId)}&expectedUpdatedAt=${encodeURIComponent(expectedUpdatedAt)}`,
    { method: 'DELETE' },
  ),
  reconcilePharmacyOperation: (accountId: string, operationId: string) =>
    fetchApi<ApiResponse<{
      status: 'succeeded' | 'failed' | 'running' | 'unknown'
      reasonCode?: string
    }>>(
      `/api/rich-menu-groups/operations/${encodeURIComponent(operationId)}/reconcile?accountId=${encodeURIComponent(accountId)}`,
      { method: 'POST' },
    ),
  resumePharmacyOperation: (
    accountId: string,
    operationId: string,
    input: { dryRun: boolean; confirmationToken?: string },
  ) => fetchApi<ApiResponse<{
    dryRun?: boolean
    confirmationToken?: string
    expiresAt?: number
    status?: 'running' | 'unknown'
    publishPhase: 'intent_recorded' | 'remote_created' | 'image_uploaded' | 'alias_created'
    nextStage?: 'create' | 'image_upload' | 'alias_create'
  }>>(
    `/api/rich-menu-groups/operations/${encodeURIComponent(operationId)}/resume?accountId=${encodeURIComponent(accountId)}`,
    { method: 'POST', body: JSON.stringify(input) },
  ),
  publishPharmacyVersion: (
    groupId: string,
    accountId: string,
    input: { dryRun: boolean; confirmationToken?: string },
  ) => fetchApi<ApiResponse<{
    dryRun?: boolean
    confirmationToken?: string
    expiresAt?: number
    readiness?: { status: 'READY' | 'BLOCKED'; reasonCodes: string[] }
    pages?: Array<{ pageId: string; newRichMenuId: string }>
  }>>(`/api/rich-menu-groups/${groupId}/publish?accountId=${encodeURIComponent(accountId)}`, {
    method: 'POST', body: JSON.stringify(input),
  }),
}
