import { validateRichMenuImage } from '../../../lib/image-validator.js';
import {
  listPharmacyRichMenuVariantOrders,
  getPharmacyRichMenuPresentation,
  type PharmacyRichMenuActionKey,
  type PharmacyRichMenuSize,
} from './layout.js';
import { sha256Hex } from './hash.js';

export const PHARMACY_RICH_MENU_CATALOG_VERSION = 'v4-5';
const CATALOG_PREFIX = `rich-menu-catalog/${PHARMACY_RICH_MENU_CATALOG_VERSION}`;
export const PHARMACY_RICH_MENU_CATALOG_MANIFEST_KEY = `${CATALOG_PREFIX}/manifest.json`;

export type PharmacyRichMenuCatalogEntry = {
  variantKey: string;
  orderedActions: PharmacyRichMenuActionKey[];
  objectKey: string;
  imageHash: string;
  width: 2500;
  height: 843 | 1686;
  size: PharmacyRichMenuSize;
  contentType: 'image/jpeg';
  bytes: number;
};

const expectedOrders = new Map(listPharmacyRichMenuVariantOrders().map((order) => {
  const presentation = getPharmacyRichMenuPresentation(order);
  return [presentation.variantKey, { order, presentation }] as const;
}));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCatalog(value: unknown): Map<string, PharmacyRichMenuCatalogEntry> {
  if (!isRecord(value) || value.catalogVersion !== PHARMACY_RICH_MENU_CATALOG_VERSION ||
      !Array.isArray(value.entries) || value.entries.length !== expectedOrders.size ||
      expectedOrders.size !== 228) {
    throw new Error('pharmacy rich-menu catalog must contain exactly 228 variants');
  }
  const entries = new Map<string, PharmacyRichMenuCatalogEntry>();
  for (const raw of value.entries) {
    if (!isRecord(raw) || typeof raw.variantKey !== 'string' || !Array.isArray(raw.orderedActions) ||
        raw.orderedActions.some((key) => typeof key !== 'string') ||
        typeof raw.objectKey !== 'string' || typeof raw.imageHash !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(raw.imageHash) || raw.width !== 2500 ||
        (raw.height !== 843 && raw.height !== 1686) ||
        (raw.size !== 'compact' && raw.size !== 'large') ||
        raw.contentType !== 'image/jpeg' || !Number.isInteger(raw.bytes) ||
        Number(raw.bytes) <= 0 || Number(raw.bytes) > 1_000_000) {
      throw new Error('invalid pharmacy rich-menu catalog entry');
    }
    const expected = expectedOrders.get(raw.variantKey);
    if (!expected || expected.order.join() !== raw.orderedActions.join() ||
        raw.size !== expected.presentation.size || raw.height !== expected.presentation.height ||
        raw.objectKey !== `${CATALOG_PREFIX}/${raw.variantKey}.jpg` || entries.has(raw.variantKey)) {
      throw new Error('pharmacy rich-menu catalog entry does not match its variant');
    }
    entries.set(raw.variantKey, raw as PharmacyRichMenuCatalogEntry);
  }
  if ([...expectedOrders.keys()].some((key) => !entries.has(key))) {
    throw new Error('pharmacy rich-menu catalog is incomplete');
  }
  return entries;
}

export async function loadPharmacyRichMenuCatalogImage(
  images: R2Bucket,
  orderedActions: readonly PharmacyRichMenuActionKey[],
): Promise<Omit<PharmacyRichMenuCatalogEntry, 'bytes'> & { bytes: Uint8Array; byteLength: number }> {
  const variantKey = getPharmacyRichMenuPresentation(orderedActions).variantKey;
  const expected = expectedOrders.get(variantKey);
  if (!expected || expected.order.join() !== orderedActions.join()) {
    throw new Error('unsupported pharmacy rich-menu catalog variant');
  }
  const manifestObject = await images.get(PHARMACY_RICH_MENU_CATALOG_MANIFEST_KEY);
  if (!manifestObject) throw new Error('pharmacy rich-menu catalog manifest is missing');
  const manifestText = await manifestObject.text();
  if (manifestText.length > 1_000_000) throw new Error('pharmacy rich-menu catalog manifest is too large');
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('pharmacy rich-menu catalog manifest is invalid JSON');
  }
  const entry = validateCatalog(manifest).get(variantKey);
  if (!entry) throw new Error('pharmacy rich-menu catalog variant is missing');

  const imageObject = await images.get(entry.objectKey);
  if (!imageObject) throw new Error('pharmacy rich-menu catalog image is missing');
  const bytes = new Uint8Array(await imageObject.arrayBuffer());
  if (bytes.byteLength !== entry.bytes || imageObject.httpMetadata?.contentType !== entry.contentType) {
    throw new Error('pharmacy rich-menu catalog image metadata does not match manifest');
  }
  const validation = validateRichMenuImage(bytes, bytes.byteLength);
  if (!validation.ok || validation.size !== entry.size || validation.format !== 'jpeg') {
    throw new Error('pharmacy rich-menu catalog image is not LINE-compliant');
  }
  if (await sha256Hex(bytes) !== entry.imageHash) {
    throw new Error('pharmacy rich-menu catalog image hash does not match manifest');
  }
  return { ...entry, bytes, byteLength: entry.bytes };
}
