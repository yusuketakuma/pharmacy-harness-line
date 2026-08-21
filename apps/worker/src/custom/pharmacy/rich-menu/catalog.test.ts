import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PHARMACY_RICH_MENU_CATALOG_MANIFEST_KEY,
  PHARMACY_RICH_MENU_CATALOG_VERSION,
  loadPharmacyRichMenuCatalogImage,
} from './catalog.js';
import { getPharmacyRichMenuPresentation, listPharmacyRichMenuVariantOrders } from './layout.js';

const image = new Uint8Array(readFileSync(resolve(
  process.cwd(), 'public/custom/pharmacy/rich-menu/initial-large-3x2-v4.jpg',
)));
const imageHash = createHash('sha256').update(image).digest('hex');
const compactImage = new Uint8Array(readFileSync(resolve(
  process.cwd(), 'public/custom/pharmacy/rich-menu/initial-single-action-v1.jpg',
)));
const compactImageHash = createHash('sha256').update(compactImage).digest('hex');

function variantKey(order: Parameters<typeof getPharmacyRichMenuPresentation>[0]) {
  return getPharmacyRichMenuPresentation(order).variantKey;
}

function manifest() {
  return {
    catalogVersion: PHARMACY_RICH_MENU_CATALOG_VERSION,
    entries: listPharmacyRichMenuVariantOrders().map((orderedActions) => {
      const key = variantKey(orderedActions);
      const presentation = getPharmacyRichMenuPresentation(orderedActions);
      const catalogImage = presentation.size === 'compact' ? compactImage : image;
      return {
        variantKey: key,
        orderedActions,
        objectKey: `rich-menu-catalog/${PHARMACY_RICH_MENU_CATALOG_VERSION}/${key}.jpg`,
        imageHash: presentation.size === 'compact' ? compactImageHash : imageHash,
        width: 2500,
        height: presentation.height,
        size: presentation.size,
        contentType: 'image/jpeg',
        bytes: catalogImage.byteLength,
      };
    }),
  };
}

function bucket(value = manifest(), bytes = image) {
  const get = vi.fn(async (key: string) => key === PHARMACY_RICH_MENU_CATALOG_MANIFEST_KEY
    ? { text: async () => JSON.stringify(value) }
    : {
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        httpMetadata: { contentType: 'image/jpeg' },
      });
  return { bucket: { get } as unknown as R2Bucket, get };
}

describe('pharmacy rich-menu static catalog', () => {
  it('uses a new immutable prefix for the v0.30.0 catalog', () => {
    expect(PHARMACY_RICH_MENU_CATALOG_VERSION).toBe('v4-3');
    expect(PHARMACY_RICH_MENU_CATALOG_MANIFEST_KEY).toBe('rich-menu-catalog/v4-3/manifest.json');
  });

  it('loads only the exact server-derived variant and verifies its bytes', async () => {
    const { bucket: images, get } = bucket();
    const result = await loadPharmacyRichMenuCatalogImage(images, [
      'prescription-send', 'prescription-history', 'manual-chat',
    ]);

    expect(result).toMatchObject({
      variantKey: 'v4-large-prescription-send.prescription-history.manual-chat',
      imageHash,
      contentType: 'image/jpeg',
    });
    expect(result.bytes).toEqual(image);
    expect(get).toHaveBeenNthCalledWith(1, PHARMACY_RICH_MENU_CATALOG_MANIFEST_KEY);
    expect(get).toHaveBeenNthCalledWith(
      2,
      `rich-menu-catalog/${PHARMACY_RICH_MENU_CATALOG_VERSION}/v4-large-prescription-send.prescription-history.manual-chat.jpg`,
    );
  });

  it('loads the compact catalog image when three cells fit in one row', async () => {
    const { bucket: images } = bucket(manifest(), compactImage);
    await expect(loadPharmacyRichMenuCatalogImage(images, [
      'manual-chat', 'pharmacy-info',
    ])).resolves.toMatchObject({
      size: 'compact', height: 843,
      variantKey: 'v4-compact-manual-chat.pharmacy-info',
      imageHash: compactImageHash,
    });
  });

  it('fails closed when one of the 228 legal variants is missing', async () => {
    const value = manifest();
    value.entries.pop();
    const { bucket: images, get } = bucket(value);

    await expect(loadPharmacyRichMenuCatalogImage(images, [])).rejects.toThrow(/228|catalog/i);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('fails closed when stored bytes do not match the release manifest hash', async () => {
    const changed = image.slice();
    changed[changed.length - 1] ^= 1;
    const { bucket: images } = bucket(manifest(), changed);

    await expect(loadPharmacyRichMenuCatalogImage(images, [
      'prescription-send', 'prescription-history', 'manual-chat',
    ])).rejects.toThrow(/hash/i);
  });
});
