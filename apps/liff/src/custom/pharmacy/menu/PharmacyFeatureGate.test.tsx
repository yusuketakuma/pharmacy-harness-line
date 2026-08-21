import { describe, expect, it } from 'vitest';
import { canAccessPharmacyFeature } from './PharmacyFeatureGate.js';

describe('pharmacy direct route feature gate', () => {
  it('allows enabled features and explicitly drainable existing records only', () => {
    expect(canAccessPharmacyFeature(['patient_intake'], [], 'patient_intake', true)).toBe(true);
    expect(canAccessPharmacyFeature([], ['patient_intake'], 'patient_intake', true)).toBe(true);
    expect(canAccessPharmacyFeature([], ['patient_intake'], 'patient_intake', false)).toBe(false);
    expect(canAccessPharmacyFeature([], [], 'patient_intake', true)).toBe(false);
  });
});
