type Credentials = { accountId: string; apiToken: string };
type D1Response = { success: boolean; result: Array<{ results?: unknown[] }> };
type Executor = (input: {
  creds: Credentials;
  databaseId: string;
  sql: string;
}) => Promise<D1Response>;

const EXPECTED_CHECKS = new Set([
  'login_channel_id',
  'liff_id',
  'account_line_user',
  'unowned_line_user',
]);

const PREFLIGHT_SQL = `
SELECT 'login_channel_id' AS check_name, COUNT(*) AS duplicate_groups
  FROM (
    SELECT login_channel_id FROM line_accounts
     WHERE login_channel_id IS NOT NULL AND login_channel_id != ''
     GROUP BY login_channel_id HAVING COUNT(*) > 1
  )
UNION ALL
SELECT 'liff_id', COUNT(*)
  FROM (
    SELECT liff_id FROM line_accounts
     WHERE liff_id IS NOT NULL AND liff_id != ''
     GROUP BY liff_id HAVING COUNT(*) > 1
  )
UNION ALL
SELECT 'account_line_user', COUNT(*)
  FROM (
    SELECT line_account_id, line_user_id FROM friends
     WHERE line_account_id IS NOT NULL AND line_user_id IS NOT NULL
     GROUP BY line_account_id, line_user_id HAVING COUNT(*) > 1
  )
UNION ALL
SELECT 'unowned_line_user', COUNT(*)
  FROM (
    SELECT line_user_id FROM friends
     WHERE line_account_id IS NULL AND line_user_id IS NOT NULL
     GROUP BY line_user_id HAVING COUNT(*) > 1
  )`;

export async function runMultitenantDataPreflight(
  execute: Executor,
  target: { creds: Credentials; databaseId: string },
): Promise<void> {
  const response = await execute({ ...target, sql: PREFLIGHT_SQL });
  const rows = response.result?.[0]?.results;
  if (!response.success || !Array.isArray(rows) || rows.length !== EXPECTED_CHECKS.size) {
    throw new Error('multi-tenant migration preflight failed: incomplete result');
  }
  const seen = new Set<string>();
  for (const value of rows) {
    const row = value as { check_name?: unknown; duplicate_groups?: unknown };
    if (typeof row.check_name !== 'string' || !EXPECTED_CHECKS.has(row.check_name) ||
        seen.has(row.check_name) || row.duplicate_groups !== 0) {
      throw new Error('multi-tenant migration preflight failed: duplicate selector');
    }
    seen.add(row.check_name);
  }
}
