/**
 * Platform admin (全体管理者) API client.
 *
 * Mirrors `lib/api.ts`'s fetchApi, with two deliberate differences: the CSRF
 * token lives under its own localStorage key and travels in its own header, so
 * the platform-admin portal can never echo the tenant admin's token (and vice
 * versa). The real boundary is the separate HttpOnly cookie server-side; these
 * distinct names just keep the two portals from being confused client-side.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL

export const PLATFORM_ADMIN_CSRF_STORAGE_KEY = 'lh_platform_admin_csrf'
export const PLATFORM_ADMIN_NAME_STORAGE_KEY = 'lh_platform_admin_name'
export const PLATFORM_ADMIN_CSRF_HEADER = 'x-platform-admin-csrf-token'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Non-2xx response. `message` is the API's own `error` text so topology and
 *  validation failures can be surfaced verbatim; `status` lets callers branch. */
export class PlatformAdminApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'PlatformAdminApiError'
    this.status = status
  }
}

export function setPlatformAdminCsrfToken(token: unknown): void {
  if (typeof window === 'undefined' || typeof token !== 'string' || !token) return
  localStorage.setItem(PLATFORM_ADMIN_CSRF_STORAGE_KEY, token)
}

export function setPlatformAdminName(name: unknown): void {
  if (typeof window === 'undefined' || typeof name !== 'string' || !name) return
  localStorage.setItem(PLATFORM_ADMIN_NAME_STORAGE_KEY, name)
}

export function clearPlatformAdminLocalState(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(PLATFORM_ADMIN_CSRF_STORAGE_KEY)
  localStorage.removeItem(PLATFORM_ADMIN_NAME_STORAGE_KEY)
}

/** `path` is relative to /api/platform-admin (e.g. '/tenants'). */
export async function platformAdminFetch<T>(path: string, options?: RequestInit): Promise<T> {
  if (!API_URL) throw new PlatformAdminApiError(0, 'NEXT_PUBLIC_API_URL is not set in build env')
  const method = (options?.method ?? 'GET').toUpperCase()
  const csrfHeaders: Record<string, string> = {}
  if (MUTATING_METHODS.has(method) && typeof window !== 'undefined') {
    const token = localStorage.getItem(PLATFORM_ADMIN_CSRF_STORAGE_KEY)
    if (token) csrfHeaders[PLATFORM_ADMIN_CSRF_HEADER] = token
  }
  const res = await fetch(`${API_URL}/api/platform-admin${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...csrfHeaders,
      ...options?.headers,
    },
  })
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; error?: string; csrfToken?: string }
    | null
  if (!res.ok) throw new PlatformAdminApiError(res.status, body?.error || `API error: ${res.status}`)
  // /login, /session and /change-password all reissue the token; keep the
  // stored copy fresh so the next mutating request double-submits the right one.
  setPlatformAdminCsrfToken(body?.csrfToken)
  return body as T
}

export type PlatformAdminSession = { id: string; name: string; mustChangePassword: boolean }

export type PlatformTenant = {
  id: string
  tenantCode: string
  displayName: string
  status: string
  lineAccountCount: number
  staffCount: number
  patientCount: number
}

export type PlatformTenantLineAccount = {
  id: string
  name: string
  channel_id: string
  is_active: number
}

export type PlatformTenantDetail = PlatformTenant & { lineAccounts: PlatformTenantLineAccount[] }

/** Row from listAdminPharmacyPatients, plus the tenant's line account it came from. */
export type PlatformPatient = {
  lineAccountId: string
  id: string
  relationship: 'self' | 'child' | 'spouse' | 'parent' | 'other'
  name: string
  name_kana: string
  birth_date: string
  sex: 'male' | 'female' | 'other' | 'prefer_not_to_say' | null
  contact_phone: string | null
  postal_code: string | null
  prefecture: string | null
  city: string | null
  address_line1: string | null
  address_line2: string | null
  archived_at: string | null
  created_at?: string
  updated_at?: string
}

export type PlatformIntakeSummary = {
  id: string
  patient_id: string
  revision: number
  schema_version: number
  representative_consent_at: string
  privacy_consent_at: string
  created_at: string
}

/** getAdminPharmacyPatientHistory + the route's expectation/handoff joins. */
export type PlatformPatientDetail = {
  lineAccountId: string
  patient: Omit<PlatformPatient, 'lineAccountId'>
  intakes: PlatformIntakeSummary[]
  latestIntake: (PlatformIntakeSummary & { answers: Record<string, unknown> }) | null
  prescriptions: Array<{
    id: string
    status: string
    active_revision: number | null
    desired_pickup_at: string | null
    requested_at: string | null
    closed_at: string | null
    created_at: string
    updated_at: string
  }>
  quotes: Array<{
    id: string
    submission_id: string
    decision: string
    estimated_ready_at: string | null
    status: string | null
    fulfillment_method: string | null
    created_at: string
  }>
  continuity: Array<{
    id: string
    status: string
    expected_next_from: string
    expected_next_to: string
    next_contact_at: string
    reminder_count: number
    created_at: string
    updated_at: string
  }>
  medicationFollowUps: Array<{
    id: string
    source_submission_id: string
    status: string
    due_at: string
    delivered_at: string | null
    responded_at: string | null
    closed_at: string | null
    version: number
    created_at: string
    updated_at: string
  }>
  timeline: Array<{
    kind: 'intake' | 'prescription' | 'fulfillment' | 'continuity' | 'medication_followup' | 'myna'
    occurred_at: string
    label: string
    status?: string | null
  }>
  nextIntakeExpectations: Array<{
    id: string
    obligation_id: string
    patient_id: string
    status: string
    timing_source: string
    supply_days: number | null
    expected_from: string
    expected_to: string
    reminder_at: string
    reminded_at: string | null
    version: number
    created_at: string
    updated_at: string
  }>
  mynaHandoffs: Array<{
    id: string
    patient_id: string | null
    expectation_id: string | null
    method: string
    status: string
    source: string
    correlation_id: string
    launched_at: string | null
    patient_reported_at: string | null
    expires_at: string
    closed_at: string | null
    created_at: string
    updated_at: string
  }>
}

export type PlatformLogType = 'prescription_events' | 'webhook_receipts' | 'platform_admin_access'

export type PlatformAccessEvent = {
  id: string
  platform_admin_id: string
  tenant_id: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  detail_json: string | null
  created_at: string
}

export type PlatformLogs = {
  prescriptionEvents?: Array<{
    id: string
    submission_id: string
    event_type: string
    actor_type: string | null
    from_status: string | null
    to_status: string | null
    created_at: string
    tenant_id: string
    line_account_id: string
  }>
  webhookReceipts?: Array<{
    tenant_id: string | null
    line_account_id: string | null
    webhook_event_id: string
    received_at: string
    status: string
    retry_count: number
    dead_lettered_at: string | null
  }>
  platformAdminAccess?: PlatformAccessEvent[]
}

/**
 * A support-mode grant, exactly as the API returns it.
 *
 * `scopes` is a JSON-encoded array, not an array: the backend stores the
 * column as TEXT and hands the row back verbatim (access-grant.ts). Parse it
 * with `grantScopes()` rather than assuming a shape.
 */
export type PlatformSupportGrant = {
  id: string
  platform_admin_id: string
  tenant_id: string
  scopes: string
  reason: string
  ticket_reference: string | null
  issued_at: string
  expires_at: string
  revoked_at: string | null
}

export const PHI_READ_SCOPE = 'phi:read'
export const DEFAULT_GRANT_MINUTES = 15
export const MAX_GRANT_MINUTES = 60

export function grantScopes(grant: PlatformSupportGrant): string[] {
  try {
    const parsed: unknown = JSON.parse(grant.scopes)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/**
 * The PHI routes return 403 for exactly one reason: no active support-mode
 * grant for that tenant. Everything else they can fail with is 401 (session)
 * or 404 (unknown tenant/patient), so status alone identifies the case.
 */
export function isSupportModeRequired(error: unknown): boolean {
  return error instanceof PlatformAdminApiError && error.status === 403
}

export type PlatformDashboard = {
  totalTenants: number
  activeTenants: number
  suspendedTenants: number
  webhookFailures24h: number
  webhookPending: number
  activeSupportGrants: number
  tenantsWithStaleActivity: number
}

export type PlatformTenantHealth = {
  tenantId: string
  lineAccounts: Array<{
    id: string
    name: string
    isActive: boolean
    hasChannelIdentity: boolean
    lastWebhookAt: string | null
  }>
  webhook24h: { success: number; failed: number }
  activeStaffCount: number
  activeSessionCount: number
  lastAdminLoginAt: string | null
}

export type PlatformIntegrityCheck = {
  name: string
  status: 'ok' | 'warn' | 'critical'
  affectedCount: number
  sampleIds: string[]
}

export type PlatformStaffMember = {
  staffId: string
  name: string
  email: string | null
  role: string
  isActive: boolean
  membershipActive: boolean
  activeSessionCount: number
}

export type PlatformLineStatus = {
  id: string
  name: string
  channelId: string
  isActive: boolean
  hasBotIdentity: boolean
  hasEncryptedCredential: boolean
  lastWebhookReceivedAt: string | null
}

/** A failed probe is a normal diagnostic result, so it arrives at HTTP 200. */
export type PlatformLineProbe =
  | { ok: true; botUserId: string; displayName: string | null }
  | { ok: false; error: string }

type Envelope<T> = { success: boolean; data: T; csrfToken?: string }

export const platformAdminApi = {
  login: (loginId: string, password: string) =>
    platformAdminFetch<Envelope<PlatformAdminSession>>('/login', {
      method: 'POST',
      body: JSON.stringify({ loginId, password }),
    }),
  logout: () => platformAdminFetch<Envelope<null>>('/logout', { method: 'POST' }),
  session: () => platformAdminFetch<Envelope<PlatformAdminSession>>('/session'),
  changePassword: (currentPassword: string, newPassword: string) =>
    platformAdminFetch<Envelope<{ mustChangePassword: boolean }>>('/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  tenants: () => platformAdminFetch<Envelope<PlatformTenant[]>>('/tenants'),
  tenant: (id: string) =>
    platformAdminFetch<Envelope<PlatformTenantDetail>>(`/tenants/${encodeURIComponent(id)}`),
  updateTenant: (id: string, changes: { displayName?: string; status?: string }) =>
    platformAdminFetch<Envelope<{ id: string; displayName: string; status: string }>>(
      `/tenants/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(changes) },
    ),
  patients: (tenantId: string) =>
    platformAdminFetch<Envelope<PlatformPatient[]>>(
      `/tenants/${encodeURIComponent(tenantId)}/patients`,
    ),
  patient: (tenantId: string, patientId: string) =>
    platformAdminFetch<Envelope<PlatformPatientDetail>>(
      `/tenants/${encodeURIComponent(tenantId)}/patients/${encodeURIComponent(patientId)}`,
    ),
  logs: (params: { tenantId?: string; type?: PlatformLogType; since?: string; limit?: number }) => {
    const query = new URLSearchParams()
    if (params.tenantId) query.set('tenantId', params.tenantId)
    if (params.type) query.set('type', params.type)
    if (params.since) query.set('since', params.since)
    if (params.limit) query.set('limit', String(params.limit))
    const suffix = query.toString()
    return platformAdminFetch<Envelope<PlatformLogs>>(`/logs${suffix ? `?${suffix}` : ''}`)
  },
  audit: (params: { all?: boolean; limit?: number }) => {
    const query = new URLSearchParams()
    if (params.all) query.set('all', 'true')
    if (params.limit) query.set('limit', String(params.limit))
    const suffix = query.toString()
    return platformAdminFetch<Envelope<PlatformAccessEvent[]>>(`/audit${suffix ? `?${suffix}` : ''}`)
  },

  // --- support mode (期限付きPHIアクセス) ---
  /** `currentPassword` is a step-up re-authentication. It is sent and forgotten:
   *  never stored, never logged, never put in a URL. */
  startSupportGrant: (
    tenantId: string,
    input: {
      reason: string
      ticketReference?: string
      scopes: string[]
      currentPassword: string
      durationMinutes?: number
    },
  ) =>
    platformAdminFetch<Envelope<PlatformSupportGrant>>(
      `/tenants/${encodeURIComponent(tenantId)}/support-grants`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  endSupportGrant: (grantId: string) =>
    platformAdminFetch<Envelope<null>>(
      `/support-grants/${encodeURIComponent(grantId)}/end`,
      { method: 'POST' },
    ),
  activeSupportGrants: () =>
    platformAdminFetch<Envelope<PlatformSupportGrant[]>>('/support-grants/active'),

  // --- dashboard / health ---
  dashboard: () => platformAdminFetch<Envelope<PlatformDashboard>>('/dashboard'),
  tenantHealth: (tenantId: string) =>
    platformAdminFetch<Envelope<PlatformTenantHealth>>(
      `/tenants/${encodeURIComponent(tenantId)}/health`,
    ),
  integrity: () => platformAdminFetch<Envelope<PlatformIntegrityCheck[]>>('/integrity'),

  // --- tenant operations ---
  staff: (tenantId: string) =>
    platformAdminFetch<Envelope<PlatformStaffMember[]>>(
      `/tenants/${encodeURIComponent(tenantId)}/staff`,
    ),
  disableStaff: (tenantId: string, staffId: string) =>
    platformAdminFetch<Envelope<{ staffId: string; sessionsRevoked: number }>>(
      `/tenants/${encodeURIComponent(tenantId)}/staff/${encodeURIComponent(staffId)}/disable`,
      { method: 'POST' },
    ),
  revokeTenantSessions: (tenantId: string) =>
    platformAdminFetch<Envelope<{ revoked: number }>>(
      `/tenants/${encodeURIComponent(tenantId)}/revoke-sessions`,
      { method: 'POST' },
    ),
  lineStatus: (tenantId: string) =>
    platformAdminFetch<Envelope<PlatformLineStatus[]>>(
      `/tenants/${encodeURIComponent(tenantId)}/line-status`,
    ),
  testLineConnection: (tenantId: string, lineAccountId: string) =>
    platformAdminFetch<Envelope<PlatformLineProbe>>(
      `/tenants/${encodeURIComponent(tenantId)}/line-accounts/${encodeURIComponent(lineAccountId)}/test-connection`,
      { method: 'POST' },
    ),
  setOutboundMessaging: (tenantId: string, paused: boolean) =>
    platformAdminFetch<Envelope<{ id: string; outboundMessagingPausedAt: string | null }>>(
      `/tenants/${encodeURIComponent(tenantId)}/outbound-messaging`,
      { method: 'POST', body: JSON.stringify({ paused }) },
    ),
  retryWebhookEvent: (tenantId: string, webhookEventId: string) =>
    platformAdminFetch<Envelope<{ webhookEventId: string; outcome: 'completed' | 'failed' | 'skipped' }>>(
      `/tenants/${encodeURIComponent(tenantId)}/webhook-events/${encodeURIComponent(webhookEventId)}/retry`,
      { method: 'POST' },
    ),
}
