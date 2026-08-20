import { beforeEach, describe, expect, test, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  jstNow: vi.fn(() => '2026-08-10T20:00:00+09:00'),
}));
const pharmacyMode = vi.hoisted(() => ({
  enabled: false,
  check: vi.fn(),
}));
pharmacyMode.check.mockImplementation(async () => pharmacyMode.enabled);
vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../custom/pharmacy/growth-loop/access.js', () => ({
  isPharmacyModeAccount: pharmacyMode.check,
}));

const { buildJourneyFollowupText, processWebinarFollowups } =
  await import('./webinar-followups.js');

describe('buildJourneyFollowupText', () => {
  const pickerUrl = 'https://liff.line.me/123/?page=webinar&slug=demo';
  const bookingUrl = 'https://line.the-harness.com/t/booking';

  test('未予約者には回の選択を案内する', () => {
    const text = buildJourneyFollowupText(
      'picker_no_registration', 'AI導入ライブ', pickerUrl, bookingUrl,
    );
    expect(text).toContain('30分間隔');
    expect(text).toContain(pickerUrl);
    expect(text).not.toContain(bookingUrl);
  });

  test('予約後の未視聴者には次回への選び直しを案内する', () => {
    const text = buildJourneyFollowupText(
      'registered_no_show', 'AI導入ライブ', pickerUrl, bookingUrl,
    );
    expect(text).toContain('選び直せます');
    expect(text).toContain(pickerUrl);
  });

  test('フォーム回答後の未予約者には相談予約リンクだけを案内する', () => {
    const text = buildJourneyFollowupText(
      'submitted_no_booking_30m', 'AI導入ライブ', pickerUrl, bookingUrl,
    );
    expect(text).toContain('回答の送信は完了');
    expect(text).toContain(bookingUrl);
    expect(text).not.toContain(pickerUrl);
  });
});

describe('processWebinarFollowups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pharmacyMode.enabled = false;
  });

  test('ブロック済みfriendを候補から除外し、選択後のブロックもpendingに残さない', async () => {
    const preparedSql: string[] = [];
    const updates: Array<{ sql: string; values: unknown[] }> = [];
    const candidate = {
      webinar_id: 'webinar-1',
      account_id: 'account-1',
      friend_id: 'friend-1',
      slug: 'demo',
      form_id: 'form-1',
      cta_clicked_at: '2026-08-10T19:00:00+09:00',
    };
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            values = bound;
            return this;
          },
          async all() {
            if (sql.includes('FROM clicks c')) {
              return { results: values[1] === 'after_30m' ? [candidate] : [] };
            }
            return { results: [] };
          },
          async first() {
            if (sql.includes('line_accounts')) return { ok: 1 };
            if (sql.includes('SELECT id, retry_key, status FROM webinar_followups')) {
              return { id: 'followup-1', retry_key: 'retry-1', status: 'pending' };
            }
            return null;
          },
          async run() {
            updates.push({ sql, values });
            return { success: true };
          },
        };
      },
    } as unknown as D1Database;
    dbMocks.getFriendById.mockResolvedValue({
      id: 'friend-1', line_user_id: 'U1', is_following: 0,
    });

    const result = await processWebinarFollowups(db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(preparedSql.some((sql) =>
      sql.includes('JOIN friends f') &&
      sql.includes('f.id = c.friend_id') &&
      sql.includes('f.is_following = 1'),
    )).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("last_error = 'not_following'"),
      values: ['2026-08-10T20:00:00+09:00', 'followup-1'],
    }));
    expect(preparedSql.some((sql) => sql.includes('tenant_line_accounts'))).toBe(true);
    expect(preparedSql.some((sql) => sql.includes('account.is_active = 1'))).toBe(true);
    expect(preparedSql.some((sql) => sql.includes("tenant.status = 'active'"))).toBe(true);
    expect(preparedSql.some((sql) => sql.includes('f.line_account_id = account.id'))).toBe(true);
    expect(preparedSql.filter((sql) => sql.includes('FROM webinar_picker_opens') || sql.includes('FROM webinar_registrations r') || sql.includes('FROM form_submissions fs')).every(
      (sql) => sql.includes('f.line_account_id = account.id'),
    )).toBe(true);
  });

  test('pharmacy account candidates are skipped before creating a followup', async () => {
    const candidate = {
      webinar_id: 'webinar-1', account_id: 'pharmacy-1', friend_id: 'friend-1',
      slug: 'demo', form_id: 'form-1', cta_clicked_at: '2026-08-10T19:00:00+09:00',
    };
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) { values = bound; return this; },
          async all() {
            return { results: sql.includes('FROM clicks c') && values[1] === 'after_30m' ? [candidate] : [] };
          },
          async first() { return { id: 'followup-1', retry_key: 'retry-1', status: 'pending' }; },
          async run() { writes.push(sql); return { success: true }; },
        };
      },
    } as unknown as D1Database;
    const canProcessAccount = vi.fn().mockResolvedValue(false);

    const result = await processWebinarFollowups(db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
      canProcessAccount,
    });

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(canProcessAccount).toHaveBeenCalledWith('pharmacy-1');
    expect(dbMocks.getFriendById).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test('callback なしでも pharmacy account の followup を作成しない', async () => {
    pharmacyMode.enabled = true;
    const candidate = {
      webinar_id: 'webinar-1', account_id: 'pharmacy-1', friend_id: 'friend-1',
      slug: 'demo', form_id: 'form-1', cta_clicked_at: '2026-08-10T19:00:00+09:00',
    };
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) { values = bound; return this; },
          async all() {
            return { results: sql.includes('FROM clicks c') && values[1] === 'after_30m' ? [candidate] : [] };
          },
          async first() { return { id: 'followup-1', retry_key: 'retry-1', status: 'pending' }; },
          async run() { writes.push(sql); return { success: true }; },
        };
      },
    } as unknown as D1Database;

    const result = await processWebinarFollowups(db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(pharmacyMode.check).toHaveBeenCalledWith(expect.anything(), 'pharmacy-1');
    expect(writes).toEqual([]);
  });

  test('stopped or unmapped account is skipped before followup creation', async () => {
    const candidate = {
      webinar_id: 'webinar-1', account_id: 'account-unmapped', friend_id: 'friend-1',
      slug: 'demo', form_id: 'form-1', cta_clicked_at: '2026-08-10T19:00:00+09:00',
    };
    const preparedSql: string[] = [];
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) { values = bound; return this; },
          async all() {
            return { results: sql.includes('FROM clicks c') && values[1] === 'after_30m' ? [candidate] : [] };
          },
          async first() {
            if (sql.includes('line_accounts')) return null;
            return { id: 'followup-1', retry_key: 'retry-1', status: 'pending' };
          },
          async run() { writes.push(sql); return { success: true }; },
        };
      },
    } as unknown as D1Database;
    dbMocks.getFriendById.mockResolvedValue({ id: 'friend-1', line_user_id: 'U1', is_following: 1 });

    const result = await processWebinarFollowups(db, {
      proxyBaseUrl: 'https://proxy.example.com',
      defaultAccessToken: 'token',
      defaultLiffId: 'liff-1',
    });

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(dbMocks.getFriendById).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(preparedSql.some((sql) => sql.includes('tenant_line_accounts'))).toBe(true);
  });
});
