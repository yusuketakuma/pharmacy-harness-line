export type FulfillmentDecision =
  | 'fulfillable'
  | 'conditional'
  | 'needs_confirmation'
  | 'not_fulfillable';

export type FulfillmentRequirementStatus = 'pending' | 'satisfied';

export type FulfillmentStatus =
  | 'CHECKING'
  | 'AVAILABLE'
  | 'PARTIALLY_AVAILABLE'
  | 'UNAVAILABLE'
  | 'PHARMACIST_REVIEW_REQUIRED';

export type FulfillmentMethod =
  | 'PICKUP'
  | 'DELIVERY'
  | 'HOME_VISIT'
  | 'FACILITY_DELIVERY';

export interface FulfillmentRequirement {
  code: string;
  status: FulfillmentRequirementStatus;
}

export interface FulfillmentQuoteInput {
  decision: FulfillmentDecision;
  reasonCodes: string[];
  requirements: FulfillmentRequirement[];
  estimatedReadyAt: string | null;
  validUntil: string | null;
  status?: FulfillmentStatus;
  fulfillmentMethod?: FulfillmentMethod | null;
  constraints?: string[];
  reservationExpiresAt?: string | null;
}

export interface FulfillmentQuote extends FulfillmentQuoteInput {
  id: string;
  submission_id: string;
  line_account_id: string;
  revision: number;
  status: FulfillmentStatus;
  fulfillmentMethod: FulfillmentMethod | null;
  constraints: string[];
  reservationExpiresAt: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  created_by: string;
  created_at: string;
}

const DECISIONS = new Set<FulfillmentDecision>([
  'fulfillable', 'conditional', 'needs_confirmation', 'not_fulfillable',
]);
const REQUIREMENT_STATUSES = new Set<FulfillmentRequirementStatus>(['pending', 'satisfied']);
const CODE_PATTERN = /^[a-z0-9_:-]{1,64}$/;
const FULFILLMENT_STATUSES = new Set<FulfillmentStatus>([
  'CHECKING', 'AVAILABLE', 'PARTIALLY_AVAILABLE', 'UNAVAILABLE', 'PHARMACIST_REVIEW_REQUIRED',
]);
const FULFILLMENT_METHODS = new Set<FulfillmentMethod>([
  'PICKUP', 'DELIVERY', 'HOME_VISIT', 'FACILITY_DELIVERY',
]);

function validOptionalIso(value: string | null): boolean {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function defaultFulfillmentStatus(decision: FulfillmentDecision): FulfillmentStatus {
  if (decision === 'fulfillable') return 'AVAILABLE';
  if (decision === 'conditional') return 'PARTIALLY_AVAILABLE';
  if (decision === 'not_fulfillable') return 'UNAVAILABLE';
  return 'PHARMACIST_REVIEW_REQUIRED';
}

function validateQuote(input: FulfillmentQuoteInput): void {
  if (!DECISIONS.has(input.decision) || !Array.isArray(input.reasonCodes) ||
      input.reasonCodes.length > 32 || input.reasonCodes.some((code) => !CODE_PATTERN.test(code)) ||
      !Array.isArray(input.requirements) || input.requirements.length > 32 ||
      input.requirements.some((requirement) => !requirement ||
        !CODE_PATTERN.test(requirement.code) ||
        !REQUIREMENT_STATUSES.has(requirement.status)) ||
      !validOptionalIso(input.estimatedReadyAt) || !validOptionalIso(input.validUntil) ||
      (input.status !== undefined && !FULFILLMENT_STATUSES.has(input.status)) ||
      (input.fulfillmentMethod !== undefined && input.fulfillmentMethod !== null &&
        !FULFILLMENT_METHODS.has(input.fulfillmentMethod)) ||
      (input.reservationExpiresAt !== undefined && !validOptionalIso(input.reservationExpiresAt ?? null)) ||
      !Array.isArray(input.constraints ?? []) || (input.constraints ?? []).length > 32 ||
      (input.constraints ?? []).some((code) => !CODE_PATTERN.test(code))) {
    throw new Error('invalid fulfillment quote');
  }
  if (input.decision === 'conditional' && input.requirements.length === 0) {
    throw new Error('invalid fulfillment quote');
  }
  const reasonCodes = new Set(input.reasonCodes);
  if (reasonCodes.size !== input.reasonCodes.length) throw new Error('invalid fulfillment quote');
  const requirementsJson = JSON.stringify(input.requirements);
  const reasonCodesJson = JSON.stringify(input.reasonCodes);
  if (reasonCodesJson.length > 4096 || requirementsJson.length > 8192) {
    throw new Error('invalid fulfillment quote');
  }
  if (JSON.stringify(input.constraints ?? []).length > 4096) {
    throw new Error('invalid fulfillment quote');
  }
}

export function quoteAllowsAcceptance(
  quote: (Pick<FulfillmentQuote, 'decision' | 'requirements'> &
    { status?: FulfillmentStatus | null; validUntil?: string | null }) | null,
  at = new Date(),
): boolean {
  if (!quote) return false;
  if (quote.validUntil && (
    !Number.isFinite(Date.parse(quote.validUntil)) || Date.parse(quote.validUntil) <= at.getTime()
  )) return false;
  if (quote.status && !['AVAILABLE', 'PARTIALLY_AVAILABLE'].includes(quote.status)) return false;
  if (quote.decision === 'fulfillable') return true;
  return quote.decision === 'conditional' &&
    quote.requirements.every((requirement) => requirement.status === 'satisfied');
}

function decodeQuoteRow(row: Record<string, unknown>): FulfillmentQuote {
  let reasonCodes: string[];
  let requirements: FulfillmentRequirement[];
  let constraints: string[];
  try {
    reasonCodes = JSON.parse(String(row.reason_codes_json)) as string[];
    requirements = JSON.parse(String(row.requirements_json)) as FulfillmentRequirement[];
    constraints = row.constraints_json == null ? [] : JSON.parse(String(row.constraints_json)) as string[];
  } catch {
    throw new Error('invalid stored fulfillment quote');
  }
  return {
    id: String(row.id),
    submission_id: String(row.submission_id),
    line_account_id: String(row.line_account_id),
    revision: Number(row.revision),
    decision: row.decision as FulfillmentDecision,
    reasonCodes,
    requirements,
    status: (row.status as FulfillmentStatus | null) ?? defaultFulfillmentStatus(row.decision as FulfillmentDecision),
    fulfillmentMethod: (row.fulfillment_method as FulfillmentMethod | null) ?? null,
    constraints,
    reservationExpiresAt: (row.reservation_expires_at as string | null) ?? null,
    confirmedBy: (row.confirmed_by as string | null) ?? null,
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    estimatedReadyAt: (row.estimated_ready_at as string | null) ?? null,
    validUntil: (row.valid_until as string | null) ?? null,
    created_by: String(row.created_by),
    created_at: String(row.created_at),
  };
}

export async function createFulfillmentQuote(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
  staffId: string,
  input: FulfillmentQuoteInput,
): Promise<FulfillmentQuote> {
  const submission = await db.prepare(
    `SELECT s.id, s.status, s.source_handoff_id, h.correlation_id
       FROM pharmacy_prescription_submissions s
       LEFT JOIN pharmacy_myna_handoffs h
         ON h.id = s.source_handoff_id AND h.line_account_id = s.line_account_id
      WHERE s.id = ? AND s.line_account_id = ?`,
  ).bind(submissionId, lineAccountId).first<{
    id: string;
    status: string;
    source_handoff_id?: string | null;
    correlation_id?: string | null;
  }>();
  if (!submission) throw new Error('fulfillment submission not found');
  if (!['received', 'accepted', 'ready'].includes(submission.status)) {
    throw new Error('invalid fulfillment submission state');
  }
  validateQuote(input);
  const now = new Date().toISOString();
  const status = input.status ?? defaultFulfillmentStatus(input.decision);
  const fulfillmentMethod = input.fulfillmentMethod ?? null;
  const constraints = input.constraints ?? [];
  const reservationExpiresAt = input.reservationExpiresAt ?? null;
  const quoteId = crypto.randomUUID();
  const inserted = await db.prepare(
    `INSERT INTO pharmacy_fulfillment_quotes
       (id, submission_id, line_account_id, revision, decision,
        reason_codes_json, requirements_json, status, fulfillment_method,
        constraints_json, reservation_expires_at, estimated_ready_at, valid_until,
        confirmed_by, confirmed_at, created_by, created_at)
     SELECT ?, s.id, s.line_account_id,
            COALESCE((SELECT MAX(revision) FROM pharmacy_fulfillment_quotes
                       WHERE submission_id = s.id AND line_account_id = s.line_account_id), 0) + 1,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM pharmacy_prescription_submissions s
      WHERE s.id = ? AND s.line_account_id = ?
      RETURNING id, submission_id, line_account_id, revision, decision,
                reason_codes_json, requirements_json, status, fulfillment_method,
                constraints_json, reservation_expires_at, estimated_ready_at, valid_until,
                confirmed_by, confirmed_at,
                created_by, created_at`,
  ).bind(
    quoteId,
    input.decision,
    JSON.stringify(input.reasonCodes),
    JSON.stringify(input.requirements),
    status,
    fulfillmentMethod,
    JSON.stringify(constraints),
    reservationExpiresAt,
    input.estimatedReadyAt,
    input.validUntil,
    staffId,
    now,
    staffId,
    now,
    submissionId,
    lineAccountId,
  ).first<Record<string, unknown>>();
  if (!inserted) throw new Error('fulfillment quote conflict');
  const quote = decodeQuoteRow(inserted);
  if (submission.source_handoff_id && submission.correlation_id) {
    await db.prepare(
      `INSERT INTO pharmacy_myna_events
       (id, handoff_id, line_account_id, event_type, actor_type, actor_id,
        correlation_id, metadata_json, occurred_at)
       VALUES (?, ?, ?, 'FULFILLMENT_QUOTE_ISSUED', 'STAFF', ?, ?, '{}', ?)`,
    ).bind(
      crypto.randomUUID(), submission.source_handoff_id, lineAccountId, staffId,
      submission.correlation_id, now,
    ).run();
  }
  return quote;
}

export async function getLatestFulfillmentQuote(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
): Promise<FulfillmentQuote | null> {
  const row = await db.prepare(
    `SELECT id, submission_id, line_account_id, revision, decision,
            reason_codes_json, requirements_json, status, fulfillment_method,
            constraints_json, reservation_expires_at, estimated_ready_at, valid_until,
            confirmed_by, confirmed_at,
            created_by, created_at
       FROM pharmacy_fulfillment_quotes
      WHERE line_account_id = ? AND submission_id = ?
      ORDER BY revision DESC, created_at DESC, id DESC
      LIMIT 1`,
  ).bind(lineAccountId, submissionId).first<Record<string, unknown>>();
  return row ? decodeQuoteRow(row) : null;
}
