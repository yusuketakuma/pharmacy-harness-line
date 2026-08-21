// Parses ?limit / ?offset. Returns null when either is not a positive / non-negative integer (caller → 400).
export function clampLimitOffset(limitRaw: string | undefined, offsetRaw: string | undefined, defaultLimit: number, max = 200): { limit: number; offset: number } | null {
  const limit = limitRaw === undefined ? defaultLimit : Number(limitRaw);
  const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
  if (limitRaw === '' || offsetRaw === '' || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) return null;
  return { limit: Math.min(max, limit), offset };
}
