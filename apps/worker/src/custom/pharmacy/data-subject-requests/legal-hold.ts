// 法定保存期間の判定。全PHIを一律3年保存する経営判断(2026-08-19)に基づき、
// 薬剤師法施行規則の調剤録・処方箋の保存期間を準用している。
// 患者の最新PHI記録から3年を経過するまでは法定保存中(legal hold)とし、
// 消去・利用停止の請求には応じられない。

export const PHI_RETENTION_YEARS = 3;
export const LEGAL_HOLD_BASIS = 'pharmacist_law_enforcement_regulation_3y';

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
): { held: boolean; releaseAt: string | null } {
  if (!latestPhiAt || !Number.isFinite(Date.parse(latestPhiAt))) {
    return { held: false, releaseAt: null };
  }
  const releaseAt = legalHoldReleaseAt(latestPhiAt);
  return { held: Date.parse(releaseAt) > now.getTime(), releaseAt };
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
 * 一方 `pharmacy_emergency_intakes` 系は friend 単位で patient_id を持たないため、
 * この患者単位の判定には入れていない。
 *
 * 各要素は必ず (lineAccountId, patientId) をこの順で2つだけバインドすること。
 */
const PHI_RECORDED_AT_SOURCES = [
  `SELECT MAX(created_at) AS recorded_at FROM pharmacy_patient_intake_responses
     WHERE line_account_id = ? AND patient_id = ?`,
  `SELECT MAX(created_at) FROM pharmacy_prescription_patients
     WHERE line_account_id = ? AND patient_id = ?`,
  `SELECT MAX(updated_at) FROM pharmacy_continuity_obligations
     WHERE line_account_id = ? AND patient_id = ?`,
  // 患者本体。患者IDは patient_id ではなく id 列。archived_at は論理削除なので起算に使わない。
  `SELECT MAX(created_at) FROM pharmacy_patients
     WHERE line_account_id = ? AND id = ?`,
  `SELECT MAX(created_at) FROM pharmacy_myna_handoffs
     WHERE line_account_id = ? AND patient_id = ?`,
  // 検証・イベントは patient_id を持たず handoff 経由でのみ患者に紐づく。
  `SELECT MAX(v.created_at) FROM pharmacy_myna_verifications v
     JOIN pharmacy_myna_handoffs h
       ON h.id = v.handoff_id AND h.line_account_id = v.line_account_id
     WHERE h.line_account_id = ? AND h.patient_id = ?`,
  `SELECT MAX(e.occurred_at) FROM pharmacy_myna_events e
     JOIN pharmacy_myna_handoffs h
       ON h.id = e.handoff_id AND h.line_account_id = e.line_account_id
     WHERE h.line_account_id = ? AND h.patient_id = ?`,
  `SELECT MAX(created_at) FROM pharmacy_prescription_expectations
     WHERE line_account_id = ? AND patient_id = ?`,
  `SELECT MAX(created_at) FROM pharmacy_next_intake_expectations
     WHERE line_account_id = ? AND patient_id = ?`,
  `SELECT MAX(e.occurred_at) FROM pharmacy_next_intake_expectation_events e
     JOIN pharmacy_next_intake_expectations x
       ON x.id = e.expectation_id AND x.line_account_id = e.line_account_id
     WHERE x.line_account_id = ? AND x.patient_id = ?`,
  `SELECT MAX(created_at) FROM pharmacy_medication_followups
     WHERE line_account_id = ? AND patient_id = ?`,
  `SELECT MAX(e.occurred_at) FROM pharmacy_medication_followup_events e
     JOIN pharmacy_medication_followups f
       ON f.id = e.followup_id AND f.line_account_id = e.line_account_id
     WHERE f.line_account_id = ? AND f.patient_id = ?`,
];

const LATEST_PHI_SQL =
  `SELECT MAX(recorded_at) AS latest FROM (${PHI_RECORDED_AT_SOURCES.join('\n UNION ALL ')})`;

/**
 * 患者に紐づくPHI記録のうち最新のものの記録時刻。
 * H-5(保存期間の一括棚卸し)とは独立に、この表だけで判定できるようにしている。
 */
export async function latestPhiRecordedAt(
  db: D1Database,
  lineAccountId: string,
  patientId: string,
): Promise<string | null> {
  const row = await db.prepare(LATEST_PHI_SQL)
    .bind(...PHI_RECORDED_AT_SOURCES.flatMap(() => [lineAccountId, patientId]))
    .first<{ latest: string | null }>();
  return row?.latest ?? null;
}
