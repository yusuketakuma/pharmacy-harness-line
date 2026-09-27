// Only a same-origin relative path may be used as a post-login destination:
// must start with a single "/" (so "//host" and "/\host" are rejected) and
// must not point back at the login page itself.
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  // The router parses URLs before navigating: tabs/newlines can turn an
  // apparently relative prefix into an external authority (for example /\t/host).
  if (/[\u0000-\u001F\u007F]/u.test(value)) return '/';
  const base = 'https://admin.invalid';
  try {
    const destination = new URL(value, base);
    if (destination.origin !== base || destination.pathname === '/login' || destination.pathname === '/login/')
      return '/';
  } catch {
    return '/';
  }
  return value;
}

// Builds the /login URL for an unauthenticated redirect, remembering where the
// staff member was so they can be sent back after logging in again.
export function loginRedirectPath(reason?: 'expired'): string {
  const params = new URLSearchParams();
  if (reason) params.set('reason', reason);
  if (typeof window !== 'undefined') {
    const next = safeNextPath(window.location.pathname + window.location.search);
    if (next !== '/') params.set('next', next);
  }
  const query = params.toString();
  return query ? `/login?${query}` : '/login';
}
