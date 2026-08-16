export type FulfillmentDecision =
  | 'fulfillable'
  | 'conditional'
  | 'needs_confirmation'
  | 'not_fulfillable';

export type FulfillmentRequirementStatus = 'pending' | 'satisfied';

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
}

export interface FulfillmentQuote extends FulfillmentQuoteInput {
  id: string;
  submission_id: string;
  line_account_id: string;
  revision: number;
  created_by: string;
  created_at: string;
}

const DECISIONS = new Set<FulfillmentDecision>([
  'fulfillable', 'conditional', 'needs_confirmation', 'not_fulfillable',
]);
const REQUIREMENT_STATUSES = new Set<FulfillmentRequirementStatus>(['pending', 'satisfied']);
const CODE_PATTERN = /^[a-z0-9_:-]{1,64}$/;

function validOptionalIso(value: string | null): boolean {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function validateQuote(input: FulfillmentQuoteInput): void {
  if (!DECISIONS.has(input.decision) || !Array.isArray(input.reasonCodes) ||
      input.reasonCodes.length > 32 || input.reasonCodes.some((code) => !CODE_PATTERN.test(code)) ||
      !Array.isArray(input.requirements) || input.requirements.length > 32 ||
      input.requirements.some((requirement) => !requirement ||
        !CODE_PATTERN.test(requirement.code) ||
        !REQUIREMENT_STATUSES.has(requirement.status)) ||
      !validOptionalIso(input.estimatedReadyAt) || !validOptionalIso(input.validUntil)) {
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
}

export function quoteAllowsAcceptance(
  quote: Pick<FulfillmentQuote, 'decision' | 'requirements'> | null,
): boolean {
  if (!quote) return false;
  if (quote.decision === 'fulfillable') return true;
  return quote.decision === 'conditional' &&
    quote.requirements.every((requirement) => requirement.status === 'satisfied');
}

function decodeQuoteRow(row: Record<string, unknown>): FulfillmentQuote {
  let reasonCodes: string[];
  let requirements: FulfillmentRequirement[];
  try {
    reasonCodes = JSON.parse(String(row.reason_codes_json)) as string[];
    requirements = JSON.parse(String(row.requirements_json)) as FulfillmentRequirement[];
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
    `SELECT id, status
       FROM pharmacy_prescription_submissions
      WHERE id = ? AND line_account_id = ?`,
  ).bind(submissionId, lineAccountId).first<{ id: string; status: string }>();
  if (!submission) throw new Error('fulfillment submission not found');
  if (!['received', 'accepted', 'ready'].includes(submission.status)) {
    throw new Error('invalid fulfillment submission state');
  }
  validateQuote(input);
  const now = new Date().toISOString();
  const inserted = await db.prepare(
    `INSERT INTO pharmacy_fulfillment_quotes
       (id, submission_id, line_account_id, revision, decision,
        reason_codes_json, requirements_json, estimated_ready_at, valid_until,
        created_by, created_at)
     SELECT ?, s.id, s.line_account_id,
            COALESCE((SELECT MAX(revision) FROM pharmacy_fulfillment_quotes
                       WHERE submission_id = s.id AND line_account_id = s.line_account_id), 0) + 1,
            ?, ?, ?, ?, ?, ?, ?
       FROM pharmacy_prescription_submissions s
      WHERE s.id = ? AND s.line_account_id = ?
      RETURNING id, submission_id, line_account_id, revision, decision,
                reason_codes_json, requirements_json, estimated_ready_at, valid_until,
                created_by, created_at`,
  ).bind(
    crypto.randomUUID(),
    input.decision,
    JSON.stringify(input.reasonCodes),
    JSON.stringify(input.requirements),
    input.estimatedReadyAt,
    input.validUntil,
    staffId,
    now,
    submissionId,
    lineAccountId,
  ).first<Record<string, unknown>>();
  if (!inserted) throw new Error('fulfillment quote conflict');
  return decodeQuoteRow(inserted);
}

export async function getLatestFulfillmentQuote(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
): Promise<FulfillmentQuote | null> {
  const row = await db.prepare(
    `SELECT id, submission_id, line_account_id, revision, decision,
            reason_codes_json, requirements_json, estimated_ready_at, valid_until,
            created_by, created_at
       FROM pharmacy_fulfillment_quotes
      WHERE line_account_id = ? AND submission_id = ?
      ORDER BY revision DESC, created_at DESC, id DESC
      LIMIT 1`,
  ).bind(lineAccountId, submissionId).first<Record<string, unknown>>();
  return row ? decodeQuoteRow(row) : null;
}
