import type { CreateRichMenuGroupInput, RichMenuAreaInput } from '@line-crm/db';
import {
  listPharmacyRichMenuVariantOrders,
  getPharmacyRichMenuPresentation,
  type PharmacyRichMenuActionKey,
} from './layout.js';
import { PHARMACY_RICH_MENU_CATALOG_VERSION } from './catalog.js';

export const PHARMACY_INITIAL_PROFILE_KEY = 'initial-large-3x2-v4';
export const PHARMACY_PREVIOUS_INITIAL_PROFILE_KEY = 'initial-large-3x2-v3';
export const PHARMACY_LEGACY_INITIAL_PROFILE_KEY = 'initial-compact-3x1';
export const PHARMACY_SINGLE_ACTION_PROFILE_KEY = 'intake-single-action-v1';
export const PHARMACY_RICH_MENU_GENERATOR_VERSION = '4';
export const PHARMACY_PREVIOUS_RICH_MENU_GENERATOR_VERSION = '3';
export const PHARMACY_LEGACY_RICH_MENU_GENERATOR_VERSION = '1';
export const PHARMACY_INITIAL_RICH_MENU_IMAGE_PATH =
  '/custom/pharmacy/rich-menu/initial-large-3x2-v4.jpg';
export const PHARMACY_PREVIOUS_INITIAL_RICH_MENU_IMAGE_PATH =
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
  return cells.map((cell, index) => buildArea(liffId, cell, index));
}

function buildArea(liffId: string, cell: MenuCell, index: number) {
  return {
    boundsX: COLUMN_X[index % 3],
    boundsY: index < 3 ? 0 : COMPACT_HEIGHT,
    boundsWidth: COLUMN_WIDTHS[index % 3],
    boundsHeight: COMPACT_HEIGHT,
    actionType: cell.page ? 'uri' as const : 'message' as const,
    actionData: cell.page
      ? { uri: liffPageUrl(liffId, cell.page) }
      : { text: cell.label },
  };
}

const CATALOG_CELLS: Record<PharmacyRichMenuActionKey, MenuCell> = {
  'prescription-send': { page: 'pharmacy-prescription-send', label: '処方せん送信' },
  'prescription-history': { page: 'pharmacy-prescription-history', label: '受付状況' },
  'medication-followup': { page: 'pharmacy-followup', label: '服薬後フォロー' },
  'manual-chat': { page: null, label: '薬局へ相談' },
  'pharmacy-info': { page: 'pharmacy-info', label: '薬局情報' },
};
const LEGAL_CATALOG_ORDERS = new Set(
  listPharmacyRichMenuVariantOrders().map((order) => order.join()),
);

export function getPharmacyRichMenuCatalogPreview(
  liffId: string,
  orderedActions: readonly PharmacyRichMenuActionKey[],
) {
  if (!liffId || !LEGAL_CATALOG_ORDERS.has(orderedActions.join())) {
    throw new Error('unsupported pharmacy rich-menu catalog order');
  }
  const keys = [...orderedActions, 'all-functions' as const];
  return buildCatalogAreas(liffId, orderedActions).map(({ actionData: _actionData, ...area }, index) => ({
    ...area,
    actionKey: keys[index],
    label: keys[index] === 'all-functions' ? 'すべての機能' : CATALOG_CELLS[keys[index]].label,
  }));
}

function buildCatalogAreas(
  liffId: string,
  orderedActions: readonly PharmacyRichMenuActionKey[],
): RichMenuAreaInput[] {
  const presentation = getPharmacyRichMenuPresentation(orderedActions);
  const cells = [...orderedActions.map((key) => CATALOG_CELLS[key]), {
    page: 'pharmacy-menu', label: 'すべての機能',
  }];
  return cells.map((cell, index) => {
    const bounds = presentation.bounds[index];
    return {
      boundsX: bounds.x,
      boundsY: bounds.y,
      boundsWidth: bounds.width,
      boundsHeight: bounds.height,
      actionType: cell.page ? 'uri' as const : 'message' as const,
      actionData: cell.page
        ? { uri: liffPageUrl(liffId, cell.page) }
        : { text: cell.label },
    };
  });
}

export function buildPharmacyCatalogRichMenu(
  accountId: string,
  liffId: string,
  orderedActions: readonly PharmacyRichMenuActionKey[],
  name: string,
): CreateRichMenuGroupInput {
  requireRichMenuInput(accountId, liffId);
  const displayName = name.trim();
  if (!displayName || displayName.length > 80) throw new Error('name must be 1-80 characters');
  if (!LEGAL_CATALOG_ORDERS.has(orderedActions.join())) {
    throw new Error('unsupported pharmacy rich-menu catalog order');
  }
  const presentation = getPharmacyRichMenuPresentation(orderedActions);
  const areas = buildCatalogAreas(liffId, orderedActions);
  return {
    accountId,
    name: displayName,
    chatBarText: 'メニュー',
    size: presentation.size,
    selected: true,
    generatorKey: null,
    generatorVersion: PHARMACY_RICH_MENU_CATALOG_VERSION,
    pages: [{ name: 'メニュー', orderIndex: 0, areas }],
  };
}

export function diagnosePharmacyRichMenuActions(
  areas: readonly RichMenuAreaInput[],
  liffId: string,
  orderedActions: readonly PharmacyRichMenuActionKey[],
): string[] {
  const expected = buildCatalogAreas(liffId, orderedActions);
  if (areas.length !== expected.length) return ['ACTION_COUNT_INVALID'];
  const reasons: string[] = [];
  areas.forEach((area, index) => {
    const target = expected[index];
    if (area.boundsX !== target.boundsX || area.boundsY !== target.boundsY ||
        area.boundsWidth !== target.boundsWidth || area.boundsHeight !== target.boundsHeight) {
      reasons.push('ACTION_BOUNDS_INVALID');
    }
    if (area.actionType !== target.actionType) {
      reasons.push('ACTION_TYPE_INVALID');
    } else if (area.actionType === 'uri' && area.actionData.uri !== target.actionData.uri) {
      reasons.push('ACTION_URI_INVALID');
    } else if (area.actionType === 'message' && area.actionData.text !== target.actionData.text) {
      reasons.push('ACTION_MESSAGE_INVALID');
    }
  });
  return [...new Set(reasons)];
}

export async function hashPharmacyRichMenuManifest(
  areas: readonly RichMenuAreaInput[],
): Promise<string> {
  const canonical = areas.map((area) => ({
    boundsX: area.boundsX,
    boundsY: area.boundsY,
    boundsWidth: area.boundsWidth,
    boundsHeight: area.boundsHeight,
    actionType: area.actionType,
    actionData: Object.fromEntries(Object.entries(area.actionData).sort(([left], [right]) =>
      left.localeCompare(right))),
  })).sort((left, right) => left.boundsY - right.boundsY || left.boundsX - right.boundsX);
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type PharmacyRichMenuSlotDiff = {
  kind: 'same' | 'added' | 'removed' | 'moved' | 'action_changed' | 'image_changed';
  currentIndex: number | null;
  draftIndex: number | null;
};

function orderedManifest(areas: readonly RichMenuAreaInput[]) {
  return [...areas].sort((left, right) =>
    left.boundsY - right.boundsY || left.boundsX - right.boundsX,
  );
}

function actionIdentity(area: RichMenuAreaInput): string {
  return `${area.actionType}:${JSON.stringify(Object.fromEntries(
    Object.entries(area.actionData).sort(([left], [right]) => left.localeCompare(right)),
  ))}`;
}

export function diffPharmacyRichMenuManifests(
  currentAreas: readonly RichMenuAreaInput[],
  draftAreas: readonly RichMenuAreaInput[],
  currentImageHash: string,
  draftImageHash: string,
): { imageChanged: boolean; slots: PharmacyRichMenuSlotDiff[] } {
  const current = orderedManifest(currentAreas).map(actionIdentity);
  const draft = orderedManifest(draftAreas).map(actionIdentity);
  const usedCurrent = new Set<number>();
  const slots: Array<PharmacyRichMenuSlotDiff | null> = draft.map(() => null);

  draft.forEach((action, draftIndex) => {
    if (current[draftIndex] === action) {
      usedCurrent.add(draftIndex);
      slots[draftIndex] = { kind: 'same', currentIndex: draftIndex, draftIndex };
    }
  });
  draft.forEach((action, draftIndex) => {
    if (slots[draftIndex]) return;
    const currentIndex = current.findIndex((candidate, index) =>
      !usedCurrent.has(index) && candidate === action,
    );
    if (currentIndex >= 0) {
      usedCurrent.add(currentIndex);
      slots[draftIndex] = { kind: 'moved', currentIndex, draftIndex };
    }
  });
  draft.forEach((_action, draftIndex) => {
    if (slots[draftIndex]) return;
    if (draftIndex < current.length && !usedCurrent.has(draftIndex)) {
      usedCurrent.add(draftIndex);
      slots[draftIndex] = { kind: 'action_changed', currentIndex: draftIndex, draftIndex };
    } else {
      slots[draftIndex] = { kind: 'added', currentIndex: null, draftIndex };
    }
  });

  const imageChanged = currentImageHash !== draftImageHash;
  const result = slots.map((slot) => {
    if (!slot) throw new Error('pharmacy rich-menu diff slot missing');
    return imageChanged && slot.kind === 'same' ? { ...slot, kind: 'image_changed' as const } : slot;
  });
  current.forEach((_action, currentIndex) => {
    if (!usedCurrent.has(currentIndex)) {
      result.push({ kind: 'removed', currentIndex, draftIndex: null });
    }
  });
  return { imageChanged, slots: result };
}

export function buildPharmacyInitialRichMenu(
  accountId: string,
  liffId: string,
): CreateRichMenuGroupInput {
  return buildLargeInitialRichMenu(
    accountId,
    liffId,
    { page: 'pharmacy-prescription-send', label: '処方せん送信' },
    PHARMACY_INITIAL_PROFILE_KEY,
    PHARMACY_RICH_MENU_GENERATOR_VERSION,
  );
}

export function buildPharmacyPreviousInitialRichMenu(
  accountId: string,
  liffId: string,
): CreateRichMenuGroupInput {
  return buildLargeInitialRichMenu(
    accountId,
    liffId,
    { page: 'pharmacy-emergency-contraception', label: '緊急避妊薬' },
    PHARMACY_PREVIOUS_INITIAL_PROFILE_KEY,
    PHARMACY_PREVIOUS_RICH_MENU_GENERATOR_VERSION,
  );
}

function buildLargeInitialRichMenu(
  accountId: string,
  liffId: string,
  firstCell: MenuCell,
  generatorKey: string,
  generatorVersion: string,
): CreateRichMenuGroupInput {
  requireRichMenuInput(accountId, liffId);

  const cells = [
    firstCell,
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
    generatorKey,
    generatorVersion,
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
    profileKey === PHARMACY_PREVIOUS_INITIAL_PROFILE_KEY ||
    profileKey === PHARMACY_LEGACY_INITIAL_PROFILE_KEY ||
    profileKey === PHARMACY_SINGLE_ACTION_PROFILE_KEY;
}

export {
  WIDTH as PHARMACY_RICH_MENU_WIDTH,
  LARGE_HEIGHT as PHARMACY_RICH_MENU_HEIGHT,
};
