import { canAccessPharmacyAccount, type PharmacyStaff } from './growth-loop/access.js';
export type StaffPrincipal = PharmacyStaff;

export async function canAccessPharmacyOperationsAccount(
  db: D1Database,
  staff: StaffPrincipal | null | undefined,
  lineAccountId: string,
  envChannelId?: string,
): Promise<boolean> {
  if (!staff || !lineAccountId) return false;
  try {
    if (staff.id === 'env-owner') {
      if (!envChannelId) return false;
      const account = await db.prepare(
        `SELECT channel_id FROM line_accounts WHERE id = ? AND is_active = 1`,
      ).bind(lineAccountId).first<{ channel_id: string }>();
      return account?.channel_id === envChannelId;
    }
    if (staff.role === 'owner') {
      const account = await db.prepare(
        `SELECT id FROM line_accounts WHERE id = ? AND is_active = 1`,
      ).bind(lineAccountId).first<{ id: string }>();
      return Boolean(account);
    }
    return await canAccessPharmacyAccount(db, staff, lineAccountId);
  } catch {
    // Fail closed if the assignment lookup is unavailable.
    return false;
  }
}
