import { describe, expect, it } from 'vitest';
import { deprecatedReceiveTarget, pharmacyRoute } from './navigation.js';

describe('pharmacyRoute', () => {
  it('keeps the tenant LIFF id on a pharmacy navigation target', () => {
    expect(pharmacyRoute('/prescriptions', '2000000000-AbCdEfGh'))
      .toBe('/prescriptions?liffId=2000000000-AbCdEfGh');
  });

  it('preserves existing query parameters while replacing the LIFF id', () => {
    expect(pharmacyRoute('/prescriptions?submissionId=sub-1&liffId=old', '2000000000-AbCdEfGh'))
      .toBe('/prescriptions?submissionId=sub-1&liffId=2000000000-AbCdEfGh');
  });

  it('keeps isolated pre-bootstrap rendering usable without inventing a tenant id', () => {
    expect(pharmacyRoute('/prescriptions')).toBe('/prescriptions');
  });
});

describe('deprecatedReceiveTarget', () => {
  it('preserves the LIFF account while redirecting to prescription sending', () => {
    expect(deprecatedReceiveTarget('?liffId=2000000000-AbCdEfGh'))
      .toBe('/prescriptions?view=send&liffId=2000000000-AbCdEfGh');
  });
});
