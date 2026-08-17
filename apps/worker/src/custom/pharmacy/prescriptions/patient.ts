import type { VerifiedLineIdentity } from '../../../services/liff-auth.js';

export interface PrescriptionPatient {
  lineAccountId: string;
  friendId: string;
}

export async function resolvePrescriptionPatient(
  db: D1Database,
  liffId: string,
  identity: VerifiedLineIdentity,
): Promise<PrescriptionPatient | null> {
  if (!liffId) return null;
  const row = await db.prepare(
    `SELECT la.id AS line_account_id, f.id AS friend_id
       FROM line_accounts la
       INNER JOIN friends f
         ON f.line_account_id = la.id AND f.line_user_id = ?
      WHERE la.liff_id = ? AND la.login_channel_id = ? AND la.is_active = 1`,
  ).bind(identity.lineUserId, liffId, identity.loginChannelId).first<{
    line_account_id: string;
    friend_id: string;
  }>();
  return row
    ? { lineAccountId: row.line_account_id, friendId: row.friend_id }
    : null;
}
