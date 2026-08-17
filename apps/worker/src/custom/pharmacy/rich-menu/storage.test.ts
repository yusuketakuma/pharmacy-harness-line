import { beforeEach, describe, expect, it, vi } from 'vitest';

const setRichMenuPageImage = vi.fn();
vi.mock('@line-crm/db', () => ({ setRichMenuPageImage }));

const { savePharmacyRichMenuImage } = await import('./storage.js');

const PNG_2500x843 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x09, 0xc4, 0x00, 0x00, 0x03, 0x4b,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

describe('pharmacy rich-menu image storage', () => {
  beforeEach(() => setRichMenuPageImage.mockReset());

  it('validates and stores a deterministic custom image key', async () => {
    const put = vi.fn();
    const result = await savePharmacyRichMenuImage({
      db: {} as D1Database,
      images: { put } as unknown as R2Bucket,
      accountId: 'account-a',
      groupId: 'group-a',
      pageId: 'page-a',
      fileName: 'initial-compact-3x1.png',
      contentType: 'image/png',
      bytes: PNG_2500x843,
    });

    expect(result).toEqual({
      imageR2Key: 'rich-menus/account-a/group-a/page-a/initial-compact-3x1.png',
      imageContentType: 'image/png',
      size: 'compact',
    });
    expect(put).toHaveBeenCalledWith(
      result.imageR2Key,
      PNG_2500x843,
      { httpMetadata: { contentType: 'image/png' } },
    );
    expect(setRichMenuPageImage).toHaveBeenCalledWith(
      expect.anything(), 'page-a', result.imageR2Key, 'image/png',
    );
  });

  it('rejects a key that could escape the page storage prefix', async () => {
    await expect(savePharmacyRichMenuImage({
      db: {} as D1Database,
      images: { put: vi.fn() } as unknown as R2Bucket,
      accountId: 'account-a',
      groupId: 'group-a',
      pageId: 'page-a',
      fileName: '../other.png',
      contentType: 'image/png',
      bytes: PNG_2500x843,
    })).rejects.toThrow(/fileName/i);
  });

  it('checks the expected LINE menu size before writing', async () => {
    const put = vi.fn();
    await expect(savePharmacyRichMenuImage({
      db: {} as D1Database,
      images: { put } as unknown as R2Bucket,
      accountId: 'account-a',
      groupId: 'group-a',
      pageId: 'page-a',
      fileName: 'initial-compact-3x1.png',
      contentType: 'image/png',
      bytes: PNG_2500x843,
      expectedSize: 'large',
    })).rejects.toThrow(/expected 'large'/i);
    expect(put).not.toHaveBeenCalled();
  });
});
