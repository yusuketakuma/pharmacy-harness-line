import type { AdminSameSite } from './admin-auth-config.js';

export function buildCookie(
  name: string,
  value: string,
  sameSite: AdminSameSite,
  maxAge: number,
  httpOnly: boolean,
  path = '/',
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (httpOnly) parts.push('HttpOnly');
  parts.push('Secure', `SameSite=${sameSite}`, `Max-Age=${maxAge}`);
  return parts.join('; ');
}
