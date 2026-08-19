import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const worker = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
const prescriptionRoutes = readFileSync(
  join(process.cwd(), 'src', 'custom', 'pharmacy', 'prescriptions', 'routes.ts'),
  'utf8',
);

function callSource(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  return source.slice(from, source.indexOf(end, from));
}

describe('pharmacy LINE credential integration', () => {
  it('passes the encryption key to request-time prescription notifications', () => {
    expect(callSource(prescriptionRoutes, 'function notificationOptions', '\n}'))
      .toContain('lineCredentialKey: env.LINE_CREDENTIAL_KEY_V1');
  });

  it.each([
    ['processDueMedicationFollowUps(env.DB, {', '}).then'],
    ['retryFailedPrescriptionNotifications(env.DB, {', '});'],
    ['deliverContinuityReminder(reminder, {', '});'],
    ['processDuePrescriptionValidityReminders(env.DB, {', '});'],
  ])('passes the encryption key to %s', (start, end) => {
    expect(callSource(worker, start, end)).toContain(
      'lineCredentialKey: env.LINE_CREDENTIAL_KEY_V1',
    );
  });

  it('keeps plaintext generic cron clients out of pharmacy-mode execution', () => {
    expect(callSource(worker, 'const lineClients', 'const defaultLineClient'))
      .toContain('if (runGenericCron)');
    expect(callSource(worker, 'await refreshLineAccessTokens', ');'))
      .toContain('lineCredentialKey: env.LINE_CREDENTIAL_KEY_V1');
  });
});
