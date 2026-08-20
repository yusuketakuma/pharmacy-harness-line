import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('../request.js', () => ({ requestPharmacyLiff: request }));

import { medicationFollowUpApi } from './api.js';

beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue({ ok: true, json: async () => ({ followUps: [] }) });
});

describe('patient medication follow-up API', () => {
  it('lists the verified owner follow-ups', async () => {
    await medicationFollowUpApi.list();
    expect(request).toHaveBeenCalledWith('/api/liff/pharmacy/medication-followups', undefined);
  });

  it('sends only a fixed response with optimistic versioning', async () => {
    await medicationFollowUpApi.respond('followup-1', 'concern', 3, 'response-key-1');
    expect(request).toHaveBeenCalledWith(
      '/api/liff/pharmacy/medication-followups/followup-1/respond',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          response: 'concern', expectedVersion: 3, idempotencyKey: 'response-key-1',
        }),
      }),
    );
  });
});
