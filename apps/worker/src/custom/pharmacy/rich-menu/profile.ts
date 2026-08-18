import type { CreateRichMenuGroupInput } from '@line-crm/db';

export const PHARMACY_INITIAL_PROFILE_KEY = 'initial-compact-3x1';
export const PHARMACY_SINGLE_ACTION_PROFILE_KEY = 'intake-single-action-v1';
export const PHARMACY_RICH_MENU_GENERATOR_VERSION = '1';
export const PHARMACY_INITIAL_RICH_MENU_IMAGE_PATH =
  '/custom/pharmacy/rich-menu/initial-compact-3x1.jpg';
export const PHARMACY_SINGLE_ACTION_RICH_MENU_IMAGE_PATH =
  '/custom/pharmacy/rich-menu/initial-single-action-v1.jpg';

const WIDTH = 2500;
const HEIGHT = 843;
const COLUMN_WIDTHS = [833, 834, 833];

function liffPageUrl(liffId: string, page: string): string {
  const base = `https://liff.line.me/${encodeURIComponent(liffId)}/`;
  return `${base}?page=${encodeURIComponent(page)}&liffId=${encodeURIComponent(liffId)}`;
}

export function buildPharmacyInitialRichMenu(
  accountId: string,
  liffId: string,
): CreateRichMenuGroupInput {
  if (!accountId) throw new Error('accountId is required');
  if (!liffId) throw new Error('liffId is required to generate pharmacy rich menu links');

  let x = 0;
  const columns = [
    { page: 'pharmacy-receive', label: 'お薬を受け取る' },
    { page: 'pharmacy-intake', label: '患者アンケート' },
    { page: null, label: '薬局へ相談' },
  ];
  const areas = columns.map((column, index) => {
    const width = COLUMN_WIDTHS[index];
    const action = column.page
      ? { type: 'uri', uri: liffPageUrl(liffId, column.page) }
      : { type: 'message', text: column.label };
    const area = {
      boundsX: x,
      boundsY: 0,
      boundsWidth: width,
      boundsHeight: HEIGHT,
      actionType: action.type as 'uri' | 'message',
      actionData: column.page
        ? { uri: action.uri }
        : { text: action.text },
    };
    x += width;
    return area;
  });

  return {
    accountId,
    name: '薬局初期メニュー',
    chatBarText: 'メニュー',
    size: 'compact',
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

export function buildPharmacySingleActionRichMenu(
  accountId: string,
  liffId: string,
  selected = false,
): CreateRichMenuGroupInput {
  if (!accountId) throw new Error('accountId is required');
  if (!liffId) throw new Error('liffId is required to generate pharmacy rich menu links');
  return {
    accountId,
    name: '処方せん受付メニュー',
    chatBarText: '処方せんを送る',
    size: 'compact',
    selected,
    generatorKey: PHARMACY_SINGLE_ACTION_PROFILE_KEY,
    generatorVersion: PHARMACY_RICH_MENU_GENERATOR_VERSION,
    pages: [{
      name: '処方せんを送る',
      orderIndex: 0,
      areas: [{
        boundsX: 0,
        boundsY: 0,
        boundsWidth: WIDTH,
        boundsHeight: HEIGHT,
        actionType: 'uri',
        actionData: { uri: liffPageUrl(liffId, 'pharmacy-receive') },
      }],
    }],
  };
}

export function isPharmacyInitialRichMenuProfile(profileKey: string | undefined): boolean {
  return profileKey === undefined || profileKey === PHARMACY_INITIAL_PROFILE_KEY || profileKey === PHARMACY_SINGLE_ACTION_PROFILE_KEY;
}

export { WIDTH as PHARMACY_RICH_MENU_WIDTH, HEIGHT as PHARMACY_RICH_MENU_HEIGHT };
