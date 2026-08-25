import { findPharmacyAdminApiCoverage } from './api-coverage.js';

/** The server-side Bearer bridge uses the same method-aware contract as the CLI. */
export function isPlatformTenantSettingsPath(method: string, path: string): boolean {
  return Boolean(findPharmacyAdminApiCoverage(method.toUpperCase(), path));
}
