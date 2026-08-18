export type StaffPrincipal = { id: string; role: 'owner' | 'admin' | 'staff' };

export async function canAccessPharmacyOperationsAccount(
  db: D1Database,
  staff: StaffPrincipal | null | undefined,
  lineAccountId: string,
  envChannelId?: string,
): Promise<boolean> {
  if (!staff || !lineAccountId) return false;
  const account = await db.prepare(
    `SELECT channel_id FROM line_accounts WHERE id = ? AND is_active = 1`,
  ).bind(lineAccountId).first<{ channel_id: string }>();
  if (!account) return false;
  if (staff.id === 'env-owner') return Boolean(envChannelId && account.channel_id === envChannelId);
  if (staff.role === 'owner') return true;

  try {
    const assigned = await db.prepare(
      `SELECT 1 AS ok FROM pharmacy_staff_accounts
        WHERE line_account_id = ? AND staff_id = ? AND is_active = 1 LIMIT 1`,
    ).bind(lineAccountId, staff.id).first<{ ok: number }>();
    return Boolean(assigned?.ok);
  } catch {
    // Fail closed if the assignment lookup is unavailable.
    return false;
  }
}
