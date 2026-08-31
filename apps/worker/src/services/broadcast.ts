import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getBroadcastById,
  getBroadcasts,
  getQueuedBroadcasts,
  updateBroadcastStatus,
  updateBroadcastBatchProgress,
  getFriendsByTag,
  updateBroadcastLineRequestId,
  createBroadcastInsight,
} from '@line-crm/db';
import type { Broadcast } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import {
  assertNoUnresolvedBroadcastVariables,
  getUnsupportedBroadcastVariables,
  hasRecipientVariables,
  renderBroadcastMessageContent,
} from './render-message.js';
import { createBroadcastRetryKey } from './broadcast-retry-key.js';
import { isPharmacyModeAccount } from '../custom/pharmacy/growth-loop/access.js';
import {
  deliverTrackedLineBroadcast,
  deliverTrackedLinePush,
} from './outbound-line-delivery.js';
import { getActiveMappedAccountTenantId } from './step-delivery.js';

// ponytail: bounded sequential pushes; raise only after Worker/subrequest timing is measured.
const TRACKED_PUSH_BATCH_SIZE = 10;

function getBroadcastAccountIds(
  broadcast: Broadcast,
  defaultAccountId?: string | null,
): string[] {
  const raw = broadcast as unknown as Record<string, unknown>;
  const accountIds = new Set<string>();
  if (typeof raw.line_account_id === 'string') accountIds.add(raw.line_account_id);
  if (typeof raw.account_ids === 'string') {
    try {
      const parsed = JSON.parse(raw.account_ids) as unknown;
      if (Array.isArray(parsed)) {
        for (const id of parsed) if (typeof id === 'string') accountIds.add(id);
      }
    } catch {
      // Invalid persisted JSON is handled by the existing broadcast validation.
    }
  }
  if (accountIds.size === 0 && defaultAccountId) accountIds.add(defaultAccountId);
  return [...accountIds];
}

async function isPharmacyBroadcast(
  db: D1Database,
  broadcast: Broadcast,
  defaultAccountId?: string | null,
): Promise<boolean> {
  for (const accountId of getBroadcastAccountIds(broadcast, defaultAccountId)) {
    if (await isPharmacyModeAccount(db, accountId)) return true;
  }
  return false;
}

async function isActiveMappedAccount(
  db: D1Database,
  accountId: string,
): Promise<boolean> {
  try {
    const row = await db.prepare(
      `SELECT 1 AS ok
         FROM tenant_line_accounts AS mapping
         INNER JOIN line_accounts AS account
                 ON account.id = mapping.line_account_id
         INNER JOIN tenants AS tenant
                 ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
        WHERE mapping.line_account_id = ? AND account.is_active = 1
        LIMIT 1`,
    ).bind(accountId).first<{ ok: number }>();
    return Boolean(row);
  } catch {
    return false;
  }
}

async function isActiveMappedBroadcast(
  db: D1Database,
  broadcast: Broadcast,
  defaultAccountId?: string | null,
): Promise<boolean> {
  const accountIds = getBroadcastAccountIds(broadcast, defaultAccountId);
  if (accountIds.length === 0) return false;
  for (const accountId of accountIds) {
    if (!(await isActiveMappedAccount(db, accountId))) return false;
  }
  return true;
}

export async function processBroadcastSend(
  db: D1Database,
  _lineClient: LineClient,
  broadcastId: string,
  _workerUrl?: string,
  defaultAccountId?: string | null,
): Promise<Broadcast> {
  const broadcast = await getBroadcastById(db, broadcastId);
  if (!broadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }
  if (await isPharmacyBroadcast(db, broadcast, defaultAccountId)) {
    throw new Error('generic feature disabled for pharmacy account');
  }
  if (!(await isActiveMappedBroadcast(db, broadcast, defaultAccountId))) {
    throw new Error('generic feature disabled for inactive or unmapped account');
  }
  if ((broadcast as unknown as { target_type: string }).target_type === 'segment') {
    throw new Error('segment broadcasts must use /send-segment');
  }

  // Mark as sending only after policy checks pass.
  await updateBroadcastStatus(db, broadcastId, 'sending');

  const unsupportedVariables = getUnsupportedBroadcastVariables(broadcast.message_content);
  if (unsupportedVariables.length > 0) {
    throw new Error(
      `Unsupported broadcast variables: ${unsupportedVariables.map((v) => `{{${v}}}`).join(', ')}`,
    );
  }

  // Provider-wide all broadcasts have no enumerable recipient list. Queue one
  // tracked provider operation without replacing that audience with D1 rows.
  if (broadcast.target_type !== 'multi-account-dedup') {
    const raw = broadcast as unknown as Record<string, unknown>;
    const accountId = raw.line_account_id as string | null;
    if (!accountId) throw new Error('generic feature disabled for unscoped broadcast');
    const segmentConditionsStr = raw.segment_conditions as string | null | undefined;
    const personalized = hasRecipientVariables(broadcast.message_content);
    if (broadcast.target_type === 'all' && segmentConditionsStr != null) {
      await db.prepare(
        `UPDATE broadcasts SET status = 'sending', batch_offset = 0 WHERE id = ?`,
      ).bind(broadcast.id).run();
      return (await getBroadcastById(db, broadcastId))!;
    }
    if (broadcast.target_type === 'all' && !personalized && segmentConditionsStr == null) {
      await db.prepare(
        `UPDATE broadcasts
            SET status = 'sending', batch_offset = 0, total_count = 0, segment_conditions = NULL
          WHERE id = ?`,
      ).bind(broadcast.id).run();
      return (await getBroadcastById(db, broadcastId))!;
    }

    // Enumerable tag and personalized audiences use the per-recipient ledger.
    const where: string[] = ['f.is_following = 1'];
    const binds: unknown[] = [];
    where.push('f.line_account_id = ?');
    binds.push(accountId);
    if (broadcast.target_type === 'tag') {
      if (!broadcast.target_tag_id) throw new Error('target_tag_id is required for personalized tag broadcast');
      where.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(broadcast.target_tag_id);
    }
    const audience = await db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN f.display_name IS NULL OR trim(f.display_name) = '' THEN 1 ELSE 0 END) AS missing_name
         FROM friends f WHERE ${where.join(' AND ')}`,
    ).bind(...binds).first<{ total: number; missing_name: number | null }>();
    if (personalized && Number(audience?.missing_name ?? 0) > 0) {
      throw new Error(`Cannot personalize broadcast: ${audience!.missing_name} recipient(s) have no display name`);
    }
    const conditions = broadcast.target_type === 'tag'
      ? { operator: 'AND', rules: [
          { type: 'is_following', value: true },
          { type: 'tag_exists', value: broadcast.target_tag_id },
        ] }
      : { operator: 'AND', rules: [{ type: 'is_following', value: true }] };
    await db.prepare(
      `UPDATE broadcasts
          SET status = 'sending', batch_offset = 0, total_count = ?, segment_conditions = ?
        WHERE id = ?`,
    ).bind(Number(audience?.total ?? 0), JSON.stringify(conditions), broadcast.id).run();
    return (await getBroadcastById(db, broadcastId))!;
  }

  // multi-account-dedup は inline 送信せず cron queue (processQueuedBroadcasts) に委譲する。
  // この関数は scheduled / 即時の単一 account 経路用で、毎回 auto-track を実行する。dedup を
  // ここで送ると (1) auto-track がここと queue 側で二重実行されて tracked link が重複し、
  // (2) 分割送信 (chunking) の継続が queue 側にあるため partial-sent のまま sent 扱いになる。
  // よって total_count だけ確定して status='sending', batch_offset=0 にし、queue に渡す。
  // total_count は executor が inactive を skip するのに合わせ、active アカウントの当選者数で
  // 計算する (routes 即時送信パスと同じロジック)。
  if (broadcast.target_type === 'multi-account-dedup') {
    const { computeDedupBroadcastPreview } = await import('./dedup-broadcast.js');
    const accountIds = (broadcast.account_ids ? JSON.parse(broadcast.account_ids) : []) as string[];
    const dedupPriority = (broadcast.dedup_priority ? JSON.parse(broadcast.dedup_priority) : []) as string[];
    const preview = await computeDedupBroadcastPreview(db, accountIds, dedupPriority, broadcast.target_tag_id ?? null);
    let projectedTotal = 0;
    const { getLineAccountById } = await import('@line-crm/db');
    for (const a of preview.perAccount) {
      const account = await getLineAccountById(db, a.accountId);
      if (account && account.is_active) projectedTotal += a.recipients.length;
    }
    await db
      .prepare(`UPDATE broadcasts SET status = 'sending', batch_offset = 0, total_count = ? WHERE id = ?`)
      .bind(projectedTotal, broadcast.id)
      .run();
    return (await getBroadcastById(db, broadcastId))!;
  }

  throw new Error('unsupported broadcast target');
}

export async function processScheduledBroadcasts(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
  defaultAccountId?: string | null,
): Promise<void> {
  const allBroadcasts = await getBroadcasts(db);

  const nowMs = Date.now();
  const scheduled = allBroadcasts.filter(
    (b) =>
      b.status === 'scheduled' &&
      b.scheduled_at !== null &&
      new Date(b.scheduled_at).getTime() <= nowMs,
  );

  for (const broadcast of scheduled) {
    try {
      if (await isPharmacyBroadcast(db, broadcast, defaultAccountId)) continue;
      if (!(await isActiveMappedBroadcast(db, broadcast, defaultAccountId))) continue;
      // Optimistic lock: claim this broadcast (scheduled → sending)
      const lockResult = await db
        .prepare(`UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'scheduled'`)
        .bind(broadcast.id)
        .run();
      if (!lockResult.meta.changes || lockResult.meta.changes === 0) continue;

      // Resolve correct lineClient for this broadcast's account
      let deliveryClient = lineClient;
      const accountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
      if (accountId) {
        const { getLineAccountById } = await import('@line-crm/db');
        const account = await getLineAccountById(db, accountId);
        if (account) {
          const { LineClient: LC } = await import('@line-crm/line-sdk');
          deliveryClient = new LC(account.channel_access_token);
        }
      }

      await processBroadcastSend(db, deliveryClient, broadcast.id, workerUrl, defaultAccountId);
    } catch (err) {
      console.error(`Failed to send scheduled broadcast ${broadcast.id}:`, err);
      // Reset to scheduled so it can be retried next cron
      try {
        await db.prepare(`UPDATE broadcasts SET status = 'scheduled' WHERE id = ? AND status = 'sending'`)
          .bind(broadcast.id).run();
      } catch (resetErr) {
        console.error(`Failed to reset broadcast ${broadcast.id} status:`, resetErr);
      }
    }
  }
}

/**
 * Cronから呼ばれるキュー処理。status='queued' のブロードキャストを
 * batch_offset から500人ずつ処理する。1回のCron実行で全バッチを処理可能。
 */
export async function processQueuedBroadcasts(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
  defaultAccountId?: string | null,
): Promise<void> {
  const queued = await getQueuedBroadcasts(db);
  const providerWide = (await getBroadcasts(db)).filter((broadcast) => {
    const raw = broadcast as unknown as Record<string, unknown>;
    return broadcast.status === 'sending'
      && typeof raw.batch_offset === 'number' && raw.batch_offset >= 0
      && broadcast.sent_at === null
      && broadcast.target_type === 'all'
      && raw.segment_conditions == null;
  });
  for (const broadcast of providerWide) {
    if (!queued.some((queuedBroadcast) => queuedBroadcast.id === broadcast.id)) {
      queued.push(broadcast);
    }
  }
  for (const broadcast of queued) {
    if (await isPharmacyBroadcast(db, broadcast, defaultAccountId)) continue;
    if (broadcast.target_type !== 'multi-account-dedup'
      && !(await isActiveMappedBroadcast(db, broadcast, defaultAccountId))) continue;
    // アカウント別のlineClientを解決
    const accountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
    let client = lineClient;
    if (accountId) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(db, accountId);
      if (account) client = new (await import('@line-crm/line-sdk')).LineClient(account.channel_access_token);
    }

    try {
      await processQueuedBroadcastBatches(db, client, broadcast, workerUrl);
    } catch (err) {
      console.error(`Failed to process queued broadcast ${broadcast.id}:`, err);
    }
  }
}

async function processQueuedBroadcastBatches(
  db: D1Database,
  lineClient: LineClient,
  broadcast: import('@line-crm/db').Broadcast,
  workerUrl?: string,
): Promise<void> {
  const raw = broadcast as unknown as Record<string, unknown>;
  const segmentConditionsStr = raw.segment_conditions as string | null;
  const batchOffset = (raw.batch_offset as number) || 0;

  // 排他ロック: batch_offset を -1 に設定して他のCronが拾わないようにする
  // WHERE batch_offset = ? で楽観ロック（既に他が処理中なら更新0行→スキップ）
  // batch_lock_at は recoverStalledBroadcasts が「ロック取得後 N 分経過」を判定する
  // ためのタイムスタンプ。created_at だと draft 作成時刻基準で本物の lock age と
  // ずれて Worker 並走 race を引き起こすため別カラムで管理する。
  // 重要: 値は SQL の strftime で生成する。jstNow() の '+09:00' suffix は SQLite で
  // UTC 正規化されて見かけ 9 時間古くなり、recover 側 (julianday('now','+9 hours'))
  // と比較すると即座に「stale」扱いされて lock 取得直後に解除される。created_at
  // 列の DEFAULT と同じ式を使って naive JST に揃える。
  const lockResult = await db.prepare(
    `UPDATE broadcasts SET batch_offset = -1, batch_lock_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE id = ? AND batch_offset = ?`,
  ).bind(broadcast.id, batchOffset).run();
  if (!lockResult.meta.changes || lockResult.meta.changes === 0) {
    // 他のCron実行が既に処理中 → スキップ
    return;
  }

  // auto-track（初回のみ）。auto-track は冪等でない (呼ぶたび新 tracked link を作る) ため
  // 「1 broadcast につき 1 回」に厳密化する。non-dedup は batch_offset が 0→N と進むので
  // `batchOffset === 0` が初回判定になる。dedup は分割送信で毎 tick batch_offset=0 から
  // 再入するため、それだけだと毎 tick auto-track が走って tracked link が二重生成される。
  // dedup の初回は dedup_progress=NULL なので、その条件を足して継続 tick では再実行しない
  // (初回に変換結果を message_content へ persist 済みなので、継続 tick はそれを使う)。
  const isDedupContinuation =
    broadcast.target_type === 'multi-account-dedup' && broadcast.dedup_progress != null;
  let finalType: string = broadcast.message_type;
  let finalContent = broadcast.message_content;
  if (workerUrl && batchOffset === 0 && !isDedupContinuation && broadcast.track_links !== 0) {
    const { autoTrackContent } = await import('./auto-track.js');
    // dedup broadcast は複数アカウントから送るためリンクの所有アカウントを一意に
    // 決められない → line_account_id は null のまま (env.LIFF_URL フォールバック)。
    const tracked = await autoTrackContent(db, broadcast.message_type, broadcast.message_content, workerUrl, {
      lineAccountId: (raw.line_account_id as string | null) ?? null,
    });
    finalType = tracked.messageType;
    finalContent = tracked.content;
    // 変換後のコンテンツを保存（次バッチ以降で使えるように）
    if (finalType !== broadcast.message_type || finalContent !== broadcast.message_content) {
      await db.prepare('UPDATE broadcasts SET message_type = ?, message_content = ? WHERE id = ?')
        .bind(finalType, finalContent, broadcast.id).run();
    }
  }

  // {{liff_id}} 置換 (single account 経路のみ; multi は dedup 側で per-account 置換)。
  const queuedAccountId = raw.line_account_id as string | null;
  if (queuedAccountId && broadcast.target_type !== 'multi-account-dedup') {
    const { getLineAccountById: getLA } = await import('@line-crm/db');
    const acct = await getLA(db, queuedAccountId);
    const liffId = (acct as unknown as { liff_id?: string | null } | null)?.liff_id ?? null;
    finalContent = renderBroadcastMessageContent(finalType, finalContent, { liffId });
  }
  const altText = raw.alt_text as string | undefined;
  const message = buildMessage(finalType, finalContent, altText || undefined);

  // multi-account-dedup: delegate to processMultiAccountDedupBroadcast.
  // dedup ループは内部で per-account に {{liff_id}} 置換 + buildMessage する。
  // auto-track で計算された finalType / finalContent を反映した broadcast を
  // 渡す (broadcast 引数の message_content をそのまま使うと auto-track 結果が
  // 落ちる)。
  if (broadcast.target_type === 'multi-account-dedup') {
    const { processMultiAccountDedupBroadcast } = await import('./dedup-broadcast.js');
    const broadcastForDedup = { ...broadcast, message_type: finalType, message_content: finalContent };
    const result = await processMultiAccountDedupBroadcast(db, broadcastForDedup);
    if (!result.complete) {
      // 時間バジェット超過または再試行可能な account failure。status='sending' のまま batch_offset を
      // -1(ロック) → 0 に戻し、次の cron tick が getQueuedBroadcasts で拾って再開する。
      // 進捗 (dedup_progress / success_count) は batch ごとに永続化済みなので、
      // success_count は加算しない (第4引数 0)。これで 5000 人配信でも 1 実行が短く終わり、
      // Worker 時間制限に当たって stall することが無くなる (= 分割送信)。
      await updateBroadcastBatchProgress(db, broadcast.id, 0, 0);
      return;
    }
    await createBroadcastInsight(db, broadcast.id);
    await updateBroadcastStatus(db, broadcast.id, 'sent', {
      totalCount: result.totalCount,
      successCount: result.successCount,
    });
    return;
  }

  const accountId = raw.line_account_id as string | null;
  if (!accountId) {
    await updateBroadcastBatchProgress(db, broadcast.id, batchOffset, 0);
    return;
  }
  const tenantId = await getActiveMappedAccountTenantId(db, accountId);
  if (!tenantId) {
    await updateBroadcastBatchProgress(db, broadcast.id, batchOffset, 0);
    return;
  }
  const personalized = hasRecipientVariables(finalContent);

  if (broadcast.target_type === 'all' && !personalized && segmentConditionsStr == null) {
    const operationId = await createBroadcastRetryKey(
      'broadcast-all-v1',
      tenantId,
      accountId,
      broadcast.id,
    );
    const result = await deliverTrackedLineBroadcast({
      db,
      operationId,
      tenantId,
      lineAccountId: accountId,
      request: { messages: [message] },
      send: async (request, retryKey) => {
        const response = await lineClient.broadcast(request.messages, retryKey);
        if (response.requestId) {
          await updateBroadcastLineRequestId(db, broadcast.id, response.requestId, null);
        }
      },
    });
    if (result !== 'sent' && result !== 'already_sent') {
      await db.prepare(
        `UPDATE broadcasts
            SET batch_offset = 0, batch_lock_at = NULL, failed_account_ids = ?
          WHERE id = ?`,
      ).bind(JSON.stringify([accountId]), broadcast.id).run();
      return;
    }
    await db.prepare(
      `UPDATE broadcasts
          SET batch_offset = 0, batch_lock_at = NULL
        WHERE id = ? AND batch_offset = -1`,
    ).bind(broadcast.id).run();
    await createBroadcastInsight(db, broadcast.id);
    await updateBroadcastStatus(db, broadcast.id, 'sent', { totalCount: 0, successCount: 0 });
    return;
  }

  // 対象ユーザーリストを取得（アカウントで絞り込む）
  let friends: Array<{ id: string; line_user_id: string; display_name: string | null }>;
  if (segmentConditionsStr) {
    const { buildSegmentQuery } = await import('./segment-query.js');
    const condition = JSON.parse(segmentConditionsStr);
    const { sql, bindings } = buildSegmentQuery(condition);
    // アカウントフィルタを追加（line_account_idで絞り込み）
    const accountSql = sql.replace('WHERE', 'WHERE f.line_account_id = ? AND');
    const accountBindings = [...bindings];
    accountBindings.unshift(accountId);
    const result = await db.prepare(accountSql).bind(...accountBindings).all<{
      id: string;
      line_user_id: string;
      display_name: string | null;
    }>();
    friends = result.results ?? [];
  } else if (broadcast.target_tag_id) {
    const { getFriendsByTag } = await import('@line-crm/db');
    const tagFriends = await getFriendsByTag(db, broadcast.target_tag_id, accountId);
    friends = tagFriends.filter(f => f.is_following).map(f => ({
      id: f.id,
      line_user_id: f.line_user_id,
      display_name: f.display_name,
    }));
  } else {
    const result = await db.prepare(
      `SELECT id, provider_line_user_id AS line_user_id, display_name
         FROM friends
        WHERE is_following = 1 AND line_account_id = ?
        ORDER BY id`,
    ).bind(accountId).all<{
      id: string;
      line_user_id: string;
      display_name: string | null;
    }>();
    friends = result.results ?? [];
  }

  const unit = `bcast_${broadcast.id.slice(0, 8).replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const unsupportedVariables = getUnsupportedBroadcastVariables(finalContent);
  if (unsupportedVariables.length > 0) {
    await updateBroadcastBatchProgress(db, broadcast.id, batchOffset, 0);
    throw new Error(
      `Unsupported broadcast variables: ${unsupportedVariables.map((v) => `{{${v}}}`).join(', ')}`,
    );
  }
  if (!personalized) {
    try {
      assertNoUnresolvedBroadcastVariables(finalContent);
    } catch (err) {
      await updateBroadcastBatchProgress(db, broadcast.id, batchOffset, 0);
      throw err;
    }
  }
  const deliveryBatchSize = TRACKED_PUSH_BATCH_SIZE;

  // Numeric offsets are not an audience cursor: tag/follow membership may change
  // between ticks. Rebuild pending recipients from the durable success projection.
  const logged = await db.prepare(
    `SELECT friend_id FROM messages_log
      WHERE broadcast_id = ? AND direction = 'outgoing'
        AND COALESCE(delivery_type, '') != 'test'`,
  ).bind(broadcast.id).all<{ friend_id: string }>();
  const loggedFriendIds = new Set((logged.results ?? []).map((row) => row.friend_id));
  const retired = await db.prepare(
    `SELECT payload.friend_id
       FROM outbound_line_deliveries AS operation
       INNER JOIN outbound_line_delivery_payloads AS payload
               ON payload.operation_id = operation.id
              AND payload.tenant_id = operation.tenant_id
              AND payload.line_account_id = operation.line_account_id
      WHERE payload.broadcast_id = ? AND operation.tenant_id = ?
        AND operation.line_account_id = ? AND operation.outcome = 'retired'
        AND payload.log_delivery_type != 'test'`,
  ).bind(broadcast.id, tenantId, accountId).all<{ friend_id: string }>();
  const retiredFriendIds = new Set((retired.results ?? []).map((row) => row.friend_id));
  const pending = friends.filter(
    (friend) => !loggedFriendIds.has(friend.id) && !retiredFriendIds.has(friend.id),
  );
  // Keep terminal ledger recipients after they leave and include current pending recipients
  // after they join. This is the live-audience denominator for this tick.
  const terminalFriendIds = new Set([...loggedFriendIds, ...retiredFriendIds]);
  await db.prepare('UPDATE broadcasts SET total_count = ? WHERE id = ?')
    .bind(terminalFriendIds.size + pending.length, broadcast.id).run();
  const batch = pending.slice(0, deliveryBatchSize);
  let accepted = 0;
  let reconciliationRequired = retiredFriendIds.size > 0;
  let transientFailure = false;

  for (const friend of batch) {
    try {
      const renderedContent = personalized
        ? renderBroadcastMessageContent(finalType, finalContent, {
          displayName: friend.display_name,
        })
        : finalContent;
      assertNoUnresolvedBroadcastVariables(renderedContent);
      const recipientMessage = personalized
        ? buildMessage(finalType, renderedContent, altText || undefined)
        : message;
      const retryKey = await createBroadcastRetryKey(
        'broadcast-recipient-v1',
        tenantId,
        accountId,
        broadcast.id,
        friend.id,
      );
      const result = await deliverTrackedLinePush({
        db,
        operationId: retryKey,
        tenantId,
        lineAccountId: accountId,
        friendId: friend.id,
        messageType: finalType,
        content: renderedContent,
        source: 'broadcast',
        broadcastId: broadcast.id,
        request: { to: friend.line_user_id, messages: [recipientMessage] },
        send: async (request, providerRetryKey) => {
          await lineClient.pushMessage(
            request.to,
            request.messages,
            providerRetryKey,
            [unit],
          );
        },
      });
      if (result === 'sent' || result === 'already_sent') {
        accepted++;
      } else {
        reconciliationRequired = true;
      }
    } catch {
      console.error('Broadcast recipient delivery failed');
      transientFailure = true;
      break;
    }
  }

  const progress = loggedFriendIds.size + accepted;
  if (reconciliationRequired) {
    await db.prepare(
      `UPDATE broadcasts
          SET batch_offset = ?, batch_lock_at = NULL, failed_account_ids = ?,
              success_count = (
                SELECT COUNT(*) FROM messages_log
                 WHERE broadcast_id = ? AND direction = 'outgoing'
                   AND COALESCE(delivery_type, '') != 'test'
              )
        WHERE id = ?`,
    ).bind(progress, JSON.stringify([accountId]), broadcast.id, broadcast.id).run();
  } else {
    await db.prepare(
      `UPDATE broadcasts
          SET batch_offset = ?, batch_lock_at = NULL,
              success_count = (
                SELECT COUNT(*) FROM messages_log
                 WHERE broadcast_id = ? AND direction = 'outgoing'
                   AND COALESCE(delivery_type, '') != 'test'
              )
        WHERE id = ?`,
    ).bind(progress, broadcast.id, broadcast.id).run();
  }
  if (transientFailure || reconciliationRequired || batch.length < pending.length) return;

  // 全バッチ完了 — ロック解除 + 完了マーク
  await updateBroadcastLineRequestId(db, broadcast.id, null, unit);
  await createBroadcastInsight(db, broadcast.id);
  await updateBroadcastStatus(db, broadcast.id, 'sent');
}

export function buildMessage(messageType: string, messageContent: string, altText?: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }

  if (messageType === 'image') {
    try {
      const parsed = JSON.parse(messageContent) as {
        originalContentUrl: string;
        previewImageUrl: string;
      };
      return {
        type: 'image',
        originalContentUrl: parsed.originalContentUrl,
        previewImageUrl: parsed.previewImageUrl,
      };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  if (messageType === 'flex') {
    try {
      const contents = JSON.parse(messageContent);
      return { type: 'flex', altText: altText || extractFlexAltText(contents), contents };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  return { type: 'text', text: messageContent };
}
