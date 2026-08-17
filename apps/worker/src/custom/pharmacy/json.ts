export async function readJsonObject(
  request: { json<T>(): Promise<T> },
): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json<unknown>();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
