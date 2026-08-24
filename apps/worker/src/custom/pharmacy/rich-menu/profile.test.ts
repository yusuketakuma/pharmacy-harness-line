import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateRichMenuImage } from '../../../lib/image-validator.js';
import {
  buildPharmacyInitialRichMenu,
  buildPharmacyCatalogRichMenu,
  diagnosePharmacyRichMenuActions,
  diffPharmacyRichMenuManifests,
  getPharmacyRichMenuCatalogPreview,
  hashPharmacyRichMenuManifest,
  buildPharmacyLegacyInitialRichMenu,
  buildPharmacyPreviousInitialRichMenu,
  buildPharmacySingleActionRichMenu,
  isPharmacyInitialRichMenuProfile,
  PHARMACY_INITIAL_PROFILE_KEY,
  PHARMACY_LEGACY_INITIAL_PROFILE_KEY,
  PHARMACY_PREVIOUS_INITIAL_PROFILE_KEY,
  PHARMACY_INITIAL_RICH_MENU_IMAGE_PATH,
  PHARMACY_SINGLE_ACTION_PROFILE_KEY,
  PHARMACY_RICH_MENU_GENERATOR_VERSION,
} from './profile.js';
import { listPharmacyRichMenuVariantOrders } from './layout.js';

describe('pharmacy rich-menu profile', () => {
  it('builds the deterministic six-area initial menu with safe LIFF links', () => {
    const group = buildPharmacyInitialRichMenu('account-a', '1234567890-AbCd');
    const page = group.pages[0];
    expect(group.generatorKey).toBe('initial-large-3x2-v5');
    expect(PHARMACY_INITIAL_PROFILE_KEY).toBe('initial-large-3x2-v5');
    expect(group.generatorVersion).toBe('5');
    expect(PHARMACY_RICH_MENU_GENERATOR_VERSION).toBe('5');
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
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-prescription-send&liffId=1234567890-AbCd',
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

  it('keeps the v3 six-area menu as an explicit rollback profile', () => {
    const group = buildPharmacyPreviousInitialRichMenu('account-a', '1234567890-AbCd');
    expect(group.generatorKey).toBe(PHARMACY_PREVIOUS_INITIAL_PROFILE_KEY);
    expect(group.generatorVersion).toBe('3');
    expect(group.size).toBe('large');
    expect(group.pages[0].areas).toHaveLength(6);
    expect(group.pages[0].areas[0].actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-emergency-contraception&liffId=1234567890-AbCd',
    });
    expect(isPharmacyInitialRichMenuProfile(PHARMACY_PREVIOUS_INITIAL_PROFILE_KEY)).toBe(true);
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

  it('builds catalog actions in the smallest fitting LINE size without disabled slots', () => {
    const group = buildPharmacyCatalogRichMenu(
      'account-a',
      '1234567890-AbCd',
      ['manual-chat', 'pharmacy-info'],
      '夜間向けメニュー',
    );
    const areas = group.pages[0].areas;

    expect(group).toMatchObject({
      accountId: 'account-a',
      name: '夜間向けメニュー',
      size: 'compact',
      generatorKey: null,
    });
    expect(areas).toHaveLength(3);
    expect(areas.map((area) => [area.boundsX, area.boundsY])).toEqual([
      [0, 0], [833, 0], [1667, 0],
    ]);
    expect(areas[0].actionData).toEqual({ text: '薬局へ相談' });
    expect(areas[1].actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-info&liffId=1234567890-AbCd',
    });
    expect(areas[2].actionData).toEqual({
      uri: 'https://liff.line.me/1234567890-AbCd/?page=pharmacy-menu&liffId=1234567890-AbCd',
    });
  });

  it('projects server-owned candidate labels and tap bounds without raw action data', () => {
    expect(getPharmacyRichMenuCatalogPreview(
      '1234567890-AbCd', [
        'prescription-send', 'prescription-history', 'medication-followup',
        'manual-chat', 'pharmacy-info',
      ],
    )[0]).toMatchObject({
      actionKey: 'prescription-send', label: '処方せん事前送信', actionType: 'uri',
    });
    expect(getPharmacyRichMenuCatalogPreview(
      '1234567890-AbCd', ['pharmacy-info'],
    )).toEqual([
      expect.objectContaining({
        actionKey: 'pharmacy-info', label: '薬局情報', actionType: 'uri',
        boundsX: 0, boundsY: 0, boundsWidth: 1250, boundsHeight: 843,
      }),
      expect.objectContaining({
        actionKey: 'all-functions', label: 'すべての機能', actionType: 'uri',
        boundsX: 1250, boundsY: 0, boundsWidth: 1250, boundsHeight: 843,
      }),
    ]);
    expect(getPharmacyRichMenuCatalogPreview('1234567890-AbCd', [])).toEqual([
      expect.objectContaining({
        actionKey: 'all-functions', label: 'すべての機能',
        boundsX: 0, boundsY: 0, boundsWidth: 2500, boundsHeight: 843,
      }),
    ]);
    expect(JSON.stringify(getPharmacyRichMenuCatalogPreview(
      '1234567890-AbCd', ['pharmacy-info'],
    ))).not.toContain('liff.line.me');
  });

  it('hashes the canonical image action manifest and detects any action change', async () => {
    const areas = buildPharmacyCatalogRichMenu(
      'account-a', '1234567890-AbCd', ['manual-chat', 'pharmacy-info'], 'Menu',
    ).pages[0].areas;
    const first = await hashPharmacyRichMenuManifest(areas);
    const changed = areas.map((area) => ({ ...area, actionData: { ...area.actionData } }));
    changed[0] = { ...changed[0], actionData: { text: '別のmessage' } };

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashPharmacyRichMenuManifest(areas.map((area) => ({ ...area })))).toBe(first);
    expect(await hashPharmacyRichMenuManifest(changed)).not.toBe(first);
  });

  it('diagnoses every adaptive catalog manifest against server-owned tap actions', () => {
    const liffId = '1234567890-AbCd';
    for (const order of listPharmacyRichMenuVariantOrders()) {
      const areas = buildPharmacyCatalogRichMenu('account-a', liffId, order, 'Menu').pages[0].areas;
      expect(diagnosePharmacyRichMenuActions(areas, liffId, order)).toEqual([]);
    }
  });

  it('diagnoses persisted actions independently of database row order', () => {
    const order = [
      'prescription-send', 'prescription-history', 'medication-followup',
      'manual-chat', 'pharmacy-info',
    ] as const;
    const areas = buildPharmacyCatalogRichMenu(
      'account-a', '1234567890-AbCd', order, 'Menu',
    ).pages[0].areas.slice().reverse();

    expect(diagnosePharmacyRichMenuActions(areas, '1234567890-AbCd', order)).toEqual([]);
  });

  it('rejects changed bounds and action types before LINE publication', () => {
    const order = ['pharmacy-info'] as const;
    const areas = buildPharmacyCatalogRichMenu(
      'account-a', '1234567890-AbCd', order, 'Menu',
    ).pages[0].areas.map((area) => ({ ...area, actionData: { ...area.actionData } }));
    areas[0].boundsX += 1;
    areas[1].actionType = 'message';
    areas[1].actionData = { text: 'すべての機能' };

    expect(diagnosePharmacyRichMenuActions(areas, '1234567890-AbCd', order)).toEqual([
      'ACTION_BOUNDS_INVALID',
      'ACTION_TYPE_INVALID',
    ]);
  });

  it('classifies slot, action, and image changes without exposing action data', () => {
    const current = buildPharmacyCatalogRichMenu(
      'account-a', '1234567890-AbCd', ['manual-chat', 'pharmacy-info'], 'Current',
    ).pages[0].areas;
    const reordered = buildPharmacyCatalogRichMenu(
      'account-a', '1234567890-AbCd', ['pharmacy-info', 'manual-chat'], 'Draft',
    ).pages[0].areas;

    expect(diffPharmacyRichMenuManifests(current, current, 'a'.repeat(64), 'a'.repeat(64)))
      .toEqual({ imageChanged: false, slots: current.map((_, index) => ({
        kind: 'same', currentIndex: index, draftIndex: index,
      })) });
    expect(diffPharmacyRichMenuManifests(current, current, 'a'.repeat(64), 'b'.repeat(64)))
      .toEqual({ imageChanged: true, slots: current.map((_, index) => ({
        kind: 'image_changed', currentIndex: index, draftIndex: index,
      })) });
    expect(diffPharmacyRichMenuManifests(current, reordered, 'a'.repeat(64), 'b'.repeat(64)).slots)
      .toEqual([
        { kind: 'moved', currentIndex: 1, draftIndex: 0 },
        { kind: 'moved', currentIndex: 0, draftIndex: 1 },
        { kind: 'image_changed', currentIndex: 2, draftIndex: 2 },
      ]);

    const changed = current.map((area) => ({ ...area, actionData: { ...area.actionData } }));
    changed[1] = { ...changed[1], actionData: { uri: 'https://liff.line.me/fixed/?page=changed' } };
    expect(diffPharmacyRichMenuManifests(current, changed, 'a'.repeat(64), 'a'.repeat(64)).slots[1])
      .toEqual({ kind: 'action_changed', currentIndex: 1, draftIndex: 1 });

    expect(diffPharmacyRichMenuManifests(current, current.slice(1), 'a'.repeat(64), 'a'.repeat(64)).slots)
      .toEqual(expect.arrayContaining([
        { kind: 'removed', currentIndex: 0, draftIndex: null },
        { kind: 'moved', currentIndex: 1, draftIndex: 0 },
      ]));
    expect(diffPharmacyRichMenuManifests(current.slice(1), current, 'a'.repeat(64), 'a'.repeat(64)).slots)
      .toEqual(expect.arrayContaining([
        { kind: 'added', currentIndex: null, draftIndex: 0 },
        { kind: 'moved', currentIndex: 0, draftIndex: 1 },
      ]));
    expect(JSON.stringify(diffPharmacyRichMenuManifests(
      current, changed, 'a'.repeat(64), 'a'.repeat(64),
    ))).not.toContain('liff.line.me');
  });
});
