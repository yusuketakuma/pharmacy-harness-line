import { describe, expect, it } from 'vitest';
import { openEmergencyPayload, sealEmergencyPayload } from './encryption.js';

const context = {
  tenantId: 'tenant-a',
  lineAccountId: 'account-a',
  friendId: 'friend-a',
  intakeId: 'intake-a',
};

describe('emergency intake encryption', () => {
  it('round-trips the minimal payload without exposing its timestamp', async () => {
    const payload = {
      intercourseAt: '2026-08-18T10:00:00+09:00',
      intercourseTimeUnknown: false,
    };
    const encrypted = await sealEmergencyPayload(payload, 'test-secret', context);

    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain('2026-08-18');
    await expect(openEmergencyPayload(encrypted, 'test-secret', context)).resolves.toEqual(payload);
  });

  it('binds ciphertext to tenant, account, patient, and intake', async () => {
    const encrypted = await sealEmergencyPayload({ intercourseAt: 'x', intercourseTimeUnknown: true }, 'secret', context);
    await expect(openEmergencyPayload(encrypted, 'secret', {
      ...context,
      lineAccountId: 'account-b',
    })).rejects.toThrow('encrypted intake is invalid');
  });

  it('fails closed without a configured secret', async () => {
    await expect(sealEmergencyPayload({}, '', context)).rejects.toThrow('encryption key is not configured');
  });
});
