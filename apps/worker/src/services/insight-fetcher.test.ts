import { describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getPendingInsights: vi.fn(),
  updateInsightResult: vi.fn(),
  markInsightFailed: vi.fn(),
  getLineAccountById: vi.fn(),
}));

vi.mock('@line-crm/db', () => dbMocks);

import { processInsightFetch } from './insight-fetcher.js';

describe('broadcast insight cron account boundary', () => {
  it('does not fall back to another LINE client for an explicitly scoped account', async () => {
    dbMocks.getPendingInsights.mockResolvedValue([{
      insightId: 'insight-1',
      broadcastId: 'broadcast-1',
      lineRequestId: 'request-1',
      aggregationUnit: null,
      sentAt: '2026-08-01T00:00:00.000Z',
      retryCount: 2,
      lineAccountId: 'account-b',
      targetType: 'all',
      accountIds: null,
      failedAccountIds: null,
      successCount: 1,
    }]);
    dbMocks.markInsightFailed.mockResolvedValue(undefined);
    const defaultClient = {
      getMessageEventInsight: vi.fn().mockResolvedValue({ overview: { delivered: 1 } }),
    };

    await processInsightFetch(
      {} as D1Database,
      new Map(),
      defaultClient as never,
    );

    expect(defaultClient.getMessageEventInsight).not.toHaveBeenCalled();
    expect(dbMocks.updateInsightResult).not.toHaveBeenCalled();
    expect(dbMocks.markInsightFailed).toHaveBeenCalledWith(
      expect.anything(),
      'insight-1',
      2,
    );
  });
});
