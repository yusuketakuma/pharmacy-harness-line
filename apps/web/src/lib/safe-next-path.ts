// Only a same-origin relative path may be used as a post-login destination:
// must start with a single "/" (so "//host" and "/\host" are rejected) and
// must not point back at the login page itself.
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  if (value === '/login' || value.startsWith('/login?')) return '/'
  return value
}

// Builds the /login URL for an unauthenticated redirect, remembering where the
// staff member was so they can be sent back after logging in again.
export function loginRedirectPath(reason?: 'expired'): string {
  const params = new URLSearchParams()
  if (reason) params.set('reason', reason)
  if (typeof window !== 'undefined') {
    const next = safeNextPath(window.location.pathname + window.location.search)
    if (next !== '/') params.set('next', next)
  }
  const query = params.toString()
  return query ? `/login?${query}` : '/login'
}
