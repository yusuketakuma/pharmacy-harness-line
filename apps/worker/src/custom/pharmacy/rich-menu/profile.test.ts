import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateRichMenuImage } from '../../../lib/image-validator.js';
import {
  buildPharmacyInitialRichMenu,
  PHARMACY_INITIAL_PROFILE_KEY,
  PHARMACY_RICH_MENU_GENERATOR_VERSION,
} from './profile.js';

describe('pharmacy rich-menu profile', () => {
  it('builds the deterministic initial menu with safe LIFF links', () => {
    const group = buildPharmacyInitialRichMenu('account-a', '1234567890-AbCd');
    const page = group.pages[0];
    expect(group.generatorKey).toBe(PHARMACY_INITIAL_PROFILE_KEY);
    expect(group.generatorVersion).toBe(PHARMACY_RICH_MENU_GENERATOR_VERSION);
    expect(group.size).toBe('compact');
    expect(page.areas).toHaveLength(3);
    expect(page.areas.map((area) => [area.boundsX, area.boundsWidth])).toEqual([
      [0, 833],
      [833, 834],
      [1667, 833],
    ]);
    expect(page.areas[0].actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-receive&liffId=1234567890-AbCd',
    });
    expect(page.areas[1].actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-intake&liffId=1234567890-AbCd',
    });
    expect(page.areas[2].actionData).toEqual({ text: '薬局へ相談' });
  });

  it('rejects a missing LIFF id instead of creating broken actions', () => {
    expect(() => buildPharmacyInitialRichMenu('account-a', '')).toThrow(/liffId is required/i);
  });

  it('ships a LINE-compliant generated initial image', () => {
    const bytes = new Uint8Array(readFileSync(resolve(process.cwd(), 'public/custom/pharmacy/rich-menu/initial-compact-3x1.jpg')));
    expect(validateRichMenuImage(bytes, bytes.byteLength)).toEqual({
      ok: true,
      size: 'compact',
      format: 'jpeg',
    });
  });
});
