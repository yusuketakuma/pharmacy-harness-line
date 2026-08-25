import { describe, expect, it } from 'vitest';
import { emergencyContraceptionRoutes } from '../emergency-contraception/routes.js';
import { pharmacyGrowthLoopRoutes } from '../growth-loop/routes.js';
import { mynaRoutes } from '../myna/routes.js';
import { pharmacyPrivacyPolicyRoutes } from '../privacy-policy/routes.js';
import { pharmacyPublicProfileRoutes } from '../public-profile/routes.js';
import { pharmacyRichMenuRoutes } from '../rich-menu/routes.js';
import { staff } from '../../../routes/admin/staff.js';
import { lineAccounts } from '../../../routes/admin/line-accounts.js';
import { richMenuGroups } from '../../../routes/messaging/rich-menu-groups.js';
import { accountSettings } from '../../../routes/admin/account-settings.js';
import { capabilities } from '../../../routes/admin/capabilities.js';
import { images } from '../../../routes/admin/images.js';
import {
  findPharmacyAdminApiCoverage,
  findPharmacyAdminApiDeferred,
} from './api-coverage.js';

const routeCandidates = [
  ...emergencyContraceptionRoutes.routes,
  ...pharmacyGrowthLoopRoutes.routes,
  ...mynaRoutes.routes,
  ...pharmacyPrivacyPolicyRoutes.routes,
  ...pharmacyPublicProfileRoutes.routes,
  ...pharmacyRichMenuRoutes.routes,
  ...staff.routes,
  ...lineAccounts.routes,
  ...richMenuGroups.routes,
  ...accountSettings.routes,
  ...capabilities.routes,
  ...images.routes,
].filter(({ method, path }) => method !== 'ALL' && (
  path.startsWith('/api/custom/pharmacy/') ||
  path.startsWith('/api/staff') ||
  path.startsWith('/api/line-accounts') ||
  path.startsWith('/api/rich-menu-groups') ||
  path.startsWith('/api/rich-menu-images') ||
  path.startsWith('/api/account-settings') ||
  path.startsWith('/api/capabilities') ||
  path.startsWith('/api/images')
));
const routes = [...new Map(routeCandidates.map((route) => [
  `${route.method} ${route.path}`, route,
])).values()];

describe('pharmacy admin API coverage leak detector', () => {
  it('classifies every custom pharmacy route exposed by admin-facing modules', () => {
    const unclassified = routes.filter(({ method, path }) =>
      !findPharmacyAdminApiCoverage(method, path) && !findPharmacyAdminApiDeferred(method, path));

    expect(unclassified.map(({ method, path }) => `${method} ${path}`)).toEqual([]);
  });

  it('records a bounded reason for every intentionally unavailable route', () => {
    const reasons = routes.flatMap(({ method, path }) => {
      const deferred = findPharmacyAdminApiDeferred(method, path);
      return deferred ? [deferred.reason] : [];
    });

    expect(new Set(reasons)).toEqual(new Set([
      'binary-output', 'destructive-operation', 'external-operation', 'legacy-lifecycle',
      'patient-operation', 'retired',
    ]));
  });

  it('covers tenant-scoped staff lifecycle changes behind explicit output and apply gates', () => {
    expect(findPharmacyAdminApiCoverage('GET', '/api/tags')).toMatchObject({
      accountScope: 'tenant',
      mutationGate: 'read-only',
      safeOutput: true,
    });
    expect(findPharmacyAdminApiCoverage('PATCH', '/api/staff/staff-a')).toMatchObject({
      accountScope: 'tenant',
      mutationGate: 'apply',
      safeOutput: true,
    });
    expect(findPharmacyAdminApiCoverage('PUT', '/api/staff/staff-a/accounts')).toMatchObject({
      accountScope: 'tenant',
      mutationGate: 'apply',
      safeOutput: true,
    });
    expect(findPharmacyAdminApiCoverage('POST', '/api/staff')).toMatchObject({
      accountScope: 'tenant',
      mutationGate: 'apply',
      safeOutput: false,
      secretOutput: true,
    });
    expect(findPharmacyAdminApiCoverage('POST', '/api/staff/staff-a/reset-password')).toMatchObject({
      accountScope: 'tenant',
      mutationGate: 'apply',
      safeOutput: false,
      secretOutput: true,
    });
    expect(findPharmacyAdminApiCoverage('DELETE', '/api/staff/staff-a')).toMatchObject({
      accountScope: 'tenant',
      mutationGate: 'apply',
      safeOutput: true,
    });
    expect(findPharmacyAdminApiDeferred('PATCH', '/api/staff/staff-a')).toBeUndefined();
    expect(findPharmacyAdminApiDeferred('PUT', '/api/staff/staff-a/accounts')).toBeUndefined();
    expect(findPharmacyAdminApiDeferred('POST', '/api/staff')).toBeUndefined();
    expect(findPharmacyAdminApiDeferred('POST', '/api/staff/staff-a/reset-password')).toBeUndefined();
    expect(findPharmacyAdminApiDeferred('DELETE', '/api/staff/staff-a')).toBeUndefined();
  });

  it('does not expose patient operations through the CLI coverage manifest', () => {
    for (const path of [
      '/api/custom/pharmacy/emergency-contraception/intakes',
      '/api/custom/pharmacy/myna-handoffs',
      '/api/custom/pharmacy/growth/submissions/submission-a/source',
    ]) {
      expect(findPharmacyAdminApiCoverage('GET', path)).toBeUndefined();
      expect(findPharmacyAdminApiCoverage('POST', path)).toBeUndefined();
    }
  });

  it('classifies capability discovery and image transfer routes', () => {
    expect(findPharmacyAdminApiCoverage('GET', '/api/capabilities')).toMatchObject({
      accountScope: 'tenant',
      mutationGate: 'read-only',
      safeOutput: true,
    });
    expect(findPharmacyAdminApiDeferred('POST', '/api/images')).toMatchObject({
      reason: 'binary-output',
    });
    expect(findPharmacyAdminApiDeferred('GET', '/api/images/tenant-object')).toMatchObject({
      reason: 'binary-output',
    });
    expect(findPharmacyAdminApiDeferred('DELETE', '/api/images/tenant-object')).toMatchObject({
      reason: 'destructive-operation',
    });
  });

  it('allows only the read-only LINE rich-menu state reconciliation endpoint', () => {
    const readback = findPharmacyAdminApiCoverage('GET', '/api/rich-menu-groups/external');

    expect(readback).toMatchObject({
      accountScope: 'query:accountId',
      mutationGate: 'read-only',
      safeOutput: true,
    });
    expect(readback?.path.test('/api/rich-menu-groups/group-a')).toBe(false);
    expect(findPharmacyAdminApiDeferred('GET', '/api/rich-menu-groups/external')).toBeUndefined();
    expect(findPharmacyAdminApiCoverage('POST', '/api/rich-menu-groups/import')).toBeUndefined();
    expect(findPharmacyAdminApiCoverage('DELETE', '/api/rich-menu-groups/external/richmenu-a'))
      .toBeUndefined();
  });
});
