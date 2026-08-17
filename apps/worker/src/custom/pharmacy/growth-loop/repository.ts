import {
  PHARMACY_CAPABILITIES,
  parsePharmacyCapabilities,
  type PharmacyCapability,
  type PharmacyCapabilityConfig,
} from './access.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function now(): string {
  return new Date().toISOString();
}

type GrowthEventInput = {
  lineAccountId: string;
  eventType: string;
  aggregateId: string;
  subjectKey?: string | null;
  occurredAt?: string;
  idempotencyKey: string;
  metadata?: Record<string, string | number | boolean | null>;
};

function prepareGrowthEvent(
  db: D1Database,
  input: GrowthEventInput,
  options: {
    ignoreDuplicate: boolean;
    condition?: { sql: string; bindings: unknown[] };
  },
) {
  if (!input.lineAccountId || !input.eventType || !input.aggregateId || !input.idempotencyKey) {
    throw new Error('growth event identity is required');
  }
  const metadata = input.metadata ?? {};
  if (Object.keys(metadata).some((key) => /message|body|drug|disease|patient|line_user|prescription/i.test(key))) {
    throw new Error('growth event metadata rejected');
  }
  const occurredAt = input.occurredAt ?? now();
  const condition = options.condition;
  const verb = options.ignoreDuplicate ? 'INSERT OR IGNORE' : 'INSERT';
  const select = condition ? `SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?, ? WHERE ${condition.sql}` : 'VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)';
  return db.prepare(
    `${verb} INTO pharmacy_growth_events
      (id, line_account_id, event_type, aggregate_id, subject_key,
       schema_version, occurred_at, idempotency_key, metadata_json, created_at)
     ${select}`,
  ).bind(
    crypto.randomUUID(), input.lineAccountId, input.eventType, input.aggregateId,
    input.subjectKey ?? null, occurredAt, input.idempotencyKey, JSON.stringify(metadata), now(),
    ...(condition?.bindings ?? []),
  );
}

async function runAuditedMutation(
  db: D1Database,
  mutation: D1PreparedStatement,
  event: GrowthEventInput,
  condition: { sql: string; bindings: unknown[] },
): Promise<boolean> {
  const audit = prepareGrowthEvent(db, event, {
    ignoreDuplicate: false,
    condition,
  });
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta?.changes ?? 0) === 1 && (results[1]?.meta?.changes ?? 0) === 1;
}

function defaultPrescriptionValidUntil(issuedOn: string | null, validityBasis: 'default_4_days' | 'prescriber_specified'): string | null {
  if (!issuedOn || validityBasis !== 'default_4_days') return null;
  const date = new Date(`${issuedOn}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 3);
  return date.toISOString().slice(0, 10);
}

function prescriptionReminderDueAt(validUntil: string | null): string | null {
  if (!validUntil) return null;
  const date = new Date(`${validUntil}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  // 00:00 UTC is 09:00 Asia/Tokyo, outside the initial quiet-hours window.
  return date.toISOString();
}

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export async function getPharmacyCapabilityConfig(
  db: D1Database,
  lineAccountId: string,
): Promise<PharmacyCapabilityConfig | null> {
  const row = await db.prepare(
    `SELECT line_account_id, mode, capabilities_json, proactive_monthly_limit,
            unfollow_alert_state, created_at, updated_at
       FROM pharmacy_account_capabilities
      WHERE line_account_id = ?`,
  ).bind(lineAccountId).first<{
    line_account_id: string;
    mode: 'pharmacy';
    capabilities_json: string;
    proactive_monthly_limit: number;
    unfollow_alert_state: 'alert_only' | 'auto_pause';
    created_at: string;
    updated_at: string;
  }>();
  if (!row) return null;
  return {
    line_account_id: row.line_account_id,
    mode: row.mode,
    capabilities: parsePharmacyCapabilities(row.capabilities_json),
    proactive_monthly_limit: row.proactive_monthly_limit,
    unfollow_alert_state: row.unfollow_alert_state,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function savePharmacyCapabilityConfig(
  db: D1Database,
  lineAccountId: string,
  capabilities: readonly string[],
  proactiveMonthlyLimit: number,
  unfollowAlertState: 'alert_only' | 'auto_pause',
  actorId: string,
): Promise<PharmacyCapabilityConfig> {
  const allowed = capabilities.filter((value): value is PharmacyCapability =>
    (PHARMACY_CAPABILITIES as readonly string[]).includes(value),
  );
  const unique = [...new Set(allowed)];
  if (!unique.length) throw new Error('at least one pharmacy capability is required');
  if (!Number.isInteger(proactiveMonthlyLimit) || proactiveMonthlyLimit < 0 || proactiveMonthlyLimit > 100) {
    throw new Error('invalid proactive monthly limit');
  }
  const timestamp = now();
  const mutation = db.prepare(
    `INSERT INTO pharmacy_account_capabilities
      (line_account_id, mode, capabilities_json, proactive_monthly_limit,
       unfollow_alert_state, created_at, updated_at)
     VALUES (?, 'pharmacy', ?, ?, ?, ?, ?)
     ON CONFLICT(line_account_id) DO UPDATE SET
       capabilities_json = excluded.capabilities_json,
       proactive_monthly_limit = excluded.proactive_monthly_limit,
       unfollow_alert_state = excluded.unfollow_alert_state,
       updated_at = excluded.updated_at`,
  ).bind(lineAccountId, JSON.stringify(unique), proactiveMonthlyLimit, unfollowAlertState, timestamp, timestamp);
  const changed = await runAuditedMutation(db, mutation, {
    lineAccountId,
    eventType: 'capability_config_updated',
    aggregateId: lineAccountId,
    occurredAt: timestamp,
    idempotencyKey: `audit:${crypto.randomUUID()}`,
    metadata: { actor_id: actorId },
  }, {
    sql: `EXISTS (SELECT 1 FROM pharmacy_account_capabilities
                  WHERE line_account_id = ? AND updated_at = ?)`,
    bindings: [lineAccountId, timestamp],
  });
  if (!changed) throw new Error('pharmacy capability config was not saved');
  const saved = await getPharmacyCapabilityConfig(db, lineAccountId);
  if (!saved) throw new Error('pharmacy capability config was not saved');
  return saved;
}

export async function recordGrowthEvent(
  db: D1Database,
  input: GrowthEventInput,
): Promise<boolean> {
  const result = await prepareGrowthEvent(db, input, { ignoreDuplicate: true }).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function createMedicalSource(
  db: D1Database,
  input: { lineAccountId: string; displayName: string; classification: 'primary' | 'other'; staffId: string },
): Promise<{ id: string; display_name: string; classification: 'primary' | 'other' }> {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 120) throw new Error('invalid medical source name');
  const id = crypto.randomUUID();
  const timestamp = now();
  const mutation = db.prepare(
    `INSERT INTO pharmacy_medical_sources
      (id, line_account_id, display_name, classification, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, input.lineAccountId, displayName, input.classification, input.staffId, timestamp, timestamp);
  const changed = await runAuditedMutation(db, mutation, {
    lineAccountId: input.lineAccountId,
    eventType: 'medical_source_created',
    aggregateId: id,
    occurredAt: timestamp,
    idempotencyKey: `audit:${crypto.randomUUID()}`,
    metadata: { actor_id: input.staffId },
  }, {
    sql: `EXISTS (SELECT 1 FROM pharmacy_medical_sources
                  WHERE id = ? AND line_account_id = ? AND updated_at = ?)`,
    bindings: [id, input.lineAccountId, timestamp],
  });
  if (!changed) throw new Error('medical source was not created');
  return { id, display_name: displayName, classification: input.classification };
}

export async function setMedicalSourceActive(
  db: D1Database,
  lineAccountId: string,
  sourceId: string,
  isActive: boolean,
  actorId: string,
): Promise<void> {
  const timestamp = now();
  const mutation = db.prepare(
    `UPDATE pharmacy_medical_sources SET is_active = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ?`,
  ).bind(isActive ? 1 : 0, timestamp, sourceId, lineAccountId);
  const changed = await runAuditedMutation(db, mutation, {
    lineAccountId,
    eventType: 'medical_source_updated',
    aggregateId: sourceId,
    occurredAt: timestamp,
    idempotencyKey: `audit:${crypto.randomUUID()}`,
    metadata: { actor_id: actorId },
  }, {
    sql: `EXISTS (SELECT 1 FROM pharmacy_medical_sources
                  WHERE id = ? AND line_account_id = ? AND updated_at = ?)`,
    bindings: [sourceId, lineAccountId, timestamp],
  });
  if (!changed) throw new Error('medical source not found');
}

export async function classifySubmissionSource(
  db: D1Database,
  input: { lineAccountId: string; submissionId: string; sourceId: string | null; classification: 'primary' | 'other' | 'unknown'; staffId: string },
): Promise<void> {
  if (input.classification !== 'unknown' && !input.sourceId) throw new Error('source is required');
  if (input.classification === 'unknown' && input.sourceId) throw new Error('unknown source must not reference a source id');
  if (input.sourceId) {
    const source = await db.prepare(
      `SELECT id, classification FROM pharmacy_medical_sources
        WHERE id = ? AND line_account_id = ? AND is_active = 1`,
    ).bind(input.sourceId, input.lineAccountId).first<{ id: string; classification: 'primary' | 'other' }>();
    if (!source) throw new Error('medical source not found');
    if (source.classification !== input.classification) throw new Error('medical source classification mismatch');
  }
  const timestamp = now();
  const mutation = db.prepare(
    `INSERT INTO pharmacy_submission_sources
      (submission_id, line_account_id, source_id, classification, entered_by, entered_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM pharmacy_prescription_submissions
         WHERE id = ? AND line_account_id = ?
      )
     ON CONFLICT(submission_id) DO UPDATE SET
       source_id = excluded.source_id,
       classification = excluded.classification,
       entered_by = excluded.entered_by,
       updated_at = excluded.updated_at`,
  ).bind(
    input.submissionId, input.lineAccountId, input.sourceId, input.classification,
    input.staffId, timestamp, timestamp, input.submissionId, input.lineAccountId,
  );
  const changed = await runAuditedMutation(db, mutation, {
    lineAccountId: input.lineAccountId,
    eventType: 'submission_source_classified',
    aggregateId: input.submissionId,
    occurredAt: timestamp,
    idempotencyKey: `audit:${crypto.randomUUID()}`,
    metadata: { actor_id: input.staffId },
  }, {
    sql: `EXISTS (SELECT 1 FROM pharmacy_submission_sources
                  WHERE submission_id = ? AND line_account_id = ? AND updated_at = ?)`,
    bindings: [input.submissionId, input.lineAccountId, timestamp],
  });
  if (!changed) throw new Error('prescription submission not found');
}

export async function savePrescriptionValidity(
  db: D1Database,
  input: {
    lineAccountId: string;
    submissionId: string;
    issuedOn: string | null;
    validUntil: string | null;
    validityBasis: 'default_4_days' | 'prescriber_specified';
    verificationStatus: 'unverified' | 'verified' | 'expired_review_required' | 'expired_confirmed';
    staffId: string | null;
  },
): Promise<void> {
  if (input.issuedOn && !isCalendarDate(input.issuedOn)) throw new Error('invalid issued date');
  if (input.validUntil && !isCalendarDate(input.validUntil)) throw new Error('invalid valid-until date');
  const defaultValidUntil = defaultPrescriptionValidUntil(input.issuedOn, input.validityBasis);
  if (input.validityBasis === 'default_4_days' && input.validUntil && input.validUntil !== defaultValidUntil) {
    throw new Error('default four-day validity cannot be overridden');
  }
  const validUntil = input.validityBasis === 'default_4_days' ? defaultValidUntil : input.validUntil;
  if (input.issuedOn && validUntil && validUntil < input.issuedOn) throw new Error('valid-until precedes issue date');
  if (input.verificationStatus !== 'unverified' && !input.staffId) throw new Error('staff verification is required');
  if (input.verificationStatus !== 'unverified' && (!input.issuedOn || !validUntil)) {
    throw new Error('verified dates are required');
  }
  const timestamp = now();
  const verifiedAt = input.verificationStatus === 'unverified' ? null : timestamp;
  const reminderDueAt = input.verificationStatus === 'verified'
    ? prescriptionReminderDueAt(validUntil)
    : null;
  const mutation = db.prepare(
    `INSERT INTO pharmacy_prescription_validities
      (submission_id, line_account_id, issued_on, valid_until, validity_basis,
       verification_status, verified_by, verified_at, reminder_due_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM pharmacy_prescription_submissions WHERE id = ? AND line_account_id = ?)
     ON CONFLICT(submission_id) DO UPDATE SET
       issued_on = excluded.issued_on, valid_until = excluded.valid_until,
       validity_basis = excluded.validity_basis, verification_status = excluded.verification_status,
       verified_by = excluded.verified_by, verified_at = excluded.verified_at,
       reminder_due_at = excluded.reminder_due_at,
       reminder_claimed_at = CASE
         WHEN pharmacy_prescription_validities.issued_on IS excluded.issued_on
          AND pharmacy_prescription_validities.valid_until IS excluded.valid_until
          AND pharmacy_prescription_validities.validity_basis = excluded.validity_basis
          AND pharmacy_prescription_validities.verification_status = excluded.verification_status
         THEN pharmacy_prescription_validities.reminder_claimed_at ELSE NULL END,
       reminder_sent_at = CASE
         WHEN pharmacy_prescription_validities.issued_on IS excluded.issued_on
          AND pharmacy_prescription_validities.valid_until IS excluded.valid_until
          AND pharmacy_prescription_validities.validity_basis = excluded.validity_basis
          AND pharmacy_prescription_validities.verification_status = excluded.verification_status
         THEN pharmacy_prescription_validities.reminder_sent_at ELSE NULL END,
       updated_at = excluded.updated_at`,
  ).bind(
    input.submissionId, input.lineAccountId, input.issuedOn, validUntil, input.validityBasis,
    input.verificationStatus, input.staffId, verifiedAt, reminderDueAt,
    timestamp, timestamp, input.submissionId, input.lineAccountId,
  );
  const changed = await runAuditedMutation(db, mutation, {
    lineAccountId: input.lineAccountId,
    eventType: 'prescription_validity_updated',
    aggregateId: input.submissionId,
    occurredAt: timestamp,
    idempotencyKey: `audit:${crypto.randomUUID()}`,
    metadata: { actor_id: input.staffId },
  }, {
    sql: `EXISTS (SELECT 1 FROM pharmacy_prescription_validities
                  WHERE submission_id = ? AND line_account_id = ? AND updated_at = ?)`,
    bindings: [input.submissionId, input.lineAccountId, timestamp],
  });
  if (!changed) throw new Error('prescription submission not found');
}

export async function markPrescriptionValidityExpiredReview(
  db: D1Database,
  input: {
    lineAccountId: string;
    submissionId: string;
    localDate: string;
    actorId: string;
    at?: Date;
  },
): Promise<boolean> {
  if (!isCalendarDate(input.localDate)) throw new Error('invalid local date');
  const timestamp = (input.at ?? new Date()).toISOString();
  const mutation = db.prepare(
    `UPDATE pharmacy_prescription_validities
        SET verification_status = 'expired_review_required',
            reminder_claimed_at = NULL, updated_at = ?
      WHERE submission_id = ? AND line_account_id = ?
        AND verification_status = 'verified' AND valid_until IS NOT NULL AND valid_until < ?
        AND EXISTS (
          SELECT 1 FROM pharmacy_prescription_submissions s
           WHERE s.id = pharmacy_prescription_validities.submission_id
             AND s.line_account_id = pharmacy_prescription_validities.line_account_id
             AND s.status NOT IN ('closed','cancelled')
        )`,
  ).bind(timestamp, input.submissionId, input.lineAccountId, input.localDate);
  return runAuditedMutation(db, mutation, {
    lineAccountId: input.lineAccountId,
    eventType: 'prescription_validity_updated',
    aggregateId: input.submissionId,
    occurredAt: timestamp,
    idempotencyKey: `audit:${crypto.randomUUID()}`,
    metadata: { actor_id: input.actorId },
  }, {
    sql: `EXISTS (SELECT 1 FROM pharmacy_prescription_validities
                  WHERE submission_id = ? AND line_account_id = ?
                    AND verification_status = 'expired_review_required' AND updated_at = ?)`,
    bindings: [input.submissionId, input.lineAccountId, timestamp],
  });
}

export interface GrowthPromiseRow {
  submission_id: string;
  revision: number;
  estimated_ready_at: string;
  quote_created_at: string;
  ready_at: string | null;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function summarizePromiseMetrics(rows: GrowthPromiseRow[], graceMinutes = 0): {
  promised: number;
  onTime: number;
  late: number;
  onTimeRate: number | null;
  p50LatenessMinutes: number | null;
  p90LatenessMinutes: number | null;
  promiseRevisionCount: number;
  promiseWithoutReady: number;
} {
  const bySubmission = new Map<string, GrowthPromiseRow[]>();
  for (const row of rows) {
    const list = bySubmission.get(row.submission_id) ?? [];
    list.push(row);
    bySubmission.set(row.submission_id, list);
  }
  let promised = 0;
  let onTime = 0;
  let late = 0;
  let promiseRevisionCount = 0;
  let promiseWithoutReady = 0;
  const lateness: number[] = [];
  for (const candidates of bySubmission.values()) {
    const readyAt = candidates.find((row) => row.ready_at)?.ready_at ?? null;
    const eligible = readyAt
      ? candidates.filter((row) => row.quote_created_at <= readyAt)
      : candidates;
    if (!eligible.length) continue;
    const quote = [...eligible].sort((a, b) => b.revision - a.revision || b.quote_created_at.localeCompare(a.quote_created_at))[0];
    promiseRevisionCount += eligible.length;
    if (!readyAt) {
      promiseWithoutReady++;
      continue;
    }
    promised++;
    const deltaMinutes = (Date.parse(readyAt) - Date.parse(quote.estimated_ready_at)) / 60000;
    if (deltaMinutes <= graceMinutes) onTime++;
    else {
      late++;
      lateness.push(deltaMinutes);
    }
  }
  return {
    promised,
    onTime,
    late,
    onTimeRate: promised ? onTime / promised : null,
    p50LatenessMinutes: percentile(lateness, 0.5),
    p90LatenessMinutes: percentile(lateness, 0.9),
    promiseRevisionCount,
    promiseWithoutReady,
  };
}

export type GrowthEventRow = { event_type: string; subject_key: string | null; occurred_at: string };

export function summarizeCohorts(
  rows: GrowthEventRow[],
  from: string,
  to: string,
  observedThrough: string,
) {
  const follows = new Map<string, string>();
  const firstFriendSubmissions = new Map<string, string>();
  const firstSubmissions = new Map<string, string>();
  const secondSubmissions = new Map<string, string>();
  const inCohort = (occurredAt: string) => occurredAt >= from && occurredAt < to;
  const rememberFirst = (target: Map<string, string>, key: string, value: string) => {
    const current = target.get(key);
    if (!current || value < current) target.set(key, value);
  };
  for (const row of rows) {
    if (!row.subject_key) continue;
    if (row.event_type === 'first_follow' && inCohort(row.occurred_at)) rememberFirst(follows, row.subject_key, row.occurred_at);
    if (row.event_type === 'first_friend_submission') rememberFirst(firstFriendSubmissions, row.subject_key, row.occurred_at);
    if (row.event_type === 'first_submission' && inCohort(row.occurred_at)) rememberFirst(firstSubmissions, row.subject_key, row.occurred_at);
    if (row.event_type === 'second_submission') rememberFirst(secondSubmissions, row.subject_key, row.occurred_at);
  }
  const followCohort = [...follows.entries()].filter(([, occurredAt]) => {
    const followAt = Date.parse(occurredAt);
    return followAt + 30 * 86400000 <= Date.parse(observedThrough);
  });
  const firstSubmissionNumerator = followCohort.filter(([subject, occurredAt]) => {
    const submittedAt = firstFriendSubmissions.get(subject);
    return !!submittedAt && Date.parse(submittedAt) >= Date.parse(occurredAt) && Date.parse(submittedAt) <= Date.parse(occurredAt) + 30 * 86400000;
  }).length;
  const firstSubmissionCohort = [...firstSubmissions.entries()].filter(([, occurredAt]) =>
    Date.parse(occurredAt) + 90 * 86400000 <= Date.parse(observedThrough));
  const secondSubmissionNumerator = firstSubmissionCohort.filter(([subject, occurredAt]) => {
    const submittedAt = secondSubmissions.get(subject);
    return !!submittedAt && Date.parse(submittedAt) >= Date.parse(occurredAt) && Date.parse(submittedAt) <= Date.parse(occurredAt) + 90 * 86400000;
  }).length;
  return {
    measurableFollows: followCohort.length,
    firstSubmissionRate: {
      numerator: firstSubmissionNumerator,
      denominator: followCohort.length,
      matureCohort: followCohort.length,
      immatureCohort: follows.size - followCohort.length,
    },
    secondSubmissionRate: {
      numerator: secondSubmissionNumerator,
      denominator: firstSubmissionCohort.length,
      matureCohort: firstSubmissionCohort.length,
      immatureCohort: firstSubmissions.size - firstSubmissionCohort.length,
    },
  };
}

export async function getGrowthDashboard(
  db: D1Database,
  lineAccountId: string,
  from: string,
  to: string,
  observedThrough = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  const bounds = [from, to];
  const eventObservationEnd = new Date(Math.min(
    Date.parse(observedThrough),
    Date.parse(to) + 90 * 86400000,
  )).toISOString();
  const [entryEvents, sourceRows, promiseRows, readyCount, validity, notifications, unfollows, config] = await Promise.all([
    db.prepare(`SELECT event_type, subject_key, occurred_at
      FROM pharmacy_growth_events
      WHERE line_account_id = ? AND occurred_at >= ? AND occurred_at < ?
        AND event_type IN ('first_follow','first_friend_submission','first_submission','second_submission')`)
      .bind(lineAccountId, from, eventObservationEnd).all<GrowthEventRow>(),
    db.prepare(`SELECT COALESCE(ss.classification, 'unknown') AS classification, COUNT(DISTINCT s.id) AS count
      FROM pharmacy_prescription_submissions s
      INNER JOIN pharmacy_prescription_events accepted
        ON accepted.submission_id = s.id AND accepted.event_type = 'status_changed'
       AND accepted.to_status = 'accepted'
      LEFT JOIN pharmacy_submission_sources ss
        ON ss.submission_id = s.id AND ss.line_account_id = s.line_account_id
      LEFT JOIN pharmacy_submission_attributes attr
        ON attr.submission_id = s.id AND attr.line_account_id = s.line_account_id
      WHERE s.line_account_id = ? AND accepted.created_at >= ? AND accepted.created_at < ?
        AND COALESCE(attr.is_synthetic, 0) = 0
      GROUP BY COALESCE(ss.classification, 'unknown')`).bind(lineAccountId, ...bounds).all<{ classification: string; count: number }>(),
    db.prepare(`WITH first_ready AS (
      SELECT s.id AS submission_id, MIN(ready.created_at) AS ready_at
        FROM pharmacy_prescription_submissions s
        INNER JOIN pharmacy_prescription_events ready
          ON ready.submission_id = s.id AND ready.event_type = 'status_changed'
         AND ready.to_status = 'ready'
        LEFT JOIN pharmacy_submission_attributes attr
          ON attr.submission_id = s.id AND attr.line_account_id = s.line_account_id
       WHERE s.line_account_id = ? AND ready.created_at >= ? AND ready.created_at < ?
         AND s.status <> 'cancelled' AND COALESCE(attr.is_synthetic, 0) = 0
       GROUP BY s.id
    )
    SELECT q.submission_id, q.revision, q.estimated_ready_at,
           q.created_at AS quote_created_at, first_ready.ready_at
      FROM pharmacy_fulfillment_quotes q
      INNER JOIN first_ready ON first_ready.submission_id = q.submission_id
     WHERE q.line_account_id = ? AND q.estimated_ready_at IS NOT NULL
       AND q.created_at <= first_ready.ready_at
       AND q.decision IN ('fulfillable','conditional')
       AND (q.status IS NULL OR q.status IN ('AVAILABLE','PARTIALLY_AVAILABLE'))
       AND (q.valid_until IS NULL OR q.valid_until > first_ready.ready_at)
       AND (q.decision = 'fulfillable' OR NOT EXISTS (
         SELECT 1 FROM json_each(q.requirements_json)
          WHERE json_extract(value, '$.status') <> 'satisfied'
       ))`)
      .bind(lineAccountId, ...bounds, lineAccountId).all<GrowthPromiseRow>(),
    db.prepare(`SELECT COUNT(DISTINCT e.submission_id) AS count
                  FROM pharmacy_prescription_events e
                  INNER JOIN pharmacy_prescription_submissions s ON s.id = e.submission_id AND s.line_account_id = ?
                  LEFT JOIN pharmacy_submission_attributes attr
                    ON attr.submission_id = s.id AND attr.line_account_id = s.line_account_id
                 WHERE e.event_type = 'status_changed' AND e.to_status = 'ready'
                   AND e.created_at >= ? AND e.created_at < ?
                   AND s.status <> 'cancelled' AND COALESCE(attr.is_synthetic, 0) = 0`)
      .bind(lineAccountId, ...bounds).first<{ count: number }>(),
    db.prepare(`SELECT
      SUM(CASE WHEN v.verification_status = 'verified' THEN 1 ELSE 0 END) AS verified_validity,
      SUM(CASE WHEN v.reminder_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS reminder_sent,
      SUM(CASE WHEN v.verification_status = 'expired_review_required' THEN 1 ELSE 0 END) AS expired_review_required,
      SUM(CASE WHEN v.verification_status = 'expired_confirmed' THEN 1 ELSE 0 END) AS confirmed_expired,
      SUM(CASE WHEN v.reminder_sent_at IS NOT NULL AND s.closed_at IS NOT NULL
                 AND substr(s.closed_at, 1, 10) <= v.valid_until THEN 1 ELSE 0 END) AS reminder_closed_in_time
      FROM pharmacy_prescription_validities v
      INNER JOIN pharmacy_prescription_submissions s
        ON s.id = v.submission_id AND s.line_account_id = v.line_account_id
      LEFT JOIN pharmacy_submission_attributes attr
        ON attr.submission_id = s.id AND attr.line_account_id = s.line_account_id
      WHERE v.line_account_id = ? AND v.created_at >= ? AND v.created_at < ?
        AND COALESCE(attr.is_synthetic, 0) = 0`)
      .bind(lineAccountId, ...bounds).first<Record<string, number | null>>(),
    db.prepare(`SELECT category, outcome, COUNT(*) AS count
      FROM pharmacy_notification_events WHERE line_account_id = ? AND occurred_at >= ? AND occurred_at < ?
      GROUP BY category, outcome`).bind(lineAccountId, ...bounds).all<{ category: string; outcome: string; count: number }>(),
    db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN n.outcome = 'sent' AND n.friend_id IS NOT NULL THEN n.friend_id END) AS exposed_friends,
      COUNT(DISTINCT CASE WHEN n.outcome = 'sent' AND julianday(u.occurred_at) < julianday(n.occurred_at, '+24 hours') THEN u.subject_key END) AS unfollow_24h,
      COUNT(DISTINCT CASE WHEN n.outcome = 'sent' AND julianday(u.occurred_at) < julianday(n.occurred_at, '+72 hours') THEN u.subject_key END) AS unfollow_72h
      FROM pharmacy_notification_events n
      LEFT JOIN pharmacy_growth_events u
        ON u.line_account_id = n.line_account_id AND u.event_type = 'unfollow'
       AND u.subject_key = 'friend:' || n.friend_id AND u.occurred_at >= n.occurred_at
       AND julianday(u.occurred_at) < julianday(n.occurred_at, '+72 hours')
      WHERE n.line_account_id = ? AND n.outcome = 'sent'
        AND n.occurred_at >= ? AND n.occurred_at < ?
        AND julianday(n.occurred_at, '+72 hours') <= julianday(?)`)
      .bind(lineAccountId, ...bounds, observedThrough).first<{ exposed_friends: number | null; unfollow_24h: number | null; unfollow_72h: number | null }>(),
    db.prepare(`SELECT unfollow_alert_state FROM pharmacy_account_capabilities
      WHERE line_account_id = ? AND mode = 'pharmacy'`)
      .bind(lineAccountId).first<{ unfollow_alert_state: 'alert_only' | 'auto_pause' }>(),
  ]);
  const events = entryEvents.results ?? [];
  const cohort = summarizeCohorts(events, from, to, observedThrough);
  const firstTimeFollows = events.filter((row) => row.event_type === 'first_follow' && row.occurred_at >= from && row.occurred_at < to).length;
  const firstSubmissions = events.filter((row) => row.event_type === 'first_submission' && row.occurred_at >= from && row.occurred_at < to).length;
  const secondSubmissions = events.filter((row) => row.event_type === 'second_submission' && row.occurred_at >= from && row.occurred_at < to).length;
  const sourceCounts = Object.fromEntries((sourceRows.results ?? []).map((row) => [row.classification, row.count]));
  const promise = summarizePromiseMetrics(promiseRows.results ?? [], 0);
  const notificationCounts = Object.fromEntries((notifications.results ?? []).map((row) => [`${row.category}:${row.outcome}`, row.count]));
  const primary = sourceCounts.primary ?? 0;
  const other = sourceCounts.other ?? 0;
  const sourceKnown = primary + other;
  const unknown = sourceCounts.unknown ?? 0;
  const sourceTotal = sourceKnown + unknown;
  return {
    from, to,
    entry: {
      firstTimeFollows,
      measurableFollows: cohort.measurableFollows,
      firstSubmissions,
      secondSubmissions,
      firstSubmissionRate: cohort.firstSubmissionRate,
      secondSubmissionRate: cohort.secondSubmissionRate,
    },
    sources: {
      primary,
      other,
      unknown,
      otherShare: sourceKnown ? other / sourceKnown : null,
      knownDenominator: sourceKnown,
      attributionCoverage: sourceTotal ? sourceKnown / sourceTotal : null,
    },
    promises: { ...promise, readyEvents: readyCount?.count ?? 0, promiseWithoutQuote: Math.max(0, (readyCount?.count ?? 0) - promise.promised), graceMinutes: 0 },
    validity: {
      verified: validity?.verified_validity ?? 0,
      reminderSent: validity?.reminder_sent ?? 0,
      reminderClosedInTime: validity?.reminder_closed_in_time ?? 0,
      expiredReviewRequired: validity?.expired_review_required ?? 0,
      confirmedExpired: validity?.confirmed_expired ?? 0,
    },
    notifications: {
      counts: notificationCounts,
      proactiveCapBlocked: notificationCounts['proactive_noncare:blocked'] ?? 0,
      attempted: Object.values(notificationCounts).reduce((sum, count) => sum + count, 0),
      proactiveAttempts: Object.entries(notificationCounts)
        .filter(([key]) => key.startsWith('proactive_noncare:'))
        .reduce((sum, [, count]) => sum + count, 0),
      alertState: config?.unfollow_alert_state ?? 'alert_only',
    },
    unfollow: {
      exposedFriends: unfollows?.exposed_friends ?? 0,
      within24h: unfollows?.unfollow_24h ?? 0,
      within72h: unfollows?.unfollow_72h ?? 0,
      sampleSize: unfollows?.exposed_friends ?? 0,
      interpretation: '推定される時間的関連（メッセージが原因とは断定しません）',
    },
  };
}
