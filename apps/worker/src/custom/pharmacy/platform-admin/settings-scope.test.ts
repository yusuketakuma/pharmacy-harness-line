import { describe, expect, it } from 'vitest';
import { isPlatformTenantSettingsPath } from './settings-scope.js';

describe('platform tenant settings scope', () => {
  it.each([
    '/api/account-settings/link-base-url',
    '/api/line-accounts/account-a',
    '/api/rich-menu-groups/group-a/publish',
    '/api/custom/pharmacy/rich-menus/prepare',
    '/api/custom/pharmacy/growth/config',
    '/api/custom/pharmacy/privacy-policy',
    '/api/custom/pharmacy/public-profile',
    '/api/custom/pharmacy/emergency-contraception/config',
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
    expect(isPlatformTenantSettingsPath(path)).toBe(true);
  });

  it.each([
    '/api/liff/pharmacy/patients',
    '/api/custom/pharmacy/prescriptions',
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
    expect(isPlatformTenantSettingsPath(path)).toBe(false);
  });
});
