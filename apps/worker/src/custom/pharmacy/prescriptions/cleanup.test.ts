import { describe, expect, it, vi } from 'vitest';
import { cleanupPrescriptionImages } from './cleanup.js';

// I19-R2: all prescription images are inside the uniform 3-year retention
// scope, so the former workflow cleanup must never physically delete. Physical
// deletion is exclusive to the recovery-gated retention purge.
describe('prescription image cleanup (I19-R2 fail-closed)', () => {
  it('never touches D1 or R2 and reports zero counts', async () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('cleanup must not query D1');
      }),
    } as unknown as D1Database;
    const images = {
      delete: vi.fn(() => Promise.reject(new Error('cleanup must not delete R2 objects'))),
    } as unknown as R2Bucket;

    await expect(
      cleanupPrescriptionImages(db, images, { now: new Date('2026-09-17T00:00:00.000Z'), limit: 25 }),
    ).resolves.toEqual({ claimed: 0, deleted: 0, failed: 0, skipped: 0 });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(images.delete).not.toHaveBeenCalled();
  });
});
