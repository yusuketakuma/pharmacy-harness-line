import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { getFriendByLineUserIdForAccount } from '@line-crm/db';
import { hasPharmacyCapability } from './access.js';
import { recordGrowthEvent } from './repository.js';
import { sendPharmacyAutomatedPush } from './sender.js';

export async function recordPharmacyFollow(input: {
  db: D1Database;
  lineAccountId: string | null;
  friendId: string;
  lineUserId: string;
  firstFollowedAt: string;
  proxyBaseUrl?: string;
  accessToken?: string;
  proxyDispatch?: HarnessProxyDispatch;
}): Promise<void> {
  if (!input.lineAccountId || !(await hasPharmacyCapability(input.db, input.lineAccountId, 'prescription_intake'))) return;
  await recordGrowthEvent(input.db, {
    lineAccountId: input.lineAccountId,
    eventType: 'first_follow',
    aggregateId: input.friendId,
    subjectKey: `friend:${input.friendId}`,
    occurredAt: input.firstFollowedAt,
    idempotencyKey: `first-follow:${input.friendId}:${input.firstFollowedAt}`,
  });
  if (!input.proxyBaseUrl || !input.accessToken) return;
  await sendPharmacyAutomatedPush({
    db: input.db,
    proxyBaseUrl: input.proxyBaseUrl,
    proxyDispatch: input.proxyDispatch,
    accessToken: input.accessToken,
    to: input.lineUserId,
    lineAccountId: input.lineAccountId,
    friendId: input.friendId,
    messageId: 'pharmacy_onboarding_v1',
    category: 'transactional_care',
    retryKey: `pharmacy-onboarding:${input.friendId}:${input.firstFollowedAt}`,
  });
}

export async function recordPharmacyUnfollowMetrics(input: {
  db: D1Database;
  lineAccountId: string | null;
  lineUserId: string;
}): Promise<void> {
  if (!input.lineAccountId || !(await hasPharmacyCapability(input.db, input.lineAccountId, 'prescription_intake'))) return;
  const friend = await getFriendByLineUserIdForAccount(input.db, input.lineUserId, input.lineAccountId);
  if (!friend || friend.line_account_id !== input.lineAccountId) return;
  const updated = await input.db.prepare(
    `SELECT id, last_unfollowed_at FROM friends WHERE id = ? AND line_account_id = ?`,
  ).bind(friend.id, input.lineAccountId).first<{ id: string; last_unfollowed_at: string | null }>();
  if (!updated?.last_unfollowed_at) return;
  await recordGrowthEvent(input.db, {
    lineAccountId: input.lineAccountId,
    eventType: 'unfollow',
    aggregateId: updated.id,
    subjectKey: `friend:${updated.id}`,
    occurredAt: updated.last_unfollowed_at,
    idempotencyKey: `unfollow:${updated.id}:${updated.last_unfollowed_at}`,
  });
}

export async function recordAcceptedSubmissionActivation(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
): Promise<void> {
  if (!(await hasPharmacyCapability(db, lineAccountId, 'prescription_intake'))) return;
  const row = await db.prepare(
    `SELECT s.friend_id AS friend_id, pp.patient_id AS patient_id, e.created_at
       FROM pharmacy_prescription_events e
      INNER JOIN pharmacy_prescription_submissions s ON s.id = e.submission_id
       LEFT JOIN pharmacy_prescription_patients pp
         ON pp.submission_id = s.id AND pp.line_account_id = s.line_account_id
        AND pp.owner_friend_id = s.friend_id
     WHERE e.submission_id = ? AND s.line_account_id = ?
       AND e.event_type = 'status_changed' AND e.to_status = 'accepted'
     ORDER BY e.created_at ASC LIMIT 1`,
  ).bind(submissionId, lineAccountId).first<{
    friend_id: string;
    patient_id: string | null;
    created_at: string;
  }>();
  if (!row) return;
  const count = row.patient_id
    ? await db.prepare(
      `SELECT COUNT(DISTINCT s.id) AS count
         FROM pharmacy_prescription_submissions s
         INNER JOIN pharmacy_prescription_events e
           ON e.submission_id = s.id AND e.event_type = 'status_changed' AND e.to_status = 'accepted'
         INNER JOIN pharmacy_prescription_patients pp
           ON pp.submission_id = s.id AND pp.line_account_id = s.line_account_id
          AND pp.owner_friend_id = s.friend_id
        WHERE s.line_account_id = ? AND pp.patient_id = ?`,
    ).bind(lineAccountId, row.patient_id).first<{ count: number }>()
    : await db.prepare(
      `SELECT COUNT(DISTINCT s.id) AS count
         FROM pharmacy_prescription_submissions s
         INNER JOIN pharmacy_prescription_events e
           ON e.submission_id = s.id AND e.event_type = 'status_changed' AND e.to_status = 'accepted'
         LEFT JOIN pharmacy_prescription_patients pp
           ON pp.submission_id = s.id AND pp.line_account_id = s.line_account_id
          AND pp.owner_friend_id = s.friend_id
        WHERE s.line_account_id = ? AND s.friend_id = ? AND pp.patient_id IS NULL`,
    ).bind(lineAccountId, row.friend_id).first<{ count: number }>();
  if (count?.count !== 1 && count?.count !== 2) return;
  await recordGrowthEvent(db, {
    lineAccountId,
    eventType: count.count === 1 ? 'first_submission' : 'second_submission',
    aggregateId: submissionId,
    subjectKey: row.patient_id ? `patient:${row.patient_id}` : `friend:${row.friend_id}`,
    occurredAt: row.created_at,
    idempotencyKey: `accepted:${submissionId}`,
  });
  const friendCount = await db.prepare(
    `SELECT COUNT(DISTINCT s.id) AS count
       FROM pharmacy_prescription_submissions s
       INNER JOIN pharmacy_prescription_events e
         ON e.submission_id = s.id AND e.event_type = 'status_changed' AND e.to_status = 'accepted'
      WHERE s.line_account_id = ? AND s.friend_id = ?`,
  ).bind(lineAccountId, row.friend_id).first<{ count: number }>();
  if (friendCount?.count === 1) {
    await recordGrowthEvent(db, {
      lineAccountId,
      eventType: 'first_friend_submission',
      aggregateId: submissionId,
      subjectKey: `friend:${row.friend_id}`,
      occurredAt: row.created_at,
      idempotencyKey: `friend-accepted:${submissionId}`,
    });
  }
}
