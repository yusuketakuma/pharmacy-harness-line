import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import type { PrescriptionStatus } from './state.js';
import { sendPharmacyAutomatedPush } from '../growth-loop/sender.js';

export interface PrescriptionNotificationOptions {
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
}

interface NotificationRecipient {
  status_event_id: string;
  status: PrescriptionStatus;
  reason_code: string | null;
  revision: number | null;
  line_user_id: string;
  channel_access_token: string;
  line_account_id: string;
  friend_id: string;
}

const REASONS: Record<string, string> = {
  blurred: '画像がぼやけています',
  cropped: '処方せんの一部が切れています',
  glare: '光が反射しています',
  unreadable: '文字を読み取れません',
  missing_page: '不足しているページがあります',
};

export function prescriptionNotificationText(
  status: PrescriptionStatus,
  reasonCode: string | null,
): string {
  switch (status) {
    case 'received':
      return '受付内容の確認待ちです。確認後、LINEでお知らせします。処方せん原本は来局時にお持ちください。';
    case 'accepted':
      return '処方せんを確認し、受付しました。お薬を準備しています。';
    case 'needs_resubmission':
      return `処方せん画像をもう一度送信してください。理由: ${REASONS[reasonCode ?? ''] ?? '画像を確認できませんでした'}`;
    case 'ready':
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
  submissionId: string,
  options: PrescriptionNotificationOptions,
  statusEventId: string | null = null,
): Promise<{ status: 'sent' | 'failed' | 'skipped' }> {
  const recipient = await db.prepare(
    `SELECT e.id AS status_event_id, e.reason_code, e.revision, s.status,
            s.line_account_id, s.friend_id,
            f.line_user_id, la.channel_access_token
       FROM pharmacy_prescription_submissions s
       INNER JOIN friends f
         ON f.id = s.friend_id AND f.line_account_id = s.line_account_id
       INNER JOIN line_accounts la ON la.id = s.line_account_id
       INNER JOIN pharmacy_prescription_events e
         ON e.submission_id = s.id AND e.event_type = 'status_changed'
        AND e.to_status = s.status
      WHERE s.id = ? AND (? IS NULL OR e.id = ?)
        AND f.is_following = 1 AND la.is_active = 1
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_prescription_events sent
           WHERE sent.submission_id = s.id
             AND sent.event_type = 'notification_sent'
             AND sent.actor_id = e.id
        )
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1`,
  ).bind(submissionId, statusEventId, statusEventId).first<NotificationRecipient>();
  if (!recipient?.line_user_id || !recipient.channel_access_token) return { status: 'skipped' };

  try {
    await sendPharmacyAutomatedPush({
      db,
      proxyBaseUrl: options.proxyBaseUrl,
      proxyDispatch: options.proxyDispatch,
      accessToken: recipient.channel_access_token,
      to: recipient.line_user_id,
      lineAccountId: recipient.line_account_id,
      friendId: recipient.friend_id,
      messageId: 'prescription_status_v1',
      category: 'transactional_care',
      vars: {
        status: recipient.status === 'draft' ? undefined : recipient.status,
        reasonCode: recipient.reason_code as 'blurred' | 'cropped' | 'glare' | 'unreadable' | 'missing_page' | undefined,
      },
      retryKey: recipient.status_event_id,
    });
    await recordNotificationEvent(db, submissionId, recipient, 'notification_sent');
    return { status: 'sent' };
  } catch {
    await recordNotificationEvent(db, submissionId, recipient, 'notification_failed');
    return { status: 'failed' };
  }
}

async function recordNotificationEvent(
  db: D1Database,
  submissionId: string,
  recipient: NotificationRecipient,
  eventType: 'notification_sent' | 'notification_failed',
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO pharmacy_prescription_events
       (id, submission_id, actor_type, actor_id, event_type,
        to_status, reason_code, revision, created_at)
     SELECT ?, id, 'system', ?, '${eventType}', ?, ?, ?, ?
       FROM pharmacy_prescription_submissions
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_prescription_events existing
           WHERE existing.submission_id = ?
             AND existing.event_type = '${eventType}'
             AND existing.actor_id = ?
        )`,
  ).bind(
    crypto.randomUUID(), recipient.status_event_id, recipient.status,
    recipient.reason_code, recipient.revision, now, submissionId,
    submissionId, recipient.status_event_id,
  ).run();
}

export async function retryFailedPrescriptionNotifications(
  db: D1Database,
  options: PrescriptionNotificationOptions,
  limit = 50,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const due = await db.prepare(
    `SELECT failed.submission_id, failed.actor_id AS status_event_id
       FROM pharmacy_prescription_events failed
       INNER JOIN pharmacy_prescription_submissions s ON s.id = failed.submission_id
       INNER JOIN pharmacy_account_capabilities pc
         ON pc.line_account_id = s.line_account_id AND pc.mode = 'pharmacy'
        AND EXISTS (SELECT 1 FROM json_each(pc.capabilities_json) WHERE json_each.value = 'prescription_intake')
       INNER JOIN pharmacy_prescription_events changed
         ON changed.id = failed.actor_id AND changed.to_status = s.status
      WHERE failed.event_type = 'notification_failed'
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_prescription_events sent
           WHERE sent.submission_id = failed.submission_id
             AND sent.event_type = 'notification_sent'
             AND sent.actor_id = failed.actor_id
        )
      GROUP BY failed.submission_id, failed.actor_id
      ORDER BY MIN(failed.created_at), failed.submission_id
      LIMIT ?`,
  ).bind(boundedLimit).all<{ submission_id: string; status_event_id: string }>();

  const result = { sent: 0, failed: 0, skipped: 0 };
  for (const row of due.results ?? []) {
    const delivery = await deliverPrescriptionNotification(
      db, row.submission_id, options, row.status_event_id,
    );
    result[delivery.status]++;
  }
  return result;
}
