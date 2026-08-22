import { describe, expect, it } from 'vitest';
import { isPlatformTenantSettingsPath } from './settings-scope.js';

describe('platform tenant settings scope', () => {
  it.each([
    '/api/account-settings/link-base-url',
    '/api/line-accounts/account-a',
    '/api/rich-menu-groups/external',
    '/api/rich-menu-groups/group-a/publish',
    '/api/custom/pharmacy/rich-menus/prepare',
    '/api/custom/pharmacy/growth/config',
    '/api/custom/pharmacy/readiness',
    '/api/custom/pharmacy/privacy-policy',
    '/api/custom/pharmacy/public-profile',
    '/api/custom/pharmacy/myna-endpoint',
    '/api/custom/pharmacy/emergency-contraception/config',
    '/api/custom/pharmacy/emergency-contraception/reminders',
    '/api/custom/pharmacy/emergency-contraception/inventory',
    '/api/custom/pharmacy/emergency-contraception/slots',
    '/api/custom/pharmacy/emergency-contraception/pharmacists/staff-a',
    '/api/automations/automation-a',
    '/api/auto-replies/reply-a',
    '/api/booking/admin/menus/menu-a',
    '/api/message-templates/template-a',
    '/api/reminders/reminder-a/steps/step-a',
    '/api/scenarios/scenario-a/steps/step-a',
    '/api/staff/staff-a',
    '/api/tags/tag-a',
    '/api/templates/template-a',
    '/api/webhooks/outgoing/webhook-a',
  ])('allows a tenant configuration path: %s', (path) => {
    expect(isPlatformTenantSettingsPath('GET', path)).toBe(true);
  });

  it.each([
    '/api/liff/pharmacy/patients',
    '/api/custom/pharmacy/prescriptions',
    '/api/custom/pharmacy/myna-handoffs',
    '/api/custom/pharmacy/emergency-contraception/intakes',
    '/api/friends',
    '/api/chats',
    '/api/broadcasts',
    '/api/scenarios/scenario-a/stats',
    '/api/scenarios/scenario-a/enroll/friend-a',
    '/api/reminders/reminder-a/enroll/friend-a',
    '/api/automations/automation-a/logs',
    '/api/line-accounts/account-a/follower-import',
    '/api/booking/admin/bookings',
    '/api/webhooks/incoming/webhook-a/receive',
    '/api/platform-admin/tenants',
  ])('rejects PHI or operational paths: %s', (path) => {
    expect(isPlatformTenantSettingsPath('GET', path)).toBe(false);
  });

  it.each([
    ['POST', '/api/staff'],
    ['PATCH', '/api/staff/staff-a'],
    ['PUT', '/api/staff/staff-a/accounts'],
    ['POST', '/api/staff/staff-a/reset-password'],
    ['DELETE', '/api/staff/staff-a'],
    ['DELETE', '/api/line-accounts/account-a'],
  ])('rejects tenant credential mutations over the Bearer path: %s %s', (method, path) => {
    expect(isPlatformTenantSettingsPath(method, path)).toBe(false);
  });

  it.each([
    ['POST', '/api/rich-menu-groups/import'],
    ['DELETE', '/api/rich-menu-groups/external/richmenu-a'],
  ])('keeps external rich-menu mutations blocked: %s %s', (method, path) => {
    expect(isPlatformTenantSettingsPath(method, path)).toBe(false);
  });

  it.each([
    ['GET', '/api/staff'],
    ['GET', '/api/staff/staff-a'],
    ['PUT', '/api/account-settings/link-base-url'],
  ])('keeps read and non-credential settings writes: %s %s', (method, path) => {
    expect(isPlatformTenantSettingsPath(method, path)).toBe(true);
  });
});
