import { describe, expect, it } from 'vitest';
import { buildRepositorySettings } from './github-settings.js';

describe('buildRepositorySettings', () => {
  it('protects main and keeps automatic deployment disabled until setup finishes', () => {
    const settings = buildRepositorySettings({
      customerRepository: 'customer/pharmacy',
      sellerRepository: 'seller/pharmacy',
    });

    expect(settings.api).toContainEqual(expect.objectContaining({
      method: 'PATCH',
      path: 'repos/customer/pharmacy',
      body: { allow_auto_merge: true },
    }));
    expect(settings.api).toContainEqual(expect.objectContaining({
      method: 'PUT',
      path: 'repos/customer/pharmacy/environments/development',
    }));
    expect(settings.api).toContainEqual(expect.objectContaining({
      method: 'PUT',
      path: 'repos/customer/pharmacy/environments/production',
    }));
    expect(settings.api).toContainEqual(expect.objectContaining({
      method: 'PUT',
      path: 'repos/customer/pharmacy/branches/main/protection',
      body: expect.objectContaining({
        required_status_checks: {
          strict: true,
          contexts: ['Customer Update Policy / policy'],
        },
        allow_force_pushes: false,
        allow_deletions: false,
      }),
    }));
    expect(settings.variables).toEqual(expect.arrayContaining([
      ['LINE_HARNESS_SELLER_REPOSITORY', 'seller/pharmacy'],
      ['CUSTOMER_UPDATE_MODE', 'manual'],
      ['CUSTOMER_UPDATE_CANARY_PASSED', 'false'],
      ['LINE_HARNESS_CLOUDFLARE_DEPLOY', 'false'],
    ]));
  });

  it('never places a seller token in generated settings', () => {
    expect(JSON.stringify(buildRepositorySettings({
      customerRepository: 'customer/pharmacy',
      sellerRepository: 'seller/pharmacy',
    }))).not.toMatch(/token|secret/i);
  });
});
