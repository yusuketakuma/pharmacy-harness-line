export function requireLineBotUserId(data: unknown): string {
  const userId = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as { userId?: unknown }).userId
    : null;
  if (typeof userId !== 'string' || !/^U[A-Za-z0-9_-]{1,127}$/u.test(userId)) {
    throw new Error('invalid bot identity');
  }
  return userId;
}
