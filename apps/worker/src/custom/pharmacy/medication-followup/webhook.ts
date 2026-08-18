import {
  parseMedicationFollowUpPostback,
  recordMedicationFollowUpPatientResponse,
} from './repository.js';

export async function handleMedicationFollowUpPostback(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    webhookEventId: string;
    data: string;
  },
): Promise<boolean> {
  if (!input.lineAccountId || !input.friendId || !input.webhookEventId) return false;
  const action = parseMedicationFollowUpPostback(input.data);
  if (!action) return false;
  await recordMedicationFollowUpPatientResponse(db, {
    lineAccountId: input.lineAccountId,
    friendId: input.friendId,
    webhookEventId: input.webhookEventId,
    ...action,
  });
  return true;
}
