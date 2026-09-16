import { Hono } from 'hono';
import {
  getStripeEvents,
  getStripeEventByStripeId,
  createStripeEvent,
  markStripeEventEffectsComplete,
  addTagToFriend,
} from '@line-crm/db';
import type { Env } from '../../index.js';
import { clampLimitOffset } from '../../lib/pagination.js';
import { awardActivityMileage } from '../../services/activity-mileage.js';

const stripe = new Hono<Env>();

interface StripeWebhookBody {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount?: number;
      currency?: string;
      metadata?: Record<string, string>;
      customer?: string;
      status?: string;
    };
  };
}

// ========== Stripeイベント一覧 ==========

stripe.get('/api/integrations/stripe/events', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const eventType = c.req.query('eventType') ?? undefined;
    const page = clampLimitOffset(c.req.query('limit'), undefined, 100);
    if (!page) return c.json({ success: false, error: 'limit が不正です' }, 400);
    // 認証 tenant が解決できている呼び出しはその tenant の friend に帰属する
    // イベントだけに絞る（pharmacy allowlist 経由の cross-tenant 閲覧を防ぐ）。
    const tenantId = c.get('tenantId') ?? undefined;
    const items = await getStripeEvents(c.env.DB, { friendId, eventType, limit: page.limit, tenantId });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        stripeEventId: e.stripe_event_id,
        eventType: e.event_type,
        friendId: e.friend_id,
        amount: e.amount,
        currency: e.currency,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        processedAt: e.processed_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/stripe/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Stripe Webhookレシーバー ==========

/** Stripe署名検証 */
async function verifyStripeSignature(secret: string, rawBody: string, sigHeader: string): Promise<boolean> {
  // Stripe署名形式: t=timestamp,v1=signature
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => {
      const [k, ...v] = p.split('=');
      return [k, v.join('=')];
    }),
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) return false;

  const encoder = new TextEncoder();
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return computedSig === expectedSig;
}

stripe.post('/api/integrations/stripe/webhook', async (c) => {
  try {
    const stripeSecret = (c.env as unknown as Record<string, string | undefined>).STRIPE_WEBHOOK_SECRET;
    let body: StripeWebhookBody;

    if (stripeSecret) {
      // 署名検証モード（本番環境）
      const sigHeader = c.req.header('Stripe-Signature') ?? '';
      const rawBody = await c.req.text();

      const valid = await verifyStripeSignature(stripeSecret, rawBody, sigHeader);
      if (!valid) {
        return c.json({ success: false, error: 'Stripe signature verification failed' }, 401);
      }
      body = JSON.parse(rawBody) as StripeWebhookBody;
    } else {
      // シークレット未設定（開発環境向け）
      body = await c.req.json<StripeWebhookBody>();
    }

    // 冪等性チェック: 受領済みかつ副作用完了なら早期return。
    // Stripeは非2xx応答を再送するため、受領行があっても副作用未完了なら
    // 効果を再実行する（各効果はイベントID由来のdedupeで1回だけ適用される）。
    const existing = await getStripeEventByStripeId(c.env.DB, body.id);
    if (existing?.effects_completed_at) {
      return c.json({ success: true, data: { message: 'Already processed' } });
    }

    const obj = body.data.object;
    const db = c.env.DB;

    // メタデータからfriendIdを取得（Stripeのメタデータにline_friend_idを設定している想定）
    const friendId = obj.metadata?.line_friend_id ?? null;

    // イベントを記録
    let event = existing;
    if (!event) {
      try {
        event = await createStripeEvent(db, {
          stripeEventId: body.id,
          eventType: body.type,
          friendId: friendId ?? undefined,
          amount: obj.amount,
          currency: obj.currency,
          metadata: JSON.stringify(obj.metadata ?? {}),
        });
      } catch (createErr) {
        // 同時配信で別workerが先に受領した場合はその行を引き継いで効果を続行する。
        event = await getStripeEventByStripeId(c.env.DB, body.id);
        if (!event) throw createErr;
      }
    }

    // 決済成功時の自動処理
    if (body.type === 'payment_intent.succeeded' && friendId) {
      const { applyScoring } = await import('@line-crm/db');
      await applyScoring(db, friendId, 'purchase', `stripe:${body.id}`);

      // 自動タグ付け（product_idベース）。tags.name はグローバル UNIQUE なので
      // 同名 tag が他 tenant に存在しうる — friend の tenant（または
      // tenant 未設定の legacy global tag）に一致するものだけを付与する。
      const productId = obj.metadata?.product_id;
      if (productId) {
        const tag = await db
          .prepare(
            `SELECT tag.id
               FROM tags AS tag
               JOIN friends AS friend ON friend.id = ?
               LEFT JOIN tenant_line_accounts AS mapping
                 ON mapping.line_account_id = friend.line_account_id
              WHERE tag.name = ?
                AND (tag.tenant_id IS NULL OR tag.tenant_id = mapping.tenant_id)`,
          )
          .bind(friendId, `purchased_${productId}`)
          .first<{ id: string }>();
        if (tag) {
          await addTagToFriend(db, friendId, tag.id);
        }
      }

      await awardActivityMileage(db, {
        eventType: 'purchase_completed',
        source: 'stripe',
        sourceEventId: body.id,
        friendId,
        subjectKey: productId || 'first_purchase',
        metadata: {
          stripeEventId: body.id,
          paymentIntentId: obj.id,
          productId: productId ?? null,
          amount: obj.amount ?? null,
          currency: obj.currency ?? null,
        },
        occurredAt: event.processed_at,
      });

      // イベントバスに発火（自動化ルール用）
      const { fireEvent } = await import('../../services/event-bus.js');
      await fireEvent(
        db,
        'cv_fire',
        { friendId, eventData: { type: 'purchase', amount: obj.amount, stripeEventId: body.id } },
        undefined,
        undefined,
        undefined,
        body.id,
      );
    }

    // サブスクリプションイベント処理（tag scope は上と同じ方針）
    if (body.type === 'customer.subscription.deleted' && friendId) {
      const cancelledTag = await db
        .prepare(
          `SELECT tag.id
             FROM tags AS tag
             JOIN friends AS friend ON friend.id = ?
             LEFT JOIN tenant_line_accounts AS mapping
               ON mapping.line_account_id = friend.line_account_id
            WHERE tag.name = 'subscription_cancelled'
              AND (tag.tenant_id IS NULL OR tag.tenant_id = mapping.tenant_id)`,
        )
        .bind(friendId)
        .first<{ id: string }>();
      if (cancelledTag) {
        await addTagToFriend(db, friendId, cancelledTag.id);
      }
    }

    // 受領と効果完了を分けて記録する。ここまで来た時点で全副作用は
    // dedupe付きで適用済みなので、次回再送は早期200へ戻る。
    await markStripeEventEffectsComplete(db, body.id);

    return c.json({
      success: true,
      data: { id: event.id, stripeEventId: event.stripe_event_id, eventType: event.event_type, processedAt: event.processed_at },
    });
  } catch (err) {
    console.error('POST /api/integrations/stripe/webhook error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { stripe };
