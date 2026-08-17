import { describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => vi.fn());
vi.mock('../../../services/line-proxy-send.js', () => ({ pushViaHarnessProxy: push }));
vi.mock('./repository.js', () => ({ getPharmacyCapabilityConfig: config }));

import { sendPharmacyAutomatedPush } from './sender.js';

describe('pharmacy automated sender', () => {
  it('fails closed when the account does not allow the message capability', async () => {
    config.mockResolvedValue({ capabilities: ['continuity'], proactive_monthly_limit: 1 });
    await expect(sendPharmacyAutomatedPush({
      db: {} as D1Database, proxyBaseUrl: 'https://worker.example', accessToken: 'token', to: 'U1',
      lineAccountId: 'account-a', friendId: 'friend-a', messageId: 'prescription_status_v1',
      category: 'transactional_care', retryKey: 'retry-1',
    })).rejects.toThrow(/capability/);
    expect(push).not.toHaveBeenCalled();
  });
});
