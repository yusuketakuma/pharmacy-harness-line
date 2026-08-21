import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../index.ts', import.meta.url).pathname, 'utf8');

describe('emergency appointment reminder cron boundary', () => {
  it('runs on the minute cron with tenant credentials and Harness Proxy dispatch', () => {
    expect(source).toContain("from './custom/pharmacy/emergency-contraception/notifications.js'");
    expect(source).toContain("event.cron === '* * * * *'");
    expect(source).toContain('processEmergencyAppointmentReminders(env.DB');
    expect(source).toContain('lineCredentialKey: env.LINE_CREDENTIAL_KEY_V1');
    expect(source).toContain('lineProxy.fetch(request, env, ctx)');
  });
});
