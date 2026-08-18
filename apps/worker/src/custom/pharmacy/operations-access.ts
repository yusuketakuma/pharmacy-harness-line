import { canAccessPharmacyAccount, type PharmacyStaff } from './growth-loop/access.js';

export async function canAccessPharmacyOperationsAccount(
  db: D1Database,
  staff: PharmacyStaff | null | undefined,
  lineAccountId: string,
  envChannelId?: string,
): Promise<boolean> {
  if (!staff || !lineAccountId) return false;
  if (staff.id === 'env-owner') {
    if (!envChannelId) return false;
    const account = await db.prepare(
      `SELECT channel_id FROM line_accounts WHERE id = ? AND is_active = 1`,
    ).bind(lineAccountId).first<{ channel_id: string }>();
    return account?.channel_id === envChannelId;
  }

  try {
    return await canAccessPharmacyAccount(db, staff, lineAccountId);
  } catch {
    // Fail closed until the Growth Loop account-assignment migration is installed.
    return false;
  }
}
