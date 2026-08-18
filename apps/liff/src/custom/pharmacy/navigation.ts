import { getLiffId } from '../../lib/liff-auth.js';

/** Keep the tenant selector when a pharmacy page is opened or reloaded. */
export function pharmacyRoute(path: string, liffId?: string): string {
  // Components are also rendered in isolated tests before LIFF bootstrap.
  // The real app renders only after initLiff(), so an unavailable id here is
  // a no-op rather than a render-time crash.
  const resolvedLiffId = liffId ?? (() => {
    try { return getLiffId(); } catch { return null; }
  })();
  if (!resolvedLiffId) return path;
  const [pathname, rawQuery = ''] = path.split('?', 2);
  const params = new URLSearchParams(rawQuery);
  params.set('liffId', resolvedLiffId);
  return `${pathname}?${params.toString()}`;
}
