import { describe, expect, it, vi } from 'vitest';
import {
  appointmentReminderSchedule,
  claimDueEmergencyAppointmentReminders,
  generateEmergencyAppointmentReminders,
  getEmergencyReminderControl,
  saveEmergencyReminderControl,
} from './reminders.js';

describe('emergency appointment reminder schedule', () => {
  it('uses the one-hour server-owned offset and Japan quiet hours', () => {
    expect(appointmentReminderSchedule('2026-08-21T01:00:00.000Z')).toEqual({
      dueAt: '2026-08-21T00:00:00.000Z',
      deadlineAt: '2026-08-21T01:00:00.000Z',
      suppressionReason: null,
    });
    expect(appointmentReminderSchedule('2026-08-20T23:30:00.000Z')).toEqual({
      dueAt: '2026-08-20T23:00:00.000Z',
      deadlineAt: '2026-08-20T23:30:00.000Z',
      suppressionReason: null,
    });
    expect(appointmentReminderSchedule('2026-08-20T23:00:00.000Z')).toMatchObject({
      suppressionReason: 'QUIET_HOURS_PAST_DEADLINE',
    });
    expect(appointmentReminderSchedule('2026-08-21T13:00:00.000Z')).toMatchObject({
      suppressionReason: 'QUIET_HOURS_PAST_DEADLINE',
    });
  });
});

describe('emergency appointment reminder generation and claim', () => {
  it('converges duplicate cron generation and creates a new occurrence only after the anchor changes', async () => {
    let rows = [{
      intake_id: 'intake-a', tenant_id: 'tenant-a', line_account_id: 'account-a',
      anchor_at: '2026-08-21T01:00:00.000Z',
    }];
    const occurrences = new Set<string>();
    const hashes: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...values: unknown[]) => ({
          all: async () => ({ results: sql.includes('SELECT intake.id') ? rows : [] }),
          run: async () => {
            if (!sql.includes('INSERT OR IGNORE')) return { meta: { changes: 0 } };
            const occurrence = `${values[1]}:${values[2]}:${values[3]}`;
            hashes.push(String(values[6]));
            if (occurrences.has(occurrence)) return { meta: { changes: 0 } };
            occurrences.add(occurrence);
            return { meta: { changes: 1 } };
          },
        }),
      })),
    } as unknown as D1Database;
    const options = { now: new Date('2026-08-20T20:00:00.000Z'), limit: 10 };

    await expect(generateEmergencyAppointmentReminders(db, options))
      .resolves.toEqual({ generated: 1, suppressed: 0, failed: 0 });
    await expect(generateEmergencyAppointmentReminders(db, options))
      .resolves.toEqual({ generated: 0, suppressed: 0, failed: 0 });
    rows = [{ ...rows[0], anchor_at: '2026-08-21T02:00:00.000Z' }];
    await expect(generateEmergencyAppointmentReminders(db, options))
      .resolves.toEqual({ generated: 1, suppressed: 0, failed: 0 });
    expect(occurrences).toHaveLength(2);
    expect(new Set(hashes)).toHaveLength(2);
  });

  it('keeps one broken account from stopping another account occurrence', async () => {
    const rows = [
      { intake_id: 'intake-a', tenant_id: 'tenant-a', line_account_id: 'account-a', anchor_at: '2026-08-21T01:00:00.000Z' },
      { intake_id: 'intake-b', tenant_id: 'tenant-b', line_account_id: 'account-b', anchor_at: '2026-08-21T02:00:00.000Z' },
    ];
    const inserted: unknown[][] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...values: unknown[]) => ({
          all: async () => ({ results: sql.includes('SELECT intake.id') ? rows : [] }),
          run: async () => {
            if (sql.includes('INSERT OR IGNORE')) {
              inserted.push(values);
              if (values.includes('account-a')) throw new Error('account-a unavailable');
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        }),
      })),
    } as unknown as D1Database;

    await expect(generateEmergencyAppointmentReminders(db, {
      now: new Date('2026-08-20T20:00:00.000Z'), limit: 10,
    })).resolves.toEqual({ generated: 1, suppressed: 0, failed: 1 });
    expect(inserted).toHaveLength(2);
    expect(inserted.flat().join(' ')).not.toMatch(/patient|reference|intercourse|pregnan|drug/iu);
  });

  it('claims due rows atomically and suppresses expired deadlines first', async () => {
    const seen: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            seen.push(`run:${sql}:${values.join(',')}`);
            return { meta: { changes: 1 } };
          },
          all: async () => {
            seen.push(`all:${sql}:${values.join(',')}`);
            return { results: [{
              id: 'reminder-a', line_account_id: 'account-a', intake_id: 'intake-a',
              anchor_at: '2026-08-21T01:00:00.000Z', due_at: '2026-08-21T00:00:00.000Z',
              deadline_at: '2026-08-21T01:00:00.000Z', occurrence_hash: 'a'.repeat(64),
              claim_token: expect.any(String),
            }] };
          },
        }),
      })),
    } as unknown as D1Database;

    const claimed = await claimDueEmergencyAppointmentReminders(
      db, new Date('2026-08-21T00:15:00.000Z'), 10,
    );
    expect(claimed).toHaveLength(1);
    expect(seen[0]).toContain("status = 'suppressed'");
    expect(seen[1]).toContain("SET status = 'processing'");
    expect(seen[1]).toContain('RETURNING');
  });
});

describe('emergency appointment reminder account control', () => {
  it('defaults to dormant and uses account-scoped revision checks for activation', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => null,
          run: async () => {
            calls.push({ sql, values });
            return { meta: { changes: 1 } };
          },
        }),
      })),
    } as unknown as D1Database;

    await expect(getEmergencyReminderControl(db, 'account-a')).resolves.toEqual({
      state: 'inactive', revision: 0, timeZone: 'Asia/Tokyo', updatedAt: null,
    });
    await expect(saveEmergencyReminderControl(db, {
      lineAccountId: 'account-a', staffId: 'staff-a', state: 'active', expectedRevision: 0,
      now: new Date('2026-08-21T00:00:00.000Z'),
    })).resolves.toMatchObject({ state: 'active', revision: 1, timeZone: 'Asia/Tokyo' });
    expect(calls[0].sql).toContain('pharmacy_emergency_reminder_controls');
    expect(calls[0].values).toEqual(expect.arrayContaining(['account-a', 'staff-a', 'active']));
  });
});
