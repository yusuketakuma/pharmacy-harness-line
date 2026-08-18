import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../index.ts'),
  'utf8',
);
const webhookSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../routes/webhook.ts'),
  'utf8',
);

describe('medication follow-up custom boundary', () => {
  it('mounts the staff API and the bounded minute processor from custom/pharmacy', () => {
    expect(source).toContain(
      "import { medicationFollowUpRoutes } from './custom/pharmacy/medication-followup/routes.js'; // custom:pharmacy-medication-followup",
    );
    expect(source).toContain(
      "import { processDueMedicationFollowUps } from './custom/pharmacy/medication-followup/notifications.js'; // custom:pharmacy-medication-followup",
    );
    expect(source).toContain("app.route('/', medicationFollowUpRoutes); // custom:pharmacy-medication-followup");
    expect(source).toContain('processDueMedicationFollowUps(env.DB');
    expect(source).toContain("event.cron === '* * * * *'");
  });

  it('handles the fixed response only inside the pharmacy postback branch', () => {
    const postback = webhookSource.indexOf('const postbackData');
    const handler = webhookSource.indexOf('await handleMedicationFollowUpPostback', postback);
    const genericAutomation = webhookSource.indexOf('await matchAndReply', postback);
    expect(postback).toBeGreaterThan(-1);
    expect(handler).toBeGreaterThan(postback);
    expect(genericAutomation).toBeGreaterThan(handler);
  });
});
