export async function resolveActiveLineAccountIdByLiffId(
  db: D1Database,
  liffId: string | undefined,
): Promise<string | null> {
  if (!liffId) return null;
  const account = await db
    .prepare('SELECT id FROM line_accounts WHERE liff_id = ? AND is_active = 1')
    .bind(liffId)
    .first<{ id: string }>();
  return account?.id ?? null;
}
