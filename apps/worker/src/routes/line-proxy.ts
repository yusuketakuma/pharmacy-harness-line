import { Hono } from 'hono';
import type { Context } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import {
  getLineAccountsForTenant,
  getFriendByLineUserIdForAccount,
  upsertFriend,
  getChatByFriendId,
  createChat,
  updateChat,
  jstNow,
} from '@line-crm/db';
import type { Friend, LineAccount } from '@line-crm/db';
import {
  authenticateApiToken,
  resolveAuthenticatedTenant,
  TENANT_HEADER,
} from '../middleware/auth.js';
import type { AuthenticatedStaff } from '../middleware/auth.js';
import { messageToLogPayload } from '../services/step-delivery.js';
import type { Env } from '../index.js';
import {
  findLineCredentialByAccessToken,
  readLineCredential,
} from '../custom/pharmacy/provisioning/line-credential-store.js';
import { sameText } from '../custom/pharmacy/provisioning/line-credentials.js';
import {
  canAccessPharmacyAccount,
  hasPharmacyModeAccount,
  isPharmacyModeAccount,
} from '../custom/pharmacy/growth-loop/access.js';
import { isApprovedRenderedPharmacyMessage } from '../custom/pharmacy/growth-loop/policy.js';

/**
 * LINE Messaging API 互換プロキシ。
 *
 * 外部エージェント (Codex / Claude Code / スクリプト等) が LINE API を直接叩くと
 * messages_log に残らず admin UI のチャット履歴から欠落する。このプロキシは
 * ベースURLを `https://api.line.me` → `https://<worker>/line-api` に差し替える
 * だけで送信を messages_log に記録する drop-in 経路を提供する。
 * 通常は source='external'、人間が個別返信する push は
 * X-Line-Harness-Source: manual を付けると source='manual' で記録する。
 *
 * 認証は2系統:
 * 1. チャネルアクセストークン (drop-in 移行用) — tenant-scoped encrypted
 *    credential store の keyed lookup と照合。未登録トークンは 401
 *    (オープンリレー防止)。legacy env token は別の unscoped install fallback。
 * 2. harness API キー (staff key / env API_KEY) — worker が保持するチャネル
 *    トークンで上流を呼ぶ。エージェントにチャネルトークンを配らずに済むので、
 *    トークンローテーション後はこちらが正規経路。複数アカウント構成では
 *    X-Line-Account-Id ヘッダー (line_accounts.id または channel_id) で送信元を指定。
 *
 * - /line-api/v2/bot/** → api.line.me へ透過転送 (メッセージ以外も可)。
 * - /line-api-data/v2/bot/** → api-data.line.me へ透過転送 (コンテンツ取得等)。
 * - 記録対象: push / multicast / broadcast。reply は replyToken から友だちを
 *   特定できないため転送のみ (reply token は webhook 受信者=worker しか持たない
 *   ので実運用では到達しない)。narrowcast は宛先が確定しないため転送のみ。
 */
const lineProxy = new Hono<Env>();

// LINE message payloads are small (multicast: 500 recipients + 5 messages).
// 1 MiB matches the webhook body cap and bounds memory before upstream fetch.
const MAX_PROXY_BODY_SIZE = 1024 * 1024;

// Non-message bodies can be binary (rich menu image upload — LINE caps it at
// 1 MB). Buffered as ArrayBuffer to preserve bytes; 3 MiB leaves headroom.
const MAX_BINARY_BODY_SIZE = 3 * 1024 * 1024;

// POST endpoints inspected for logging. reply/narrowcast are included so the
// body is parsed as JSON (never binary) and the not-logged warning fires.
const MESSAGE_SEND_PATHS = new Set([
  '/v2/bot/message/push',
  '/v2/bot/message/multicast',
  '/v2/bot/message/broadcast',
  '/v2/bot/message/reply',
  '/v2/bot/message/narrowcast',
]);

// Unknown recipients cost a getProfile subrequest plus ~4 D1 queries each; cap
// them so a multicast full of strangers cannot exhaust the Workers subrequest
// budget. Overflow is skipped WITH a console.warn — never silently.
const MAX_FRIEND_CREATIONS = 20;

// D1 caps bound parameters at ~100 per statement. 8 params per row → 12 rows
// per INSERT keeps each statement legal while packing ~300 rows per db.batch
// subrequest (25 statements), so even large broadcasts stay in budget.
const ROWS_PER_INSERT = 12;
const STATEMENTS_PER_BATCH = 25;

// Chunk size for friend lookups via IN (...) — same 100-bind ceiling.
const LOOKUP_CHUNK = 90;

const AUTH_FAILED = {
  message:
    'Authentication failed. Confirm that the access token in the authorization header is valid.',
};

// push/multicast の宛先のうち friend として記録できるのは実ユーザーのみ。
// group (C…) / room (R…) 宛は friend 行を捏造しないためスキップする。
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

type ParsedSend = { to?: unknown; messages?: unknown };

type ProxyLogSource = 'external' | 'manual';

type LogRow = {
  friendId: string;
  messageType: string;
  content: string;
  deliveryType: string | null;
  lineAccountId: string | null;
};

type ResolvedCaller = {
  /** Channel access token used against api.line.me / api-data.line.me. */
  upstreamToken: string;
  /** line_accounts.id when the channel is DB-registered, else null (env default). */
  lineAccountId: string | null;
  /** Total number of registered accounts — used to scope broadcast logging. */
  accountCount: number;
  staff: AuthenticatedStaff | null;
};

function bearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function asMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is Message => !!m && typeof m === 'object' && 'type' in m);
}

/**
 * Resolve the caller to a channel. Channel tokens use the keyed encrypted
 * credential index; harness API keys (staff key / env API_KEY) map to a channel
 * via X-Line-Account-Id or the single active tenant account and then decrypt
 * its credential. Returns a Response on auth/validation failure.
 */
async function resolveCaller(c: Context<Env>, token: string): Promise<ResolvedCaller | Response> {
  // harness API キー経路 — worker 側でチャネルトークンを解決する。
  const staff = await authenticateApiToken(c, token);
  if (staff) {
    const identity = await resolveAuthenticatedTenant(
      c.env.DB,
      staff,
      c.req.header(TENANT_HEADER),
      c.env.LEGACY_ENV_OWNER_BYPASS === 'true',
    );
    if (!identity) {
      return c.json({ message: 'Tenant access denied' }, 403);
    }
    const tenantAccounts = (await getLineAccountsForTenant(c.env.DB, identity.tenant.id))
      .filter((account) => account.is_active);

    const requestedId = c.req.header('X-Line-Account-Id');
    let account: LineAccount | undefined;
    if (requestedId) {
      account = tenantAccounts.find((a) => a.id === requestedId || a.channel_id === requestedId);
      if (!account) {
        return c.json({ message: 'LINE account access denied' }, 403);
      }
    } else if (tenantAccounts.length === 1) {
      account = tenantAccounts[0];
    } else if (tenantAccounts.length > 1) {
      return c.json(
        { message: 'Multiple LINE accounts registered — set the X-Line-Account-Id header' },
        400,
      );
    }

    if (account) {
      if (await isPharmacyModeAccount(c.env.DB, account.id) &&
          !(await canAccessPharmacyAccount(c.env.DB, staff, account.id))) {
        return c.json({ message: 'Pharmacy account access denied' }, 403);
      }
      const rootSecret = c.env.LINE_CREDENTIAL_KEY_V1;
      if (!rootSecret) {
        return c.json({ message: 'LINE account credential unavailable' }, 403);
      }
      const upstreamToken = await readLineCredential(c.env.DB, rootSecret, {
        tenantId: identity.tenant.id,
        lineAccountId: account.id,
        kind: 'channel_access_token',
      });
      if (!upstreamToken) {
        return c.json({ message: 'LINE account credential unavailable' }, 403);
      }
      return {
        upstreamToken,
        lineAccountId: account.id,
        accountCount: tenantAccounts.length,
        staff,
      };
    }
    return c.json({ message: 'No LINE account configured' }, 400);
  }

  // Tenant-scoped drop-in mode. The store performs a keyed digest lookup and
  // decrypts only the active mapped account; no plaintext token scan occurs.
  const rootSecret = c.env.LINE_CREDENTIAL_KEY_V1;
  if (rootSecret) {
    const credential = await findLineCredentialByAccessToken(c.env.DB, rootSecret, token);
    if (credential) {
      let accountCount: number;
      try {
        const count = await c.env.DB.prepare(
          `SELECT COUNT(*) AS count
             FROM tenant_line_accounts AS mapping
             INNER JOIN tenants AS tenant
                     ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
             INNER JOIN line_accounts AS account
                     ON account.id = mapping.line_account_id AND account.is_active = 1
            WHERE mapping.tenant_id = ?`,
        ).bind(credential.tenantId).first<{ count: number }>();
        if (!count || !Number.isSafeInteger(count.count) || count.count < 1) {
          return c.json(AUTH_FAILED, 401);
        }
        accountCount = count.count;
      } catch {
        return c.json(AUTH_FAILED, 401);
      }
      return {
        upstreamToken: credential.credential,
        lineAccountId: credential.lineAccountId,
        accountCount,
        staff: null,
      };
    }
  }

  // Legacy unscoped install fallback. It is intentionally unreachable from
  // the staff-key path above, which always requires tenant membership and an
  // encrypted tenant credential.
  if (sameText(token, c.env.LINE_CHANNEL_ACCESS_TOKEN)) {
    try {
      if (await hasPharmacyModeAccount(c.env.DB)) {
        return c.json({ message: 'Account scope required in a pharmacy installation' }, 403);
      }
      const count = await c.env.DB.prepare(
        'SELECT COUNT(*) AS count FROM line_accounts WHERE is_active = 1',
      ).first<{ count: number }>();
      if (!count || !Number.isSafeInteger(count.count) || count.count < 0) {
        return c.json(AUTH_FAILED, 401);
      }
      return { upstreamToken: token, lineAccountId: null, accountCount: count.count, staff: null };
    } catch {
      return c.json(AUTH_FAILED, 401);
    }
  }
  return c.json(AUTH_FAILED, 401);
}

async function rejectUnsafePharmacySend(
  c: Context<Env>,
  caller: ResolvedCaller,
  path: string,
  rawBody: string | undefined,
  source: ProxyLogSource,
): Promise<Response | null> {
  const lineAccountId = caller.lineAccountId;
  if (!lineAccountId) {
    return await hasPharmacyModeAccount(c.env.DB)
      ? c.json({ message: 'Account scope required in a pharmacy installation' }, 403)
      : null;
  }
  if (!(await isPharmacyModeAccount(c.env.DB, lineAccountId))) {
    return null;
  }
  if (source === 'manual') {
    return caller.staff
      ? null
      : c.json({ message: 'Manual pharmacy send requires assigned staff' }, 403);
  }
  if (path !== '/v2/bot/message/push' || !rawBody) {
    return c.json({ message: 'Generic automated send is disabled for pharmacy accounts' }, 403);
  }
  const eventId = c.req.header('X-Pharmacy-Notification-Event-Id');
  if (!eventId || !/^[A-Za-z0-9._:-]{1,160}$/.test(eventId)) {
    return c.json({ message: 'Approved pharmacy notification claim required' }, 403);
  }
  let parsed: ParsedSend;
  try {
    parsed = JSON.parse(rawBody) as ParsedSend;
  } catch {
    return c.json({ message: 'Invalid message payload' }, 400);
  }
  const messages = asMessages(parsed.messages);
  const event = await c.env.DB.prepare(
    `SELECT e.message_id, f.provider_line_user_id AS line_user_id
       FROM pharmacy_notification_events e
       INNER JOIN friends f
         ON f.id = e.friend_id AND f.line_account_id = e.line_account_id
      WHERE e.id = ? AND e.line_account_id = ? AND e.outcome = 'attempted'`,
  ).bind(eventId, lineAccountId).first<{ message_id: string; line_user_id: string }>();
  if (!event || parsed.to !== event.line_user_id || messages.length !== 1 ||
      !isApprovedRenderedPharmacyMessage(event.message_id, messages[0])) {
    return c.json({ message: 'Pharmacy notification payload rejected' }, 403);
  }
  return null;
}

/** Look up friends for a set of userIds in IN-clause chunks (≤100 binds each). */
async function getFriendsByLineUserIds(
  db: D1Database,
  userIds: string[],
  lineAccountId: string | null,
): Promise<Map<string, Pick<Friend, 'id' | 'line_user_id' | 'line_account_id'>>> {
  const found = new Map<string, Pick<Friend, 'id' | 'line_user_id' | 'line_account_id'>>();
  for (let i = 0; i < userIds.length; i += LOOKUP_CHUNK) {
    const chunk = userIds.slice(i, i + LOOKUP_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const scope = lineAccountId ? 'line_account_id = ?' : 'line_account_id IS NULL';
    const result = await db
      .prepare(`SELECT id, provider_line_user_id AS line_user_id, line_account_id
                  FROM friends
                 WHERE provider_line_user_id IN (${placeholders}) AND ${scope}`)
      .bind(...chunk, ...(lineAccountId ? [lineAccountId] : []))
      .all<Pick<Friend, 'id' | 'line_user_id' | 'line_account_id'>>();
    for (const row of result.results ?? []) {
      found.set(row.line_user_id, row);
    }
  }
  return found;
}

/**
 * Create a friend row for a recipient we have never seen. Mirrors
 * ensureFriendFromWebhookUser (webhook.ts) except that line_account_id is only
 * set on newly created rows — an outgoing push must not rebind an existing
 * friend's account attribution.
 */
async function createFriendForRecipient(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string | null,
): Promise<Friend | null> {
  try {
    let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('[line-proxy] getProfile failed', err);
    }

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      lineAccountId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    return friend;
  } catch (err) {
    console.error('[line-proxy] friend creation failed', err);
    return null;
  }
}

/** Multi-row INSERT keeps large broadcasts within the D1 subrequest budget. */
async function insertLogRows(
  db: D1Database,
  rows: LogRow[],
  source: ProxyLogSource,
): Promise<void> {
  if (rows.length === 0) return;
  const now = jstNow();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    const values = chunk
      .map(() => `(?, ?, 'outgoing', ?, ?, NULL, NULL, ?, ?, ?, ?)`)
      .join(', ');
    const params = chunk.flatMap((row) => [
      crypto.randomUUID(),
      row.friendId,
      row.messageType,
      row.content,
      row.deliveryType,
      source,
      row.lineAccountId,
      now,
    ]);
    statements.push(
      db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES ${values}`,
        )
        .bind(...params),
    );
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
  }
}

/** 1:1 push は operator 手動送信と同じ扱いでチャットを更新する (chats.ts:608 と同型)。 */
async function touchChat(db: D1Database, friendId: string): Promise<void> {
  const chat = (await getChatByFriendId(db, friendId)) ?? (await createChat(db, { friendId }));
  await updateChat(db, chat.id, { status: 'in_progress', lastMessageAt: jstNow() });
}

/**
 * Record a successfully forwarded send into messages_log. Never throws: the
 * upstream send already happened, so a logging failure must not turn the
 * caller's 200 into an error (it would trigger client retries = double sends).
 */
async function logProxySend(
  db: D1Database,
  caller: ResolvedCaller,
  path: string,
  rawBody: string,
  source: ProxyLogSource,
): Promise<void> {
  try {
    const parsed = JSON.parse(rawBody) as ParsedSend;
    const messages = asMessages(parsed.messages);
    if (messages.length === 0) return;
    const payloads = messages.map(messageToLogPayload);
    const lineClient = new LineClient(caller.upstreamToken);
    const { lineAccountId } = caller;
    const rowsFor = (friendId: string, deliveryType: string | null): LogRow[] =>
      payloads.map((p) => ({
        friendId,
        messageType: p.messageType,
        content: p.content,
        deliveryType,
        lineAccountId,
      }));

    if (path === '/v2/bot/message/push' && typeof parsed.to === 'string') {
      if (!LINE_USER_ID_RE.test(parsed.to)) {
        console.warn(`[line-proxy] push to non-user target not logged: ${parsed.to.slice(0, 4)}…`);
        return;
      }
      const friend =
        (await getFriendByLineUserIdForAccount(db, parsed.to, lineAccountId)) ??
        (await createFriendForRecipient(db, lineClient, parsed.to, lineAccountId));
      if (!friend) return;
      await insertLogRows(db, rowsFor(friend.id, 'push'), source);
      await touchChat(db, friend.id);
      return;
    }

    if (path === '/v2/bot/message/multicast' && Array.isArray(parsed.to)) {
      const userIds = [
        ...new Set(
          parsed.to.filter((t): t is string => typeof t === 'string' && LINE_USER_ID_RE.test(t)),
        ),
      ];
      const known = await getFriendsByLineUserIds(db, userIds, lineAccountId);
      const rows: LogRow[] = [];
      let created = 0;
      let skipped = 0;
      for (const userId of userIds) {
        let friend = known.get(userId) ?? null;
        if (!friend) {
          if (created >= MAX_FRIEND_CREATIONS) {
            skipped++;
            continue;
          }
          created++;
          friend = await createFriendForRecipient(db, lineClient, userId, lineAccountId);
        }
        if (friend) rows.push(...rowsFor(friend.id, 'push'));
      }
      if (skipped > 0) {
        console.warn(
          `[line-proxy] multicast: ${skipped} unknown recipients not logged (friend-creation cap ${MAX_FRIEND_CREATIONS})`,
        );
      }
      await insertLogRows(db, rows, source);
      return;
    }

    if (path === '/v2/bot/message/broadcast') {
      // A LINE broadcast reaches the followers of ONE channel. Scope the log
      // to that channel's friends; with a single registered account the whole
      // friends table belongs to it (legacy rows may carry NULL account_id).
      let friendIds: string[] = [];
      if (caller.accountCount <= 1 && lineAccountId) {
        // Single active account: legacy rows may carry NULL account_id, but
        // rows pinned to a deactivated account are not this channel's followers.
        const result = await db
          .prepare(
            'SELECT id FROM friends WHERE is_following = 1 AND (line_account_id = ? OR line_account_id IS NULL)',
          )
          .bind(lineAccountId)
          .all<{ id: string }>();
        friendIds = (result.results ?? []).map((r) => r.id);
      } else if (caller.accountCount <= 1) {
        const result = await db
          .prepare('SELECT id FROM friends WHERE is_following = 1')
          .all<{ id: string }>();
        friendIds = (result.results ?? []).map((r) => r.id);
      } else if (lineAccountId) {
        const result = await db
          .prepare('SELECT id FROM friends WHERE is_following = 1 AND line_account_id = ?')
          .bind(lineAccountId)
          .all<{ id: string }>();
        friendIds = (result.results ?? []).map((r) => r.id);
      } else {
        // Multi-account install + unregistered env token: the recipient set is
        // unknowable, and logging every friend would fabricate sends on other
        // accounts' timelines. Register the account to get broadcast logging.
        console.warn(
          '[line-proxy] broadcast not logged: env token is not registered in line_accounts and multiple accounts exist',
        );
        return;
      }
      const rows = friendIds.flatMap((friendId) => rowsFor(friendId, null));
      await insertLogRows(db, rows, source);
      console.log(`[line-proxy] broadcast logged for ${friendIds.length} friends`);
      return;
    }

    if (path === '/v2/bot/message/reply' || path === '/v2/bot/message/narrowcast') {
      console.warn(
        `[line-proxy] ${path} forwarded but not logged (recipient cannot be resolved)`,
      );
    }
  } catch (err) {
    console.error('[line-proxy] logProxySend failed:', err);
  }
}

function proxyHandler(prefix: string, upstreamBase: string, logSends: boolean) {
  return async (c: Context<Env>): Promise<Response> => {
    const url = new URL(c.req.url);
    const encodedPath = url.pathname.slice(prefix.length);
    // Percent-encoded paths (/%70ush) must not dodge the message-send check —
    // LINE decodes them upstream, so match against the decoded form.
    let path: string;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      return c.json({ message: 'Not found' }, 404);
    }
    if (!path.startsWith('/v2/bot/') || !encodedPath.startsWith('/v2/bot/')) {
      return c.json({ message: 'Not found' }, 404);
    }

    const token = bearerToken(c.req.header('Authorization'));
    if (!token) return c.json(AUTH_FAILED, 401);

    // Resolve the token to a known channel or harness key. Unknown tokens are
    // rejected so the worker cannot be used as an open relay.
    const caller = await resolveCaller(c, token);
    if (caller instanceof Response) return caller;

    const method = c.req.method.toUpperCase();
    const isMessageSend = logSends && method === 'POST' && MESSAGE_SEND_PATHS.has(path);

    // Proxy 経由の自動送信と、人間が行う個別返信を区別する。未指定は従来どおり
    // external。manual は 1:1 push だけに限定し、一斉配信で未対応をまとめて消す
    // 事故を防ぐ。独自ヘッダーは上流 LINE API には転送しない。
    const requestedSource = c.req.header('X-Line-Harness-Source');
    let logSource: ProxyLogSource = 'external';
    if (isMessageSend && requestedSource) {
      if (requestedSource !== 'manual') {
        return c.json({ message: 'X-Line-Harness-Source must be manual' }, 400);
      }
      if (path !== '/v2/bot/message/push') {
        return c.json(
          { message: 'X-Line-Harness-Source: manual is only supported for push messages' },
          400,
        );
      }
      logSource = 'manual';
    }

    // Message sends are buffered as text (needed for log parsing). Everything
    // else is buffered as raw bytes — e.g. rich menu image upload is binary
    // and text-decoding it would corrupt the payload.
    let rawBody: string | undefined;
    let binaryBody: ArrayBuffer | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const cap = isMessageSend ? MAX_PROXY_BODY_SIZE : MAX_BINARY_BODY_SIZE;
      const declared = Number.parseInt(c.req.header('Content-Length') ?? '', 10);
      if (Number.isFinite(declared) && declared > cap) {
        return c.json({ message: 'Payload too large' }, 413);
      }
      if (isMessageSend) {
        rawBody = await c.req.text();
        if (new TextEncoder().encode(rawBody).byteLength > cap) {
          return c.json({ message: 'Payload too large' }, 413);
        }
      } else {
        binaryBody = await c.req.arrayBuffer();
        if (binaryBody.byteLength > cap) {
          return c.json({ message: 'Payload too large' }, 413);
        }
      }
    }

    if (isMessageSend) {
      const rejected = await rejectUnsafePharmacySend(c, caller, path, rawBody, logSource);
      if (rejected) return rejected;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${caller.upstreamToken}`,
    };
    const contentType = c.req.header('Content-Type');
    if (contentType) headers['Content-Type'] = contentType;
    const retryKey = c.req.header('X-Line-Retry-Key');
    if (retryKey) headers['X-Line-Retry-Key'] = retryKey;

    let upstream: Response;
    try {
      upstream = await fetch(`${upstreamBase}${encodedPath}${url.search}`, {
        method,
        headers,
        body: rawBody ?? binaryBody,
      });
    } catch (err) {
      console.error('[line-proxy] upstream fetch failed:', err);
      return c.json({ message: 'Upstream request failed' }, 502);
    }

    if (isMessageSend && upstream.ok && rawBody) {
      // Log in the background where possible: a multicast to hundreds of
      // friends must not delay the client response (timeout → client retry →
      // double send). Falls back to inline await outside a Workers runtime.
      const logging = logProxySend(c.env.DB, caller, path, rawBody, logSource);
      try {
        c.executionCtx.waitUntil(logging);
      } catch {
        await logging;
      }
    }

    const responseHeaders = new Headers();
    for (const name of [
      'content-type',
      'x-line-request-id',
      'x-line-accepted-request-id',
      'retry-after',
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    // Stream the body through — api-data downloads (images, video) can be
    // large binary; buffering them as text would corrupt and bloat memory.
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  };
}

lineProxy.all('/line-api/*', proxyHandler('/line-api', 'https://api.line.me', true));
lineProxy.all('/line-api-data/*', proxyHandler('/line-api-data', 'https://api-data.line.me', false));

export { lineProxy };
