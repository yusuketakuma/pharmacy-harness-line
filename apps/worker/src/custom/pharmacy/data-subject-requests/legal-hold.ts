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
 * 患者に紐づくPHI記録のうち最新のものの記録時刻。
 * H-5(保存期間の一括棚卸し)とは独立に、この表だけで判定できるようにしている。
 */
export async function latestPhiRecordedAt(
  db: D1Database,
  lineAccountId: string,
  patientId: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT MAX(recorded_at) AS latest FROM (
       SELECT MAX(created_at) AS recorded_at FROM pharmacy_patient_intake_responses
         WHERE line_account_id = ? AND patient_id = ?
       UNION ALL
       SELECT MAX(created_at) FROM pharmacy_prescription_patients
         WHERE line_account_id = ? AND patient_id = ?
       UNION ALL
       SELECT MAX(updated_at) FROM pharmacy_continuity_obligations
         WHERE line_account_id = ? AND patient_id = ?
     )`,
  ).bind(
    lineAccountId, patientId, lineAccountId, patientId, lineAccountId, patientId,
  ).first<{ latest: string | null }>();
  return row?.latest ?? null;
}
