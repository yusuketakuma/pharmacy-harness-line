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

function defaultPrescriptionValidUntil(issuedOn: string | null, validityBasis: 'default_4_days' | 'prescriber_specified'): string | null {
  if (!issuedOn || validityBasis !== 'default_4_days') return null;
  const date = new Date(`${issuedOn}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 3);
  return date.toISOString().slice(0, 10);
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
  await db.prepare(
    `INSERT INTO pharmacy_account_capabilities
      (line_account_id, mode, capabilities_json, proactive_monthly_limit,
       unfollow_alert_state, created_at, updated_at)
     VALUES (?, 'pharmacy', ?, ?, ?, ?, ?)
     ON CONFLICT(line_account_id) DO UPDATE SET
       capabilities_json = excluded.capabilities_json,
       proactive_monthly_limit = excluded.proactive_monthly_limit,
       unfollow_alert_state = excluded.unfollow_alert_state,
       updated_at = excluded.updated_at`,
  ).bind(lineAccountId, JSON.stringify(unique), proactiveMonthlyLimit, unfollowAlertState, timestamp, timestamp).run();
  const saved = await getPharmacyCapabilityConfig(db, lineAccountId);
  if (!saved) throw new Error('pharmacy capability config was not saved');
  return saved;
}

export async function recordGrowthEvent(
  db: D1Database,
  input: {
    lineAccountId: string;
    eventType: string;
    aggregateId: string;
    subjectKey?: string | null;
    occurredAt?: string;
    idempotencyKey: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
): Promise<boolean> {
  if (!input.lineAccountId || !input.eventType || !input.aggregateId || !input.idempotencyKey) {
    throw new Error('growth event identity is required');
  }
  const metadata = input.metadata ?? {};
  if (Object.keys(metadata).some((key) => /message|body|drug|disease|patient|line_user|prescription/i.test(key))) {
    throw new Error('growth event metadata rejected');
  }
  const timestamp = input.occurredAt ?? now();
  const result = await db.prepare(
    `INSERT OR IGNORE INTO pharmacy_growth_events
      (id, line_account_id, event_type, aggregate_id, subject_key,
       schema_version, occurred_at, idempotency_key, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.lineAccountId, input.eventType, input.aggregateId,
    input.subjectKey ?? null, timestamp, input.idempotencyKey, JSON.stringify(metadata), now(),
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function createMedicalSource(
  db: D1Database,
  input: { lineAccountId: string; displayName: string; classification: 'primary' | 'other'; staffId: string },
): Promise<{ id: string; display_name: string; classification: 'primary' | 'other' }> {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 120) throw new Error('invalid medical source name');
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO pharmacy_medical_sources
      (id, line_account_id, display_name, classification, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, input.lineAccountId, displayName, input.classification, input.staffId, now(), now()).run();
  return { id, display_name: displayName, classification: input.classification };
}

export async function classifySubmissionSource(
  db: D1Database,
  input: { lineAccountId: string; submissionId: string; sourceId: string | null; classification: 'primary' | 'other' | 'unknown'; staffId: string },
): Promise<void> {
  if (input.classification !== 'unknown' && !input.sourceId) throw new Error('source is required');
  if (input.sourceId) {
    const source = await db.prepare(
      `SELECT id FROM pharmacy_medical_sources
        WHERE id = ? AND line_account_id = ? AND is_active = 1`,
    ).bind(input.sourceId, input.lineAccountId).first<{ id: string }>();
    if (!source) throw new Error('medical source not found');
  }
  const timestamp = now();
  const result = await db.prepare(
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
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('prescription submission not found');
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
  const validUntil = input.validUntil ?? defaultPrescriptionValidUntil(input.issuedOn, input.validityBasis);
  if (input.issuedOn && validUntil && validUntil < input.issuedOn) throw new Error('valid-until precedes issue date');
  if (input.verificationStatus !== 'unverified' && !input.staffId) throw new Error('staff verification is required');
  const timestamp = now();
  const result = await db.prepare(
    `INSERT INTO pharmacy_prescription_validities
      (submission_id, line_account_id, issued_on, valid_until, validity_basis,
       verification_status, verified_by, verified_at, reminder_due_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'unverified' THEN NULL ELSE ? END,
            CASE WHEN ? IS NULL THEN NULL ELSE datetime(?, '-1 day') END, ?, ?
      WHERE EXISTS (SELECT 1 FROM pharmacy_prescription_submissions WHERE id = ? AND line_account_id = ?)
     ON CONFLICT(submission_id) DO UPDATE SET
       issued_on = excluded.issued_on, valid_until = excluded.valid_until,
       validity_basis = excluded.validity_basis, verification_status = excluded.verification_status,
       verified_by = excluded.verified_by, verified_at = excluded.verified_at,
       reminder_due_at = excluded.reminder_due_at, updated_at = excluded.updated_at`,
  ).bind(
    input.submissionId, input.lineAccountId, input.issuedOn, validUntil, input.validityBasis,
    input.verificationStatus, input.staffId, input.verificationStatus, timestamp,
    validUntil, validUntil, timestamp, timestamp, input.submissionId, input.lineAccountId,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('prescription submission not found');
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
    promiseRevisionCount++;
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

type GrowthEventRow = { event_type: string; subject_key: string | null; occurred_at: string };

function summarizeCohorts(rows: GrowthEventRow[], from: string, to: string) {
  const follows = new Map<string, string>();
  const firstSubmissions = new Map<string, string>();
  const secondSubmissions = new Map<string, string>();
  for (const row of rows) {
    if (!row.subject_key) continue;
    if (row.event_type === 'first_follow' && row.occurred_at >= from && row.occurred_at < to) follows.set(row.subject_key, row.occurred_at);
    if (row.event_type === 'first_submission') firstSubmissions.set(row.subject_key, row.occurred_at);
    if (row.event_type === 'second_submission') secondSubmissions.set(row.subject_key, row.occurred_at);
  }
  const followCohort = [...follows.entries()].filter(([, occurredAt]) => {
    const followAt = Date.parse(occurredAt);
    return followAt + 30 * 86400000 <= Date.parse(to);
  });
  const firstSubmissionNumerator = followCohort.filter(([subject, occurredAt]) => {
    const submittedAt = firstSubmissions.get(subject);
    return !!submittedAt && Date.parse(submittedAt) >= Date.parse(occurredAt) && Date.parse(submittedAt) <= Date.parse(occurredAt) + 30 * 86400000;
  }).length;
  const firstSubmissionCohort = [...firstSubmissions.entries()].filter(([, occurredAt]) =>
    Date.parse(occurredAt) + 90 * 86400000 <= Date.parse(to));
  const secondSubmissionNumerator = firstSubmissionCohort.filter(([subject, occurredAt]) => {
    const submittedAt = secondSubmissions.get(subject);
    return !!submittedAt && Date.parse(submittedAt) >= Date.parse(occurredAt) && Date.parse(submittedAt) <= Date.parse(occurredAt) + 90 * 86400000;
  }).length;
  return {
    measurableFollows: follows.size,
    firstSubmissionRate: { numerator: firstSubmissionNumerator, denominator: followCohort.length, matureCohort: followCohort.length ? followCohort.length : 0 },
    secondSubmissionRate: { numerator: secondSubmissionNumerator, denominator: firstSubmissionCohort.length, matureCohort: firstSubmissionCohort.length },
  };
}

export async function getGrowthDashboard(
  db: D1Database,
  lineAccountId: string,
  from: string,
  to: string,
): Promise<Record<string, unknown>> {
  const bounds = [from, to];
  const cohortTo = new Date(Date.parse(to) + 90 * 86400000).toISOString();
  const [entryEvents, sourceRows, promiseRows, readyCount, validity, notifications, unfollows] = await Promise.all([
    db.prepare(`SELECT event_type, subject_key, occurred_at
      FROM pharmacy_growth_events
      WHERE line_account_id = ? AND occurred_at >= ? AND occurred_at < ?
        AND event_type IN ('first_follow','first_submission','second_submission')`)
      .bind(lineAccountId, from, cohortTo).all<GrowthEventRow>(),
    db.prepare(`SELECT COALESCE(ss.classification, 'unknown') AS classification, COUNT(DISTINCT s.id) AS count
      FROM pharmacy_prescription_submissions s
      INNER JOIN pharmacy_prescription_events accepted
        ON accepted.submission_id = s.id AND accepted.to_status = 'accepted'
      LEFT JOIN pharmacy_submission_sources ss
        ON ss.submission_id = s.id AND ss.line_account_id = s.line_account_id
      WHERE s.line_account_id = ? AND accepted.created_at >= ? AND accepted.created_at < ?
      GROUP BY COALESCE(ss.classification, 'unknown')`).bind(lineAccountId, ...bounds).all<{ classification: string; count: number }>(),
    db.prepare(`SELECT q.submission_id, q.revision, q.estimated_ready_at,
                       q.created_at AS quote_created_at,
                       MIN(CASE WHEN ready.to_status = 'ready' AND ready.created_at >= q.created_at
                                THEN ready.created_at END) AS ready_at
                  FROM pharmacy_fulfillment_quotes q
                  LEFT JOIN pharmacy_prescription_events ready
                    ON ready.submission_id = q.submission_id
                 WHERE q.line_account_id = ? AND q.estimated_ready_at IS NOT NULL
                   AND q.created_at >= ? AND q.created_at < ?
                 GROUP BY q.id, q.submission_id, q.revision, q.estimated_ready_at, q.created_at`)
      .bind(lineAccountId, ...bounds).all<GrowthPromiseRow>(),
    db.prepare(`SELECT COUNT(DISTINCT e.submission_id) AS count
                  FROM pharmacy_prescription_events e
                  INNER JOIN pharmacy_prescription_submissions s ON s.id = e.submission_id AND s.line_account_id = ?
                 WHERE e.to_status = 'ready' AND e.created_at >= ? AND e.created_at < ?`)
      .bind(lineAccountId, ...bounds).first<{ count: number }>(),
    db.prepare(`SELECT
      SUM(CASE WHEN v.verification_status = 'verified' THEN 1 ELSE 0 END) AS verified_validity,
      SUM(CASE WHEN v.reminder_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS reminder_sent,
      SUM(CASE WHEN v.verification_status = 'expired_review_required' THEN 1 ELSE 0 END) AS expired_review_required,
      SUM(CASE WHEN v.reminder_sent_at IS NOT NULL AND s.closed_at IS NOT NULL
                 AND substr(s.closed_at, 1, 10) <= v.valid_until THEN 1 ELSE 0 END) AS reminder_closed_in_time
      FROM pharmacy_prescription_validities v
      INNER JOIN pharmacy_prescription_submissions s
        ON s.id = v.submission_id AND s.line_account_id = v.line_account_id
      WHERE v.line_account_id = ? AND v.created_at >= ? AND v.created_at < ?`)
      .bind(lineAccountId, ...bounds).first<Record<string, number | null>>(),
    db.prepare(`SELECT category, outcome, COUNT(*) AS count
      FROM pharmacy_notification_events WHERE line_account_id = ? AND occurred_at >= ? AND occurred_at < ?
      GROUP BY category, outcome`).bind(lineAccountId, ...bounds).all<{ category: string; outcome: string; count: number }>(),
    db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN n.outcome = 'sent' AND n.friend_id IS NOT NULL THEN n.friend_id END) AS exposed_friends,
      COUNT(DISTINCT CASE WHEN julianday(u.occurred_at) < julianday(n.occurred_at, '+24 hours') THEN u.subject_key END) AS unfollow_24h,
      COUNT(DISTINCT CASE WHEN julianday(u.occurred_at) < julianday(n.occurred_at, '+72 hours') THEN u.subject_key END) AS unfollow_72h
      FROM pharmacy_notification_events n
      LEFT JOIN pharmacy_growth_events u
        ON u.line_account_id = n.line_account_id AND u.event_type = 'unfollow'
       AND u.subject_key = n.friend_id AND u.occurred_at >= n.occurred_at
       AND julianday(u.occurred_at) < julianday(n.occurred_at, '+72 hours')
      WHERE n.line_account_id = ? AND n.occurred_at >= ? AND n.occurred_at < ?`)
      .bind(lineAccountId, ...bounds).first<{ exposed_friends: number | null; unfollow_24h: number | null; unfollow_72h: number | null }>(),
  ]);
  const events = entryEvents.results ?? [];
  const cohort = summarizeCohorts(events, from, to);
  const firstTimeFollows = events.filter((row) => row.event_type === 'first_follow' && row.occurred_at >= from && row.occurred_at < to).length;
  const firstSubmissions = events.filter((row) => row.event_type === 'first_submission' && row.occurred_at >= from && row.occurred_at < to).length;
  const secondSubmissions = events.filter((row) => row.event_type === 'second_submission' && row.occurred_at >= from && row.occurred_at < to).length;
  const sourceCounts = Object.fromEntries((sourceRows.results ?? []).map((row) => [row.classification, row.count]));
  const promise = summarizePromiseMetrics(promiseRows.results ?? [], 0);
  const notificationCounts = Object.fromEntries((notifications.results ?? []).map((row) => [`${row.category}:${row.outcome}`, row.count]));
  const primary = sourceCounts.primary ?? 0;
  const other = sourceCounts.other ?? 0;
  const sourceKnown = primary + other;
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
    sources: { primary, other, unknown: sourceCounts.unknown ?? 0, otherShare: sourceKnown ? other / sourceKnown : null, knownDenominator: sourceKnown },
    promises: { ...promise, readyEvents: readyCount?.count ?? 0, promiseWithoutQuote: Math.max(0, (readyCount?.count ?? 0) - promise.promised), graceMinutes: 0 },
    validity: {
      verified: validity?.verified_validity ?? 0,
      reminderSent: validity?.reminder_sent ?? 0,
      reminderClosedInTime: validity?.reminder_closed_in_time ?? 0,
      expiredReviewRequired: validity?.expired_review_required ?? 0,
    },
    notifications: notificationCounts,
    unfollow: {
      exposedFriends: unfollows?.exposed_friends ?? 0,
      within24h: unfollows?.unfollow_24h ?? 0,
      within72h: unfollows?.unfollow_72h ?? 0,
      interpretation: '推定される時間的関連（メッセージが原因とは断定しません）',
    },
  };
}
