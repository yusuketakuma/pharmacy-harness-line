import type { HarnessProxyDispatch } from './line-proxy-send.js';
import { pushViaHarnessProxy } from './line-proxy-send.js';
import {
  isPharmacyModeAccount,
} from '../custom/pharmacy/growth-loop/access.js';
import { readLineCredential } from '../custom/pharmacy/provisioning/line-credential-store.js';
import {
  sendPharmacyAutomatedPush,
  type PharmacyPushResult,
} from '../custom/pharmacy/growth-loop/sender.js';
import type { PharmacyMessageVars } from '../custom/pharmacy/growth-loop/policy.js';

export type MeetReminderKind = 'day_before' | 'hour_before';
export type MeetConsultationStatus = 'confirmed' | 'cancelled' | 'completed' | 'all';

export interface RegisterMeetConsultationInput {
  externalEventId: string;
  friendId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  meetUrl: string;
}

export interface MeetReminderSchedule {
  kind: MeetReminderKind;
  scheduledAt: string;
}

export interface MeetReminderDeliveryOptions {
  now: Date;
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
  lineCredentialKey?: string;
}

interface MeetConsultationRow {
  id: string;
  external_event_id: string;
  friend_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  meet_url: string;
  status: 'confirmed' | 'cancelled' | 'completed';
}

interface DueMeetReminderRow {
  id: string;
  consultation_id: string;
  friend_id: string;
  kind: MeetReminderKind;
  retry_count: number;
  delivery_id: string | null;
  title: string;
  starts_at: string;
  meet_url: string;
  line_user_id: string;
  line_account_id: string;
  channel_access_token: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_RETRY = 3;
const CLAIM_STALE_MS = 15 * MINUTE_MS;
const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z0-9-]+(?:[/?#].*)?$/i;

function normalizeDate(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid ISO datetime`);
  return date;
}

export function calculateMeetReminderSchedule(
  startsAt: string,
  now: Date,
): MeetReminderSchedule[] {
  const start = normalizeDate(startsAt, 'startsAt');
  const startMs = start.getTime();
  const nowMs = now.getTime();
  if (startMs <= nowMs) return [];

  const schedules: MeetReminderSchedule[] = [];
  const untilStart = startMs - nowMs;

  // 24時間以内に確定した予定は、前日通知を次のcronで即時送信する。
  // 開始1時間以内なら同時に2通送らず、1時間前通知だけにまとめる。
  if (untilStart > HOUR_MS) {
    schedules.push({
      kind: 'day_before',
      scheduledAt: new Date(Math.max(startMs - DAY_MS, nowMs)).toISOString(),
    });
  }
  schedules.push({
    kind: 'hour_before',
    scheduledAt: new Date(Math.max(startMs - HOUR_MS, nowMs)).toISOString(),
  });
  return schedules;
}

export function renderMeetReminderText(kind: MeetReminderKind, startsAt: string, meetUrl: string, now = new Date()): string {
  const start = normalizeDate(startsAt, 'startsAt');
  const jst = new Date(start.getTime() + 9 * HOUR_MS);
  const todayJst = new Date(now.getTime() + 9 * HOUR_MS);
  const today = todayJst.toISOString().slice(0, 10);
  const tomorrow = new Date(todayJst.getTime() + DAY_MS).toISOString().slice(0, 10);
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const iso = jst.toISOString();
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const time = iso.slice(11, 16);
  const dateLabel = `${month}月${day}日（${weekdays[jst.getUTCDay()]}）${time}`;
  const dayLabel = iso.slice(0, 10) === today ? '本日' : iso.slice(0, 10) === tomorrow ? '明日' : '';
  const lead = `${dayLabel}${dateLabel}から${kind === 'hour_before' ? '（開始約1時間前）' : ''}`;

  return `【個別相談リマインド】\n${lead}、Google Meetで個別相談を予定しています。\n\nお時間になりましたら、こちらからご参加ください。\n${meetUrl}\n\nよろしくお願いいたします！`;
}

export async function listMeetConsultations(
  db: D1Database,
  tenantId: string,
  lineAccountId: string,
  status: MeetConsultationStatus,
): Promise<unknown[]> {
  const result = await db.prepare(
    `SELECT c.id, c.external_event_id, c.friend_id, c.title, c.starts_at, c.ends_at,
            c.meet_url, c.status, c.created_at, c.updated_at,
            f.display_name,
            SUM(CASE WHEN r.status='pending' THEN 1 ELSE 0 END) AS pending_reminders,
            SUM(CASE WHEN r.status='sent' THEN 1 ELSE 0 END) AS sent_reminders,
            SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END) AS failed_reminders
       FROM meet_consultations c
       INNER JOIN friends f ON f.id = c.friend_id
       INNER JOIN tenant_line_accounts mapping ON mapping.line_account_id = f.line_account_id
       LEFT JOIN meet_consultation_reminders r ON r.consultation_id = c.id
      WHERE (? = 'all' OR c.status = ?) AND mapping.tenant_id = ?
        AND f.line_account_id = ?
      GROUP BY c.id
      ORDER BY c.starts_at ASC`,
  ).bind(status, status, tenantId, lineAccountId).all();
  return result.results ?? [];
}

export async function registerMeetConsultation(
  db: D1Database,
  input: RegisterMeetConsultationInput,
  lineAccountId: string,
  now = new Date(),
): Promise<{ id: string; startsAt: string; reminders: MeetReminderSchedule[] }> {
  if (!input.externalEventId.trim()) throw new Error('externalEventId is required');
  if (!input.friendId.trim()) throw new Error('friendId is required');
  if (!input.title.trim()) throw new Error('title is required');
  if (!MEET_URL_RE.test(input.meetUrl)) throw new Error('meetUrl must be a Google Meet URL');

  const start = normalizeDate(input.startsAt, 'startsAt');
  const end = normalizeDate(input.endsAt, 'endsAt');
  if (end.getTime() <= start.getTime()) throw new Error('endsAt must be after startsAt');
  if (start.getTime() <= now.getTime()) throw new Error('startsAt must be in the future');

  const friend = await db
    .prepare('SELECT id FROM friends WHERE id = ? AND line_account_id = ? AND is_following = 1')
    .bind(input.friendId, lineAccountId)
    .first<{ id: string }>();
  if (!friend) throw new Error('friend not found or not following');

  const existing = await db
    .prepare(`SELECT consultation.* FROM meet_consultations consultation
      INNER JOIN friends friend ON friend.id = consultation.friend_id
      WHERE consultation.external_event_id = ? AND friend.line_account_id = ?`)
    .bind(input.externalEventId, lineAccountId)
    .first<MeetConsultationRow>();
  const consultationId = existing?.id ?? crypto.randomUUID();
  const normalizedStart = start.toISOString();
  const normalizedEnd = end.toISOString();
  const scheduleChanged = Boolean(
    existing &&
    (existing.friend_id !== input.friendId ||
      existing.starts_at !== normalizedStart ||
      existing.ends_at !== normalizedEnd ||
      existing.meet_url !== input.meetUrl),
  );
  const nowIso = now.toISOString();

  const schedules = calculateMeetReminderSchedule(normalizedStart, now);
  const expectedKinds = new Set(schedules.map((item) => item.kind));
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO meet_consultations
        (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
       ON CONFLICT(external_event_id) DO UPDATE SET
         friend_id=excluded.friend_id,
         title=excluded.title,
         starts_at=excluded.starts_at,
         ends_at=excluded.ends_at,
         meet_url=excluded.meet_url,
         status='confirmed',
         updated_at=excluded.updated_at
       WHERE EXISTS (
         SELECT 1 FROM friends scoped_friend
          WHERE scoped_friend.id = meet_consultations.friend_id
            AND scoped_friend.line_account_id = ?
       )`,
    )
    .bind(
      consultationId,
      input.externalEventId,
      input.friendId,
      input.title,
      normalizedStart,
      normalizedEnd,
      input.meetUrl,
      nowIso,
      nowIso,
      lineAccountId,
    ),
  ];
  for (const item of schedules) {
    // 再スケジュールは新しい配送世代: delivery_id を採番し直して、LINE proxy の
    // 送信済みledgerが前世代のretry keyを再利用して新通知を握り潰すのを防ぐ。
    // 同世代のretryや同日時の再登録ではdelivery_idが変わらずdedupeが効く。
    statements.push(db.prepare(
      `INSERT INTO meet_consultation_reminders
        (id, consultation_id, kind, scheduled_at, status, retry_count, delivery_id, created_at, updated_at)
       SELECT ?, consultation.id, ?, ?, 'pending', 0, ?, ?, ?
         FROM meet_consultations AS consultation
         INNER JOIN friends AS friend ON friend.id = consultation.friend_id
        WHERE consultation.external_event_id = ? AND friend.line_account_id = ?
       ON CONFLICT(consultation_id, kind) DO UPDATE SET
         scheduled_at=excluded.scheduled_at, status='pending', retry_count=0,
         delivery_id=excluded.delivery_id,
         sent_at=NULL, last_error=NULL, updated_at=excluded.updated_at
       WHERE ? = 1 OR meet_consultation_reminders.status = 'cancelled'`,
    ).bind(
      crypto.randomUUID(), item.kind, item.scheduledAt, crypto.randomUUID(), nowIso, nowIso,
      input.externalEventId, lineAccountId, !existing || scheduleChanged ? 1 : 0,
    ));
  }

  // 直前への日程変更などで不要になった種類は送らない。
  for (const kind of ['day_before', 'hour_before'] as const) {
    if (expectedKinds.has(kind)) continue;
    statements.push(db.prepare(
        `UPDATE meet_consultation_reminders
            SET status='cancelled', updated_at=?
          WHERE consultation_id = (
            SELECT consultation.id FROM meet_consultations AS consultation
            INNER JOIN friends AS friend ON friend.id = consultation.friend_id
            WHERE consultation.external_event_id = ? AND friend.line_account_id = ?
          ) AND kind=? AND status IN ('pending','failed','processing')`,
      )
      .bind(nowIso, input.externalEventId, lineAccountId, kind));
  }

  const results = await db.batch(statements);
  if (results[0]?.meta?.changes !== 1) throw new Error('consultation account scope conflict');
  const registered = await db.prepare(`SELECT consultation.id FROM meet_consultations consultation
    INNER JOIN friends friend ON friend.id = consultation.friend_id
    WHERE consultation.external_event_id = ? AND friend.line_account_id = ?`)
    .bind(input.externalEventId, lineAccountId).first<{ id: string }>();
  if (!registered) throw new Error('consultation account scope conflict');

  return { id: registered.id, startsAt: normalizedStart, reminders: schedules };
}

export async function cancelMeetConsultation(
  db: D1Database,
  externalEventId: string,
  lineAccountId: string,
  now = new Date(),
): Promise<boolean> {
  const consultation = await db
    .prepare(`SELECT consultation.id FROM meet_consultations consultation
      INNER JOIN friends friend ON friend.id = consultation.friend_id
      WHERE consultation.external_event_id = ? AND friend.line_account_id = ?`)
    .bind(externalEventId, lineAccountId)
    .first<{ id: string }>();
  if (!consultation) return false;
  const nowIso = now.toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE meet_consultations AS consultation
      SET status='cancelled', updated_at=?
      WHERE consultation.id=? AND EXISTS (
        SELECT 1 FROM friends friend
         WHERE friend.id = consultation.friend_id AND friend.line_account_id = ?
      )`).bind(nowIso, consultation.id, lineAccountId),
    db.prepare(
      `UPDATE meet_consultation_reminders
          SET status='cancelled', updated_at=?
        WHERE consultation_id=? AND status IN ('pending','failed')
          AND EXISTS (
            SELECT 1 FROM meet_consultations scoped_consultation
            INNER JOIN friends scoped_friend ON scoped_friend.id = scoped_consultation.friend_id
            WHERE scoped_consultation.id = meet_consultation_reminders.consultation_id
              AND scoped_friend.line_account_id = ?
          )`,
    ).bind(nowIso, consultation.id, lineAccountId),
  ]);
  return results[0]?.meta?.changes === 1;
}

export function meetJstDateTime(startsAt: string): { genericDate: string; genericTime: string } {
  const jst = new Date(normalizeDate(startsAt, 'startsAt').getTime() + 9 * HOUR_MS).toISOString();
  return { genericDate: jst.slice(0, 10), genericTime: jst.slice(11, 16) };
}

/**
 * 薬局アカウントは承認済みテンプレート送信経路(meet_consultation_v1)に
 * 限定し、暗号化 credential ストアから token を取得する。
 * line_accounts.channel_access_token の平文列は非薬局の従来経路専用。
 */
async function dispatchMeetReminder(
  db: D1Database,
  row: DueMeetReminderRow,
  options: MeetReminderDeliveryOptions,
): Promise<void> {
  if (await isPharmacyModeAccount(db, row.line_account_id)) {
    const tenant = await db.prepare(
      `SELECT mapping.tenant_id FROM tenant_line_accounts AS mapping
        WHERE mapping.line_account_id = ? LIMIT 1`,
    ).bind(row.line_account_id).first<{ tenant_id: string }>();
    const accessToken = options.lineCredentialKey && tenant
      ? await readLineCredential(db, options.lineCredentialKey, {
          tenantId: tenant.tenant_id,
          lineAccountId: row.line_account_id,
          kind: 'channel_access_token',
        })
      : null;
    if (!accessToken) throw new Error('meet reminder channel credential unavailable');
    const { genericDate, genericTime } = meetJstDateTime(row.starts_at);
    const vars: PharmacyMessageVars = {
      meetStatus: row.kind,
      genericDate,
      genericTime,
      meetUrl: row.meet_url,
    };
    const outcome: PharmacyPushResult = await sendPharmacyAutomatedPush({
      db,
      proxyBaseUrl: options.proxyBaseUrl,
      proxyDispatch: options.proxyDispatch,
      accessToken,
      to: row.line_user_id,
      lineAccountId: row.line_account_id,
      friendId: row.friend_id,
      messageId: 'meet_consultation_v1',
      category: 'transactional_care',
      vars,
      // delivery_id is re-minted per schedule generation, so the same key
      // dedupes retries of this generation without reusing an older one.
      retryKey: `meet-reminder:${row.delivery_id ?? row.id}`,
    });
    if (outcome !== 'sent' && outcome !== 'already_sent') {
      throw new Error(`meet reminder not dispatched: ${outcome}`);
    }
    return;
  }
  const text = renderMeetReminderText(row.kind, row.starts_at, row.meet_url, options.now);
  await pushViaHarnessProxy(
    options.proxyBaseUrl,
    row.channel_access_token,
    row.line_user_id,
    [{ type: 'text', text }],
    row.delivery_id ?? row.id,
    options.proxyDispatch,
  );
}

export async function processDueMeetConsultationReminders(
  db: D1Database,
  options: MeetReminderDeliveryOptions,
): Promise<{ sent: number; failed: number }> {
  const nowIso = options.now.toISOString();
  const due = await db
    .prepare(
      `SELECT r.id, r.consultation_id, r.kind, r.retry_count, r.delivery_id,
              c.title, c.starts_at, c.meet_url, c.friend_id,
              f.provider_line_user_id AS line_user_id, f.line_account_id,
              la.channel_access_token
         FROM meet_consultation_reminders r
         INNER JOIN meet_consultations c ON c.id = r.consultation_id
         INNER JOIN friends f ON f.id = c.friend_id
         INNER JOIN line_accounts la ON la.id = f.line_account_id
        WHERE r.retry_count < ?
          AND (r.status IN ('pending','failed')
               OR (r.status = 'processing' AND r.updated_at <= ?))
          AND r.scheduled_at <= ?
          AND c.status = 'confirmed'
          AND c.starts_at > ?
          AND f.is_following = 1
          AND la.is_active = 1
        ORDER BY r.scheduled_at ASC
        LIMIT 100`,
    )
    .bind(
      MAX_RETRY,
      new Date(options.now.getTime() - CLAIM_STALE_MS).toISOString(),
      nowIso,
      nowIso,
    )
    .all<DueMeetReminderRow>();

  let sent = 0;
  let failed = 0;
  for (const row of due.results ?? []) {
    const attempt = row.retry_count + 1;
    const claim = await db.prepare(
      `UPDATE meet_consultation_reminders
          SET status='processing', retry_count=?, last_error=NULL, updated_at=?
        WHERE id=? AND retry_count=? AND delivery_id IS ?
          AND (status IN ('pending','failed')
               OR (status='processing' AND updated_at <= ?))
          AND EXISTS (
            SELECT 1 FROM meet_consultations c
            INNER JOIN friends f ON f.id = c.friend_id
            INNER JOIN line_accounts la ON la.id = f.line_account_id
            WHERE c.id = meet_consultation_reminders.consultation_id
              AND c.status = 'confirmed' AND c.starts_at > ?
              AND f.is_following = 1 AND la.is_active = 1
          )`,
    ).bind(
      attempt,
      nowIso,
      row.id,
      row.retry_count,
      row.delivery_id,
      new Date(options.now.getTime() - CLAIM_STALE_MS).toISOString(),
      nowIso,
    ).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;

    try {
      await dispatchMeetReminder(db, row, options);
      const settled = await db
        .prepare(
          `UPDATE meet_consultation_reminders
              SET status='sent', sent_at=?, last_error=NULL, updated_at=?
            WHERE id=? AND status='processing' AND retry_count=? AND delivery_id IS ?`,
        )
        .bind(nowIso, nowIso, row.id, attempt, row.delivery_id)
        .run();
      if ((settled.meta?.changes ?? 0) === 1) sent++;
    } catch (error) {
      const settled = await db
        .prepare(
          `UPDATE meet_consultation_reminders
              SET status='failed', last_error=?, updated_at=?
            WHERE id=? AND status='processing' AND retry_count=? AND delivery_id IS ?`,
        )
        .bind(
          error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
          nowIso,
          row.id,
          attempt,
          row.delivery_id,
        )
        .run();
      if ((settled.meta?.changes ?? 0) === 1) failed++;
    }
  }
  return { sent, failed };
}
