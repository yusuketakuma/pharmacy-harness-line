import { describe, expect, it } from 'vitest';
import { getPharmacyActionQueue } from './action-queue.js';

type Row = {
  id: string;
  status: string;
  deadline_at: string | null;
  activity_at: string | null;
};

function database(rows: Record<string, Row[]>, failingTable?: string) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const table = Object.keys(rows).find((name) => sql.includes(name));
      return {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return {
            async all() {
              if (failingTable && sql.includes(failingTable)) throw new Error('domain unavailable');
              return { results: table ? rows[table] : [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe('pharmacy action queue', () => {
  it('returns a bounded, account-scoped, non-PHI union with deadline categories', async () => {
    const { db, calls } = database({
      pharmacy_prescription_submissions: [
        { id: 'submission-a', status: 'received', deadline_at: null, activity_at: '2026-09-13T23:00:00.000Z' },
      ],
      pharmacy_myna_handoffs: [
        { id: 'handoff-a', status: 'EXPIRED', deadline_at: '2026-09-13T12:00:00.000Z', activity_at: '2026-09-13T10:00:00.000Z' },
      ],
      pharmacy_prescription_patients: [
        { id: 'submission-b', status: 'unreviewed', deadline_at: null, activity_at: '2026-09-14T00:00:00.000Z' },
      ],
      pharmacy_continuity_obligations: [
        { id: 'obligation-a', status: 'active', deadline_at: '2026-09-14T15:00:00.000Z', activity_at: '2026-09-14T00:00:00.000Z' },
      ],
      pharmacy_medication_followups: [
        { id: 'followup-a', status: 'concern', deadline_at: '2026-09-15T00:00:00.000Z', activity_at: '2026-09-14T00:00:00.000Z' },
      ],
      pharmacy_emergency_intakes: [
        { id: 'emergency-a', status: 'provisional', deadline_at: '2026-09-14T05:00:00.000Z', activity_at: '2026-09-14T00:00:00.000Z' },
      ],
      chats: [
        { id: 'chat-a', status: 'unread', deadline_at: null, activity_at: '2026-09-14T02:00:00.000Z' },
      ],
    });

    const result = await getPharmacyActionQueue(db, 'account-a', new Date('2026-09-14T03:00:00.000Z'));

    expect(result).toMatchObject({ accountId: 'account-a', partial: false, truncated: false });
    expect(result.items).toEqual([
      { domain: 'electronicPrescription', status: 'EXPIRED', deadline: 'overdue', detailHref: '/myna' },
      { domain: 'emergencyContraception', status: 'provisional', deadline: 'today', detailHref: '/emergency-contraception' },
      { domain: 'continuity', status: 'active', deadline: 'upcoming', detailHref: '/continuity' },
      { domain: 'medicationFollowup', status: 'concern', deadline: 'upcoming', detailHref: '/patient-intakes?followup=attention' },
      { domain: 'manualChat', status: 'unread', deadline: 'none', detailHref: '/chats?unanswered=1' },
      { domain: 'patientIntake', status: 'unreviewed', deadline: 'none', detailHref: '/patient-intakes' },
      { domain: 'prescriptionIntake', status: 'received', deadline: 'none', detailHref: '/prescriptions' },
    ]);
    expect(calls).toHaveLength(7);
    expect(calls.every(({ values }) => values[0] === 'account-a')).toBe(true);
    const output = JSON.stringify(result);
    expect(output).not.toMatch(/patient_id|friend_id|encrypted_payload|name|reference_code/i);
  });

  it('keeps available domains and marks a partial result when one query fails', async () => {
    const { db } = database({
      pharmacy_prescription_submissions: [
        { id: 'submission-a', status: 'received', deadline_at: null, activity_at: '2026-09-14T00:00:00.000Z' },
      ],
    }, 'pharmacy_myna_handoffs');

    const result = await getPharmacyActionQueue(db, 'account-a', new Date('2026-09-14T03:00:00.000Z'));

    expect(result.partial).toBe(true);
    expect(result.items).toContainEqual({
      domain: 'prescriptionIntake', status: 'received', deadline: 'none', detailHref: '/prescriptions',
    });
  });

  it('caps the response even when a domain has more work', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      id: `submission-${index}`,
      status: 'received',
      deadline_at: null,
      activity_at: `2026-09-14T00:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    const { db } = database({ pharmacy_prescription_submissions: rows });

    const result = await getPharmacyActionQueue(db, 'account-a', new Date('2026-09-14T03:00:00.000Z'));

    expect(result.items).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
});
