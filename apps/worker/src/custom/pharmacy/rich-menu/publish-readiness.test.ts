import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPharmacyCatalogRichMenu, hashPharmacyRichMenuManifest } from './profile.js';

const repositories = vi.hoisted(() => ({ binding: vi.fn(), layout: vi.fn() }));
vi.mock('./repository.js', () => ({
  getPharmacyRichMenuDraftBinding: repositories.binding,
  getPharmacyRichMenuLayout: repositories.layout,
}));
const capabilities = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../growth-loop/repository.js', () => ({ getPharmacyCapabilityConfig: capabilities.get }));
const catalog = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./catalog.js', () => ({
  PHARMACY_RICH_MENU_CATALOG_VERSION: 'v4-2',
  loadPharmacyRichMenuCatalogImage: catalog.load,
}));

const { getPharmacyRichMenuPublishReadiness } = await import('./publish-readiness.js');
const image = new Uint8Array(readFileSync(resolve(
  process.cwd(), 'public/custom/pharmacy/rich-menu/initial-compact-3x1.jpg',
)));
const imageHash = createHash('sha256').update(image).digest('hex');
const liffId = '1234567890-AbCd';
const liffIdHash = createHash('sha256').update(liffId).digest('hex');
const input = buildPharmacyCatalogRichMenu(
  'account-a', liffId, ['manual-chat', 'pharmacy-info'], '夜間向けメニュー',
);
let baseBinding: Record<string, unknown>;

function group() {
  return {
    id: 'group-a', account_id: 'account-a', name: input.name, chat_bar_text: input.chatBarText,
    size: 'compact', default_page_id: 'page-a', is_default_for_all: 0, selected: 1,
    status: 'draft', publishing_at: null, generator_key: null, generator_version: 'v4-2',
    created_at: '2026-08-21T00:00:00Z', updated_at: '2026-08-21T00:00:00Z',
    pages: [{
      id: 'page-a', group_id: 'group-a', order_index: 0, name: 'メニュー', alias_id: 'alias-a',
      line_richmenu_id: null,
      image_r2_key: 'rich-menus/account-a/group-a/page-a/v4-compact-manual-chat.pharmacy-info.jpg',
      image_content_type: 'image/jpeg', created_at: '', updated_at: '',
      areas: input.pages[0].areas.map((area, index) => ({
        id: `area-${index}`, page_id: 'page-a', bounds_x: area.boundsX, bounds_y: area.boundsY,
        bounds_width: area.boundsWidth, bounds_height: area.boundsHeight,
        action_type: area.actionType, action_data: JSON.stringify(area.actionData), actionData: area.actionData,
        created_at: '', updated_at: '',
      })),
    }],
  } as any;
}

beforeEach(async () => {
  vi.clearAllMocks();
  const manifestHash = await hashPharmacyRichMenuManifest(input.pages[0].areas);
  baseBinding = {
    groupId: 'group-a', lineAccountId: 'account-a', layoutRevision: 2, capabilityRevision: 7,
    liffIdHash, catalogVersion: 'v4-2', menuSize: 'compact',
    catalogVariantKey: 'v4-compact-manual-chat.pharmacy-info',
    catalogObjectKey: 'rich-menu-catalog/v4-2/v4-compact-manual-chat.pharmacy-info.jpg',
    manifestHash, imageHash, createdAt: '2026-08-21T00:00:00Z',
  };
  repositories.binding.mockResolvedValue(baseBinding);
  repositories.layout.mockResolvedValue({
    lineAccountId: 'account-a', revision: 2,
    preferredOrder: ['prescription-send', 'prescription-history', 'medication-followup', 'manual-chat', 'pharmacy-info'],
  });
  capabilities.get.mockResolvedValue({
    revision: 7, capabilities: ['manual_chat', 'pharmacy_info', 'pharmacy_rich_menu'],
  });
  catalog.load.mockResolvedValue({
    variantKey: 'v4-compact-manual-chat.pharmacy-info', orderedActions: ['manual-chat', 'pharmacy-info'],
    objectKey: 'rich-menu-catalog/v4-2/v4-compact-manual-chat.pharmacy-info.jpg', imageHash,
    contentType: 'image/jpeg', width: 2500, height: 843, size: 'compact',
    bytes: image, byteLength: image.byteLength,
  });
});

function images(bytes = image) {
  return { get: vi.fn(async () => ({
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    httpMetadata: { contentType: 'image/jpeg' },
  })) } as unknown as R2Bucket;
}

describe('pharmacy rich-menu publish readiness', () => {
  it('returns READY only when every immutable evidence value still matches', async () => {
    await expect(getPharmacyRichMenuPublishReadiness({
      db: {} as D1Database, images: images(), accountId: 'account-a', liffId, group: group(),
    })).resolves.toMatchObject({ status: 'READY', reasonCodes: [], evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('reuses the same evidence gate when switching a published saved version', async () => {
    const published = group();
    published.status = 'published';
    await expect(getPharmacyRichMenuPublishReadiness({
      db: {} as D1Database, images: images(), accountId: 'account-a', liffId,
      group: published, requiredStatus: 'published',
    })).resolves.toMatchObject({ status: 'READY', reasonCodes: [] });
  });

  it('blocks stale capabilities before reading catalog or copied image bytes', async () => {
    capabilities.get.mockResolvedValue({ revision: 8, capabilities: ['manual_chat'] });
    const bucket = images();
    const readiness = await getPharmacyRichMenuPublishReadiness({
      db: {} as D1Database, images: bucket, accountId: 'account-a', liffId, group: group(),
    });

    expect(readiness).toMatchObject({ status: 'BLOCKED', reasonCodes: expect.arrayContaining(['CAPABILITY_REVISION_STALE']) });
    expect(catalog.load).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('blocks action or copied-image changes', async () => {
    const changedGroup = group();
    changedGroup.pages[0].areas[0].actionData = { text: 'changed' };
    const actionReadiness = await getPharmacyRichMenuPublishReadiness({
      db: {} as D1Database, images: images(), accountId: 'account-a', liffId, group: changedGroup,
    });
    expect(actionReadiness.reasonCodes).toContain('ACTION_MANIFEST_CHANGED');

    const changed = image.slice();
    changed[changed.length - 1] ^= 1;
    const imageReadiness = await getPharmacyRichMenuPublishReadiness({
      db: {} as D1Database, images: images(changed), accountId: 'account-a', liffId, group: group(),
    });
    expect(imageReadiness.reasonCodes).toContain('SAVED_IMAGE_CHANGED');
  });

  it('blocks an invalid tap manifest even when its stored hash matches', async () => {
    const cases = [
      {
        reason: 'ACTION_URI_INVALID',
        mutate: (candidate: ReturnType<typeof group>) => {
          candidate.pages[0].areas[1].actionData = {
            uri: `https://example.test/${liffId}/?page=unknown&liffId=${liffId}`,
          };
        },
      },
      {
        reason: 'ACTION_URI_INVALID',
        mutate: (candidate: ReturnType<typeof group>) => {
          candidate.pages[0].areas[1].actionData = {
            uri: 'https://liff.line.me/9999999999-Wrong/?page=pharmacy-info&liffId=9999999999-Wrong',
          };
        },
      },
      {
        reason: 'ACTION_URI_INVALID',
        mutate: (candidate: ReturnType<typeof group>) => {
          candidate.pages[0].areas[1].actionData = {
            uri: `https://liff.line.me/${liffId}/?page=pharmacy-prescription-send&liffId=${liffId}`,
          };
        },
      },
      {
        reason: 'ACTION_MESSAGE_INVALID',
        mutate: (candidate: ReturnType<typeof group>) => {
          candidate.pages[0].areas[0].actionData = { text: '自由入力メッセージ' };
        },
      },
      {
        reason: 'ACTION_COUNT_INVALID',
        mutate: (candidate: ReturnType<typeof group>) => {
          candidate.pages[0].areas.pop();
        },
      },
    ];

    for (const item of cases) {
      const candidate = group();
      item.mutate(candidate);
      const areas = candidate.pages[0].areas.map((area: any) => ({
        boundsX: area.bounds_x,
        boundsY: area.bounds_y,
        boundsWidth: area.bounds_width,
        boundsHeight: area.bounds_height,
        actionType: area.action_type,
        actionData: area.actionData,
      }));
      repositories.binding.mockResolvedValue({
        ...baseBinding,
        manifestHash: await hashPharmacyRichMenuManifest(areas),
      });

      const readiness = await getPharmacyRichMenuPublishReadiness({
        db: {} as D1Database,
        images: images(),
        accountId: 'account-a',
        liffId,
        group: candidate,
      });

      expect(readiness.reasonCodes).toContain(item.reason);
    }
  });
});
