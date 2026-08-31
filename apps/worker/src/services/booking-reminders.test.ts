import { describe, expect, test, vi } from 'vitest';
import { processDueReminders } from './booking-reminders.js';

interface DueRow {
  id: string;
  booking_id: string;
  kind: 'day_before' | 'hours_before';
  retry_count: number;
  starts_at: string;
  menu_name: string;
  staff_name: string;
  channel_access_token: string;
  line_user_id: string;
  tenant_id?: string;
  line_account_id?: string;
  friend_id?: string;
  status?: 'pending' | 'processing' | 'failed' | 'failed_permanent' | 'sent' | 'cancelled';
  claimed_at?: string | null;
  first_attempted_at?: string | null;
}

function stubDB(due: DueRow[]) {
  const updates: Array<{ sql: string; bound: unknown[] }> = [];
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all() {
          if (sql.includes('FROM booking_reminders')) {
            const [, , staleClaimAt] = bound as [string, string, string];
            return {
              results: due.filter((row) => {
                const status = row.status ?? 'pending';
                return status === 'pending' || status === 'failed' ||
                  (status === 'processing' && row.claimed_at != null && row.claimed_at <= staleClaimAt);
              }).map((row) => ({ ...row })),
            };
          }
          return { results: [] };
        },
        async run() {
          updates.push({ sql, bound });
          if (sql.includes('LINE_RETRY_HORIZON_EXPIRED')) {
            const [horizon] = bound as [string];
            let changes = 0;
            for (const row of due) {
              const status = row.status ?? 'pending';
              if ((status === 'processing' || status === 'failed') &&
                  row.first_attempted_at != null && row.first_attempted_at <= horizon) {
                row.status = 'failed_permanent';
                changes += 1;
              }
            }
            return { success: true, meta: { changes } };
          }
          if (sql.includes('SET retry_count = retry_count + 1')) {
            const [claimedAt, firstAttemptedAt, id, expected, staleClaimAt] = bound as [
              string, string, string, number, string,
            ];
            const row = due.find((item) => item.id === id);
            const status = row?.status ?? 'pending';
            if (!row || row.retry_count !== expected ||
                (status !== 'pending' && status !== 'failed' &&
                 !(status === 'processing' && row.claimed_at != null && row.claimed_at <= staleClaimAt))) {
              return { success: true, meta: { changes: 0 } };
            }
            row.retry_count += 1;
            row.status = 'processing';
            row.claimed_at = claimedAt;
            row.first_attempted_at ??= firstAttemptedAt;
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("SET status='sent'")) {
            const [, id, expected] = bound as [string, string, number | undefined];
            const row = due.find((item) => item.id === id);
            if (expected !== undefined &&
                (!row || row.status !== 'processing' || row.retry_count !== expected)) {
              return { success: true, meta: { changes: 0 } };
            }
            if (row) row.status = 'sent';
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, updates, queries };
}

const REMINDER_HOURS_BEFORE = 2;
const NOW = new Date('2026-05-10T05:01:00Z');

describe('processDueReminders', () => {
  test('does not dispatch the same reminder from an overlapping cron sweep', async () => {
    const due: DueRow[] = [{
      id: 'R1', booking_id: 'B1', kind: 'day_before', retry_count: 0,
      starts_at: '2099-05-10T05:00:00Z', menu_name: 'カット', staff_name: '山田',
      channel_access_token: 'tok', line_user_id: 'U_xyz', status: 'pending',
    }];
    const { db } = stubDB(due);
    const sender = vi.fn(async () => {
      if (sender.mock.calls.length === 1) {
        await processDueReminders(db, {
          now: NOW, sender, reminderHoursBefore: REMINDER_HOURS_BEFORE,
        });
      }
    });

    await processDueReminders(db, {
      now: NOW, sender, reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });

    expect(sender).toHaveBeenCalledTimes(1);
  });

  test('retires an unresolved reminder after the LINE retry-key horizon', async () => {
    const due: DueRow[] = [{
      id: 'R1', booking_id: 'B1', kind: 'day_before', retry_count: 1,
      starts_at: '2099-05-10T05:00:00Z', menu_name: 'カット', staff_name: '山田',
      channel_access_token: 'tok', line_user_id: 'U_xyz', status: 'processing',
      claimed_at: '2026-05-08T00:00:00.000Z',
      first_attempted_at: '2026-05-08T00:00:00.000Z',
    }];
    const { db } = stubDB(due);
    const sender = vi.fn();

    await processDueReminders(db, {
      now: NOW, sender, reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });

    expect(due[0].status).toBe('failed_permanent');
    expect(sender).not.toHaveBeenCalled();
  });

  test('due な reminder を sent にし sender を呼ぶ', async () => {
    const due: DueRow[] = [
      {
        id: 'R1',
        booking_id: 'B1',
        kind: 'day_before',
        retry_count: 0,
        starts_at: '2026-05-10T05:00:00Z',
        menu_name: 'カット',
        staff_name: '山田',
        channel_access_token: 'tok',
        line_user_id: 'U_xyz',
        tenant_id: 'tenant-1',
        line_account_id: 'account-1',
        friend_id: 'friend-1',
      },
    ];
    const { db, updates, queries } = stubDB(due);
    const sender = vi.fn().mockResolvedValue(undefined);
    const result = await processDueReminders(db, {
      now: NOW,
      sender,
      reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({
        channelAccessToken: 'tok',
        toLineUserId: 'U_xyz',
        retryKey: 'R1',
        kind: 'day_before',
        db,
        tenantId: 'tenant-1',
        lineAccountId: 'account-1',
        friendId: 'friend-1',
      }),
    );
    expect(updates.find((u) => u.sql.includes("status='sent'"))).toBeTruthy();
    const dueQuery = queries.find((sql) => sql.includes('FROM booking_reminders'))!;
    expect(dueQuery).toContain('pharmacy_account_capabilities');
    expect(dueQuery).toContain('la.is_active = 1');
    expect(dueQuery).toContain('tenant_line_accounts');
    expect(dueQuery).toContain("tenant.status = 'active'");
    expect(dueQuery).toContain('m.line_account_id = b.line_account_id');
    expect(dueQuery).toContain('s.line_account_id = b.line_account_id');
    expect(dueQuery).toContain('f.line_account_id = b.line_account_id');
  });

  test('未来の reminder は対象外（DB が返さない前提なので空入力）', async () => {
    const { db } = stubDB([]);
    const sender = vi.fn();
    const result = await processDueReminders(db, {
      now: NOW,
      sender,
      reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(sender).not.toHaveBeenCalled();
  });

  test('送信失敗 1 回目: status=failed, retry_count=1', async () => {
    const due: DueRow[] = [
      {
        id: 'R1',
        booking_id: 'B1',
        kind: 'day_before',
        retry_count: 0,
        starts_at: '2026-05-10T05:00:00Z',
        menu_name: 'カット',
        staff_name: '山田',
        channel_access_token: 'tok',
        line_user_id: 'U',
      },
    ];
    const { db, updates } = stubDB(due);
    const sender = vi.fn().mockRejectedValue(new Error('LINE 500'));
    const result = await processDueReminders(db, {
      now: NOW,
      sender,
      reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });
    expect(result).toEqual({ sent: 0, failed: 1 });
    const failedUpdate = updates.find((u) => u.sql.includes('SET status = ?, retry_count = ?'));
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate!.bound[0]).toBe('failed');
    expect(failedUpdate!.bound[1]).toBe(1); // retry_count
  });

  test('送信失敗 3 回目: failed_permanent', async () => {
    const due: DueRow[] = [
      {
        id: 'R1',
        booking_id: 'B1',
        kind: 'hours_before',
        retry_count: 2, // 3回目
        starts_at: '2026-05-10T05:00:00Z',
        menu_name: 'カット',
        staff_name: '山田',
        channel_access_token: 'tok',
        line_user_id: 'U',
      },
    ];
    const { db, updates } = stubDB(due);
    const sender = vi.fn().mockRejectedValue(new Error('LINE 500'));
    await processDueReminders(db, {
      now: NOW,
      sender,
      reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });
    const u = updates.find((x) => x.sql.includes('SET status = ?, retry_count = ?'));
    expect(u!.bound[0]).toBe('failed_permanent');
    expect(u!.bound[1]).toBe(3);
  });
});
