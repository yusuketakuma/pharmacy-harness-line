import { extractFlexAltText } from '../utils/flex-alt-text.js';

/**
 * イベントバス — システム内イベントの発火と処理
 *
 * イベント発生時に以下を実行:
 * 1. アクティブな送信Webhookへ通知
 * 2. スコアリングルール適用
 * 3. 自動化ルール(IF-THEN)実行
 */

import {
  getActiveOutgoingWebhooksByEvent,
  applyScoring,
  getActiveAutomationsByEvent,
  createAutomationLog,
  addTagToFriend,
  removeTagFromFriend,
  enrollFriendInScenario,
  jstNow,
  getFriendScore,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { sendAdConversions } from './ad-conversion.js';
import { isPharmacyModeAccount } from '../custom/pharmacy/growth-loop/access.js';
import { validateHttpsUrl } from '../lib/validate-https-url.js';
import { createBroadcastRetryKey } from './broadcast-retry-key.js';

const OUTGOING_WEBHOOK_TIMEOUT_MS = 10_000;

class WebhookUnknownOutcomeError extends Error {
  readonly name = 'WebhookUnknownOutcomeError';
}

class WebhookRejectedError extends Error {
  readonly name = 'WebhookRejectedError';

  constructor(readonly status: number, statusText: string) {
    super(`Webhook delivery failed: ${status} ${statusText}`);
  }
}

interface WebhookDeliveryContext {
  tenantId: string | null;
  lineAccountId: string | null;
  eventType: string;
  eventKey?: string;
  targetType: 'configured' | 'automation';
  targetId: string;
}

async function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(OUTGOING_WEBHOOK_TIMEOUT_MS),
    });
  } catch {
    throw new WebhookUnknownOutcomeError('Webhook delivery outcome is unknown');
  }
  if (response.ok) return response.status;
  if (response.status >= 500) {
    throw new WebhookUnknownOutcomeError('Webhook delivery outcome is unknown');
  }
  throw new WebhookRejectedError(response.status, response.statusText);
}

async function deliverWebhook(
  db: D1Database,
  url: string,
  body: string,
  headers: Record<string, string>,
  context?: WebhookDeliveryContext,
): Promise<void> {
  if (validateHttpsUrl(url)) throw new Error('Invalid webhook URL');
  const eventKey = context?.eventKey;
  const deliveryId = eventKey && context
    ? await createBroadcastRetryKey(
        'outgoing-webhook',
        context.tenantId ?? 'legacy',
        context.lineAccountId ?? '',
        context.eventType,
        eventKey,
        context.targetType,
        context.targetId,
      )
    : null;
  const requestHeaders = { ...headers };
  if (deliveryId) {
    requestHeaders['Idempotency-Key'] = deliveryId;
    requestHeaders['X-Webhook-Delivery-Id'] = deliveryId;
  }

  // Legacy events without a tenant or stable source key still get bounded,
  // validated HTTP delivery, but cannot be safely deduplicated in D1.
  if (!deliveryId || !context?.tenantId) {
    await postWebhook(url, body, requestHeaders);
    return;
  }

  const claimToken = crypto.randomUUID();
  const now = jstNow();
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO outgoing_webhook_deliveries
      (id, tenant_id, line_account_id, target_type, target_id, event_type,
       outcome, claim_token, attempt_count, attempted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'attempted', ?, 1, ?, ?, ?)`,
  ).bind(
    deliveryId,
    context.tenantId,
    context.lineAccountId,
    context.targetType,
    context.targetId,
    context.eventType,
    claimToken,
    now,
    now,
    now,
  ).run();

  if ((inserted.meta?.changes ?? 0) !== 1) {
    const existing = await db.prepare(
      `SELECT outcome FROM outgoing_webhook_deliveries
        WHERE id = ? AND tenant_id = ? AND line_account_id IS ?`,
    ).bind(deliveryId, context.tenantId, context.lineAccountId)
      .first<{ outcome: 'attempted' | 'sent' | 'failed' }>();
    if (existing?.outcome === 'sent') return;
    if (existing?.outcome !== 'failed') {
      throw new WebhookUnknownOutcomeError('Webhook delivery outcome is unknown');
    }
    const reclaimed = await db.prepare(
      `UPDATE outgoing_webhook_deliveries
          SET outcome = 'attempted', claim_token = ?, attempt_count = attempt_count + 1,
              http_status = NULL, attempted_at = ?, settled_at = NULL, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND line_account_id IS ? AND outcome = 'failed'`,
    ).bind(
      claimToken,
      now,
      now,
      deliveryId,
      context.tenantId,
      context.lineAccountId,
    ).run();
    if ((reclaimed.meta?.changes ?? 0) !== 1) {
      throw new WebhookUnknownOutcomeError('Webhook delivery outcome is unknown');
    }
  }

  const settle = async (outcome: 'sent' | 'failed', status: number): Promise<void> => {
    const settledAt = jstNow();
    let result: D1Result;
    try {
      result = await db.prepare(
        `UPDATE outgoing_webhook_deliveries
            SET outcome = ?, claim_token = NULL, http_status = ?,
                settled_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND line_account_id IS ?
            AND outcome = 'attempted' AND claim_token = ?`,
      ).bind(
        outcome,
        status,
        settledAt,
        settledAt,
        deliveryId,
        context.tenantId,
        context.lineAccountId,
        claimToken,
      ).run();
    } catch {
      throw new WebhookUnknownOutcomeError('Webhook delivery outcome is unknown');
    }
    if ((result.meta?.changes ?? 0) !== 1) {
      throw new WebhookUnknownOutcomeError('Webhook delivery outcome is unknown');
    }
  };

  try {
    await settle('sent', await postWebhook(url, body, requestHeaders));
  } catch (error) {
    if (error instanceof WebhookRejectedError) {
      await settle('failed', error.status);
    }
    throw error;
  }
}

export interface EventPayload {
  friendId?: string;
  eventData?: Record<string, unknown>;
  conversionEventName?: string;
  conversionValue?: number;
  replyToken?: string;
}

/**
 * Fire an event and run all registered handlers.
 *
 * Execution is split into two sequential phases so that score_threshold
 * conditions in automation rules see the score already updated by this event:
 *
 *   Phase 1 (concurrent): outgoing webhooks + scoring
 *   Phase 2 (concurrent): automations + notifications, with currentScore injected
 *
 * eventKey must identify the same immutable source event across redelivery.
 */
export async function fireEvent(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
  tenantId?: string | null,
  eventKey?: string,
): Promise<void> {
  let eventAccountId = lineAccountId ?? null;
  if (!eventAccountId && payload.friendId) {
    const friend = await db.prepare(
      `SELECT line_account_id FROM friends WHERE id = ?`,
    ).bind(payload.friendId).first<{ line_account_id: string | null }>();
    eventAccountId = friend?.line_account_id ?? null;
  }
  if (await isPharmacyModeAccount(db, eventAccountId)) return;

  let eventTenantId = tenantId ?? null;
  if (!eventTenantId && eventAccountId) {
    const mapping = await db.prepare(
      `SELECT tenant_id FROM tenant_line_accounts WHERE line_account_id = ?`,
    ).bind(eventAccountId).first<{ tenant_id: string }>();
    eventTenantId = mapping?.tenant_id ?? null;
  }

  // Phase 1: fire webhooks, apply scoring rules, and ad conversion postback concurrently.
  const phase1: Promise<unknown>[] = [
    fireOutgoingWebhooks(db, eventType, payload, eventTenantId, eventAccountId, eventKey),
    processScoring(db, eventType, payload),
  ];
  if (payload.friendId && payload.conversionEventName) {
    phase1.push(
      sendAdConversions(db, payload.friendId, payload.conversionEventName, payload.conversionValue),
    );
  }
  await Promise.allSettled(phase1);

  // Build an enriched payload with the freshly-updated score.
  const enrichedPayload: EventPayload = payload.friendId
    ? {
        ...payload,
        eventData: {
          ...payload.eventData,
          currentScore: await getFriendScore(db, payload.friendId),
        },
      }
    : payload;

  // Phase 2: tenant-only events have no safe account scope for legacy automations.
  if (!eventTenantId || eventAccountId) {
    await processAutomations(
      db,
      eventType,
      enrichedPayload,
      lineAccessToken,
      eventAccountId,
      eventTenantId,
      eventKey,
    );
  }
}

/** 送信Webhookへの通知 */
async function fireOutgoingWebhooks(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  tenantId: string | null,
  lineAccountId: string | null,
  eventKey?: string,
): Promise<void> {
  try {
    const webhooks = await getActiveOutgoingWebhooksByEvent(db, eventType, tenantId);
    for (const wh of webhooks) {
      try {
        const body = JSON.stringify({
          event: eventType,
          timestamp: jstNow(),
          data: payload,
        });

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        // HMAC署名（シークレットがある場合）
        if (wh.secret) {
          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(wh.secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
          );
          const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
          const hexSignature = Array.from(new Uint8Array(signature))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          headers['X-Webhook-Signature'] = hexSignature;
        }

        await deliverWebhook(db, wh.url, body, headers, {
          tenantId,
          lineAccountId,
          eventType,
          eventKey,
          targetType: 'configured',
          targetId: wh.id,
        });
      } catch (err) {
        console.error(`送信Webhook ${wh.id} への通知失敗:`, err);
      }
    }
  } catch (err) {
    console.error('fireOutgoingWebhooks error:', err);
  }
}

/** スコアリングルール適用 */
async function processScoring(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
): Promise<void> {
  if (!payload.friendId) return;
  try {
    await applyScoring(db, payload.friendId, eventType);
  } catch (err) {
    console.error('processScoring error:', err);
  }
}

/** 自動化ルール(IF-THEN)実行 */
async function processAutomations(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
  tenantId?: string | null,
  eventKey?: string,
): Promise<void> {
  try {
    const allAutomations = await getActiveAutomationsByEvent(db, eventType);
    // Filter by account: match this account's automations + unassigned (backward compat)
    const automations = allAutomations.filter(
      (a) => !a.line_account_id || !lineAccountId || a.line_account_id === lineAccountId,
    );

    for (const automation of automations) {
      const conditions = JSON.parse(automation.conditions) as Record<string, unknown>;
      const actions = JSON.parse(automation.actions) as Array<{ type: string; params: Record<string, string> }>;

      // 条件チェック（簡易版: 条件が空なら常にマッチ）
      if (!matchConditions(conditions, payload)) continue;

      const results: Array<{ action: string; success: boolean; error?: string }> = [];

      for (const [actionIndex, action] of actions.entries()) {
        try {
          await executeAction(db, action, payload, lineAccessToken, lineAccountId, {
            tenantId: tenantId ?? null,
            lineAccountId: lineAccountId ?? null,
            eventType,
            eventKey,
            targetType: 'automation',
            targetId: `${automation.id}:${actionIndex}`,
          });
          results.push({ action: action.type, success: true });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          results.push({ action: action.type, success: false, error: errorMsg });
        }
      }

      const allSuccess = results.every((r) => r.success);
      const anySuccess = results.some((r) => r.success);

      await createAutomationLog(db, {
        automationId: automation.id,
        friendId: payload.friendId,
        eventData: JSON.stringify(payload.eventData ?? {}),
        actionsResult: JSON.stringify(results),
        status: allSuccess ? 'success' : anySuccess ? 'partial' : 'failed',
      });
    }
  } catch (err) {
    console.error('processAutomations error:', err);
  }
}

/** 条件マッチング */
function matchConditions(
  conditions: Record<string, unknown>,
  payload: EventPayload,
): boolean {
  // 条件が空 → 常にマッチ
  if (Object.keys(conditions).length === 0) return true;

  // score_threshold チェック
  if (conditions.score_threshold !== undefined && payload.eventData) {
    const currentScore = payload.eventData.currentScore as number | undefined;
    if (currentScore !== undefined && currentScore < (conditions.score_threshold as number)) {
      return false;
    }
  }

  // tag_id チェック
  if (conditions.tag_id !== undefined && payload.eventData) {
    if (payload.eventData.tagId !== conditions.tag_id) return false;
  }

  // keyword チェック（message_received / postback_received イベント用）
  if (conditions.keyword !== undefined && payload.eventData) {
    const text = payload.eventData.text as string | undefined;
    if (!text || !text.includes(conditions.keyword as string)) return false;
  }

  // keyword_exact（完全一致）
  if (conditions.keyword_exact) {
    const rawText = payload.eventData?.text as string | undefined;
    const text = (rawText || '').trim();
    if (text !== conditions.keyword_exact) {
      return false;
    }
  }

  return true;
}

/** アクション実行 */
async function executeAction(
  db: D1Database,
  action: { type: string; params: Record<string, string> },
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
  deliveryContext?: WebhookDeliveryContext,
): Promise<void> {
  const friendId = payload.friendId;
  if (!friendId && action.type !== 'send_webhook') {
    throw new Error('friendId is required for this action');
  }

  switch (action.type) {
    case 'add_tag':
      await addTagToFriend(db, friendId!, action.params.tagId);
      break;

    case 'remove_tag':
      await removeTagFromFriend(db, friendId!, action.params.tagId);
      break;

    case 'start_scenario':
      await enrollFriendInScenario(db, friendId!, action.params.scenarioId);
      break;

    case 'send_message': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT provider_line_user_id AS line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);

      // template_id が set なら templates から content/type を resolve、
      // なければ inline params を使う。template が見つからない (削除済 等) は
      // inline fallback (content が空なら下流の JSON.parse が throw → automation
      // 全体は partial 扱い)。
      let resolvedType = action.params.messageType || 'text';
      let resolvedContent = action.params.content ?? '';
      const tplId = action.params.template_id;
      if (tplId) {
        const { getTemplateById } = await import('@line-crm/db');
        const tpl = await getTemplateById(db, tplId);
        if (tpl) {
          resolvedType = tpl.message_type;
          resolvedContent = tpl.message_content;
        }
      }

      let msg: Message;
      let logContent: string;
      if (resolvedType === 'flex') {
        const contents = JSON.parse(resolvedContent);
        msg = { type: 'flex', altText: action.params.altText || extractFlexAltText(contents), contents };
        logContent = JSON.stringify(contents);
      } else if (resolvedType === 'image') {
        // template に "originalContentUrl" / "previewImageUrl" を持つ JSON が入る前提。
        // parse 失敗時は text fallback ではなく throw → automation 側で partial 扱いにする。
        const parsed = JSON.parse(resolvedContent) as { originalContentUrl: string; previewImageUrl: string };
        msg = {
          type: 'image',
          originalContentUrl: parsed.originalContentUrl,
          previewImageUrl: parsed.previewImageUrl,
        };
        logContent = JSON.stringify(parsed);
      } else {
        msg = { type: 'text', text: resolvedContent };
        logContent = resolvedContent;
      }

      let deliveryType: 'reply' | 'push';
      if (payload.replyToken) {
        try {
          await lineClient.replyMessage(payload.replyToken, [msg]);
          payload.replyToken = undefined;
          deliveryType = 'reply';
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isTokenError = errMsg.includes('400') || errMsg.includes('Invalid reply token');
          if (isTokenError) {
            await lineClient.pushMessage(friend.line_user_id, [msg]);
            deliveryType = 'push';
          } else {
            throw err;
          }
        }
      } else {
        await lineClient.pushMessage(friend.line_user_id, [msg]);
        deliveryType = 'push';
      }

      // log は実際に送信した msg の type を反映する。msgType が 'image' 等で
      // else 経路に入った場合、actual message は text なので 'text' で記録すべき。
      // params の messageType をそのまま使うと admin 側で画像/Flex プレースホルダ
      // が出てしまう。
      await logOutgoingMessage(db, {
        friendId,
        messageType: msg.type,
        content: logContent,
        deliveryType,
        source: 'automation',
        lineAccountId,
      });
      break;
    }

    case 'send_webhook': {
      const url = action.params.url;
      if (url) {
        await deliverWebhook(
          db,
          url,
          JSON.stringify({ friendId, ...payload.eventData }),
          { 'Content-Type': 'application/json' },
          deliveryContext,
        );
      }
      break;
    }

    case 'switch_rich_menu': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT provider_line_user_id AS line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);
      await lineClient.linkRichMenuToUser(friend.line_user_id, action.params.richMenuId);
      break;
    }

    case 'remove_rich_menu': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT provider_line_user_id AS line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);
      await lineClient.unlinkRichMenuFromUser(friend.line_user_id);
      break;
    }

    case 'set_metadata': {
      if (!friendId) break;
      const existing = await db
        .prepare('SELECT metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ metadata: string }>();
      const current = JSON.parse(existing?.metadata || '{}') as Record<string, unknown>;
      // {{message}} を受信メッセージ内容に置換してからパース
      // JSON文字列内に埋め込むため、JSON仕様に準拠して全制御文字をエスケープ
      const escapeForJsonString = (s: string): string =>
        s
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t')
          .replace(/[\u0000-\u001f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      const messageText = (payload.eventData?.text as string | undefined) || '';
      const raw = (action.params.data || '{}')
        .replace(/\{\{message\}\}/g, escapeForJsonString(messageText));
      const patch = JSON.parse(raw) as Record<string, unknown>;
      const merged = { ...current, ...patch };
      await db
        .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(merged), jstNow(), friendId)
        .run();
      break;
    }

    default:
      console.warn(`未知のアクションタイプ: ${action.type}`);
  }
}

/** 送信メッセージを messages_log に記録（失敗しても例外を上げない） */
export async function logOutgoingMessage(
  db: D1Database,
  params: {
    friendId: string;
    messageType: string;
    content: string;
    deliveryType: 'reply' | 'push';
    source: string;
    lineAccountId?: string | null;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        params.friendId,
        params.messageType,
        params.content,
        params.deliveryType,
        params.source,
        params.lineAccountId ?? null,
        jstNow(),
      )
      .run();
  } catch (err) {
    console.error('logOutgoingMessage failed:', err);
  }
}
