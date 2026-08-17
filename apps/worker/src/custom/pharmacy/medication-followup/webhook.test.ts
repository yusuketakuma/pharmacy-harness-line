import { beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.hoisted(() => vi.fn());
vi.mock('./repository.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('./repository.js')),
  recordMedicationFollowUpPatientResponse: record,
}));

import { handleMedicationFollowUpPostback } from './webhook.js';

beforeEach(() => {
  vi.clearAllMocks();
  record.mockResolvedValue(undefined);
});

describe('medication follow-up webhook', () => {
  it('accepts only a fixed response with verified account context', async () => {
    const followUpId = '123e4567-e89b-42d3-a456-426614174000';
    const db = {} as D1Database;
    await expect(handleMedicationFollowUpPostback(db, {
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      webhookEventId: 'webhook-event-a',
      data: `pharmacy-followup:${followUpId}:pharmacist_requested`,
    })).resolves.toBe(true);
    expect(record).toHaveBeenCalledWith(db, {
      lineAccountId: 'account-a', friendId: 'friend-a', followUpId,
      response: 'pharmacist_requested', webhookEventId: 'webhook-event-a',
    });

    await expect(handleMedicationFollowUpPostback(db, {
      lineAccountId: 'account-a', friendId: 'friend-a', webhookEventId: 'webhook-event-b',
      data: 'generic-action',
    })).resolves.toBe(false);
    await expect(handleMedicationFollowUpPostback(db, {
      lineAccountId: '', friendId: 'friend-a', webhookEventId: 'webhook-event-c',
      data: `pharmacy-followup:${followUpId}:concern`,
    })).resolves.toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
