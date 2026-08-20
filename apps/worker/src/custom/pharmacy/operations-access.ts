import { canAccessPharmacyAccount, type PharmacyStaff } from './growth-loop/access.js';
export type StaffPrincipal = PharmacyStaff;

export async function canAccessPharmacyOperationsAccount(
  db: D1Database,
  staff: StaffPrincipal | null | undefined,
  lineAccountId: string,
  _envChannelId?: string,
): Promise<boolean> {
  if (!staff || !lineAccountId) return false;
  if (staff.id === 'env-owner') return false;
  try {
    return await canAccessPharmacyAccount(db, staff, lineAccountId);
  } catch {
    // Fail closed if the assignment lookup is unavailable.
    return false;
  }
}
