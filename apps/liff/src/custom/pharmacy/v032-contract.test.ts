import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  pharmacyMainMenuItems,
  pharmacyMenuGroups,
  PHARMACY_MENU_GROUPS,
} from './menu/MainMenuPage.js';

const pageSources = [
  './menu/MainMenuPage.tsx',
  './prescriptions/PrescriptionPage.tsx',
  './intake/PatientIntakePage.tsx',
  './continuity/ContinuityPage.tsx',
  './medication-followup/MedicationFollowUpPage.tsx',
  './emergency-contraception/EmergencyContraceptionPage.tsx',
  './public-profile/PharmacyInfoPage.tsx',
] as const;

function readRelative(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function contrastRatio(foreground: string, background: string): number {
  const channel = (value: string, offset: number) => {
    const channelValue = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channelValue <= 0.03928 ? channelValue / 12.92 : ((channelValue + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (value: string) => 0.2126 * channel(value, 1) + 0.7152 * channel(value, 3) + 0.0722 * channel(value, 5);
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

describe('pharmacy LIFF v0.32 route-wide contract', () => {
  it('mounts every pharmacy journey under the shared PharmacyPage shell', () => {
    const app = readRelative('../../App.tsx');
    for (const path of [
      '/prescriptions',
      '/pharmacy/menu',
      '/pharmacy/info',
      '/pharmacy/patient-intake',
      '/pharmacy/continuity',
      '/pharmacy/medication-followup',
      '/pharmacy/emergency-contraception',
    ]) {
      expect(app).toContain(`path="${path}"`);
      expect(app).toContain('<PharmacyPage');
    }
  });

  it('applies the shared visual and readable supplemental-text contract to every page', () => {
    for (const path of pageSources) {
      const source = readRelative(path);
      expect(source, path).toContain('pharmacy-main');
      expect(source, path).toContain('min-h-11');
      expect(source, path).not.toContain('text-xs');
      if (!path.endsWith('/public-profile/PharmacyInfoPage.tsx')) {
        expect(source, path).toContain('pharmacyRoute(');
      }
    }
    const css = readRelative('../../index.css');
    expect(css).toContain('--pharmacy-primary: #166534');
    expect(css).toContain('--pharmacy-info: #1d4ed8');
    expect(css).toContain('safe-area-inset-bottom');
    expect(contrastRatio('#166534', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#1d4ed8', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#92400e', '#fffbeb')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#b91c1c', '#fef2f2')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps all menu groups and internal routes tenant-preserving', () => {
    const items = pharmacyMainMenuItems('e2e-liff', [
      'prescription_intake', 'patient_intake', 'electronic_prescription',
      'continuity', 'medication_followup', 'emergency_contraception', 'pharmacy_info',
    ]);
    expect(pharmacyMenuGroups(items).map(({ group }) => group)).toEqual([...PHARMACY_MENU_GROUPS]);
    expect(items.every(({ to }) => to.includes('liffId=e2e-liff'))).toBe(true);
    expect(items.every(({ label }) => label.length > 0)).toBe(true);
  });

  it('does not persist patient intake drafts outside the mounted page state', () => {
    expect(readRelative('./intake/PatientIntakePage.tsx')).not.toContain('sessionStorage');
    expect(readRelative('./intake/PatientIntakePage.tsx')).toContain('beforeunload');
  });

  it('does not render arbitrary runtime error messages on patient pages', () => {
    for (const path of [
      './prescriptions/PrescriptionPage.tsx',
      './intake/PatientIntakePage.tsx',
      './emergency-contraception/EmergencyContraceptionPage.tsx',
    ]) {
      const source = readRelative(path);
      expect(source, path).toContain('pharmacyErrorMessage');
      expect(source, path).not.toMatch(/\?\s*err\.message/);
    }
  });
});
