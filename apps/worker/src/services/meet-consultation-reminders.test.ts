import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  cancelMeetConsultation,
  calculateMeetReminderSchedule,
  listMeetConsultations,
  processDueMeetConsultationReminders,
  registerMeetConsultation,
  renderMeetReminderText,
} from './meet-consultation-reminders.js';

function consultationDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE friends (
      id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, is_following INTEGER NOT NULL
    );
    CREATE TABLE meet_consultations (
      id TEXT PRIMARY KEY, external_event_id TEXT NOT NULL UNIQUE,
      friend_id TEXT NOT NULL REFERENCES friends(id), title TEXT NOT NULL,
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, meet_url TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE meet_consultation_reminders (
      id TEXT PRIMARY KEY, consultation_id TEXT NOT NULL REFERENCES meet_consultations(id),
      kind TEXT NOT NULL, scheduled_at TEXT NOT NULL, status TEXT NOT NULL,
      retry_count INTEGER NOT NULL, sent_at TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (consultation_id, kind)
    );
    INSERT INTO friends VALUES ('friend-a', 'account-a', 1);`);
  const statement = (sql: string, values: unknown[] = []) => ({
    __sql: sql,
    __values: values,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => sqlite.prepare(sql).get(...values) as T | undefined ?? null,
    runSync: () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const results: Array<{ meta: { changes: number } }> = [];
      sqlite.exec('BEGIN');
      try {
        for (const item of statements as unknown as Array<ReturnType<typeof statement>>) {
          results.push(item.runSync());
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}

describe('calculateMeetReminderSchedule', () => {
  it('schedules the previous day and one hour before', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    expect(calculateMeetReminderSchedule('2026-08-10T10:00:00.000Z', now)).toEqual([
      { kind: 'day_before', scheduledAt: '2026-08-09T10:00:00.000Z' },
      { kind: 'hour_before', scheduledAt: '2026-08-10T09:00:00.000Z' },
    ]);
  });

  it('sends the day-before reminder immediately when confirmed within 24 hours', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    expect(calculateMeetReminderSchedule('2026-08-08T12:00:00.000Z', now)).toEqual([
      { kind: 'day_before', scheduledAt: '2026-08-08T00:00:00.000Z' },
      { kind: 'hour_before', scheduledAt: '2026-08-08T11:00:00.000Z' },
    ]);
  });

  it('does not send two messages together when confirmed within one hour', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    expect(calculateMeetReminderSchedule('2026-08-08T00:30:00.000Z', now)).toEqual([
      { kind: 'hour_before', scheduledAt: '2026-08-08T00:00:00.000Z' },
    ]);
  });
});

describe('renderMeetReminderText', () => {
  it('renders the JST date and Meet URL', () => {
    const text = renderMeetReminderText(
      'hour_before',
      '2026-08-09T01:00:00.000Z',
      'https://meet.google.com/abc-defg-hij',
    );
    expect(text).toContain('8月9日（日）10:00');
    expect(text).toContain('開始約1時間前');
    expect(text).toContain('https://meet.google.com/abc-defg-hij');
  });
});

describe('meet consultation tenant and account scope', () => {
  it('lists only consultations mapped to the authenticated tenant', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            calls.push({ sql, values });
            return { all: async () => ({ results: [] }) };
          },
        };
      },
    } as unknown as D1Database;

    await listMeetConsultations(db, 'tenant-a', 'account-a', 'confirmed');

    expect(calls[0].sql).toContain('tenant_line_accounts');
    expect(calls[0].sql).toContain('f.line_account_id');
    expect(calls[0].values).toEqual(['confirmed', 'confirmed', 'tenant-a', 'account-a']);
  });

  it('rejects a friend outside the server-resolved LINE account before registration', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            calls.push({ sql, values });
            return { first: async () => null };
          },
        };
      },
    } as unknown as D1Database;

    await expect(registerMeetConsultation(db, {
      externalEventId: 'event-a',
      friendId: 'friend-a',
      title: 'Synthetic consultation',
      startsAt: '2026-08-10T10:00:00.000Z',
      endsAt: '2026-08-10T11:00:00.000Z',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    }, 'account-b', new Date('2026-08-08T00:00:00.000Z'))).rejects.toThrow(/friend not found/);
    expect(calls[0].sql).toContain('line_account_id = ?');
    expect(calls[0].values).toEqual(['friend-a', 'account-b']);
  });

  it('cannot cancel an event owned by another LINE account', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            calls.push({ sql, values });
            return { first: async () => null };
          },
        };
      },
    } as unknown as D1Database;

    await expect(cancelMeetConsultation(
      db, 'event-a', 'account-b', new Date('2026-08-08T00:00:00.000Z'),
    )).resolves.toBe(false);
    expect(calls[0].sql).toContain('line_account_id = ?');
    expect(calls[0].values).toEqual(['event-a', 'account-b']);
  });

  it('writes the consultation and both required reminders in one D1 batch', async () => {
    const { db, sqlite } = consultationDb();

    await registerMeetConsultation(db, {
      externalEventId: 'event-a',
      friendId: 'friend-a',
      title: 'Synthetic consultation',
      startsAt: '2026-08-10T10:00:00.000Z',
      endsAt: '2026-08-10T11:00:00.000Z',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    }, 'account-a', new Date('2026-08-08T00:00:00.000Z'));

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM meet_consultations').get())
      .toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM meet_consultation_reminders').get())
      .toEqual({ count: 2 });
    sqlite.close();
  });

  it('rolls back the consultation when either required reminder cannot be stored', async () => {
    const { db, sqlite } = consultationDb();
    sqlite.exec(`CREATE TRIGGER reject_hour_before
      BEFORE INSERT ON meet_consultation_reminders
      WHEN NEW.kind = 'hour_before'
      BEGIN SELECT RAISE(ABORT, 'synthetic reminder failure'); END;`);

    await expect(registerMeetConsultation(db, {
      externalEventId: 'event-a',
      friendId: 'friend-a',
      title: 'Synthetic consultation',
      startsAt: '2026-08-10T10:00:00.000Z',
      endsAt: '2026-08-10T11:00:00.000Z',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    }, 'account-a', new Date('2026-08-08T00:00:00.000Z'))).rejects.toThrow(/reminder failure/);

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM meet_consultations').get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM meet_consultation_reminders').get())
      .toEqual({ count: 0 });
    sqlite.close();
  });

  it('converges on the event owner when another registration wins the insert race', async () => {
    const { db, sqlite } = consultationDb();
    const racingDb = {
      ...db,
      batch: async (statements: D1PreparedStatement[]) => {
        sqlite.prepare(`INSERT INTO meet_consultations
          (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url,
           status, created_at, updated_at)
          VALUES ('winner', 'event-race', 'friend-a', 'Concurrent', ?, ?, ?,
           'confirmed', ?, ?)`).run(
          '2026-08-10T10:00:00.000Z', '2026-08-10T11:00:00.000Z',
          'https://meet.google.com/abc-defg-hij',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z',
        );
        return db.batch(statements);
      },
    } as D1Database;

    const result = await registerMeetConsultation(racingDb, {
      externalEventId: 'event-race',
      friendId: 'friend-a',
      title: 'Synthetic consultation',
      startsAt: '2026-08-10T10:00:00.000Z',
      endsAt: '2026-08-10T11:00:00.000Z',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    }, 'account-a', new Date('2026-08-08T00:00:00.000Z'));

    expect(result.id).toBe('winner');
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM meet_consultation_reminders
      WHERE consultation_id = 'winner'`).get()).toEqual({ count: 2 });
    sqlite.close();
  });
});

describe('processDueMeetConsultationReminders', () => {
  it('sends through the Harness proxy and marks the reminder sent', async () => {
    const updates: unknown[][] = [];
    const queries: string[] = [];
    const db = {
      prepare(sql: string) {
        queries.push(sql);
        return {
          bind(...args: unknown[]) {
            return {
              async all() {
                if (!sql.includes('FROM meet_consultation_reminders r')) return { results: [] };
                return {
                  results: [{
                    id: '6db37bc2-f0c4-4fa8-baa6-5ec7069e1165',
                    consultation_id: 'consultation-1',
                    kind: 'hour_before',
                    retry_count: 0,
                    title: 'AI導入 個別相談',
                    starts_at: '2026-08-09T01:00:00.000Z',
                    meet_url: 'https://meet.google.com/abc-defg-hij',
                    line_user_id: 'U00000000000000000000000000000000',
                    channel_access_token: 'channel-token',
                  }],
                };
              },
              async run() {
                updates.push(args);
                return { success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const dispatch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://proxy.example.com/line-api/v2/bot/message/push');
      expect(request.headers.get('x-line-retry-key')).toBe(
        '6db37bc2-f0c4-4fa8-baa6-5ec7069e1165',
      );
      const body = await request.json() as { to: string; messages: Array<{ text: string }> };
      expect(body.to).toBe('U00000000000000000000000000000000');
      expect(body.messages[0].text).toContain('Google Meet');
      return new Response('{}', { status: 200 });
    });

    const result = await processDueMeetConsultationReminders(db, {
      now: new Date('2026-08-09T00:00:00.000Z'),
      proxyBaseUrl: 'https://proxy.example.com',
      proxyDispatch: dispatch,
    });

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(queries.find((sql) => sql.includes('FROM meet_consultation_reminders'))).toContain(
      'pharmacy_account_capabilities',
    );
    expect(updates).toContainEqual([
      '2026-08-09T00:00:00.000Z',
      '2026-08-09T00:00:00.000Z',
      '6db37bc2-f0c4-4fa8-baa6-5ec7069e1165',
    ]);
  });
});
