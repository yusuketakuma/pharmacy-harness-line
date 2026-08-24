import { describe, expect, it } from 'vitest';
import { findPharmacyAdminApiCoverage } from './api-coverage.js';
import { isPlatformTenantSettingsPath } from './settings-scope.js';

describe('platform tenant settings scope', () => {
  it.each([
    ['GET', '/api/account-settings/link-base-url'],
    ['GET', '/api/line-accounts/account-a'],
    ['GET', '/api/rich-menu-groups/external'],
    ['POST', '/api/rich-menu-groups/group-a/publish'],
    ['GET', '/api/custom/pharmacy/growth/config'],
    ['GET', '/api/custom/pharmacy/readiness'],
    ['GET', '/api/custom/pharmacy/privacy-policy'],
    ['GET', '/api/custom/pharmacy/public-profile'],
    ['GET', '/api/custom/pharmacy/myna-endpoint'],
    ['GET', '/api/custom/pharmacy/emergency-contraception/config'],
    ['GET', '/api/custom/pharmacy/emergency-contraception/reminders'],
    ['PUT', '/api/custom/pharmacy/emergency-contraception/inventory'],
    ['POST', '/api/custom/pharmacy/emergency-contraception/slots'],
    ['PUT', '/api/custom/pharmacy/emergency-contraception/pharmacists/staff-a'],
    ['GET', '/api/staff/staff-a'],
    ['GET', '/api/tags'],
  ])('allows a covered tenant configuration path: %s %s', (method, path) => {
    expect(isPlatformTenantSettingsPath(method, path)).toBe(true);
    expect(findPharmacyAdminApiCoverage(method, path)).toBeDefined();
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
    ['GET', '/api/automations/automation-a'],
    ['GET', '/api/auto-replies/reply-a'],
    ['GET', '/api/booking/admin/menus/menu-a'],
    ['GET', '/api/message-templates/template-a'],
    ['GET', '/api/reminders/reminder-a/steps/step-a'],
    ['GET', '/api/scenarios/scenario-a/steps/step-a'],
    ['GET', '/api/tags/tag-a'],
    ['GET', '/api/templates/template-a'],
    ['GET', '/api/webhooks/outgoing/webhook-a'],
  ])('rejects settings without tenant-safe CLI coverage: %s %s', (method, path) => {
    expect(findPharmacyAdminApiCoverage(method, path)).toBeUndefined();
    expect(isPlatformTenantSettingsPath(method, path)).toBe(false);
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

  it.each([
    ['GET', '/api/tags'],
    ['PATCH', '/api/staff/staff-a'],
    ['PUT', '/api/staff/staff-a/accounts'],
    ['GET', '/api/automations/automation-a'],
  ])('uses the CLI coverage manifest as the server authority: %s %s', (method, path) => {
    expect(isPlatformTenantSettingsPath(method, path)).toBe(
      Boolean(findPharmacyAdminApiCoverage(method, path)),
    );
  });
});
