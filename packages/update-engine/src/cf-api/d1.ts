import type { CfApiCreds } from '../types.js';
import { authHeader, d1QueryApiUrl, readBodyExcerpt, throwHttpError } from './_shared.js';

/**
 * Cloudflare D1 Query API helper.
 *
 * Wraps `POST /accounts/{accountId}/d1/database/{databaseId}/query` so the
 * update engine can run schema migrations (and read back the version table)
 * against a customer's D1 instance using only their CF API token + account
 * id + database id — no `wrangler` binary required at runtime.
 *
 * `sql` may hold one statement or several semicolon-separated ones: D1 runs a
 * multi-statement string as a single batch and answers with one entry in
 * `result` per statement. `applyD1Migrations` relies on that for the atomic
 * migration+ledger write; its legacy-baseline path deliberately calls this
 * helper once per statement instead, so a failure surfaces against the exact
 * SQL that broke and duplicate-object errors can be skipped individually.
 */

/**
 * Execute SQL against a D1 database.
 *
 * Returns the raw Cloudflare API envelope (`{ success, result, ... }`) so
 * callers can inspect `result[0].results` for SELECT rows or `meta` for
 * row-counts on writes.
 *
 * Throws on non-2xx with the HTTP status and a truncated body excerpt so
 * caller logs always include the API's error reason, and on a failed envelope
 * (see {@link assertD1Success}) — HTTP 200 does not mean the SQL ran.
 */
export async function executeD1Query(opts: {
  creds: CfApiCreds;
  databaseId: string;
  sql: string;
  params?: any[];
}): Promise<{ success: boolean; result: any[] }> {
  const { creds, databaseId, sql } = opts;
  const params = opts.params ?? [];

  const res = await fetch(d1QueryApiUrl(creds.accountId, databaseId), {
    method: 'POST',
    headers: {
      ...authHeader(creds.apiToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });

  if (!res.ok) {
    // Legacy error shape kept on purpose: `HTTP <status>:` comes before the
    // body excerpt, whereas the shared `throwHttpError` puts the colon after
    // the prefix. Callers and logs depend on this exact wording.
    const excerpt = await readBodyExcerpt(res);
    throw new Error(`D1 query failed HTTP ${res.status}: ${excerpt}`);
  }

  return assertD1Success((await res.json()) as { success: boolean; result: any[] });
}

/**
 * Fail closed on a D1 envelope that reports failure.
 *
 * Cloudflare answers a rejected query with HTTP 200 and `success: false`, and
 * a multi-statement request carries a per-statement `success` inside
 * `result`. Returning either as-is is fail-open: callers record a migration
 * whose schema change never landed.
 */
export function assertD1Success<T extends { success: boolean; result: any[] }>(body: T): T {
  if (body.success !== true) throw new Error(`D1 query failed: ${d1ErrorDetail(body)}`);
  const results = body.result ?? [];
  for (let i = 0; i < results.length; i += 1) {
    const statement = results[i];
    if (statement && typeof statement === 'object' && 'success' in statement
      && statement.success !== true) {
      throw new Error(`D1 query failed at statement ${i + 1}: ${d1ErrorDetail(statement)}`);
    }
  }
  return body;
}

/** Error reason from a D1 envelope, truncated like `readBodyExcerpt`. */
function d1ErrorDetail(body: unknown): string {
  const source = (body ?? {}) as { errors?: unknown; messages?: unknown; error?: unknown };
  const detail = source.errors ?? source.messages ?? source.error ?? body;
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return text && text.length > 500 ? `${text.slice(0, 500)}…` : (text ?? '');
}

export async function getD1Bookmark(opts: {
  creds: CfApiCreds;
  databaseId: string;
}): Promise<string> {
  const base = d1QueryApiUrl(opts.creds.accountId, opts.databaseId).replace(/\/query$/, '');
  const res = await fetch(`${base}/time_travel/bookmark`, {
    headers: authHeader(opts.creds.apiToken),
  });
  if (!res.ok) await throwHttpError('GET D1 bookmark failed', res);
  const body = (await res.json()) as { result?: { bookmark?: string } };
  if (!body.result?.bookmark) throw new Error('GET D1 bookmark: missing bookmark');
  return body.result.bookmark;
}
