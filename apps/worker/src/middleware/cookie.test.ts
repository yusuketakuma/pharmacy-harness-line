import { describe, expect, it } from 'vitest';
import {
  adminSessionCookie,
  buildCookie,
  csrfCookie,
} from './auth.js';
import {
  platformAdminCsrfCookie,
  platformAdminSessionCookie,
} from '../custom/pharmacy/platform-admin/auth.js';

describe('admin cookie serialization', () => {
  it('keeps tenant cookies site-wide with the existing attributes', () => {
    expect(adminSessionCookie('token/value', 'Lax', 1800)).toBe(
      'lh_admin_session=token%2Fvalue; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800',
    );
    expect(csrfCookie('csrf', 'Strict')).toBe(
      'lh_csrf=csrf; Path=/; Secure; SameSite=Strict; Max-Age=28800',
    );
    expect(buildCookie('name', 'value', 'None', 60, true)).toBe(
      'name=value; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=60',
    );
  });

  it('keeps platform-admin cookies scoped to their API prefix', () => {
    expect(platformAdminSessionCookie('token', 'Lax', 1800)).toBe(
      'lh_platform_admin_session=token; Path=/api/platform-admin; HttpOnly; Secure; SameSite=Lax; Max-Age=1800',
    );
    expect(platformAdminCsrfCookie('csrf', 'None')).toBe(
      'lh_platform_admin_csrf=csrf; Path=/api/platform-admin; Secure; SameSite=None; Max-Age=28800',
    );
  });
});
