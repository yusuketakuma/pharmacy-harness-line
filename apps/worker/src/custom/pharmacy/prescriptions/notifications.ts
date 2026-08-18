import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { pushViaHarnessProxy } from '../../../services/line-proxy-send.js';
import type { PrescriptionStatus } from './state.js';

export interface PrescriptionNotificationOptions {
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
}

export type PrescriptionNotificationStatus = 'sent' | 'already_sent' | 'failed' | 'skipped' | 'superseded';

interface NotificationRecipient {
  status_event_id: string;
  status: PrescriptionStatus;
  reason_code: string | null;
  revision: number | null;
  line_user_id: string;
  channel_access_token: string;
  intake_method: 'E_PRESCRIPTION' | 'PAPER' | 'MEDICAL_INSTITUTION_SENT';
  liff_id: string | null;
  estimated_ready_at: string | null;
}

const REASONS: Record<string, string> = {
  blurred: '画像がぼやけています',
  cropped: '処方せんの一部が切れています',
  glare: '光が反射しています',
  unreadable: '文字を読み取れません',
  missing_page: '不足しているページがあります',
};

function prescriptionPageUrl(liffId: string | null, submissionId: string): string | null {
  if (!liffId) return null;
  const query = new URLSearchParams({ page: 'prescription', submissionId });
  return `https://liff.line.me/${encodeURIComponent(liffId)}/?${query.toString()}`;
}

function formatReadyAt(value: string | null, now = new Date()): string | null {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) return null;
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(timestamp));
}

export function prescriptionNotificationText(
  status: PrescriptionStatus,
  reasonCode: string | null,
  details: Pick<NotificationRecipient, 'intake_method' | 'liff_id' | 'estimated_ready_at'> & {
    submissionId: string;
  } = {
    intake_method: 'PAPER',
    liff_id: null,
    estimated_ready_at: null,
    submissionId: '',
  },
): string {
  const readyAt = formatReadyAt(details.estimated_ready_at);
  switch (status) {
    case 'received':
      if (details.intake_method === 'E_PRESCRIPTION') {
        return '処方せんを受け付けました。薬局で内容を確認し、準備状況をLINEでお知らせします。';
      }
      if (details.intake_method === 'MEDICAL_INSTITUTION_SENT') {
        return '受付内容を確認しています。準備状況はLINEでお知らせします。';
      }
      return '処方せんを受け付けました。薬局で内容を確認し、準備状況をLINEでお知らせします。処方せん原本は来局時にお持ちください。';
    case 'accepted':
      return readyAt
        ? `処方せんを確認しました。準備予定: ${readyAt}。準備ができたらLINEでお知らせします。`
        : '処方せんを確認しました。準備を進めています。準備ができたらLINEでお知らせします。';
    case 'needs_resubmission': {
      const link = prescriptionPageUrl(details.liff_id, details.submissionId);
      const linkText = link ? `\n再送する: ${link}` : '';
      return `処方せん画像をもう一度送信してください。理由: ${REASONS[reasonCode ?? ''] ?? '画像を確認できませんでした'}${linkText}`;
    }
    case 'ready':
      if (details.intake_method === 'E_PRESCRIPTION') {
        return 'お薬の準備ができました。ご案内した受取方法でお受け取りください。';
      }
      if (details.intake_method === 'MEDICAL_INSTITUTION_SENT') {
        return 'お薬の準備ができました。薬局へ受取方法をご確認ください。';
      }
      return 'お薬の準備ができました。処方せん原本を持って薬局へお越しください。';
    case 'closed':
      return 'お薬のお渡しが完了しました。ご利用ありがとうございました。';
    case 'cancelled':
      return '処方せんの受付をキャンセルしました。ご不明点は個別チャットでお問い合わせください。';
    default:
      return '処方せんの受付状況が更新されました。';
  }
}

export async function deliverPrescriptionNotification(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
  options: PrescriptionNotificationOptions,
  statusEventId: string | null = null,
): Promise<{ status: PrescriptionNotificationStatus }> {
  const recipient = await db.prepare(
    `SELECT e.id AS status_event_id, e.reason_code, e.revision, s.status,
            s.intake_method,
            f.line_user_id, la.channel_access_token, la.liff_id,
            q.estimated_ready_at
       FROM pharmacy_prescription_submissions s
       INNER JOIN friends f
         ON f.id = s.friend_id AND f.line_account_id = s.line_account_id
       INNER JOIN line_accounts la ON la.id = s.line_account_id
       INNER JOIN pharmacy_prescription_events e
         ON e.submission_id = s.id AND e.event_type = 'status_changed'
        AND e.to_status = s.status
        AND (? IS NULL OR e.id = ?)
       LEFT JOIN pharmacy_fulfillment_quotes q
         ON q.id = (
           SELECT quote.id
             FROM pharmacy_fulfillment_quotes quote
            WHERE quote.submission_id = s.id
              AND quote.line_account_id = s.line_account_id
              AND quote.created_at <= e.created_at
            ORDER BY quote.created_at DESC, quote.revision DESC, quote.id DESC
            LIMIT 1
         )
      WHERE s.id = ? AND s.line_account_id = ?
        AND f.is_following = 1 AND la.is_active = 1
        AND s.readiness_notice_consent_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_prescription_events sent
           WHERE sent.submission_id = s.id
             AND sent.event_type = 'notification_sent'
             AND sent.actor_id = e.id
        )
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1`,
  ).bind(statusEventId, statusEventId, submissionId, lineAccountId).first<NotificationRecipient>();

  if (!recipient?.line_user_id || !recipient.channel_access_token) {
    if (statusEventId) {
      const statusEvent = await db.prepare(
        `SELECT e.to_status, s.status
           FROM pharmacy_prescription_events e
           INNER JOIN pharmacy_prescription_submissions s ON s.id = e.submission_id
          WHERE e.id = ? AND e.submission_id = ? AND s.line_account_id = ?
            AND e.event_type = 'status_changed'`,
      ).bind(statusEventId, submissionId, lineAccountId).first<{ to_status: string; status: string }>();
      if (statusEvent && statusEvent.to_status !== statusEvent.status) return { status: 'superseded' };
      const sent = await db.prepare(
        `SELECT 1
           FROM pharmacy_prescription_events sent
           INNER JOIN pharmacy_prescription_submissions s ON s.id = sent.submission_id
          WHERE sent.submission_id = ? AND sent.actor_id = ?
            AND sent.event_type = 'notification_sent'
            AND s.line_account_id = ?
          LIMIT 1`,
      ).bind(submissionId, statusEventId, lineAccountId).first<{ 1: number }>();
      if (sent) return { status: 'already_sent' };
    }
    return { status: 'skipped' };
  }

  try {
    await pushViaHarnessProxy(
      options.proxyBaseUrl,
      recipient.channel_access_token,
      recipient.line_user_id,
      [{
        type: 'text',
        text: prescriptionNotificationText(recipient.status, recipient.reason_code, {
          intake_method: recipient.intake_method,
          liff_id: recipient.liff_id,
          estimated_ready_at: recipient.estimated_ready_at,
          submissionId,
        }),
      }],
      recipient.status_event_id,
      options.proxyDispatch,
    );
    await recordNotificationEvent(db, lineAccountId, submissionId, recipient, 'notification_sent');
    return { status: 'sent' };
  } catch {
    try {
      await recordNotificationEvent(db, lineAccountId, submissionId, recipient, 'notification_failed');
    } catch {
      // Keep the request failure-isolated and avoid exposing delivery/audit details.
      console.error('[pharmacy-prescription] notification audit unavailable');
    }
    return { status: 'failed' };
  }
}

async function recordNotificationEvent(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
  recipient: NotificationRecipient,
  eventType: 'notification_sent' | 'notification_failed',
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO pharmacy_prescription_events
       (id, submission_id, actor_type, actor_id, event_type,
        to_status, reason_code, revision, created_at)
     SELECT ?, s.id, 'system', ?, '${eventType}', ?, ?, ?, ?
       FROM pharmacy_prescription_submissions s
      WHERE s.id = ? AND s.line_account_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_prescription_events existing
           WHERE existing.submission_id = s.id
             AND existing.event_type = '${eventType}'
             AND existing.actor_id = ?
        )`,
  ).bind(
    crypto.randomUUID(), recipient.status_event_id, recipient.status,
    recipient.reason_code, recipient.revision, now, submissionId,
    lineAccountId, recipient.status_event_id,
  ).run();
}

export async function retryFailedPrescriptionNotifications(
  db: D1Database,
  options: PrescriptionNotificationOptions,
  limit = 50,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const due = await db.prepare(
    `SELECT s.line_account_id, failed.submission_id, failed.actor_id AS status_event_id
       FROM pharmacy_prescription_events failed
       INNER JOIN pharmacy_prescription_submissions s ON s.id = failed.submission_id
       INNER JOIN pharmacy_prescription_events changed
         ON changed.id = failed.actor_id
        AND changed.submission_id = failed.submission_id
        AND changed.to_status = s.status
      WHERE failed.event_type = 'notification_failed'
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_prescription_events sent
           WHERE sent.submission_id = failed.submission_id
             AND sent.event_type = 'notification_sent'
             AND sent.actor_id = failed.actor_id
        )
      GROUP BY s.line_account_id, failed.submission_id, failed.actor_id
      ORDER BY MIN(failed.created_at), failed.submission_id
      LIMIT ?`,
  ).bind(boundedLimit).all<{ line_account_id: string; submission_id: string; status_event_id: string }>();

  const result = { sent: 0, failed: 0, skipped: 0 };
  for (const row of due.results ?? []) {
    const delivery = await deliverPrescriptionNotification(
      db, row.line_account_id, row.submission_id, options, row.status_event_id,
    );
    if (delivery.status === 'sent' || delivery.status === 'already_sent') result.sent++;
    else if (delivery.status === 'failed') result.failed++;
    else result.skipped++;
  }
  return result;
}
