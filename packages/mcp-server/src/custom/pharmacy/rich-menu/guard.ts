export function pinnedAccountId(explicit?: string): string {
  const configured = process.env.LINE_HARNESS_ACCOUNT_ID?.trim();
  if (!configured) {
    throw new Error('LINE_HARNESS_ACCOUNT_ID is required for pharmacy rich-menu management');
  }
  if (explicit && explicit !== configured) {
    throw new Error('accountId does not match LINE_HARNESS_ACCOUNT_ID');
  }
  return configured;
}

export function requireConfirmation(
  dryRun: boolean,
  confirm: boolean,
  operation: string,
): void {
  if (!dryRun && !confirm) {
    throw new Error(`${operation} is mutating; rerun with dryRun=false and confirm=true`);
  }
}
