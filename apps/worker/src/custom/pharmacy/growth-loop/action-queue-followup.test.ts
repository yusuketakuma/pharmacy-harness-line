import { describe, expect, it } from 'vitest';
import { d1FromSqlite, openTestSqlite } from '../test-sqlite.js';
import { getPharmacyActionQueue } from './action-queue.js';

function followUpSchema(withResponseDeadline: boolean) {
  const sqlite = openTestSqlite();
  sqlite.exec(`
    CREATE TABLE pharmacy_medication_followups (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      status TEXT NOT NULL,
      due_at TEXT NOT NULL,
      ${withResponseDeadline ? 'response_deadline_at TEXT,' : ''}
      updated_at TEXT NOT NULL
    );
    INSERT INTO pharmacy_medication_followups
      (id, line_account_id, status, due_at, ${withResponseDeadline ? 'response_deadline_at,' : ''} updated_at)
    VALUES
      ('followup-sla', 'account-a', 'concern', '2026-09-20T00:00:00.000Z',
       ${withResponseDeadline ? `'2026-09-13T00:00:00.000Z',` : ''}
       '2026-09-12T00:00:00.000Z'),
      ('followup-waiting', 'account-a', 'delivered', '2026-09-20T00:00:00.000Z',
       ${withResponseDeadline ? 'NULL,' : ''}
       '2026-09-12T00:00:00.000Z');
  `);
  return sqlite;
}

describe('pharmacy action queue medication follow-up deadlines', () => {
  it('uses the response SLA deadline while staff are the blocker', async () => {
    const sqlite = followUpSchema(true);
    try {
      const result = await getPharmacyActionQueue(
        d1FromSqlite(sqlite), 'account-a', new Date('2026-09-14T03:00:00.000Z'),
      );
      const items = result.items.filter((item) => item.domain === 'medicationFollowup');
      expect(items).toEqual([
        { domain: 'medicationFollowup', status: 'concern', deadline: 'overdue',
          detailHref: '/patient-intakes?followup=attention' },
        { domain: 'medicationFollowup', status: 'delivered', deadline: 'upcoming',
          detailHref: '/patient-intakes?followup=attention' },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('keeps listing follow-ups by due date before the SLA column lands', async () => {
    const sqlite = followUpSchema(false);
    try {
      const result = await getPharmacyActionQueue(
        d1FromSqlite(sqlite), 'account-a', new Date('2026-09-14T03:00:00.000Z'),
      );
      const items = result.items.filter((item) => item.domain === 'medicationFollowup');
      expect(items).toEqual([
        { domain: 'medicationFollowup', status: 'concern', deadline: 'upcoming',
          detailHref: '/patient-intakes?followup=attention' },
        { domain: 'medicationFollowup', status: 'delivered', deadline: 'upcoming',
          detailHref: '/patient-intakes?followup=attention' },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
