import { URL_TOKEN_SQL } from '../lib/url-token.js';

export interface DedupPreviewPerAccount {
  accountId: string;
  accountName: string;
  accountCountry: string | null;
  selectedCount: number;
  sendCount: number;
  excludedToHigherPriority: number;
  // identKey: dedup の正規化 ID (URL_TOKEN_SQL / 'uid:'||user_id / 'solo:'||friend_id)。
  // resume 時の send 済判定に使う。lineUserId はプロバイダ単位のID なので、
  // 同じ論理人物が別 LINE 公式アカウント (別プロバイダ) にいる場合に二重配信
  // する事故を防ぐため、cross-account でユニークな identKey を採用する。
  recipients: Array<{
    friendId: string;
    lineUserId: string;
    identKey: string;
    displayName: string | null;
  }>;
}

export interface DedupPreviewResult {
  totalSelected: number;
  uniqueRecipients: number;
  reduction: number;
  reductionRate: number;
  perAccount: DedupPreviewPerAccount[];
}

interface RankedRow {
  friend_id: string;
  line_user_id: string;
  line_account_id: string;
  ident_key: string;
  display_name: string | null;
}

/**
 * Compute the per-account dedup preview for a multi-account broadcast.
 * Same function called from preview API and send executor — guarantees that
 * displayed numbers and actually-sent numbers are computed identically (modulo
 * live data drift between preview and send time, which is intentional design).
 *
 * Single SQL with WITH/ROW_NUMBER OVER does the dedup in the DB layer; JS
 * only aggregates per-account. This relies on production D1 supporting
 * ROW_NUMBER() OVER PARTITION BY (SQLite 3.25+; D1 is 3.45+).
 *
 * Filters: is_following=1 AND line_account_id IS NOT NULL.
 * identity_key: COALESCE(URL_TOKEN_SQL, 'uid:'||user_id, 'solo:'||id).
 * Tie-breaking: priority CASE first, created_at ASC second.
 */
export async function computeDedupBroadcastPreview(
  db: D1Database,
  accountIds: string[],
  dedupPriority: string[],
  targetTagId?: string | null,
): Promise<DedupPreviewResult> {
  if (accountIds.length === 0) {
    return { totalSelected: 0, uniqueRecipients: 0, reduction: 0, reductionRate: 0, perAccount: [] };
  }

  const priority = dedupPriority.filter((id) => accountIds.includes(id));

  const inPlaceholders = accountIds.map(() => '?').join(', ');

  const caseWhens = priority.map((_, i) => `WHEN ? THEN ${i}`).join(' ');
  const caseExpr = priority.length === 0
    ? '999'
    : `CASE line_account_id ${caseWhens} ELSE 999 END`;

  // Tag filter — applied identically to both selectedCount and ranked queries
  // so the "selected" denominator and the dedup numerator share the same
  // population. Empty/null targetTagId means "no tag filter".
  const hasTagFilter = !!targetTagId;
  const tagJoinForSelectedCount = hasTagFilter
    ? `AND EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = friends.id AND ft.tag_id = ?)`
    : '';
  const tagJoinForRanked = hasTagFilter
    ? `AND EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`
    : '';

  // Per-account selectedCount.
  const selectedCountSql = `
    SELECT line_account_id, COUNT(*) AS cnt
    FROM friends
    WHERE is_following = 1
      AND line_account_id IN (${inPlaceholders})
      AND line_account_id IS NOT NULL
      ${tagJoinForSelectedCount}
    GROUP BY line_account_id
  `;
  const selectedCountBinds = hasTagFilter
    ? [...accountIds, targetTagId]
    : [...accountIds];
  const selectedCounts = await db
    .prepare(selectedCountSql)
    .bind(...selectedCountBinds)
    .all<{ line_account_id: string; cnt: number }>();

  const selectedCountByAccount = new Map<string, number>();
  for (const row of selectedCounts.results ?? []) {
    selectedCountByAccount.set(row.line_account_id, row.cnt);
  }
  const totalSelected = (selectedCounts.results ?? []).reduce((sum, r) => sum + r.cnt, 0);

  // Ranked query: returns only the rn=1 rows (primary recipients).
  const rankedSql = `
    WITH selected AS (
      SELECT
        f.id            AS friend_id,
        f.provider_line_user_id AS line_user_id,
        f.display_name,
        f.line_account_id,
        f.created_at,
        COALESCE(${URL_TOKEN_SQL}, 'uid:'||f.user_id, 'solo:'||f.id) AS ident_key
      FROM friends f
      WHERE f.is_following = 1
        AND f.line_account_id IN (${inPlaceholders})
        AND f.line_account_id IS NOT NULL
        ${tagJoinForRanked}
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY ident_key
          ORDER BY ${caseExpr}, created_at ASC
        ) AS rn
      FROM selected
    )
    SELECT friend_id, line_user_id, line_account_id, ident_key, display_name
    FROM ranked
    WHERE rn = 1
    ORDER BY line_account_id, created_at
  `;
  // Bind order matches placeholder order in the SQL: accountIds (for IN), then
  // tag filter (if any) inside the `selected` CTE, then priority (for the CASE
  // in ORDER BY of the `ranked` CTE).
  const rankedBinds = hasTagFilter
    ? [...accountIds, targetTagId, ...priority]
    : [...accountIds, ...priority];
  const rankedRows = await db
    .prepare(rankedSql)
    .bind(...rankedBinds)
    .all<RankedRow>();

  // Aggregate per-account.
  const sendCountByAccount = new Map<string, RankedRow[]>();
  for (const row of rankedRows.results ?? []) {
    const list = sendCountByAccount.get(row.line_account_id) ?? [];
    list.push(row);
    sendCountByAccount.set(row.line_account_id, list);
  }

  const uniqueRecipients = (rankedRows.results ?? []).length;
  const reduction = totalSelected - uniqueRecipients;
  const reductionRate = totalSelected > 0 ? reduction / totalSelected : 0;

  // Per-account meta.
  const accountMetaSql = `SELECT id, name, country FROM line_accounts WHERE id IN (${inPlaceholders})`;
  const metaRows = await db
    .prepare(accountMetaSql)
    .bind(...accountIds)
    .all<{ id: string; name: string; country: string | null }>();
  const metaByAccount = new Map<string, { name: string; country: string | null }>();
  for (const r of metaRows.results ?? []) {
    metaByAccount.set(r.id, { name: r.name, country: r.country });
  }

  const perAccount: DedupPreviewPerAccount[] = accountIds.map((id) => {
    const selectedCount = selectedCountByAccount.get(id) ?? 0;
    const winners = sendCountByAccount.get(id) ?? [];
    const sendCount = winners.length;
    const meta = metaByAccount.get(id) ?? { name: id, country: null };
    return {
      accountId: id,
      accountName: meta.name,
      accountCountry: meta.country,
      selectedCount,
      sendCount,
      excludedToHigherPriority: selectedCount - sendCount,
      recipients: winners.map((w) => ({
        friendId: w.friend_id,
        lineUserId: w.line_user_id,
        identKey: w.ident_key,
        displayName: w.display_name ?? null,
      })),
    };
  });

  return { totalSelected, uniqueRecipients, reduction, reductionRate, perAccount };
}

import { LineClient, type Message } from '@line-crm/line-sdk';
import { getLineAccountById, jstNow, updateBroadcastLineRequestId } from '@line-crm/db';
import { calculateStaggerDelay, sleep, addMessageVariation } from './stealth.js';
import {
  assertNoUnresolvedBroadcastVariables,
  hasRecipientVariables,
  renderBroadcastMessageContent,
} from './render-message.js';
import { buildMessage } from './broadcast.js';
import { createBroadcastRetryKey } from './broadcast-retry-key.js';
import { deliverTrackedLinePush } from './outbound-line-delivery.js';
import {
  getActiveMappedAccountTenantId,
  isPermanentLineDeliveryError,
} from './step-delivery.js';

const MULTICAST_BATCH_SIZE = 500;
const PERSONALIZED_PUSH_BATCH_SIZE = 10;

export interface ProcessMultiAccountDedupResult {
  totalCount: number;
  successCount: number;
  failedAccountIds: string[];
  // false = 時間バジェット超過または再試行可能な失敗で未送が残る。
  // caller は status='sent' にせず batch_offset=0 に戻して次の cron tick に継続させる。
  // true = 再試行可能な未送がない。terminal failure は failedAccountIds に残る。
  complete: boolean;
}

// 1 回の cron 実行でこの時間 (ms) を超えたら、残りは次の tick に回して yield する。
// これにより 1 実行が常に短く終わり、Cloudflare Worker の時間制限に達して stall する
// ことが構造的に無くなる (5000 人でも数 tick に分割されて淡々と進む)。stagger sleep も
// この経過時間に含まれる。判定は次 batch の sleep+multicast の「前」に行うため、超過判定
// 時点から更に 1 batch 分 (最大 ~5s sleep + multicast) はみ出し得る。それを見込んで Worker
// CPU 制限 (約30s) に対し十分な余裕を取った 10s に設定する (実効ロック保持は最大 ~15-18s)。
const MAX_RUN_MS = 10_000;

/**
 * Send a multi-account-dedup broadcast.
 *
 * Called by processBroadcastSend (in broadcast.ts) when
 * broadcast.target_type === 'multi-account-dedup'. Re-runs
 * computeDedupBroadcastPreview at send time (live data, drift from preview by
 * design) to obtain the per-account recipient list, then for each account:
 *   - skip if account is missing or inactive (not a failure)
 *   - send recipients in 500-friend batches with stagger delays
 *   - log per-friend INSERTs into messages_log
 *   - on multicast exception, log the account in failedAccountIds and continue
 *
 * Persists failedAccountIds to broadcasts.failed_account_ids when non-empty.
 * Status determination ('sent' vs 'failed' vs 'sent + partial') is left to
 * the caller (processBroadcastSend) — see broadcast.ts §7.3.
 */
/**
 * dedup broadcast の再開状態。plan は provider I/O 前に winner・宛先・表示名・
 * account 別本文を固定し、sentIdentKeys は配信済みの意味論的 ID を横断保持する。
 * 完了時の最大 JSON サイズを先に検証するため、途中で D1 row 上限を踏まない。
 */
interface FrozenDedupRecipient {
  accountId: string;
  friendId: string;
  lineUserId: string;
  identKey: string;
  displayName: string | null;
}

interface FrozenDedupPlan {
  recipients: FrozenDedupRecipient[];
  accountContent: Record<string, string>;
}

interface DedupProgress {
  sentIdentKeys: string[];
  plan?: FrozenDedupPlan;
}

const MAX_DEDUP_PROGRESS_BYTES = 900_000;

function parseFrozenPlan(value: unknown): FrozenDedupPlan | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { recipients?: unknown; accountContent?: unknown };
  if (!Array.isArray(candidate.recipients)
    || !candidate.accountContent
    || typeof candidate.accountContent !== 'object'
    || Array.isArray(candidate.accountContent)) return undefined;
  const recipients = candidate.recipients.filter((recipient): recipient is FrozenDedupRecipient => {
    if (!recipient || typeof recipient !== 'object') return false;
    const row = recipient as Record<string, unknown>;
    return typeof row.accountId === 'string'
      && typeof row.friendId === 'string'
      && typeof row.lineUserId === 'string'
      && typeof row.identKey === 'string'
      && (row.displayName === null || typeof row.displayName === 'string');
  });
  if (recipients.length !== candidate.recipients.length) return undefined;
  const accountContent = Object.fromEntries(
    Object.entries(candidate.accountContent as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  if (Object.keys(accountContent).length
    !== Object.keys(candidate.accountContent as Record<string, unknown>).length) return undefined;
  return { recipients, accountContent };
}

function parseProgress(raw: string | null | undefined): DedupProgress {
  const empty: DedupProgress = { sentIdentKeys: [] };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { sentIdentKeys?: unknown }).sentIdentKeys)) {
      return {
        sentIdentKeys: [...new Set((parsed as { sentIdentKeys: unknown[] }).sentIdentKeys
          .filter((s): s is string => typeof s === 'string'))],
        plan: parseFrozenPlan((parsed as { plan?: unknown }).plan),
      };
    }
  } catch {
    // caller が保存済みの破損 progress を fail-closed にする
  }
  return empty;
}

export async function processMultiAccountDedupBroadcast(
  db: D1Database,
  broadcast: {
    id: string;
    account_ids: string | null;
    dedup_priority: string | null;
    target_tag_id?: string | null;
    message_type: string;
    message_content: string;
    alt_text?: string | null;
    dedup_progress?: string | null;
    aggregation_unit?: string | null;
  },
  lineClientFactory: (token: string) => LineClient = (t) => new LineClient(t),
  opts: { maxRunMs?: number; now?: () => number } = {},
): Promise<ProcessMultiAccountDedupResult> {
  // 時間バジェット制御 (テストでは clock を注入して yield を決定的に再現できる)。
  // 変数名は clock — batch ループ内の `const now = jstNow()` (timestamp 文字列) と
  // 衝突させないため。
  const clock = opts.now ?? (() => Date.now());
  const maxRunMs = opts.maxRunMs ?? MAX_RUN_MS;
  const startMs = clock();
  // 1 batch でも送ったら true。時間切れでも最低 1 batch は進めて前進を保証する
  // (毎 tick 必ず success_count が伸びる → 永久に同じ所で足踏みしない)。
  let sentAnyBatch = false;
  let timeExceeded = false;

  const accountIds = (broadcast.account_ids ? JSON.parse(broadcast.account_ids) : []) as string[];
  const dedupPriority = (broadcast.dedup_priority ? JSON.parse(broadcast.dedup_priority) : []) as string[];

  const progress = parseProgress(broadcast.dedup_progress);
  const failPlan = async (totalCount: number): Promise<ProcessMultiAccountDedupResult> => {
    const failedAccountIds = [...new Set(accountIds)];
    await db.prepare(
      `UPDATE broadcasts SET failed_account_ids = ? WHERE id = ?`,
    ).bind(failedAccountIds.length > 0 ? JSON.stringify(failedAccountIds) : null, broadcast.id).run();
    return {
      totalCount,
      successCount: progress.sentIdentKeys.length,
      failedAccountIds,
      complete: true,
    };
  };
  if (broadcast.dedup_progress != null && !progress.plan) {
    return failPlan(progress.sentIdentKeys.length);
  }

  const needsPlanPersistence = !progress.plan;
  if (!progress.plan) {
    const preview = await computeDedupBroadcastPreview(
      db,
      accountIds,
      dedupPriority,
      broadcast.target_tag_id ?? null,
    );
    const recipients: FrozenDedupRecipient[] = [];
    const accountContent: Record<string, string> = {};
    for (const accountResult of preview.perAccount) {
      const account = await getLineAccountById(db, accountResult.accountId);
      if (!account || !account.is_active) continue;
      accountContent[account.id] = renderBroadcastMessageContent(
        broadcast.message_type,
        broadcast.message_content,
        { liffId: (account as unknown as { liff_id?: string | null }).liff_id ?? null },
      );
      recipients.push(...accountResult.recipients.map((recipient) => ({
        accountId: account.id,
        ...recipient,
      })));
    }
    progress.plan = { recipients, accountContent };
  }

  const plan = progress.plan;
  const completedProgress = JSON.stringify({
    ...progress,
    sentIdentKeys: [...new Set([
      ...progress.sentIdentKeys,
      ...plan.recipients.map((recipient) => recipient.identKey),
    ])],
  });
  // ponytail: JSON plan keeps this migration-free; use a row-per-recipient table above 900KB.
  if (new TextEncoder().encode(completedProgress).length > MAX_DEDUP_PROGRESS_BYTES) {
    return failPlan(new Set([
      ...progress.sentIdentKeys,
      ...plan.recipients.map((recipient) => recipient.identKey),
    ]).size);
  }
  if (needsPlanPersistence) {
    await db.prepare(
      `UPDATE broadcasts SET dedup_progress = ? WHERE id = ?`,
    ).bind(JSON.stringify(progress), broadcast.id).run();
  }

  // Network I/O 前に固定した plan だけを再生する。ライブの名前・画像・
  // winner ・batch 境界は再試行 key を変えない。
  const sentSet = new Set(progress.sentIdentKeys);
  const allIdentKeys = new Set<string>([
    ...progress.sentIdentKeys,
    ...plan.recipients.map((recipient) => recipient.identKey),
  ]);
  const recipientsByAccount = new Map<string, FrozenDedupRecipient[]>();
  for (const recipient of plan.recipients) {
    const recipients = recipientsByAccount.get(recipient.accountId) ?? [];
    recipients.push(recipient);
    recipientsByAccount.set(recipient.accountId, recipients);
  }

  const failedAccountIds: string[] = [];
  let hasRetryableFailure = false;
  const recordFailedAccount = (accountId: string) => {
    if (!failedAccountIds.includes(accountId)) failedAccountIds.push(accountId);
  };

  // 単一 broadcast-wide unit を全アカウント multicast で共有する。各 LINE
  // チャネルは独立した unit namespace を持つので「同じ名前で別カウント」が
  // アカウント側に保持される。fetch-insight 側で account_ids をループして
  // それぞれ getUnitInsight → 合算する設計 (routes/broadcasts.ts の dedup 分岐)。
  //
  // LINE customAggregationUnit は alphanumeric + underscore のみ (1-30 chars)。
  // broadcast.id.slice(0, 8) だと id がハイフン含む形 (例: 'bcast-xxxx-...')
  // のとき 'bcast_bcast-xx' と無効値を生成して LINE が 400 を返す。fallback は
  // hex のみに正規化する。`broadcasts.aggregation_unit` カラムが既に有効な
  // unit で埋まっていれば優先採用する (API/UI 経由作成時はそうなる)。
  const fallbackUnit = `bcast_${broadcast.id.slice(0, 8).replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const unit = broadcast.aggregation_unit ?? fallbackUnit;

  for (const [accountId, recipients] of recipientsByAccount) {
    if (timeExceeded) break; // 時間バジェット超過 — 残アカウントは次の cron tick で処理
    const account = await getLineAccountById(db, accountId);
    if (!account || !account.is_active) {
      recordFailedAccount(accountId);
      continue;
    }

    if (recipients.length === 0) continue;

    // 既に送信済の identKey を持つ recipient を除外して残差だけ送る。
    // identKey は dedup の意味論的 ID なので、母集団変動や cross-account 遷移が
    // あっても論理重複を完全に防げる。
    if (!recipients.some((recipient) => !sentSet.has(recipient.identKey))) continue;

    const client = lineClientFactory(account.channel_access_token);
    const accountContent = plan.accountContent[accountId];
    if (accountContent == null) {
      recordFailedAccount(accountId);
      continue;
    }
    const personalized = hasRecipientVariables(accountContent);
    if (!personalized) assertNoUnresolvedBroadcastVariables(accountContent);
    const tenantId = await getActiveMappedAccountTenantId(db, account.id);
    if (!tenantId) {
      recordFailedAccount(account.id);
      continue;
    }
    const deliveryBatchSize = personalized ? PERSONALIZED_PUSH_BATCH_SIZE : MULTICAST_BATCH_SIZE;
    const totalBatches = Math.ceil(recipients.length / deliveryBatchSize);

    // Per-account の liff_id でテンプレ変数 ({{liff_id}}) を置換してから
    // buildMessage する。これで 1 broadcast から複数アカへ配信する際、
    // 友だちの所属アカに対応した LIFF URL が届く (events の運用要件)。
    const message = personalized
      ? null
      : buildMessage(broadcast.message_type, accountContent, broadcast.alt_text ?? undefined);

    try {
      for (let i = 0; i < recipients.length; i += deliveryBatchSize) {
        const batchIdx = Math.floor(i / deliveryBatchSize);
        const batch = recipients
          .slice(i, i + deliveryBatchSize)
          .filter((recipient) => !sentSet.has(recipient.identKey));
        if (batch.length === 0) continue;

        // 時間バジェットを超えたら、残りは次の cron tick に回して yield する。
        // ただし最低 1 batch は必ず送る (sentAnyBatch ガード) ことで毎 tick 前進を保証。
        if (sentAnyBatch && clock() - startMs > maxRunMs) {
          timeExceeded = true;
          break;
        }

        if (batchIdx > 0) {
          await sleep(calculateStaggerDelay(recipients.length, batchIdx));
        }

        const delivered = [] as Array<{
          recipient: (typeof batch)[number];
          messageType: string;
          content: string;
        }>;
        let batchDeliveryError: unknown = null;
        if (personalized) {
          for (const recipient of batch) {
            try {
              const content = renderBroadcastMessageContent(broadcast.message_type, accountContent, {
                displayName: recipient.displayName,
              });
              assertNoUnresolvedBroadcastVariables(content);
              const recipientMessage = buildMessage(
                broadcast.message_type,
                content,
                broadcast.alt_text ?? undefined,
              );
              const retryKey = await createBroadcastRetryKey(
                broadcast.id,
                'dedup-personalized-push',
                recipient.identKey,
              );
              const result = await deliverTrackedLinePush({
                db,
                operationId: retryKey,
                tenantId: tenantId!,
                lineAccountId: account.id,
                friendId: recipient.friendId,
                messageType: broadcast.message_type,
                content,
                source: 'broadcast',
                broadcastId: broadcast.id,
                request: { to: recipient.lineUserId, messages: [recipientMessage] },
                send: async (request, providerRetryKey) => {
                  await client.pushMessage(
                    request.to,
                    request.messages,
                    providerRetryKey,
                    [unit],
                  );
                },
              });
              if (result !== 'sent' && result !== 'already_sent') {
                throw new Error('OUTBOUND_LINE_RECONCILIATION_REQUIRED');
              }
              delivered.push({ recipient, messageType: broadcast.message_type, content });
            } catch (err) {
              batchDeliveryError = err;
              break;
            }
          }
        } else {
          let batchMessage = message!;
          if (batchMessage.type === 'text' && totalBatches > 1) {
            batchMessage = { ...batchMessage, text: addMessageVariation(batchMessage.text, batchIdx) } as Message;
          }
          const retryKey = await createBroadcastRetryKey(
            broadcast.id,
            'dedup-multicast',
            account.id,
            ...batch.map((r) => r.identKey),
            JSON.stringify(batchMessage),
          );
          await client.multicast(batch.map((r) => r.lineUserId), [batchMessage], [unit], retryKey);
          for (const recipient of batch) {
            delivered.push({
              recipient,
              messageType: broadcast.message_type,
              content: accountContent,
            });
          }
        }

        // multicast 成功直後に identKey を sent set へ追加。
        for (const { recipient: r } of delivered) {
          progress.sentIdentKeys.push(r.identKey);
          sentSet.add(r.identKey);
        }

        const now = jstNow();
        // multicast は log と progress を同じ batch で確定する。personalized push は
        // recipient ごとの outbound ledger が先に log を確定するため、ここでは progress
        // だけを書く。crash 後の再入でも ledger が already_sent を返して progress を直せる。
        const stmts = [
          ...(personalized ? [] : delivered.map(({ recipient: r, messageType, content }) =>
            db.prepare(
              `INSERT INTO messages_log
                (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, 'push', 'broadcast', ?, ?)`,
            ).bind(crypto.randomUUID(), r.friendId, messageType, content, broadcast.id, account.id, now),
          )),
          // success_count は absolute (`= ?`) で書いて double-counting を防ぐ。
          db.prepare(
            `UPDATE broadcasts SET dedup_progress = ?, success_count = ? WHERE id = ?`,
          ).bind(JSON.stringify(progress), progress.sentIdentKeys.length, broadcast.id),
        ];
        await db.batch(stmts);
        sentAnyBatch = true; // 1 batch 以上 durable に記録した → 前進保証 & yield 可
        if (batchDeliveryError) throw batchDeliveryError;
      }
    } catch (err) {
      console.error(`[multi-account-dedup] account ${account.id} failed:`, err);
      recordFailedAccount(account.id);
      const message = err instanceof Error ? err.message : String(err);
      const terminal = isPermanentLineDeliveryError(err)
        || message === 'OUTBOUND_LINE_RECONCILIATION_REQUIRED'
        || message === 'OUTBOUND_LINE_DELIVERY_SCOPE_MISMATCH';
      if (!terminal) hasRetryableFailure = true;
    }
  }

  // failed_account_ids は常に上書きする。前回 stalled run で残った古い失敗リストを
  // resume 後の成功で上書きしないと「全件成功したのに UI が partial-failure 表示」に
  // なる。今回失敗が無ければ NULL に戻して clean state にする。
  await db.prepare(
    `UPDATE broadcasts SET failed_account_ids = ? WHERE id = ?`,
  ).bind(failedAccountIds.length > 0 ? JSON.stringify(failedAccountIds) : null, broadcast.id).run();

  const successCount = progress.sentIdentKeys.length;
  const totalCount = allIdentKeys.size;

  // aggregation_unit を保存して fetch-insight が LINE Insight API を叩けるようにする。
  // 1 件以上送れたときだけ書く (全件失敗時は insight 取得しても意味ない)。
  if (successCount > 0) {
    await updateBroadcastLineRequestId(db, broadcast.id, null, unit);
  }

  // dedup_progress の clear は意図的にここでは行わない。caller (processQueuedBroadcastBatches
  // など) が updateBroadcastStatus(broadcast.id, 'sent', ...) を呼ぶときに同一 UPDATE で
  // clear される設計 (db/broadcasts.ts: updateBroadcastStatus 参照)。
  // この関数の return 後・status='sent' 確定前に Worker crash した場合は dedup_progress
  // が残ったままで status='sending', batch_offset=-1 になり、recoverStalledBroadcasts が
  // 再投入して resume → 完走済みアカは batchOffset >= recipients.length で skip → 重複なし。
  //
  // complete=false (時間超過または再試行可能な失敗) のときは caller が
  // status='sent' にせず batch_offset=0 に戻し、次の cron tick で再開する。
  return {
    totalCount,
    successCount,
    failedAccountIds,
    complete: !timeExceeded && !hasRetryableFailure,
  };
}
