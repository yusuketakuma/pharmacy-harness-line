/**
 * Error for a non-2xx LINE response. The upstream body, including its
 * `message`/`error` fields, can echo private request data. Callers log this
 * error, so only emit a fixed known detail needed for retry classification.
 * Used by both the direct SDK and the Harness reply proxy.
 */
export async function createLineApiError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    message?: unknown;
    error?: unknown;
  } | null;
  const detail = (body?.message ?? body?.error) === 'Invalid reply token' ? ' — Invalid reply token' : '';
  return new Error(`LINE API error: ${res.status} ${res.statusText}${detail}`);
}
