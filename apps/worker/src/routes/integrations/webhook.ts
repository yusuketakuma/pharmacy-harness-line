import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import { createStickerMessageContent } from '@line-crm/shared';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserIdForAccount,
  getScenariosForAccount,
  enrollFriendInScenario,
  upsertChatOnMessage,
  jstNow,
  toJstString,
  getEntryRouteByRefCode,
  getMessageTemplateById,
} from '@line-crm/db';
import type { EntryRoute, Friend } from '@line-crm/db';
import { fireEvent } from '../../services/event-bus.js';
import { matchAndReply } from '../../services/auto-reply.js';
import { buildMessage } from '../../services/step-delivery.js';
import { pushImmediateFirstStep } from '../../services/immediate-first-step.js';
import type { Env } from '../../index.js';
import { awardActivityMileage } from '../../services/activity-mileage.js';
import { replyViaHarnessProxy } from '../../services/line-proxy-send.js';
import type { HarnessProxyDispatch } from '../../services/line-proxy-send.js';
import { dispatchLineProxyLocally } from '../../services/local-line-proxy.js';
import { recordPharmacyFollow, recordPharmacyUnfollowMetrics } from '../../custom/pharmacy/growth-loop/onboarding.js'; // custom:pharmacy-growth-loop
import { isPharmacyModeAccount } from '../../custom/pharmacy/growth-loop/access.js'; // custom:pharmacy-allowlist
import { handleMedicationFollowUpPostback } from '../../custom/pharmacy/medication-followup/webhook.js'; // custom:pharmacy-medication-followup
import { readLineCredential } from '../../custom/pharmacy/provisioning/line-credential-store.js'; // custom:pharmacy-credentials

const webhook = new Hono<Env>();

// LINE webhook bodies are small (events array). Cap defends against unauthenticated
// large-payload DoS before signature verification (#104). 1 MiB leaves room for
// bursty batched deliveries (~100 events × ~5 KB) while still well below the
// 128 MB Cloudflare Workers memory ceiling.
const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024; // 1 MiB

// Durable inbox (H-3). A receipt row owns one event body plus its processing
// state; the cron sweep re-runs whatever the request-time attempt did not
// finish. See packages/db/migrations/custom_023_pharmacy_webhook_durable_inbox.sql.
const WEBHOOK_INBOX_LEASE_MS = 5 * 60_000;
const WEBHOOK_INBOX_MAX_ATTEMPTS = 10;
const WEBHOOK_INBOX_SWEEP_LIMIT = 50;
const WEBHOOK_RECEIPT_RETENTION_DAYS = 30;

interface WebhookInboxRow {
  tenant_id: string;
  line_account_id: string;
  webhook_event_id: string;
  payload: string | null;
}

interface WebhookEventRunner {
  db: D1Database;
  credentialRootSecret: string;
  workerUrl?: string;
  liffUrl?: string;
  r2?: R2Bucket;
  proxyDispatch?: HarnessProxyDispatch;
  /** Pre-resolved on the request path; the cron sweep resolves per row. */
  lineClient?: LineClient;
  channelAccessToken?: string;
}

/**
 * LINE always sends webhookEventId. Synthesize one for anything that does not
 * so the event is still stored durably — it just cannot be deduplicated.
 */
function readWebhookEventId(event: WebhookEvent): string {
  const raw = (event as WebhookEvent & { webhookEventId?: unknown }).webhookEventId;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 128
    ? raw
    : `synthetic:${crypto.randomUUID()}`;
}

/**
 * Returns true when this delivery is the one that stored the event. A false
 * means another delivery already owns it — completed (dedup) or still pending
 * for the sweep — so this request must not process it again.
 */
async function storeWebhookEvent(
  db: D1Database,
  tenantId: string,
  lineAccountId: string,
  webhookEventId: string,
  event: WebhookEvent,
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO pharmacy_webhook_event_receipts
      (tenant_id, line_account_id, webhook_event_id, received_at, payload, status, retry_count)
     VALUES (?, ?, ?, ?, ?, 'pending', 0)`,
  ).bind(tenantId, lineAccountId, webhookEventId, jstNow(), JSON.stringify(event)).run();
  // D1 always provides meta.changes. Test doubles and older compatible
  // adapters may omit it; only an explicit zero means this is a redelivery.
  return !result.meta || result.meta.changes !== 0;
}

/**
 * The single "process this event" path, used inline after the durable write
 * and again by the cron sweep. Leases the row, runs the handler, then settles
 * it as completed or failed — never deletes it.
 */
export async function runWebhookInboxEvent(
  runner: WebhookEventRunner,
  row: WebhookInboxRow & { event?: WebhookEvent },
  now: Date = new Date(),
): Promise<'completed' | 'failed' | 'skipped'> {
  const { db } = runner;
  const key = [row.tenant_id, row.line_account_id, row.webhook_event_id];

  const claim = await db.prepare(
    `UPDATE pharmacy_webhook_event_receipts
        SET status = 'processing',
            lease_until = ?,
            retry_count = retry_count + 1
      WHERE tenant_id = ? AND line_account_id = ? AND webhook_event_id = ?
        AND status <> 'completed'
        AND dead_lettered_at IS NULL
        AND (lease_until IS NULL OR lease_until <= ?)`,
  ).bind(
    toJstString(new Date(now.getTime() + WEBHOOK_INBOX_LEASE_MS)),
    ...key,
    toJstString(now),
  ).run();
  if (claim.meta && claim.meta.changes === 0) return 'skipped';

  try {
    const event = row.event
      ?? (row.payload ? JSON.parse(row.payload) as WebhookEvent : null);
    if (!event) throw new Error('WEBHOOK_INBOX_PAYLOAD_MISSING');

    const accessToken = runner.channelAccessToken
      ?? await readLineCredential(db, runner.credentialRootSecret, {
        tenantId: row.tenant_id,
        lineAccountId: row.line_account_id,
        kind: 'channel_access_token',
      });
    if (!accessToken) throw new Error('WEBHOOK_INBOX_CREDENTIAL_UNAVAILABLE');

    await handleEvent(
      db,
      runner.lineClient ?? new LineClient(accessToken),
      event,
      accessToken,
      row.line_account_id,
      row.tenant_id,
      runner.credentialRootSecret,
      runner.workerUrl,
      runner.liffUrl,
      runner.r2,
      runner.proxyDispatch,
    );
  } catch (err) {
    console.error('Error handling webhook event:', err);
    // Stay in the inbox. The sweep retries until the attempt cap, then the row
    // is dead-lettered — kept with its payload so it can be replayed by hand
    // (status back to 'pending', retry_count 0). No replay UI exists yet.
    await db.prepare(
      `UPDATE pharmacy_webhook_event_receipts
          SET status = 'failed', lease_until = NULL
        WHERE tenant_id = ? AND line_account_id = ? AND webhook_event_id = ?`,
    ).bind(...key).run();
    return 'failed';
  }

  await db.prepare(
    `UPDATE pharmacy_webhook_event_receipts
        SET status = 'completed', lease_until = NULL
      WHERE tenant_id = ? AND line_account_id = ? AND webhook_event_id = ?`,
  ).bind(...key).run();
  return 'completed';
}

/**
 * Cron recovery for events whose request-time attempt never finished (isolate
 * evicted, CPU limit, transient D1/LINE failure).
 */
export async function sweepWebhookInbox(options: {
  db: D1Database;
  credentialRootSecret?: string;
  workerUrl?: string;
  liffUrl?: string;
  r2?: R2Bucket;
  proxyDispatch?: HarnessProxyDispatch;
  now?: Date;
  limit?: number;
}): Promise<{ claimed: number; completed: number; failed: number; deadLettered: number }> {
  const { db } = options;
  const now = options.now ?? new Date();
  const nowJst = toJstString(now);
  const summary = { claimed: 0, completed: 0, failed: 0, deadLettered: 0 };

  // Attempt cap first, so a row that crashed mid-processing is retired by the
  // same rule as one that failed cleanly.
  const retired = await db.prepare(
    `UPDATE pharmacy_webhook_event_receipts
        SET status = 'failed', lease_until = NULL, dead_lettered_at = ?
      WHERE status <> 'completed'
        AND dead_lettered_at IS NULL
        AND retry_count >= ?`,
  ).bind(nowJst, WEBHOOK_INBOX_MAX_ATTEMPTS).run();
  summary.deadLettered = retired.meta?.changes ?? 0;

  if (!options.credentialRootSecret) return summary;

  const due = await db.prepare(
    `SELECT tenant_id, line_account_id, webhook_event_id, payload
       FROM pharmacy_webhook_event_receipts
      WHERE status <> 'completed'
        AND dead_lettered_at IS NULL
        AND payload IS NOT NULL
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY received_at
      LIMIT ?`,
  ).bind(nowJst, options.limit ?? WEBHOOK_INBOX_SWEEP_LIMIT).all<WebhookInboxRow>();

  const runner: WebhookEventRunner = {
    db,
    credentialRootSecret: options.credentialRootSecret,
    workerUrl: options.workerUrl,
    liffUrl: options.liffUrl,
    r2: options.r2,
    proxyDispatch: options.proxyDispatch,
  };

  for (const row of due.results ?? []) {
    const outcome = await runWebhookInboxEvent(runner, row, now)
      .catch(() => 'failed' as const);
    if (outcome === 'skipped') continue;
    summary.claimed++;
    summary[outcome]++;
  }
  return summary;
}

/**
 * M-7. Settled rows are only kept long enough to absorb LINE redelivery.
 * `pending`/`processing` rows are never purged regardless of age — deleting one
 * would drop an event that has not been handled yet.
 * `received_at` is written with jstNow(), so the cutoff compares lexicographically.
 */
export async function purgeWebhookEventReceipts(
  db: D1Database,
  options: { now?: Date; retentionDays?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? WEBHOOK_RECEIPT_RETENTION_DAYS;
  const cutoff = toJstString(new Date(now.getTime() - retentionDays * 86_400_000));
  const result = await db.prepare(
    `DELETE FROM pharmacy_webhook_event_receipts
      WHERE received_at < ?
        AND (status = 'completed' OR dead_lettered_at IS NOT NULL)`,
  ).bind(cutoff).run();
  return result.meta?.changes ?? 0;
}

async function ensureFriendFromWebhookUser(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string,
): Promise<Friend | null> {
  let friend = await getFriendByLineUserIdForAccount(db, userId, lineAccountId);

  if (!friend) {
    let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      // A signed webhook already proves this user interacted with the bot.
      // If profile lookup is temporarily unavailable, keep the event processable
      // by creating the friend with the LINE userId and filling profile later.
      console.error('[webhook] Failed to get profile for unknown user', err);
    }

    try {
      friend = await upsertFriend(db, {
        lineUserId: userId,
        lineAccountId,
        displayName: profile?.displayName ?? null,
        pictureUrl: profile?.pictureUrl ?? null,
        statusMessage: profile?.statusMessage ?? null,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'FRIEND_ACCOUNT_CONFLICT') {
        console.error('[webhook] Friend account conflict');
        return null;
      }
      throw error;
    }
  }

  return friend;
}

webhook.post('/webhook', async (c) => {
  // Pre-read size guard: reject before reading the body if Content-Length is oversized.
  const contentLengthHeader = c.req.header('Content-Length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_SIZE) {
      return c.json({ status: 'too_large' }, 413);
    }
  }

  const rawBody = await c.req.text();

  // Post-read size guard for the case where Content-Length was absent or untrustworthy.
  // Use UTF-8 byte count: `rawBody.length` counts UTF-16 code units, so multibyte
  // payloads (Japanese/emoji) would otherwise bypass the cap.
  const rawBodyByteLength = new TextEncoder().encode(rawBody).byteLength;
  if (rawBodyByteLength > MAX_WEBHOOK_BODY_SIZE) {
    return c.json({ status: 'too_large' }, 413);
  }

  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  // Cheap pre-reject for unsigned / malformed-signature requests. LINE signatures
  // are HMAC-SHA256 + base64 = 44 chars. This avoids D1 lookups and HMAC compute
  // for junk traffic on a public endpoint.
  const LINE_SIGNATURE_LENGTH = 44;
  if (signature.length !== LINE_SIGNATURE_LENGTH) {
    console.error('Missing or malformed LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  // JSON.parse is bounded by MAX_WEBHOOK_BODY_SIZE above. `destination` is an
  // untrusted selector only: the selected account secret still must verify the
  // raw body. This keeps signature work O(1) instead of trying every tenant.
  const destination = (body as { destination?: unknown }).destination;
  if (typeof destination !== 'string' || destination.length === 0 || destination.length > 128 ||
      !Array.isArray(body.events)) {
    console.error('Invalid LINE webhook envelope');
    return c.json({ status: 'ok' }, 200);
  }

  const account = await db.prepare(
    `SELECT line_account.id, mapping.tenant_id
       FROM pharmacy_line_channel_identities AS identity
       INNER JOIN line_accounts AS line_account
               ON line_account.id = identity.line_account_id
              AND line_account.is_active = 1
       INNER JOIN tenant_line_accounts AS mapping
               ON mapping.line_account_id = line_account.id
       INNER JOIN tenants AS tenant
               ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
      WHERE identity.bot_user_id = ?
      LIMIT 1`,
  ).bind(destination).first<{
    id: string;
    tenant_id: string;
  }>();
  if (!account) {
    console.error('Unknown LINE webhook destination');
    return c.json({ status: 'ok' }, 200);
  }

  const credentialRootSecret = c.env.LINE_CREDENTIAL_KEY_V1;
  if (!credentialRootSecret) {
    console.error('LINE webhook credentials are not configured');
    return c.json({ status: 'ok' }, 200);
  }

  const channelSecret = await readLineCredential(db, credentialRootSecret, {
    tenantId: account.tenant_id,
    lineAccountId: account.id,
    kind: 'channel_secret',
  });
  const channelAccessToken = await readLineCredential(db, credentialRootSecret, {
    tenantId: account.tenant_id,
    lineAccountId: account.id,
    kind: 'channel_access_token',
  });
  if (!channelSecret || !channelAccessToken) {
    console.error('LINE webhook credentials are unavailable');
    return c.json({ status: 'ok' }, 200);
  }

  if (!await verifySignature(channelSecret, rawBody, signature)) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  const matchedAccountId = account.id;
  const matchedTenantId = account.tenant_id;

  const lineClient = new LineClient(channelAccessToken);

  // H-3: durable before ACK. Every event body reaches the inbox before LINE is
  // told the delivery succeeded, so an isolate evicted during processing loses
  // nothing — the cron sweep picks the row up. A storage failure must surface
  // as 5xx: proceeding silently is exactly the loss this replaces.
  const claimed: Array<{ webhookEventId: string; event: WebhookEvent }> = [];
  try {
    for (const event of body.events) {
      const webhookEventId = readWebhookEventId(event);
      if (await storeWebhookEvent(db, matchedTenantId, matchedAccountId, webhookEventId, event)) {
        claimed.push({ webhookEventId, event });
      }
    }
  } catch (err) {
    console.error('[webhook] failed to store inbound events', err);
    return c.json({ status: 'error' }, 500);
  }

  const runner: WebhookEventRunner = {
    db,
    credentialRootSecret,
    workerUrl: c.env.WORKER_URL || new URL(c.req.url).origin,
    liffUrl: c.env.LIFF_URL,
    r2: c.env.IMAGES,
    proxyDispatch: (request) => dispatchLineProxyLocally(request, c.env, c.executionCtx),
    lineClient,
    channelAccessToken,
  };

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  c.executionCtx.waitUntil((async () => {
    for (const item of claimed) {
      await runWebhookInboxEvent(runner, {
        tenant_id: matchedTenantId,
        line_account_id: matchedAccountId,
        webhook_event_id: item.webhookEventId,
        payload: null,
        event: item.event,
      }).catch((err) => {
        console.error('[webhook] inbox event runner failed', err);
      });
    }
  })());

  return c.json({ status: 'ok' }, 200);
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string,
  tenantId: string,
  credentialRootSecret: string,
  workerUrl?: string,
  liffUrl?: string,
  r2?: R2Bucket,
  proxyDispatch?: HarnessProxyDispatch,
): Promise<void> {
  // Dedup and retry state live in the durable inbox row that the request
  // handler (or the cron sweep) already claimed before calling this.
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get LINE profile', err);
    }

    let friend: Friend;
    try {
      friend = await upsertFriend(db, {
        lineUserId: userId,
        lineAccountId,
        displayName: profile?.displayName ?? null,
        pictureUrl: profile?.pictureUrl ?? null,
        statusMessage: profile?.statusMessage ?? null,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'FRIEND_ACCOUNT_CONFLICT') {
        console.error('[webhook] Friend account conflict');
        return;
      }
      throw error;
    }

    try {
      await recordPharmacyFollow({
        db,
        lineAccountId,
        friendId: friend.id,
        lineUserId: userId,
        firstFollowedAt: friend.first_followed_at ?? friend.created_at,
        proxyBaseUrl: workerUrl,
        accessToken: lineAccessToken,
        proxyDispatch,
      });
    } catch (error) {
      console.error('[pharmacy-growth] follow metric failed', error instanceof Error ? error.message : 'unknown error');
    }

    if (await isPharmacyModeAccount(db, lineAccountId ?? friend.line_account_id)) return;

    // 新規・再フォローのどちらでも、最初の友だち登録マイルを同じキーで非同期投入する。
    // first_followed_at を使うため再フォローやWebhook再送では二重加算されない。
    const firstFollowedAt = friend.first_followed_at ?? friend.created_at;
    await awardActivityMileage(db, {
      eventType: 'friend_registered',
      source: 'line_relationship',
      sourceEventId: `${friend.id}:friend_registered:${firstFollowedAt}`,
      friendId: friend.id,
      subjectKey: friend.id,
      metadata: { lineAccountId },
      occurredAt: firstFollowedAt,
    });

    // Resolve referral link (entry_route) for this friend.
    // /auth/callback (OAuth path) writes friends.ref_code in parallel with
    // this follow webhook, so the field can briefly be NULL when LINE
    // delivers the event. Retry a few times (~1s total) before giving up,
    // otherwise override mode and intro pushes silently fall back to the
    // account default whenever the webhook wins the race.
    const { getFriendById } = await import('@line-crm/db');
    let friendRefCode = (friend as { ref_code?: string | null }).ref_code ?? null;
    if (!friendRefCode) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const refreshed = await getFriendById(db, friend.id);
        const refreshedRef = (refreshed as { ref_code?: string | null } | null)?.ref_code ?? null;
        if (refreshedRef) {
          friendRefCode = refreshedRef;
          break;
        }
      }
    }
    const referralRoute: EntryRoute | null = friendRefCode
      ? await getEntryRouteByRefCode(db, friendRefCode)
      : null;
    const runAccountScenarios =
      !referralRoute || referralRoute.run_account_friend_add_scenarios !== 0;

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    // Account and tenant scoping is done in SQL (M-1): an account-unassigned
    // scenario from another tenant must never match this account's events.
    // Skip entirely when a referral link explicitly overrides (run_account_friend_add_scenarios=0).
    const scenarios = runAccountScenarios ? await getScenariosForAccount(db, lineAccountId) : [];
    for (const scenario of scenarios) {
      if (scenario.trigger_type === 'friend_add' && scenario.is_active) {
        try {
          // INSERT OR IGNORE handles dedup via UNIQUE(friend_id, scenario_id)
          const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);
          if (!friendScenario) continue; // already enrolled

          // Immediate delivery: step1 が「now 以前」にスケジュールされる場合のみ
          // replyMessage で即時送信する (reply token は無料・push 枠を消費しない)。
          // - relative + delay_minutes=0 → 即時
          // - elapsed + offset_days=0 + offset_minutes=0 → 即時
          // - absolute_time で過去時刻 → computeNextDeliveryAt が now に clamp するので即時
          // reply 失敗時 (2つ目のシナリオで token 消費済み等) は claim が解放され
          // cron が push で配信する。
          // skipCooldown: 60秒以内の再フォロー (前の enrollment が completed 済み)
          // でも必ず welcome を返す — 旧 webhook 実装のセマンティクスを維持。
          const sent = await pushImmediateFirstStep(
            db,
            friend.id,
            scenario.id,
            { defaultAccessToken: lineAccessToken, workerUrl },
            {
              enrollment: friendScenario,
              reply: { client: lineClient, replyToken: event.replyToken },
              skipCooldown: true,
            },
          );
          if (sent) console.log(`Immediate delivery: sent scenario ${scenario.id} step 1`);
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // Referral link side-effects (intro push + dedicated scenario)
    if (referralRoute) {
      // Intro push from referral link
      if (referralRoute.intro_template_id) {
        try {
          const template = await getMessageTemplateById(db, referralRoute.intro_template_id);
          if (template) {
            const message = buildMessage(template.message_type, template.message_content);
            await lineClient.pushMessage(userId, [message]);
            console.log(`[follow] referral intro push sent route=${referralRoute.id}`);
          }
        } catch (err) {
          console.error('[follow] referral intro push failed', err);
        }
      }

      // Dedicated scenario enrollment from referral link. A delay-0 first
      // step is pushed immediately (same instant-welcome semantics as
      // friend_add / tag_added enrollments — previously this path always
      // waited for the next cron tick). pushMessage, not reply: the reply
      // token may already be consumed by an account friend_add scenario
      // above, and the intro push on this path uses pushMessage too.
      if (referralRoute.scenario_id) {
        try {
          const enrollment = await enrollFriendInScenario(db, friend.id, referralRoute.scenario_id);
          console.log(`[follow] referral scenario enrolled scenario=${referralRoute.scenario_id}`);
          if (enrollment) {
            await pushImmediateFirstStep(
              db,
              friend.id,
              referralRoute.scenario_id,
              { defaultAccessToken: lineAccessToken, workerUrl },
              { enrollment },
            );
          }
        } catch (err) {
          console.error('[follow] referral scenario enrollment failed', err);
        }
      }
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false, lineAccountId);
    try {
      await recordPharmacyUnfollowMetrics({ db, lineAccountId, lineUserId: userId });
    } catch (error) {
      console.error('[pharmacy-growth] unfollow metric failed', error instanceof Error ? error.message : 'unknown error');
    }
    return;
  }

  // Postback events — triggered by Flex buttons with action.type: "postback"
  // Uses the same auto_replies matching but without displaying text in chat
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const postbackData = (event as unknown as { postback: { data: string } }).postback.data;

    // postback の incoming 自体を messages_log に記録する。Rich Menu のタップで
    // 利用者が "コスト比較" などのアクションを起こした事実を chat 履歴で可視化する。
    // delivery_type='push' は厳密には push ではないが、incoming/non-test として
    // 既存 chat list / 詳細 SQL のフィルタを通すための妥当な値 (auto_reply text 同様)。
    try {
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
           VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'postback', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, postbackData, lineAccountId ?? null, jstNow())
        .run();
    } catch (err) {
      console.error('Failed to log incoming postback', err);
    }

    const pharmacyAccountId = lineAccountId ?? friend.line_account_id;
    if (await isPharmacyModeAccount(db, pharmacyAccountId)) {
      const webhookEventId = (event as WebhookEvent & { webhookEventId?: string }).webhookEventId;
      if (pharmacyAccountId && webhookEventId) {
        try {
          await handleMedicationFollowUpPostback(db, {
            lineAccountId: pharmacyAccountId,
            friendId: friend.id,
            webhookEventId,
            data: postbackData,
          });
        } catch {
          console.error('[pharmacy-followup] patient response rejected');
        }
      }
      return;
    }

    // postback data を auto_replies にマッチさせて返信 (テキスト経路と共通)。
    // silent + automation で「返信なしでタグだけ付ける」構成もここで成立する。
    const { matched: postbackMatched, replyTokenConsumed: postbackReplyTokenConsumed } =
      await matchAndReply(db, lineClient, friend, postbackData, event.replyToken, {
        lineAccountId,
        workerUrl,
        liffUrl,
        logContext: 'postback',
        replyMessage: workerUrl
          ? (token, messages) => replyViaHarnessProxy(
              workerUrl,
              lineAccessToken,
              token,
              messages,
              proxyDispatch,
            )
          : undefined,
      });

    // イベントバス発火: 専用イベント postback_received。
    // postback.data を text に載せることで、IF-THEN 自動化の keyword /
    // keyword_exact 条件がリッチメニューのタップ（タグ付与等）に効く。
    // message_received を流用しないのは意図的 — 流用すると既存インストールの
    // message_received スコアリング・catch-all 自動化・送信 Webhook 購読者が
    // メニュータップで誤発火し、条件側に source を見る術がないため。
    // なお upsertChatOnMessage は呼ばない: メニュータップは自発メッセージでは
    // ないので、未対応 inbox を汚さないのが正しい (テキスト経路との意図的な差分)。
    await fireEvent(db, 'postback_received', {
      friendId: friend.id,
      eventData: { text: postbackData, matched: postbackMatched },
      replyToken: postbackReplyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }

  // 非テキストの受信メッセージ（スタンプ/画像/音声/動画/ファイル/位置情報等）もログに残す。
  // ここで早期 return することで、テキスト用の auto_reply / scenario 判定には進まない
  // （スタンプ単体に対するキーワードマッチは意味を持たないため）。inbox 抜けだけ防ぐ。
  if (event.type === 'message' && event.message.type !== 'text') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const msg = event.message as {
      id: string;
      type: string;
      fileName?: string;
      title?: string;
      packageId?: string | number;
      package_id?: string | number;
      stickerId?: string | number;
      sticker_id?: string | number;
      stickerResourceType?: string | number;
      sticker_resource_type?: string | number;
    };
    const labels: Record<string, string> = {
      sticker: '[スタンプ]',
      image: '[画像]',
      audio: '[音声]',
      video: '[動画]',
      file: msg.fileName ? `[ファイル: ${msg.fileName}]` : '[ファイル]',
      location: msg.title ? `[位置情報: ${msg.title}]` : '[位置情報]',
    };
    const content = labels[msg.type] ?? `[${msg.type}]`;

    // image の場合は LINE Content API でバイナリを取得 → R2 → JSON URL に置換。
    // 失敗時は labels[msg.type] のラベル文字列のまま (フォールバック)。
    let finalContent = content;
    if (msg.type === 'sticker') {
      const stickerContent = createStickerMessageContent(msg);
      if (stickerContent) {
        finalContent = JSON.stringify(stickerContent);
      }
    }
    if (msg.type === 'image' && r2 && workerUrl) {
      const lineMessageId = msg.id;
      const { fetchAndStoreIncomingImage } = await import('../../services/incoming-image.js');
      const refs = await fetchAndStoreIncomingImage({
        r2,
        workerUrl,
        channelAccessToken: lineAccessToken,
        tenantId,
        accountId: lineAccountId,
        messageId: lineMessageId,
      });
      if (refs) {
        finalContent = JSON.stringify(refs);
      }
    }

    const logId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
         VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, 'user', ?, ?)`,
      )
      .bind(logId, friend.id, msg.type, finalContent, lineAccountId, jstNow())
      .run();
    if (!(await isPharmacyModeAccount(db, lineAccountId ?? friend.line_account_id))) {
      await awardActivityMileage(db, {
        eventType: 'message_received',
        source: 'line',
        sourceEventId: logId,
        friendId: friend.id,
        metadata: { messageType: msg.type },
      });
    }
    // text と同様、非 text の自発メッセージ (画像/スタンプ等) でも chat を unread に戻す。
    // これが無いと resolved 除外 (unanswered-inbox CANDIDATES_SQL) が「解決済み後に
    // 画像だけ送ってきた友だち」をバッジ・未対応一覧から永久に落としてしまう。
    // 非 text は auto_reply keyword にマッチし得ないので常に要対応扱いで正しい。
    await upsertChatOnMessage(db, friend.id);
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'user', ?, ?)`,
      )
      .bind(logId, friend.id, incomingText, lineAccountId, now)
      .run();

    if (await isPharmacyModeAccount(db, lineAccountId ?? friend.line_account_id)) {
      await upsertChatOnMessage(db, friend.id);
      return;
    }

    await awardActivityMileage(db, {
      eventType: 'message_received',
      source: 'line',
      sourceEventId: logId,
      friendId: friend.id,
      metadata: { messageType: 'text' },
      occurredAt: now,
    });

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            `SELECT f.provider_line_user_id AS line_user_id,
                    f.line_account_id, mapping.tenant_id
               FROM friends AS f
               INNER JOIN line_accounts AS account
                       ON account.id = f.line_account_id AND account.is_active = 1
               INNER JOIN tenant_line_accounts AS mapping
                       ON mapping.line_account_id = account.id
               INNER JOIN tenants AS tenant
                       ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
              WHERE f.user_id = ?
                AND f.line_account_id != ?
                AND f.is_following = 1
                AND mapping.tenant_id = ?`,
          ).bind(friendRecord.user_id, lineAccountId, tenantId)
            .all<{ line_user_id: string; line_account_id: string; tenant_id: string }>();

          let notifiedAccount = false;
          for (const other of otherFriends.results) {
            if (other.tenant_id !== tenantId) continue;
            const otherAccessToken = await readLineCredential(db, credentialRootSecret, {
              tenantId: other.tenant_id,
              lineAccountId: other.line_account_id,
              kind: 'channel_access_token',
            });
            if (!otherAccessToken) continue;
            const otherClient = new LineClient(otherAccessToken);
            await otherClient.pushMessage(other.line_user_id, [buildMessage('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(liffUrl ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${liffUrl}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
            notifiedAccount = true;
          }

          if (!notifiedAccount) return;

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）。
    // silent タイプは返信しないが matched=true になり unread / push を抑止する。
    const { matched, replyTokenConsumed } = await matchAndReply(
      db,
      lineClient,
      friend,
      incomingText,
      event.replyToken,
      {
        lineAccountId,
        workerUrl,
        liffUrl,
        replyMessage: workerUrl
          ? (token, messages) => replyViaHarnessProxy(
              workerUrl,
              lineAccessToken,
              token,
              messages,
              proxyDispatch,
            )
          : undefined,
      },
    );

    // auto_replies にマッチしなかった = 自発メッセージ → unread にする
    if (!matched) {
      await upsertChatOnMessage(db, friend.id);
    }

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply didn't actually consume it
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }
}

export { webhook };
