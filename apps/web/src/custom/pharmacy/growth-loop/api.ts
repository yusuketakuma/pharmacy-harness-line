import type { ApiResponse } from '@line-crm/shared'
import { fetchApi } from '../../../lib/api'

export type PharmacyOperationsSummary = {
  accountId: string
  checkedAt: string
  capabilityError: boolean
  domains: Record<
    'prescriptionIntake' | 'electronicPrescription' | 'patientIntake' |
    'continuity' | 'medicationFollowup' | 'emergencyContraception',
    {
      enabled: boolean | null
      activeCount: number | null
      statusCounts: Record<string, number>
      updatedAt: string | null
      error: boolean
    }
  >
  richMenu: {
    status: 'READY' | 'BLOCKED' | 'UNVERIFIED' | null
    capabilityEnabled: boolean | null
    layoutConfigured: boolean | null
    savedVersionAvailable: boolean | null
    catalogVersionCurrent: boolean | null
    publishedVersionAvailable: boolean | null
    currentDefaultRecorded: boolean | null
    error: boolean
  }
}

export const pharmacyGrowthApi = {
  operationsSummary: (accountId: string) =>
    fetchApi<ApiResponse<PharmacyOperationsSummary>>(
      `/api/custom/pharmacy/operations-summary?line_account_id=${encodeURIComponent(accountId)}`,
    ),
  activeWork: (accountId: string) =>
    fetchApi<ApiResponse<Record<
      'prescription_intake' | 'electronic_prescription' | 'patient_intake' | 'continuity' |
      'medication_followup' | 'emergency_contraception' | 'manual_chat' | 'pharmacy_info', number
    >>>(`/api/custom/pharmacy/active-work?line_account_id=${encodeURIComponent(accountId)}`),
  readiness: (accountId: string) =>
    fetchApi<ApiResponse<{
      accountId: string
      checkedAt: string
      configurationDoctor: {
        accountId: string
        checkedAt: string
        status: 'READY' | 'BLOCKED' | 'UNVERIFIED'
        reasonCodes: string[]
        checks: Array<{
          key: string
          required: boolean
          status: 'READY' | 'BLOCKED' | 'UNVERIFIED'
          reasonCodes: string[]
          impact: string
          fixHref: string
        }>
      }
      electronicPrescription: {
        status: 'READY' | 'BLOCKED' | 'UNVERIFIED'
        capabilityEnabled: boolean
        endpointConfigured: boolean
        endpointEvidence: { status: 'UNVERIFIED'; source: 'manual_console'; checkedAt: string | null; freshnessHours: 24 }
      }
      emergencyContraception: {
        status: 'READY' | 'BLOCKED'
        capabilityEnabled: boolean
        trainedPharmacistAvailable: boolean
        inventoryAvailable: boolean
        futureSlotAvailable: boolean
      }
      richMenu: {
        status: 'READY' | 'BLOCKED' | 'UNVERIFIED'
        syncStatus: 'CURRENT' | 'STALE' | 'UNVERIFIED'
        capabilityEnabled: boolean
        layoutConfigured: boolean
        savedVersionAvailable: boolean
        catalogVersionCurrent: boolean
        publishedVersionAvailable: boolean
        currentDefaultRecorded: boolean
        capabilityRevisionCurrent: boolean
        uploadVerified: boolean
        defaultReadbackVerified: boolean
        evidenceCheckedAt: string | null
        reasonCodes: string[]
      }
    }>>(`/api/custom/pharmacy/readiness?line_account_id=${encodeURIComponent(accountId)}`),
  config: (accountId: string) =>
    fetchApi<ApiResponse<{
      line_account_id: string
      mode: 'pharmacy'
      capabilities: string[]
      proactive_monthly_limit: number
      unfollow_alert_state: 'alert_only' | 'auto_pause'
      revision: number
      created_at: string
      updated_at: string
    } | null>>(`/api/custom/pharmacy/growth/config?line_account_id=${encodeURIComponent(accountId)}`),
  saveConfig: (accountId: string, body: {
    capabilities: string[]
    expectedRevision: number
    proactiveMonthlyLimit: number
  }) => fetchApi<ApiResponse<{
    line_account_id: string
    mode: 'pharmacy'
    capabilities: string[]
    proactive_monthly_limit: number
    unfollow_alert_state: 'alert_only' | 'auto_pause'
    revision: number
    created_at: string
    updated_at: string
  }>>(`/api/custom/pharmacy/growth/config?line_account_id=${encodeURIComponent(accountId)}`, {
    method: 'PUT', body: JSON.stringify(body),
  }),
  dashboard: (accountId: string, from?: string, to?: string) => {
    const query = new URLSearchParams({ line_account_id: accountId })
    if (from) query.set('from', from)
    if (to) query.set('to', to)
    return fetchApi<ApiResponse<{
      from: string
      to: string
      entry: {
        firstTimeFollows: number
        measurableFollows: number
        firstSubmissions: number
        secondSubmissions: number
        firstSubmissionRate: { numerator: number; denominator: number; matureCohort: number; immatureCohort: number }
        secondSubmissionRate: { numerator: number; denominator: number; matureCohort: number; immatureCohort: number }
      }
      sources: { primary: number; other: number; unknown: number; otherShare: number | null; knownDenominator: number; attributionCoverage: number | null }
      promises: {
        promised: number
        onTime: number
        late: number
        onTimeRate: number | null
        p50LatenessMinutes: number | null
        p90LatenessMinutes: number | null
        promiseRevisionCount: number
        promiseWithoutReady: number
        readyEvents: number
        promiseWithoutQuote: number
        graceMinutes: number
      }
      validity: { verified: number; reminderSent: number; reminderClosedInTime: number; expiredReviewRequired: number; confirmedExpired: number }
      notifications: { counts: Record<string, number>; proactiveCapBlocked: number; proactiveAttempts: number; attempted: number; reconciliationRequired: number; alertState: 'alert_only' | 'auto_pause' }
      messaging: {
        sent: number
        received: number
        manual: number
        automated: number
        sourceUnverified: number
        push: number
        reply: number
        deliveryUnverified: number
        uniqueCorrespondents: number
        attempted: number
        reconciliationRequired: number
        legacyUnscoped: { count: null; status: 'UNVERIFIED' }
      }
      unfollow: { exposedFriends: number; within24h: number; within72h: number; sampleSize: number; interpretation: string }
    }>>(`/api/custom/pharmacy/growth/dashboard?${query.toString()}`)
  },
  sources: (accountId: string) =>
    fetchApi<ApiResponse<Array<{ id: string; display_name: string; classification: 'primary' | 'other'; is_active: number; created_at: string; updated_at: string }>>>(
      `/api/custom/pharmacy/growth/sources?line_account_id=${encodeURIComponent(accountId)}`,
    ),
  createSource: (accountId: string, body: { displayName: string; classification: 'primary' | 'other' }) =>
    fetchApi<ApiResponse<{ id: string }>>(`/api/custom/pharmacy/growth/sources?line_account_id=${encodeURIComponent(accountId)}`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  setSourceActive: (accountId: string, sourceId: string, isActive: boolean) =>
    fetchApi<ApiResponse<never>>(`/api/custom/pharmacy/growth/sources/${encodeURIComponent(sourceId)}?line_account_id=${encodeURIComponent(accountId)}`, {
      method: 'PATCH', body: JSON.stringify({ isActive }),
    }),
  classifySource: (accountId: string, submissionId: string, body: { sourceId: string | null; classification: 'primary' | 'other' | 'unknown' }) =>
    fetchApi<ApiResponse<never>>(`/api/custom/pharmacy/growth/submissions/${encodeURIComponent(submissionId)}/source?line_account_id=${encodeURIComponent(accountId)}`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  saveValidity: (accountId: string, submissionId: string, body: {
    issuedOn: string | null
    validUntil: string | null
    validityBasis: 'default_4_days' | 'prescriber_specified'
    verificationStatus: 'unverified' | 'verified' | 'expired_review_required' | 'expired_confirmed'
  }) => fetchApi<ApiResponse<never>>(`/api/custom/pharmacy/growth/submissions/${encodeURIComponent(submissionId)}/validity?line_account_id=${encodeURIComponent(accountId)}`, {
    method: 'PUT', body: JSON.stringify(body),
  }),
}
