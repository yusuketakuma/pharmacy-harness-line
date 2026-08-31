import { Hono } from 'hono';
import type { Env } from '../../index.js';
import {
  getFriendByLineUserIdForAccount,
  getLineAccountById,
  getLineAccountByIdForTenant,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { createBroadcastRetryKey } from '../../services/broadcast-retry-key.js';
import { deliverTrackedLinePush } from '../../services/outbound-line-delivery.js';

const app = new Hono<Env>();

// Meet Harness calls this when a hearing session completes
app.post('/api/meet-callback', async (c) => {
  const body = await c.req.json<{
    session_id: string;
    scenario_id: string;
    line_user_id: string;
    line_account_id: string;
    status: string;
    context?: Record<string, unknown>;
    transcripts: Array<{
      question_text?: string;
      transcript: string;
    }>;
    requirements_doc?: string;
    completed_at: string;
  }>().catch(() => null);

  if (!body) return c.json({ success: false, error: 'Invalid JSON body' }, 400);

  const requiredStrings: unknown[] = [
    body.line_user_id,
    body.line_account_id,
    body.session_id,
    body.status,
    body.completed_at,
  ];
  if (requiredStrings.some((value) => typeof value !== 'string' || value.trim() === '')) {
    return c.json({
      success: false,
      error: 'Required fields must be non-empty strings',
    }, 400);
  }
  if (!Array.isArray(body.transcripts) || body.transcripts.some((item) => (
    !item
    || typeof item !== 'object'
    || typeof item.transcript !== 'string'
    || (item.question_text !== undefined && typeof item.question_text !== 'string')
  ))) {
    return c.json({ success: false, error: 'transcripts must be an array' }, 400);
  }

  const tenantId = c.get('tenantId');
  if (!tenantId) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const ownedAccount = await getLineAccountByIdForTenant(
    c.env.DB,
    tenantId,
    body.line_account_id,
  );
  if (!ownedAccount) return c.json({ success: false, error: 'friend not found' }, 404);

  const friend = await getFriendByLineUserIdForAccount(
    c.env.DB,
    body.line_user_id,
    body.line_account_id,
  );
  if (!friend) {
    return c.json({ success: false, error: 'friend not found' }, 404);
  }

  // Resolve the credential only after proving tenant ownership.
  const account = await getLineAccountById(c.env.DB, body.line_account_id);
  if (!account?.channel_access_token || account.channel_access_token.startsWith('encrypted:')) {
    return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);
  }
  const lineClient = new LineClient(account.channel_access_token);

  // Build Flex message with requirements doc
  const transcriptRows = body.transcripts.map((t) => ({
    type: 'box' as const, layout: 'vertical' as const, margin: 'md' as const,
    contents: [
      { type: 'text' as const, text: t.question_text || 'Q', size: 'xxs' as const, color: '#64748b' },
      { type: 'text' as const, text: t.transcript, size: 'sm' as const, color: '#1e293b', wrap: true },
    ],
  }));

  const resultFlex = {
    type: 'bubble', size: 'giga',
    header: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: 'ヒアリング完了', size: 'lg', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: `${friend.display_name || ''}さん`, size: 'xs', color: '#64748b', margin: 'sm' },
      ],
      paddingAll: '20px', backgroundColor: '#f0f9ff',
    },
    body: {
      type: 'box', layout: 'vertical',
      contents: [
        ...transcriptRows,
        { type: 'separator', margin: 'lg' },
        ...(body.requirements_doc ? [
          { type: 'text' as const, text: '要件定義書', size: 'sm' as const, weight: 'bold' as const, color: '#1e293b', margin: 'lg' as const },
          { type: 'text' as const, text: body.requirements_doc.slice(0, 1000), size: 'xs' as const, color: '#334155', wrap: true, margin: 'sm' as const },
        ] : []),
      ],
      paddingAll: '20px',
    },
  };

  let deliveryFailure: 409 | 503 | null = null;
  try {
    const retryKey = await createBroadcastRetryKey(
      'meet-callback', friend.id, body.session_id,
    );
    const result = await deliverTrackedLinePush({
      db: c.env.DB,
      operationId: retryKey,
      tenantId,
      lineAccountId: body.line_account_id,
      friendId: friend.id,
      messageType: 'flex',
      content: JSON.stringify(resultFlex),
      source: 'meet-callback',
      request: {
        to: friend.line_user_id,
        messages: [{ type: 'flex', altText: 'ヒアリング結果', contents: resultFlex }],
      },
      send: async (request, providerRetryKey) => {
        await lineClient.pushMessage(request.to, request.messages, providerRetryKey);
      },
    });
    if (result !== 'sent' && result !== 'already_sent') {
      deliveryFailure = 409;
    }
  } catch (e) {
    console.error('Failed to send meet callback message:', e);
    deliveryFailure = 503;
  }

  // Save to friend metadata
  let metadataFailure = false;
  try {
    const existing = JSON.parse(friend.metadata || '{}') as Record<string, unknown>;
    const updated = {
      ...existing,
      meet_hearing: {
        session_id: body.session_id,
        status: body.status,
        context: body.context,
        transcripts: body.transcripts,
        requirements_doc: body.requirements_doc,
        completed_at: body.completed_at,
      },
    };
    const result = await c.env.DB.prepare(
      'UPDATE friends SET metadata = ?, updated_at = datetime(\'now\') WHERE id = ? AND line_account_id = ?',
    )
      .bind(JSON.stringify(updated), friend.id, body.line_account_id)
      .run();
    if ((result.meta?.changes ?? 0) !== 1) throw new Error('FRIEND_METADATA_UPDATE_FENCED');
  } catch (e) {
    console.error('Failed to save meet hearing to metadata:', e);
    metadataFailure = true;
  }

  if (metadataFailure) {
    return c.json({ success: false, error: 'Failed to save meet hearing' }, 500);
  }

  if (deliveryFailure) {
    return c.json({
      success: false,
      error: deliveryFailure === 409
        ? 'Message delivery requires reconciliation'
        : 'Message delivery failed',
    }, deliveryFailure);
  }

  return c.json({ success: true });
});

export { app as meetCallback };
