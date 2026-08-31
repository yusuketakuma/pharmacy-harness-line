import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBroadcastById: vi.fn(),
  getBroadcasts: vi.fn(),
  getQueuedBroadcasts: vi.fn(),
  updateBroadcastStatus: vi.fn(),
  pharmacyMode: vi.fn(),
  processMultiAccountDedupBroadcast: vi.fn(),
  autoTrackContent: vi.fn(),
}));

vi.mock('@line-crm/db', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@line-crm/db')),
  getBroadcastById: mocks.getBroadcastById,
  getBroadcasts: mocks.getBroadcasts,
  getQueuedBroadcasts: mocks.getQueuedBroadcasts,
  updateBroadcastStatus: mocks.updateBroadcastStatus,
}));

vi.mock('../custom/pharmacy/growth-loop/access.js', () => ({
  isPharmacyModeAccount: mocks.pharmacyMode,
}));

vi.mock('./dedup-broadcast.js', () => ({
  processMultiAccountDedupBroadcast: mocks.processMultiAccountDedupBroadcast,
}));

vi.mock('./auto-track.js', () => ({
  autoTrackContent: mocks.autoTrackContent,
}));

import {
  processBroadcastSend,
  processQueuedBroadcasts,
  processScheduledBroadcasts,
} from './broadcast.js';

const broadcast = {
  id: 'broadcast-1',
  title: 'generic',
  message_type: 'text',
  message_content: 'generic promotion',
  target_type: 'all',
  target_tag_id: null,
  status: 'scheduled',
  scheduled_at: '2026-08-17T00:00:00Z',
  sent_at: null,
  total_count: 0,
  success_count: 0,
  track_links: 0,
  line_account_id: 'account-pharmacy',
  account_ids: null,
  created_at: '2026-08-17T00:00:00Z',
};

function database(mapped = true) {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const statement = {
    bind: vi.fn(),
    first: vi.fn(async () => (mapped ? { ok: 1 } : null)),
    run,
  };
  statement.bind.mockReturnValue(statement);
  return { db: { prepare: vi.fn(() => statement) } as unknown as D1Database, run };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pharmacyMode.mockResolvedValue(true);
  mocks.getBroadcastById.mockResolvedValue(broadcast);
  mocks.getBroadcasts.mockResolvedValue([broadcast]);
  mocks.getQueuedBroadcasts.mockResolvedValue([{ ...broadcast, status: 'sending' }]);
  mocks.processMultiAccountDedupBroadcast.mockResolvedValue({
    totalCount: 1,
    successCount: 0,
    failedAccountIds: ['account-unmapped'],
    complete: true,
  });
  mocks.autoTrackContent.mockResolvedValue({ messageType: 'text', content: 'tracked' });
});

describe('generic broadcast exclusion for pharmacy accounts', () => {
  it('rejects the shared direct-send path before changing status or calling LINE', async () => {
    const { db } = database();
    const lineClient = { broadcast: vi.fn() };

    await expect(processBroadcastSend(db, lineClient as never, broadcast.id)).rejects.toThrow(
      'generic feature disabled for pharmacy account',
    );

    expect(mocks.updateBroadcastStatus).not.toHaveBeenCalled();
    expect(lineClient.broadcast).not.toHaveBeenCalled();
  });

  it('does not claim a scheduled pharmacy broadcast in cron', async () => {
    const { db, run } = database();
    await processScheduledBroadcasts(db, { broadcast: vi.fn() } as never);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not claim a queued pharmacy broadcast in cron', async () => {
    const { db, run } = database();
    await processQueuedBroadcasts(db, { broadcast: vi.fn() } as never);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not claim a scheduled broadcast for an unmapped account', async () => {
    mocks.pharmacyMode.mockResolvedValue(false);
    const { db, run } = database(false);

    await processScheduledBroadcasts(db, { broadcast: vi.fn() } as never);

    expect(run).not.toHaveBeenCalled();
  });

  it('queues a provider-audience all broadcast without deriving a D1 recipient count', async () => {
    mocks.pharmacyMode.mockResolvedValue(false);
    mocks.getBroadcastById
      .mockResolvedValueOnce({ ...broadcast, status: 'draft' })
      .mockResolvedValueOnce({ ...broadcast, status: 'sending', segment_conditions: '{}' });
    const { db } = database(true);
    const lineClient = { broadcast: vi.fn() };

    const result = await processBroadcastSend(db, lineClient as never, broadcast.id);

    expect(result.status).toBe('sending');
    expect(lineClient.broadcast).not.toHaveBeenCalled();
    expect(vi.mocked(db.prepare).mock.calls.some(([sql]) => String(sql).includes('FROM friends')))
      .toBe(false);
  });

  it('rejects a persisted scheduled segment before it can be widened to all followers', async () => {
    mocks.pharmacyMode.mockResolvedValue(false);
    mocks.getBroadcastById.mockResolvedValueOnce({
      ...broadcast,
      target_type: 'segment',
      segment_conditions: JSON.stringify({ operator: 'AND', rules: [] }),
    });
    const { db } = database(true);
    const lineClient = { broadcast: vi.fn() };

    await expect(processBroadcastSend(db, lineClient as never, broadcast.id)).rejects.toThrow(
      'segment broadcasts must use /send-segment',
    );

    expect(mocks.updateBroadcastStatus).not.toHaveBeenCalled();
    expect(lineClient.broadcast).not.toHaveBeenCalled();
  });

  it('lets dedup terminal handling settle a queue with an unmapped member account', async () => {
    mocks.pharmacyMode.mockResolvedValue(false);
    const dedupBroadcast = {
      ...broadcast,
      status: 'sending',
      target_type: 'multi-account-dedup',
      line_account_id: null,
      account_ids: JSON.stringify(['account-active', 'account-unmapped']),
      dedup_priority: JSON.stringify(['account-active', 'account-unmapped']),
      batch_offset: 0,
      batch_lock_at: null,
      dedup_progress: null,
      segment_conditions: null,
    };
    mocks.getQueuedBroadcasts.mockResolvedValue([dedupBroadcast]);
    const { db } = database(false);

    await processQueuedBroadcasts(db, {} as never);

    expect(mocks.processMultiAccountDedupBroadcast).toHaveBeenCalledOnce();
    expect(mocks.updateBroadcastStatus).toHaveBeenCalledWith(
      db,
      dedupBroadcast.id,
      'sent',
      { totalCount: 1, successCount: 0 },
    );
  });

  it('does not auto-track an empty corrupt dedup continuation', async () => {
    mocks.pharmacyMode.mockResolvedValue(false);
    mocks.getQueuedBroadcasts.mockResolvedValue([{
      ...broadcast,
      status: 'sending',
      target_type: 'multi-account-dedup',
      line_account_id: null,
      account_ids: JSON.stringify(['account-active']),
      dedup_priority: JSON.stringify(['account-active']),
      batch_offset: 0,
      batch_lock_at: null,
      dedup_progress: '',
      segment_conditions: null,
      track_links: 1,
    }]);
    const { db } = database(false);

    await processQueuedBroadcasts(db, {} as never, 'https://worker.example');

    expect(mocks.autoTrackContent).not.toHaveBeenCalled();
    expect(mocks.processMultiAccountDedupBroadcast).toHaveBeenCalledOnce();
  });
});
