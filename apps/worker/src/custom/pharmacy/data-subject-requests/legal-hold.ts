// 法定保存期間の判定。全PHIを一律3年保存する経営判断(2026-08-19)に基づき、
// 薬剤師法施行規則の調剤録・処方箋の保存期間を準用している。
// 患者の最新PHI記録から3年を経過するまでは法定保存中(legal hold)とし、
// 消去・利用停止の請求には応じられない。

export const PHI_RETENTION_YEARS = 3;
export const LEGAL_HOLD_BASIS = 'pharmacist_law_enforcement_regulation_3y';

/** SQL callers must alias pharmacy_data_subject_requests as `request` and bind now last. */
export const ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQL = `NOT (
  request.status = 'legal_hold_assessed'
  AND COALESCE((
    request.legal_hold = 0
    OR (
      request.legal_hold = 1
      AND length(request.legal_hold_release_at) = 24
      AND request.legal_hold_release_at GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND request.legal_hold_release_at <= ?
    )
  ), 0)
)`;

export type RetentionStatus = 'held' | 'released' | 'unknown';

export interface RetentionAssessment {
  status: RetentionStatus;
  releaseAt: string | null;
}

export interface RetentionPatientScope {
  tenantId: string;
  lineAccountId: string;
  ownerFriendId: string;
  patientId: string;
}

/** 消去・利用停止が法定保存期間によって妨げられる請求種別。 */
export function isRetentionBlockedRequestType(requestType: string): boolean {
  return requestType === 'erasure' || requestType === 'suspension';
}

export function legalHoldReleaseAt(latestPhiAt: string): string {
  const at = new Date(latestPhiAt);
  at.setUTCFullYear(at.getUTCFullYear() + PHI_RETENTION_YEARS);
  return at.toISOString();
}

export function assessRetention(
  latestPhiAt: string | null,
  now: Date,
): RetentionAssessment {
  if (!Number.isFinite(now.getTime()) ||
      !latestPhiAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(latestPhiAt) ||
      !Number.isFinite(Date.parse(latestPhiAt))) {
    return { status: 'unknown', releaseAt: null };
  }
  const releaseAt = legalHoldReleaseAt(latestPhiAt);
  if (!Number.isFinite(Date.parse(releaseAt))) return { status: 'unknown', releaseAt: null };
  return { status: Date.parse(releaseAt) > now.getTime() ? 'held' : 'released', releaseAt };
}

/**
 * Resolve the complete retention scope before a destructive decision.
 *
 * A query failure, an inactive/multiple tenant mapping, or an ambiguous patient
 * owner is deliberately indistinguishable from an unknown source to callers:
 * all three cases must block deletion.
 */
export async function assessPatientRetention(
  db: D1Database,
  scope: RetentionPatientScope,
  now: Date,
): Promise<RetentionAssessment> {
  try {
    const tenant = await db.prepare(
      `SELECT COUNT(*) AS count
         FROM tenant_line_accounts AS mapping
         INNER JOIN tenants AS tenant ON tenant.id = mapping.tenant_id
        WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?
          AND tenant.status = 'active'`,
    ).bind(scope.tenantId, scope.lineAccountId).first<{ count: number }>();
    if ((tenant?.count ?? 0) !== 1) return { status: 'unknown', releaseAt: null };

    const patient = await db.prepare(
      `SELECT COUNT(*) AS count
         FROM pharmacy_patients
        WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?`,
    ).bind(scope.patientId, scope.lineAccountId, scope.ownerFriendId).first<{ count: number }>();
    if ((patient?.count ?? 0) !== 1) return { status: 'unknown', releaseAt: null };

    return assessRetention(
      await latestPhiRecordedAt(
        db, scope.lineAccountId, scope.patientId, scope.ownerFriendId,
      ),
      now,
    );
  } catch {
    return { status: 'unknown', releaseAt: null };
  }
}

/**
 * 患者に紐づくPHI表と、その行の保存期間起算列。
 * docs/pharmacy/RETENTION_MATRIX.md で患者に紐づくPHIと分類した表を網羅する。
 * 一部でも漏らすと、まだ保存期間中のPHIが残っているのに legal hold が外れる。
 *
 * 監査表(`*_events`)を含める理由: 親行の `created_at` より後に発生し、
 * かつ行自体がPHI(状態遷移 `concern`/`escalated`、`metadata_json`)を持つ。
 * 3年前に作られたフォローアップが先月 `escalated` した場合、親行だけを見ると
 * 保存期間経過と誤判定するため、監査表の `occurred_at` も比較対象に入れる。
 * patient_id を持たないLINE/EC sourceもowner単位で含める。どの患者の記録かを
 * 一意に証明できないsourceを無視するより、owner配下の全患者をholdする方が安全である。
 * DSR受付・監査時刻は請求自身で3年holdを再生成しない。未決のDSR tombstoneは
 * retention readinessを独立にBLOCKEDへ固定し、ここで基礎PHIの起算日にはしない。
 */
const PATIENT_PHI_RECORDED_AT_SOURCES = [
  ['pharmacy_patient_intake_responses.created_at',
   `SELECT created_at AS recorded_at FROM pharmacy_patient_intake_responses
     WHERE line_account_id = ? AND patient_id = ?`,
  ],
  ['pharmacy_prescription_patients.created_at',
   `SELECT created_at AS recorded_at FROM pharmacy_prescription_patients
     WHERE line_account_id = ? AND patient_id = ?`],
  ['pharmacy_prescription_submissions.created_at',
   `SELECT s.created_at AS recorded_at FROM pharmacy_prescription_submissions s
     JOIN pharmacy_prescription_patients p ON p.submission_id = s.id
       AND p.line_account_id = s.line_account_id
     WHERE p.line_account_id = ? AND p.patient_id = ?`],
  ['pharmacy_prescription_files.created_at',
   `SELECT f.created_at AS recorded_at FROM pharmacy_prescription_files f
     JOIN pharmacy_prescription_submissions s ON s.id = f.submission_id
     JOIN pharmacy_prescription_patients p ON p.submission_id = s.id
       AND p.line_account_id = s.line_account_id
     WHERE p.line_account_id = ? AND p.patient_id = ?`],
  ['pharmacy_prescription_events.created_at',
   `SELECT e.created_at AS recorded_at FROM pharmacy_prescription_events e
     JOIN pharmacy_prescription_submissions s ON s.id = e.submission_id
     JOIN pharmacy_prescription_patients p ON p.submission_id = s.id
       AND p.line_account_id = s.line_account_id
     WHERE p.line_account_id = ? AND p.patient_id = ?`],
  ['pharmacy_prescription_view_events.viewed_at',
   `SELECT e.viewed_at AS recorded_at FROM pharmacy_prescription_view_events e
     JOIN pharmacy_prescription_patients p ON p.submission_id = e.submission_id
     WHERE p.line_account_id = ? AND p.patient_id = ?`],
  ['pharmacy_prescription_validities.created_at',
   `SELECT v.created_at AS recorded_at FROM pharmacy_prescription_validities v
     JOIN pharmacy_prescription_patients p ON p.submission_id = v.submission_id
       AND p.line_account_id = v.line_account_id
     WHERE p.line_account_id = ? AND p.patient_id = ?`],
  ['pharmacy_submission_sources.entered_at',
   `SELECT source.entered_at AS recorded_at FROM pharmacy_submission_sources source
     JOIN pharmacy_prescription_patients p ON p.submission_id = source.submission_id
       AND p.line_account_id = source.line_account_id
     WHERE p.line_account_id = ? AND p.patient_id = ?`],
  ['pharmacy_submission_attributes.created_at',
   `SELECT a.created_at AS recorded_at FROM pharmacy_submission_attributes a
     JOIN pharmacy_prescription_patients p ON p.submission_id = a.submission_id
       AND p.line_account_id = a.line_account_id
     WHERE p.line_account_id = ? AND p.patient_id = ?`],
  ['pharmacy_fulfillment_quotes.created_at',
   `SELECT q.created_at AS recorded_at FROM pharmacy_fulfillment_quotes q
     JOIN pharmacy_prescription_patients p ON p.submission_id = q.submission_id
       AND p.line_account_id = q.line_account_id
     WHERE p.line_account_id = ? AND p.patient_id = ?`],
  ['pharmacy_print_tasks.created_at',
   `SELECT task.created_at AS recorded_at FROM pharmacy_print_tasks task
     JOIN pharmacy_prescription_patients p ON p.submission_id = task.submission_id
       AND p.line_account_id = task.line_account_id
     WHERE p.line_account_id = ? AND p.patient_id = ?`],
  ['pharmacy_continuity_obligations.created_at',
   `SELECT created_at AS recorded_at FROM pharmacy_continuity_obligations
     WHERE line_account_id = ? AND patient_id = ?`],
  ['pharmacy_continuity_events.created_at',
   `SELECT e.created_at AS recorded_at FROM pharmacy_continuity_events e
     JOIN pharmacy_continuity_obligations o ON o.id = e.obligation_id
       AND o.line_account_id = e.line_account_id
     WHERE o.line_account_id = ? AND o.patient_id = ?`],
  // 患者本体。患者IDは patient_id ではなく id 列。archived_at は論理削除なので起算に使わない。
  ['pharmacy_patients.created_at',
   `SELECT created_at AS recorded_at FROM pharmacy_patients
     WHERE line_account_id = ? AND id = ?`],
  ['pharmacy_myna_handoffs.created_at',
   `SELECT created_at AS recorded_at FROM pharmacy_myna_handoffs
     WHERE line_account_id = ? AND patient_id = ?`],
  // 検証・イベントは patient_id を持たず handoff 経由でのみ患者に紐づく。
  ['pharmacy_myna_verifications.created_at',
   `SELECT v.created_at AS recorded_at FROM pharmacy_myna_verifications v
     JOIN pharmacy_myna_handoffs h
       ON h.id = v.handoff_id AND h.line_account_id = v.line_account_id
     WHERE h.line_account_id = ? AND h.patient_id = ?`],
  ['pharmacy_myna_events.occurred_at',
   `SELECT e.occurred_at AS recorded_at FROM pharmacy_myna_events e
     JOIN pharmacy_myna_handoffs h
       ON h.id = e.handoff_id AND h.line_account_id = e.line_account_id
     WHERE h.line_account_id = ? AND h.patient_id = ?`],
  ['pharmacy_prescription_expectations.created_at',
   `SELECT created_at AS recorded_at FROM pharmacy_prescription_expectations
     WHERE line_account_id = ? AND patient_id = ?`],
  ['pharmacy_next_intake_expectations.created_at',
   `SELECT created_at AS recorded_at FROM pharmacy_next_intake_expectations
     WHERE line_account_id = ? AND patient_id = ?`],
  ['pharmacy_next_intake_expectation_events.occurred_at',
   `SELECT e.occurred_at AS recorded_at FROM pharmacy_next_intake_expectation_events e
     JOIN pharmacy_next_intake_expectations x
       ON x.id = e.expectation_id AND x.line_account_id = e.line_account_id
     WHERE x.line_account_id = ? AND x.patient_id = ?`],
  ['pharmacy_medication_followups.created_at',
   `SELECT created_at AS recorded_at FROM pharmacy_medication_followups
     WHERE line_account_id = ? AND patient_id = ?`],
  ['pharmacy_medication_followup_events.occurred_at',
   `SELECT e.occurred_at AS recorded_at FROM pharmacy_medication_followup_events e
     JOIN pharmacy_medication_followups f
       ON f.id = e.followup_id AND f.line_account_id = e.line_account_id
     WHERE f.line_account_id = ? AND f.patient_id = ?`],
] as const;

const OWNER_PHI_RECORDED_AT_SOURCES = [
  ['friends.created_at',
   `SELECT created_at AS recorded_at FROM friends
     WHERE line_account_id = ? AND id = ?`],
  ['chats.created_at',
   `SELECT c.created_at AS recorded_at FROM chats c
     JOIN friends f ON f.id = c.friend_id
     WHERE f.line_account_id = ? AND f.id = ?`],
  ['messages_log.created_at',
   `SELECT m.created_at AS recorded_at FROM messages_log m
     JOIN friends f ON f.id = m.friend_id
     WHERE f.line_account_id = ? AND f.id = ?`],
  ['pharmacy_notification_events.occurred_at',
   `SELECT occurred_at AS recorded_at FROM pharmacy_notification_events
     WHERE line_account_id = ? AND friend_id = ?`],
  ['pharmacy_incoming_image_objects.stored_at',
   `SELECT object.stored_at AS recorded_at FROM pharmacy_incoming_image_objects object
     JOIN messages_log message ON message.id = object.message_id
     WHERE object.line_account_id = ? AND message.friend_id = ?`],
  ['pharmacy_emergency_intakes.created_at',
   `SELECT created_at AS recorded_at FROM pharmacy_emergency_intakes
     WHERE line_account_id = ? AND owner_friend_id = ?`],
  ['pharmacy_emergency_intake_events.occurred_at',
   `SELECT event.occurred_at AS recorded_at FROM pharmacy_emergency_intake_events event
     JOIN pharmacy_emergency_intakes intake ON intake.id = event.intake_id
       AND intake.line_account_id = event.line_account_id
     WHERE intake.line_account_id = ? AND intake.owner_friend_id = ?`],
  ['pharmacy_emergency_intake_access_events.accessed_at',
   `SELECT event.accessed_at AS recorded_at FROM pharmacy_emergency_intake_access_events event
     JOIN pharmacy_emergency_intakes intake ON intake.id = event.intake_id
       AND intake.line_account_id = event.line_account_id
     WHERE intake.line_account_id = ? AND intake.owner_friend_id = ?`],
  ['pharmacy_emergency_counter_confirmations.confirmed_at',
   `SELECT confirmation.confirmed_at AS recorded_at
      FROM pharmacy_emergency_counter_confirmations confirmation
      JOIN pharmacy_emergency_intakes intake ON intake.id = confirmation.intake_id
       AND intake.line_account_id = confirmation.line_account_id
     WHERE intake.line_account_id = ? AND intake.owner_friend_id = ?`],
  ['pharmacy_emergency_sale_records.sold_at',
   `SELECT sold_at AS recorded_at FROM pharmacy_emergency_sale_records
     WHERE line_account_id = ? AND owner_friend_id = ?`],
  ['pharmacy_emergency_reminders.created_at',
   `SELECT reminder.created_at AS recorded_at FROM pharmacy_emergency_reminders reminder
     JOIN pharmacy_emergency_intakes intake ON intake.id = reminder.intake_id
       AND intake.line_account_id = reminder.line_account_id
     WHERE intake.line_account_id = ? AND intake.owner_friend_id = ?`],
] as const;

export const RETENTION_SOURCE_INVENTORY = [
  ...PATIENT_PHI_RECORDED_AT_SOURCES.map(([field]) => field),
  ...OWNER_PHI_RECORDED_AT_SOURCES.map(([field]) => field),
] as const;

const LATEST_PHI_SQL =
  `SELECT recorded_at FROM (${[
    ...PATIENT_PHI_RECORDED_AT_SOURCES,
    ...OWNER_PHI_RECORDED_AT_SOURCES,
  ].map(([, sql]) => sql).join('\n UNION ALL ')}) AS source_dates`;

/**
 * 患者に紐づくPHI記録のうち最新のものの記録時刻。
 * H-5(保存期間の一括棚卸し)とは独立に、この表だけで判定できるようにしている。
 */
export async function latestPhiRecordedAt(
  db: D1Database,
  lineAccountId: string,
  patientId: string,
  ownerFriendId: string,
): Promise<string | null> {
  const rows = await db.prepare(LATEST_PHI_SQL)
    .bind(
      ...PATIENT_PHI_RECORDED_AT_SOURCES.flatMap(() => [lineAccountId, patientId]),
      ...OWNER_PHI_RECORDED_AT_SOURCES.flatMap(() => [lineAccountId, ownerFriendId]),
    )
    .all<{ recorded_at: string | null }>();
  const sourceDates = (rows.results ?? []).map((row) => row.recorded_at);
  if (sourceDates.some((value) => value === null)) return null;
  const timestamps = sourceDates
    .filter((value): value is string => value !== null);
  if (timestamps.some((value) =>
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)))) return null;
  return timestamps.sort().at(-1) ?? null;
}
