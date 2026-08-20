import type { CreateRichMenuGroupInput } from '@line-crm/db';

export const PHARMACY_INITIAL_PROFILE_KEY = 'initial-large-3x2-v3';
export const PHARMACY_LEGACY_INITIAL_PROFILE_KEY = 'initial-compact-3x1';
export const PHARMACY_SINGLE_ACTION_PROFILE_KEY = 'intake-single-action-v1';
export const PHARMACY_RICH_MENU_GENERATOR_VERSION = '3';
export const PHARMACY_LEGACY_RICH_MENU_GENERATOR_VERSION = '1';
export const PHARMACY_INITIAL_RICH_MENU_IMAGE_PATH =
  '/custom/pharmacy/rich-menu/initial-large-3x2-v3.jpg';
export const PHARMACY_LEGACY_INITIAL_RICH_MENU_IMAGE_PATH =
  '/custom/pharmacy/rich-menu/initial-compact-3x1.jpg';
export const PHARMACY_SINGLE_ACTION_RICH_MENU_IMAGE_PATH =
  '/custom/pharmacy/rich-menu/initial-single-action-v1.jpg';

const WIDTH = 2500;
const COMPACT_HEIGHT = 843;
const LARGE_HEIGHT = 1686;
const COLUMN_WIDTHS = [833, 834, 833];
const COLUMN_X = [0, 833, 1667];

interface MenuCell {
  page: string | null;
  label: string;
}

function liffPageUrl(liffId: string, page: string): string {
  const base = `https://liff.line.me/${encodeURIComponent(liffId)}/`;
  return `${base}?page=${encodeURIComponent(page)}&liffId=${encodeURIComponent(liffId)}`;
}

function requireRichMenuInput(accountId: string, liffId: string): void {
  if (!accountId) throw new Error('accountId is required');
  if (!liffId) throw new Error('liffId is required to generate pharmacy rich menu links');
}

function buildAreas(liffId: string, cells: MenuCell[]) {
  return cells.map((cell, index) => ({
    boundsX: COLUMN_X[index % 3],
    boundsY: index < 3 ? 0 : COMPACT_HEIGHT,
    boundsWidth: COLUMN_WIDTHS[index % 3],
    boundsHeight: COMPACT_HEIGHT,
    actionType: cell.page ? 'uri' as const : 'message' as const,
    actionData: cell.page
      ? { uri: liffPageUrl(liffId, cell.page) }
      : { text: cell.label },
  }));
}

export function buildPharmacyInitialRichMenu(
  accountId: string,
  liffId: string,
): CreateRichMenuGroupInput {
  requireRichMenuInput(accountId, liffId);

  const cells = [
    { page: 'pharmacy-emergency-contraception', label: '緊急避妊薬' },
    { page: 'pharmacy-prescription-history', label: '受付状況' },
    { page: 'pharmacy-followup', label: '服薬後フォロー' },
    { page: null, label: '薬局へ相談' },
    { page: 'pharmacy-info', label: '薬局情報' },
    { page: 'pharmacy-menu', label: 'すべての機能' },
  ];
  const areas = buildAreas(liffId, cells);

  return {
    accountId,
    name: '薬局初期メニュー',
    chatBarText: 'メニュー',
    size: 'large',
    selected: true,
    generatorKey: PHARMACY_INITIAL_PROFILE_KEY,
    generatorVersion: PHARMACY_RICH_MENU_GENERATOR_VERSION,
    pages: [{
      name: '初期メニュー',
      orderIndex: 0,
      areas,
    }],
  };
}

export function buildPharmacyLegacyInitialRichMenu(
  accountId: string,
  liffId: string,
): CreateRichMenuGroupInput {
  requireRichMenuInput(accountId, liffId);
  const columns = [
    { page: 'pharmacy-receive', label: 'お薬を受け取る' },
    { page: 'pharmacy-intake', label: '患者アンケート' },
    { page: null, label: '薬局へ相談' },
  ];
  const areas = buildAreas(liffId, columns);
  return {
    accountId,
    name: '薬局初期メニュー',
    chatBarText: 'メニュー',
    size: 'compact',
    selected: true,
    generatorKey: PHARMACY_LEGACY_INITIAL_PROFILE_KEY,
    generatorVersion: PHARMACY_LEGACY_RICH_MENU_GENERATOR_VERSION,
    pages: [{ name: '初期メニュー', orderIndex: 0, areas }],
  };
}

export function buildPharmacySingleActionRichMenu(
  accountId: string,
  liffId: string,
  selected = false,
): CreateRichMenuGroupInput {
  requireRichMenuInput(accountId, liffId);
  return {
    accountId,
    name: '処方せん受付メニュー',
    chatBarText: '処方せんを送る',
    size: 'compact',
    selected,
    generatorKey: PHARMACY_SINGLE_ACTION_PROFILE_KEY,
    generatorVersion: PHARMACY_LEGACY_RICH_MENU_GENERATOR_VERSION,
    pages: [{
      name: '処方せんを送る',
      orderIndex: 0,
      areas: [{
        boundsX: 0,
        boundsY: 0,
        boundsWidth: WIDTH,
        boundsHeight: COMPACT_HEIGHT,
        actionType: 'uri',
        actionData: { uri: liffPageUrl(liffId, 'pharmacy-prescription-send') },
      }],
    }],
  };
}

export function isPharmacyInitialRichMenuProfile(profileKey: string | undefined): boolean {
  return profileKey === undefined || profileKey === PHARMACY_INITIAL_PROFILE_KEY ||
    profileKey === PHARMACY_LEGACY_INITIAL_PROFILE_KEY ||
    profileKey === PHARMACY_SINGLE_ACTION_PROFILE_KEY;
}

export {
  WIDTH as PHARMACY_RICH_MENU_WIDTH,
  LARGE_HEIGHT as PHARMACY_RICH_MENU_HEIGHT,
};
