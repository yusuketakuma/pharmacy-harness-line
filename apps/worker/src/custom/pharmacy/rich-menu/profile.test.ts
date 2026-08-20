import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateRichMenuImage } from '../../../lib/image-validator.js';
import {
  buildPharmacyInitialRichMenu,
  buildPharmacyLegacyInitialRichMenu,
  buildPharmacySingleActionRichMenu,
  isPharmacyInitialRichMenuProfile,
  PHARMACY_INITIAL_PROFILE_KEY,
  PHARMACY_LEGACY_INITIAL_PROFILE_KEY,
  PHARMACY_INITIAL_RICH_MENU_IMAGE_PATH,
  PHARMACY_SINGLE_ACTION_PROFILE_KEY,
  PHARMACY_RICH_MENU_GENERATOR_VERSION,
} from './profile.js';

describe('pharmacy rich-menu profile', () => {
  it('builds the deterministic six-area initial menu with safe LIFF links', () => {
    const group = buildPharmacyInitialRichMenu('account-a', '1234567890-AbCd');
    const page = group.pages[0];
    expect(group.generatorKey).toBe(PHARMACY_INITIAL_PROFILE_KEY);
    expect(group.generatorVersion).toBe(PHARMACY_RICH_MENU_GENERATOR_VERSION);
    expect(group.size).toBe('large');
    expect(page.areas).toHaveLength(6);
    expect(page.areas.map((area) => [area.boundsX, area.boundsY, area.boundsWidth, area.boundsHeight])).toEqual([
      [0, 0, 833, 843],
      [833, 0, 834, 843],
      [1667, 0, 833, 843],
      [0, 843, 833, 843],
      [833, 843, 834, 843],
      [1667, 843, 833, 843],
    ]);
    expect(page.areas[0].actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-emergency-contraception&liffId=1234567890-AbCd',
    });
    expect(page.areas[1].actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-prescription-history&liffId=1234567890-AbCd',
    });
    expect(page.areas[2].actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-followup&liffId=1234567890-AbCd',
    });
    expect(page.areas[3].actionData).toEqual({ text: '薬局へ相談' });
    expect(page.areas[4].actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-info&liffId=1234567890-AbCd',
    });
    expect(page.areas[5].actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-menu&liffId=1234567890-AbCd',
    });
  });

  it('keeps the three-area initial menu as an explicit legacy profile', () => {
    const group = buildPharmacyLegacyInitialRichMenu('account-a', '1234567890-AbCd');
    expect(group.generatorKey).toBe(PHARMACY_LEGACY_INITIAL_PROFILE_KEY);
    expect(group.size).toBe('compact');
    expect(group.pages[0].areas).toHaveLength(3);
  });

  it('rejects a missing LIFF id instead of creating broken actions', () => {
    expect(() => buildPharmacyInitialRichMenu('account-a', '')).toThrow(/liffId is required/i);
  });

  it('rejects an empty profile key so prepare remains idempotent', () => {
    expect(isPharmacyInitialRichMenuProfile('')).toBe(false);
  });

  it('builds a versioned single-action intake profile without removing the legacy profile', () => {
    const group = buildPharmacySingleActionRichMenu('account-a', '1234567890-AbCd', true);
    const area = group.pages[0].areas[0];
    expect(group.generatorKey).toBe(PHARMACY_SINGLE_ACTION_PROFILE_KEY);
    expect(group.selected).toBe(true);
    expect(group.pages[0].areas).toHaveLength(1);
    expect(area).toMatchObject({ boundsX: 0, boundsY: 0, boundsWidth: 2500, boundsHeight: 843 });
    expect(area.actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-prescription-send&liffId=1234567890-AbCd',
    });
  });

  it('ships a LINE-compliant generated initial image', () => {
    const bytes = new Uint8Array(readFileSync(resolve(process.cwd(), `public${PHARMACY_INITIAL_RICH_MENU_IMAGE_PATH}`)));
    expect(validateRichMenuImage(bytes, bytes.byteLength)).toEqual({
      ok: true,
      size: 'large',
      format: 'jpeg',
    });
  });
});
