export interface PrescriptionCleanupOptions {
  now?: Date;
  limit?: number;
}

// I19-R2 (audit v4): every prescription image, including cancelled, stale-draft,
// and closed submissions, is inside the uniform 3-year retention scope
// (docs/pharmacy/RETENTION_MATRIX.md). Physical deletion is exclusive to the
// recovery-gated retention purge (retention-purge.ts), so this former
// workflow-cleanup cron entry is a fail-closed no-op. Rows previously claimed
// as state='deleted' are left for the same gated purge rather than deleted
// out-of-band here.
export async function cleanupPrescriptionImages(
  _db: D1Database,
  _images: R2Bucket,
  _options: PrescriptionCleanupOptions = {},
): Promise<{ claimed: number; deleted: number; failed: number; skipped: number }> {
  return { claimed: 0, deleted: 0, failed: 0, skipped: 0 };
}
