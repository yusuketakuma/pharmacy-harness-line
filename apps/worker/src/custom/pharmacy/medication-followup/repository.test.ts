import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMedicationFollowUpTransitionAllowed } from './repository.js';

describe('medication follow-up workflow', () => {
  it('requires a pharmacist response before closing a patient concern', () => {
    expect(isMedicationFollowUpTransitionAllowed('concern', 'closed')).toBe(false);
    expect(isMedicationFollowUpTransitionAllowed('pharmacist_requested', 'closed')).toBe(false);
    expect(isMedicationFollowUpTransitionAllowed('assigned', 'closed')).toBe(false);
    expect(isMedicationFollowUpTransitionAllowed('escalated', 'closed')).toBe(false);
    expect(isMedicationFollowUpTransitionAllowed('responded', 'closed')).toBe(true);
    expect(isMedicationFollowUpTransitionAllowed('no_issue', 'closed')).toBe(true);
  });

  it('binds patient lists to both the verified account and LINE owner', () => {
    const source = readFileSync(
      fileURLToPath(import.meta.url).replace(/repository\.test\.ts$/, 'repository.ts'),
      'utf8',
    );
    expect(source).toContain('WHERE f.line_account_id = ? AND f.owner_friend_id = ?');
    expect(source).toContain('patient.owner_friend_id = f.owner_friend_id');
    expect(source).toContain(').bind(lineAccountId, friendId).all<PatientMedicationFollowUp>()');
  });

  it('gates only new scheduling at the final account-scoped write', () => {
    const source = readFileSync(
      fileURLToPath(import.meta.url).replace(/repository\.test\.ts$/, 'repository.ts'),
      'utf8',
    );
    const schedule = source.slice(
      source.indexOf('export async function scheduleMedicationFollowUp'),
      source.indexOf('export async function transitionMedicationFollowUp'),
    );
    expect(schedule).toContain("value = 'medication_followup'");
  });
});
