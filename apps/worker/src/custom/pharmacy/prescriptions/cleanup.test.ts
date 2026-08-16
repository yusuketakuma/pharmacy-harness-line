import { describe, expect, it, vi } from 'vitest';
import { cleanupPrescriptionImages } from './cleanup.js';

type Candidate = {
  file_id: string;
  submission_id: string;
  r2_key: string;
  revision: number;
  state: 'pending' | 'ready' | 'deleted';
};

function fakeDb(candidates: Candidate[], claimChanges = 1) {
  const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        all: async () => {
          calls.push({ sql, values, operation: 'all' });
          return { results: candidates };
        },
        run: async () => {
          calls.push({ sql, values, operation: 'run' });
          return { success: true, meta: { changes: claimChanges } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, calls };
}

const now = new Date('2026-08-17T12:00:00.000Z');
const candidate: Candidate = {
  file_id: 'file-1',
  submission_id: 'submission-1',
  r2_key: 'custom/pharmacy/prescriptions/submission-1/1/file-1',
  revision: 1,
  state: 'ready',
};

describe('prescription image retention cleanup', () => {
  it('uses exact 24-hour and 30-day inclusive boundaries with a bounded batch', async () => {
    const { db, calls } = fakeDb([]);
    const images = { delete: vi.fn() } as unknown as R2Bucket;

    await cleanupPrescriptionImages(db, images, { now, limit: 25 });

    expect(calls[0].values).toEqual([
      '2026-08-16T12:00:00.000Z',
      '2026-08-16T12:00:00.000Z',
      '2026-08-16T12:00:00.000Z',
      '2026-07-18T12:00:00.000Z',
      25,
    ]);
    expect(calls[0].sql).toContain('f.updated_at <= ?');
    expect(calls[0].sql).toContain('s.closed_at <= ?');
    expect(calls[0].sql).toContain("reason_code = 'patient_cancelled'");
    expect(calls[0].sql).toContain("reason_code = 'admin_cancelled'");
    expect(calls[0].sql).toContain('LIMIT ?');
  });

  it('conditionally marks due files before deleting R2 and records deletion afterwards', async () => {
    const { db, calls } = fakeDb([candidate]);
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(cleanupPrescriptionImages(
      db,
      { delete: remove } as unknown as R2Bucket,
      { now },
    )).resolves.toEqual({ claimed: 1, deleted: 1, failed: 0, skipped: 0 });

    const claimIndex = calls.findIndex((call) => call.sql.includes("SET state = 'deleted'"));
    const eventIndex = calls.findIndex((call) =>
      call.operation === 'run' && call.sql.includes('INSERT INTO pharmacy_prescription_events'),
    );
    expect(claimIndex).toBeGreaterThan(0);
    expect(eventIndex).toBeGreaterThan(claimIndex);
    expect(remove).toHaveBeenCalledWith(candidate.r2_key);
    expect(calls[claimIndex].sql).toContain("s.status IN ('received','needs_resubmission','accepted','ready')");
    expect(calls[claimIndex].sql).toContain('f.revision = s.active_revision');
  });

  it('leaves a claimed file retryable when R2 deletion fails', async () => {
    const { db, calls } = fakeDb([candidate]);
    const remove = vi.fn().mockRejectedValue(new Error('R2 unavailable'));

    await expect(cleanupPrescriptionImages(
      db,
      { delete: remove } as unknown as R2Bucket,
      { now },
    )).resolves.toEqual({ claimed: 1, deleted: 0, failed: 1, skipped: 0 });

    expect(calls.some((call) =>
      call.operation === 'run' && call.sql.includes('INSERT INTO pharmacy_prescription_events'),
    )).toBe(false);
    expect(calls[0].sql).toContain("f.state = 'deleted'");
    expect(calls[0].sql).toContain("event_type = 'file_deleted'");
  });

  it('retries an already claimed object without claiming it twice', async () => {
    const { db, calls } = fakeDb([{ ...candidate, state: 'deleted' }]);
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(cleanupPrescriptionImages(
      db,
      { delete: remove } as unknown as R2Bucket,
      { now },
    )).resolves.toEqual({ claimed: 0, deleted: 1, failed: 0, skipped: 0 });

    expect(calls.filter((call) => call.sql.includes("SET state = 'deleted'"))).toHaveLength(0);
  });

  it('skips deletion when a conditional claim loses a race', async () => {
    const { db } = fakeDb([candidate], 0);
    const remove = vi.fn();

    await expect(cleanupPrescriptionImages(
      db,
      { delete: remove } as unknown as R2Bucket,
      { now },
    )).resolves.toEqual({ claimed: 0, deleted: 0, failed: 0, skipped: 1 });
    expect(remove).not.toHaveBeenCalled();
  });
});
