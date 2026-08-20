import { isPharmacyModeAccount } from './growth-loop/access.js';

export async function shouldRunGenericCron(
  db: D1Database,
  activeAccountIds: string[],
): Promise<boolean> {
  if (activeAccountIds.length === 0) return false;
  for (const accountId of activeAccountIds) {
    if (await isPharmacyModeAccount(db, accountId)) return false;
  }
  return true;
}
