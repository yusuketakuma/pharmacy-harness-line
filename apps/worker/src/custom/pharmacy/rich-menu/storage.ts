import { setRichMenuPageImage } from '@line-crm/db';
import { validateRichMenuImage } from '../../../lib/image-validator.js';

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function savePharmacyRichMenuImage(input: {
  db: D1Database;
  images: R2Bucket;
  accountId: string;
  groupId: string;
  pageId: string;
  fileName: string;
  contentType: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
  expectedSize?: 'large' | 'compact';
}): Promise<{
  imageR2Key: string;
  imageContentType: 'image/png' | 'image/jpeg';
  size: 'large' | 'compact';
}> {
  if (!SAFE_FILE_NAME.test(input.fileName)) {
    throw new Error('fileName must be a simple image file name');
  }
  const validation = validateRichMenuImage(input.bytes, input.bytes.byteLength);
  if (!validation.ok) throw new Error(validation.error);
  if (input.expectedSize && validation.size !== input.expectedSize) {
    throw new Error(`image size '${validation.size}' does not match expected '${input.expectedSize}'`);
  }
  const extension = input.contentType === 'image/png' ? '.png' : '.jpg';
  if (!input.fileName.toLowerCase().endsWith(extension)) {
    throw new Error(`fileName must end with ${extension}`);
  }

  const imageR2Key = `rich-menus/${input.accountId}/${input.groupId}/${input.pageId}/${input.fileName}`;
  await input.images.put(imageR2Key, input.bytes, {
    httpMetadata: { contentType: input.contentType },
  });
  await setRichMenuPageImage(input.db, input.pageId, imageR2Key, input.contentType);
  return {
    imageR2Key,
    imageContentType: input.contentType,
    size: validation.size,
  };
}
