import { describe, expect, it, vi } from 'vitest';

vi.mock('../../custom/pharmacy/growth-loop/access.js', () => ({
  hasPharmacyModeAccount: vi.fn().mockResolvedValue(true),
}));

const { trafficPools } = await import('./traffic-pools.js');

describe('legacy traffic pool landing in pharmacy mode', () => {
  it('fails closed before resolving a generic pool', async () => {
    const response = await trafficPools.request('/pool/main', {}, {
      DB: {} as D1Database,
    });

    expect(response.status).toBe(404);
  });
});
