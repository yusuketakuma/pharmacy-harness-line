type QueryContext = { req: { query(name: string): string | undefined } };

export function getPharmacyAccountId(c: QueryContext): string | null {
  return c.req.query('line_account_id') || null;
}
