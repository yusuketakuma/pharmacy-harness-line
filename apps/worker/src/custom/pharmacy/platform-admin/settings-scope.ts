import { findPharmacyAdminApiDeferred, isPharmacyAdminApiPath } from './api-coverage.js';

const SIMPLE_CONFIG = /^\/api\/(?:auto-replies|automations|message-templates|staff|tags|templates)(?:\/[^/]+)?$/u;
const REMINDER_CONFIG = /^\/api\/reminders(?:\/[^/]+(?:\/steps(?:\/[^/]+)?)?)?$/u;
const SCENARIO_CONFIG = /^\/api\/scenarios(?:\/[^/]+(?:\/steps(?:\/[^/]+|\/reorder)?)?)?$/u;
const WEBHOOK_CONFIG = /^\/api\/webhooks\/(?:incoming|outgoing)(?:\/[^/]+)?$/u;
const BOOKING_CONFIG = /^\/api\/booking\/admin\/(?:menus(?:\/[^/]+(?:\/staff)?)?|staff(?:\/[^/]+(?:\/(?:availability-rules|menus|google-calendar))?)?)$/u;
const LINE_ACCOUNT_CONFIG = /^\/api\/line-accounts(?:\/order|\/[^/]+(?:\/connect)?)?$/u;

const STAFF_PATH = /^\/api\/staff(?:\/.*)?$/u;

/**
 * Non-PHI tenant configuration that an authenticated platform admin may manage.
 * Method-aware: tenant staff credentials (create / role / account assignment)
 * stay behind the staff login, and routes the CLI contract defers are refused
 * here as well.
 */
export function isPlatformTenantSettingsPath(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (findPharmacyAdminApiDeferred(verb, path)) return false;
  if (STAFF_PATH.test(path) && verb !== 'GET') return false;
  return isPharmacyAdminApiPath(path) ||
    path.startsWith('/api/account-settings/') ||
    path.startsWith('/api/rich-menu-groups') ||
    path.startsWith('/api/rich-menu-images/') ||
    path.startsWith('/api/rich-menus') ||
    path === '/api/custom/pharmacy/growth/config' ||
    path === '/api/custom/pharmacy/readiness' ||
    path === '/api/custom/pharmacy/privacy-policy' ||
    path === '/api/custom/pharmacy/public-profile' ||
    path === '/api/custom/pharmacy/emergency-contraception/config' ||
    /^\/api\/custom\/pharmacy\/emergency-contraception\/pharmacists\/[^/]+$/u.test(path) ||
    path.startsWith('/api/custom/pharmacy/rich-menus/') ||
    SIMPLE_CONFIG.test(path) || REMINDER_CONFIG.test(path) ||
    SCENARIO_CONFIG.test(path) || WEBHOOK_CONFIG.test(path) ||
    BOOKING_CONFIG.test(path) || LINE_ACCOUNT_CONFIG.test(path);
}
