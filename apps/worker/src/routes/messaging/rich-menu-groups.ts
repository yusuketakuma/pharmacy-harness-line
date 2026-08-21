import { Hono, type Context } from 'hono';
import {
  getRichMenuGroups,
  getRichMenuGroupById,
  getRichMenuGroupWithPages,
  createRichMenuGroup,
  updateRichMenuGroupMeta,
  replaceRichMenuPages,
  deleteRichMenuGroup,
  setRichMenuPageImage,
  pageBelongsToGroup,
  acquireRichMenuAccountLock,
  releasePublishLock,
  markRichMenuGroupPublished,
  markRichMenuGroupUnpublished,
  getLineAccountByIdForTenant,
  getFollowingLineUserIdsByTag,
  type RichMenuGroup,
  type RichMenuGroupWithPages,
  type RichMenuPageInput,
  type RichMenuAreaInput,
  type CreateRichMenuGroupInput,
  type UpdateRichMenuGroupMetaInput,
} from '@line-crm/db';
import type { Env } from '../../index.js';
import { validateRichMenuImage } from '../../lib/image-validator.js';
import { readLineCredential } from '../../custom/pharmacy/provisioning/line-credential-store.js';
import { getPharmacyRichMenuPublishReadiness } from '../../custom/pharmacy/rich-menu/publish-readiness.js';
import {
  PHARMACY_RICH_MENU_PUBLISH_CONFIRMATION_TTL_MS,
  signPharmacyRichMenuResumeConfirmation,
  signPharmacyRichMenuPublishConfirmation,
  verifyPharmacyRichMenuResumeConfirmation,
  verifyPharmacyRichMenuPublishConfirmation,
} from '../../custom/pharmacy/rich-menu/publish-confirmation.js';
import {
  advancePharmacyRichMenuPublishPhase,
  beginPharmacyRichMenuOperation,
  consumePharmacyRichMenuResumeConfirmation,
  finishPharmacyRichMenuOperation,
  getPharmacyRichMenuLifecycleControl,
  getPharmacyRichMenuOperation,
  getUnresolvedPharmacyRichMenuOperation,
  isPharmacyRichMenuKnownGood,
  recordPharmacyRichMenuExpectedDefault,
  recordPharmacyRichMenuRemoteId,
} from '../../custom/pharmacy/rich-menu/repository.js';
import {
  buildAliasId,
  buildLineRichMenuPayload,
  matchesLineRichMenuPayload,
  publishRichMenuGroup,
  unpublishRichMenuGroup,
  linkRichMenuBulkChunked,
  type LineRichMenuClient,
  type R2Like,
  type GroupInput,
} from '../../lib/rich-menu-publisher.js';

export const richMenuGroups = new Hono<Env>();

function getScopedLineAccount(c: Context<Env>, lineAccountId: string) {
  return getLineAccountByIdForTenant(c.env.DB, c.get('tenantId'), lineAccountId);
}

async function resolveLineAccessToken(c: Context<Env>, lineAccountId: string): Promise<string | null> {
  const tenantId = c.get('tenantId');
  const rootSecret = c.env.LINE_CREDENTIAL_KEY_V1;
  if (!tenantId || !rootSecret) return null;
  try {
    return await readLineCredential(c.env.DB, rootSecret, {
      tenantId,
      lineAccountId,
      kind: 'channel_access_token',
    });
  } catch {
    return null;
  }
}

async function isImmutablePharmacyRichMenuVersion(db: D1Database, groupId: string): Promise<boolean> {
  return Boolean(await db.prepare(
    `SELECT 1 AS ok FROM pharmacy_rich_menu_draft_bindings WHERE group_id = ? LIMIT 1`,
  ).bind(groupId).first<{ ok: number }>());
}

function pharmacyPublishIdentity(groupId: string, confirmationId: string) {
  const generation = confirmationId.replaceAll(/[^A-Za-z0-9]/gu, '').slice(0, 12).toLowerCase();
  if (!generation) throw new Error('invalid pharmacy rich-menu confirmation identity');
  return {
    generation,
    aliasId: buildAliasId(groupId, 0, generation),
    menuName: `pharmacy:${groupId.slice(0, 8)}:${generation}`,
  };
}

function toGroupInput(group: RichMenuGroupWithPages): GroupInput {
  return {
    id: group.id,
    size: group.size,
    chatBarText: group.chat_bar_text,
    isDefaultForAll: group.is_default_for_all === 1,
    selected: group.selected === 1,
    pages: group.pages.map((page) => ({
      id: page.id,
      aliasId: page.alias_id,
      orderIndex: page.order_index,
      name: page.name,
      imageR2Key: page.image_r2_key,
      imageContentType: page.image_content_type,
      lineRichMenuId: page.line_richmenu_id,
      areas: page.areas.map((area) => ({
        bounds: {
          x: area.bounds_x,
          y: area.bounds_y,
          width: area.bounds_width,
          height: area.bounds_height,
        },
        actionType: area.action_type,
        actionData: area.actionData,
      })),
    })),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function remoteRichMenuIdOf(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const value = (candidate as { richMenuId?: unknown }).richMenuId;
  return typeof value === 'string' && value ? value : null;
}

function remoteRichMenuNameOf(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const value = (candidate as { name?: unknown }).name;
  return typeof value === 'string' && value ? value : null;
}

async function readR2Bytes(object: R2ObjectBody): Promise<Uint8Array> {
  const body = object.body as unknown;
  return body instanceof Uint8Array
    ? body
    : new Uint8Array(await new Response(object.body).arrayBuffer());
}

// ----- Serialization (snake_case row → camelCase response) -----

function serializeGroup(row: RichMenuGroup) {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    chatBarText: row.chat_bar_text,
    size: row.size,
    defaultPageId: row.default_page_id,
    isDefaultForAll: row.is_default_for_all === 1,
    selected: row.selected === 1,
    status: row.status,
    generatorKey: row.generator_key,
    generatorVersion: row.generator_version,
    publishingAt: row.publishing_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeGroupWithPages(row: RichMenuGroupWithPages) {
  return {
    ...serializeGroup(row),
    pages: row.pages.map((p) => ({
      id: p.id,
      orderIndex: p.order_index,
      name: p.name,
      aliasId: p.alias_id,
      lineRichmenuId: p.line_richmenu_id,
      imageR2Key: p.image_r2_key,
      imageContentType: p.image_content_type,
      areas: p.areas.map((a) => ({
        id: a.id,
        boundsX: a.bounds_x,
        boundsY: a.bounds_y,
        boundsWidth: a.bounds_width,
        boundsHeight: a.bounds_height,
        actionType: a.action_type,
        actionData: a.actionData,
      })),
    })),
  };
}

// ----- Input parsing / validation -----

const VALID_SIZES = new Set(['large', 'compact']);
const VALID_ACTION_TYPES = new Set(['uri', 'message', 'postback', 'richmenuswitch']);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseAreaInput(raw: unknown): Parsed<RichMenuAreaInput> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'area must be object' };
  const r = raw as Record<string, unknown>;
  const fields: (keyof RichMenuAreaInput)[] = ['boundsX', 'boundsY', 'boundsWidth', 'boundsHeight'];
  for (const f of fields) {
    if (typeof r[f] !== 'number' || !Number.isFinite(r[f]) || (r[f] as number) < 0) {
      return { ok: false, error: `area.${f} must be a non-negative number` };
    }
  }
  if ((r.boundsWidth as number) <= 0 || (r.boundsHeight as number) <= 0) {
    return { ok: false, error: 'area width/height must be positive' };
  }
  if (typeof r.actionType !== 'string' || !VALID_ACTION_TYPES.has(r.actionType)) {
    return { ok: false, error: `area.actionType must be one of ${[...VALID_ACTION_TYPES].join('/')}` };
  }
  if (!r.actionData || typeof r.actionData !== 'object') {
    return { ok: false, error: 'area.actionData must be object' };
  }
  return {
    ok: true,
    value: {
      boundsX: r.boundsX as number,
      boundsY: r.boundsY as number,
      boundsWidth: r.boundsWidth as number,
      boundsHeight: r.boundsHeight as number,
      actionType: r.actionType as RichMenuAreaInput['actionType'],
      actionData: r.actionData as Record<string, unknown>,
    },
  };
}

function parsePageInput(raw: unknown): Parsed<RichMenuPageInput> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'page must be object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0) return { ok: false, error: 'page.name required' };
  if (typeof r.orderIndex !== 'number' || !Number.isInteger(r.orderIndex) || r.orderIndex < 0) {
    return { ok: false, error: 'page.orderIndex must be non-negative integer' };
  }
  if (r.id !== undefined && (typeof r.id !== 'string' || r.id.length === 0)) {
    return { ok: false, error: 'page.id must be non-empty string when present' };
  }
  if (!Array.isArray(r.areas)) return { ok: false, error: 'page.areas must be array' };
  if (r.areas.length > 20) return { ok: false, error: 'page.areas exceeds LINE limit of 20' };
  const areas: RichMenuAreaInput[] = [];
  for (const a of r.areas) {
    const parsed = parseAreaInput(a);
    if (!parsed.ok) return parsed;
    areas.push(parsed.value);
  }
  return {
    ok: true,
    value: {
      id: r.id as string | undefined,
      name: r.name,
      orderIndex: r.orderIndex,
      areas,
    },
  };
}

function parsePages(raw: unknown): Parsed<RichMenuPageInput[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'pages must be a non-empty array' };
  const pages: RichMenuPageInput[] = [];
  for (const p of raw) {
    const parsed = parsePageInput(p);
    if (!parsed.ok) return parsed;
    pages.push(parsed.value);
  }
  // order_index は 0..N-1 で重複なしを必須化。
  const orders = pages.map((p) => p.orderIndex).sort((a, b) => a - b);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i) return { ok: false, error: 'page.orderIndex must be 0..N-1 with no duplicates' };
  }
  // page.id (任意) が指定されている場合、payload 内で重複していないことを保証。
  // 重複していると PATCH の id 維持で existingMap が同じ row を 2 回返し PK 衝突する。
  const seen = new Set<string>();
  for (const p of pages) {
    if (p.id !== undefined) {
      if (seen.has(p.id)) {
        return { ok: false, error: `page.id "${p.id}" is duplicated in pages array` };
      }
      seen.add(p.id);
    }
  }
  return { ok: true, value: pages };
}

// create では input.page.id がそのまま DB 投入されない (新 UUID で再生成) ため、
// area.actionData.targetPageId が input.page.id を指していても publish 時に解決できない。
// 段階的なフローを促すため、create 時の richmenuswitch action は明示的に拒否する。
// switcher を組みたい場合は作成後 PATCH で追加する。
function rejectRichmenuswitchInCreate(pages: RichMenuPageInput[]): string | null {
  for (const p of pages) {
    for (const a of p.areas) {
      if (a.actionType === 'richmenuswitch') {
        return 'create payload may not include richmenuswitch actions; create the group first, then PATCH with switcher actions';
      }
    }
  }
  return null;
}

function parseCreateBody(raw: unknown): Parsed<CreateRichMenuGroupInput> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.accountId !== 'string' || r.accountId.length === 0) return { ok: false, error: 'accountId required' };
  if (typeof r.name !== 'string' || r.name.length === 0) return { ok: false, error: 'name required' };
  if (typeof r.chatBarText !== 'string' || r.chatBarText.length === 0 || r.chatBarText.length > 14) {
    return { ok: false, error: 'chatBarText required (1..14 chars)' };
  }
  if (typeof r.size !== 'string' || !VALID_SIZES.has(r.size)) return { ok: false, error: 'size must be large or compact' };
  if (r.selected !== undefined && typeof r.selected !== 'boolean') {
    return { ok: false, error: 'selected must be boolean' };
  }
  if (r.generatorKey !== undefined && (typeof r.generatorKey !== 'string' || r.generatorKey.length === 0 || r.generatorKey.length > 128)) {
    return { ok: false, error: 'generatorKey must be 1..128 chars when present' };
  }
  if (r.generatorVersion !== undefined && (typeof r.generatorVersion !== 'string' || r.generatorVersion.length === 0 || r.generatorVersion.length > 32)) {
    return { ok: false, error: 'generatorVersion must be 1..32 chars when present' };
  }
  const pages = parsePages(r.pages);
  if (!pages.ok) return pages;
  return {
    ok: true,
    value: {
      accountId: r.accountId,
      name: r.name,
      chatBarText: r.chatBarText,
      size: r.size as 'large' | 'compact',
      selected: r.selected === true,
      pages: pages.value,
      generatorKey: r.generatorKey as string | undefined,
      generatorVersion: r.generatorVersion as string | undefined,
    },
  };
}

function parsePatchBody(raw: unknown): Parsed<{ meta: UpdateRichMenuGroupMetaInput; pages?: RichMenuPageInput[] }> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be object' };
  const r = raw as Record<string, unknown>;
  const meta: UpdateRichMenuGroupMetaInput = {};
  if (r.name !== undefined) {
    if (typeof r.name !== 'string' || r.name.length === 0) return { ok: false, error: 'name must be non-empty string' };
    meta.name = r.name;
  }
  if (r.chatBarText !== undefined) {
    if (typeof r.chatBarText !== 'string' || r.chatBarText.length === 0 || r.chatBarText.length > 14) {
      return { ok: false, error: 'chatBarText must be 1..14 chars' };
    }
    meta.chatBarText = r.chatBarText;
  }
  if (r.isDefaultForAll !== undefined) {
    return { ok: false, error: 'isDefaultForAll must be changed through the display settings action' };
  }
  if (r.selected !== undefined) {
    if (typeof r.selected !== 'boolean') return { ok: false, error: 'selected must be boolean' };
    meta.selected = r.selected;
  }
  let pages: RichMenuPageInput[] | undefined;
  if (r.pages !== undefined) {
    const p = parsePages(r.pages);
    if (!p.ok) return p;
    pages = p.value;
  }
  return { ok: true, value: { meta, pages } };
}

// ----- Routes -----

async function groupMatchesAccountScope(
  c: Context<Env>,
  group: Pick<RichMenuGroup, 'account_id'>,
): Promise<boolean> {
  const requestedAccountId = c.req.query('accountId');
  if (requestedAccountId && requestedAccountId !== group.account_id) return false;
  // Browser admin requests are scoped by the selected account in the session UI.
  // Bearer callers (SDK/MCP) must always send accountId so an ID cannot cross tenants.
  if (!requestedAccountId && c.req.header('Authorization')) return false;
  return Boolean(await getScopedLineAccount(c, group.account_id));
}

// LINE 上の rich menu の画像をプロキシで返す (Authorization が必要なため
// admin 経由で取得して画面に流す)。
richMenuGroups.get('/api/rich-menu-groups/external/:richMenuId/image', async (c) => {
  const richMenuId = c.req.param('richMenuId');
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const account = await getScopedLineAccount(c, accountId);
  if (!account) return c.json({ success: false, error: 'line account not found' }, 404);
  const accessToken = await resolveLineAccessToken(c, accountId);
  if (!accessToken) return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);
  const res = await fetch(
    `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    return c.json(
      { success: false, error: `LINE image fetch failed: ${res.status}` },
      res.status === 404 ? 404 : 500,
    );
  }
  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('content-type') ?? 'image/png',
      'Cache-Control': 'private, max-age=300',
    },
  });
});

// LINE 上の admin 管理外 rich menu を D1 に取り込んで管理対象にする。
// 取り込み後は通常の編集画面で操作できる。
//
// query: { accountId, richMenuId }
richMenuGroups.post('/api/rich-menu-groups/import', async (c) => {
  const accountId = c.req.query('accountId');
  const richMenuId = c.req.query('richMenuId');
  if (!accountId || !richMenuId) {
    return c.json({ success: false, error: 'accountId and richMenuId query params required' }, 400);
  }
  const account = await getScopedLineAccount(c, accountId);
  if (!account) return c.json({ success: false, error: 'line account not found' }, 404);
  const accessToken = await resolveLineAccessToken(c, accountId);
  if (!accessToken) return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);

  // 既に admin 管理下にあるかチェック
  const existing = await c.env.DB
    .prepare(
      `SELECT g.id, g.name FROM rich_menu_pages p
         JOIN rich_menu_groups g ON g.id = p.group_id
        WHERE g.account_id = ? AND p.line_richmenu_id = ?`,
    )
    .bind(accountId, richMenuId)
    .first<{ id: string; name: string }>();
  if (existing) {
    return c.json(
      { success: false, error: `既に管理画面で管理中のメニューです: ${existing.name}` },
      409,
    );
  }

  const auth = `Bearer ${accessToken}`;

  // 1. LINE から rich menu 詳細を取得
  const detailRes = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
    headers: { Authorization: auth },
  });
  if (!detailRes.ok) {
    return c.json(
      { success: false, error: `LINE 詳細取得失敗: ${detailRes.status}` },
      500,
    );
  }
  type LineArea = {
    bounds: { x: number; y: number; width: number; height: number };
    action: {
      type: string;
      uri?: string;
      text?: string;
      data?: string;
      displayText?: string;
      richMenuAliasId?: string;
    };
  };
  const detail = (await detailRes.json()) as {
    name: string;
    chatBarText: string;
    selected: boolean;
    size: { width: number; height: number };
    areas: LineArea[];
  };

  // 2. size 判定
  const size: 'large' | 'compact' | null =
    detail.size.width === 2500 && detail.size.height === 1686
      ? 'large'
      : detail.size.width === 2500 && detail.size.height === 843
        ? 'compact'
        : null;
  if (!size) {
    return c.json(
      {
        success: false,
        error: `非対応サイズ ${detail.size.width}x${detail.size.height}。管理画面は 2500×1686 (Large) と 2500×843 (Compact) のみ対応しています。`,
      },
      400,
    );
  }

  // 3. action 変換 (LINE → admin)
  const convertedAreas: RichMenuAreaInput[] = [];
  for (const a of detail.areas ?? []) {
    if (a.action.type === 'uri' && typeof a.action.uri === 'string') {
      convertedAreas.push({
        boundsX: a.bounds.x, boundsY: a.bounds.y,
        boundsWidth: a.bounds.width, boundsHeight: a.bounds.height,
        actionType: 'uri',
        actionData: { uri: a.action.uri },
      });
    } else if (a.action.type === 'message' && typeof a.action.text === 'string') {
      convertedAreas.push({
        boundsX: a.bounds.x, boundsY: a.bounds.y,
        boundsWidth: a.bounds.width, boundsHeight: a.bounds.height,
        actionType: 'message',
        actionData: { text: a.action.text },
      });
    } else if (a.action.type === 'postback' && typeof a.action.data === 'string') {
      convertedAreas.push({
        boundsX: a.bounds.x, boundsY: a.bounds.y,
        boundsWidth: a.bounds.width, boundsHeight: a.bounds.height,
        actionType: 'postback',
        actionData: {
          data: a.action.data,
          ...(a.action.displayText ? { displayText: a.action.displayText } : {}),
        },
      });
    } else if (a.action.type === 'richmenuswitch') {
      return c.json(
        {
          success: false,
          error:
            'タブ切替 (richmenuswitch) を含むリッチメニューは現在インポートできません。タブ切替は管理画面で複数ページとして新規作成してください。',
        },
        400,
      );
    } else {
      return c.json(
        {
          success: false,
          error: `非対応アクション「${a.action.type}」を含むリッチメニューはインポートできません。`,
        },
        400,
      );
    }
  }

  // 4. 画像を LINE から取得して R2 に保存
  const imgRes = await fetch(
    `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
    { headers: { Authorization: auth } },
  );
  if (!imgRes.ok) {
    return c.json(
      { success: false, error: `LINE 画像取得失敗: ${imgRes.status}` },
      500,
    );
  }
  const contentType = imgRes.headers.get('content-type') ?? 'image/png';
  const ext = contentType.includes('jpeg') ? 'jpg' : 'png';
  const imageBytes = new Uint8Array(await imgRes.arrayBuffer());

  // 5. D1 に group + page + areas を作成
  const created = await createRichMenuGroup(c.env.DB, {
    accountId,
    name: detail.name,
    chatBarText: detail.chatBarText,
    size,
    selected: detail.selected,
    pages: [
      {
        name: 'ページ 1',
        orderIndex: 0,
        areas: convertedAreas,
      },
    ],
  });
  const newPage = created.pages[0];

  // 6. 画像を R2 に保存して page に紐付け
  const r2Key = `rich-menus/${accountId}/${created.id}/${newPage.id}/${Date.now()}.${ext}`;
  await c.env.IMAGES.put(r2Key, imageBytes, { httpMetadata: { contentType } });
  await setRichMenuPageImage(c.env.DB, newPage.id, r2Key, contentType);

  // 7. line_richmenu_id と status='published' を一括確定
  // 7. alias を upsert (今後の再 publish 時の安定 ID として)
  const aliasId = `lhx-${created.id.slice(0, 8)}-0`;
  try {
    await fetch(`https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, {
      method: 'DELETE',
      headers: { Authorization: auth },
    });
  } catch {
    // 無視
  }

  // 8. line_richmenu_id、alias、status='published' を一括確定
  await markRichMenuGroupPublished(c.env.DB, created.id, null, null, [
    { pageId: newPage.id, aliasId, lineRichMenuId: richMenuId },
  ]);
  await fetch('https://api.line.me/v2/bot/richmenu/alias', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId }),
  });

  return c.json({ success: true, data: { id: created.id, name: created.name } });
});

// LINE 公式アカウント上のリッチメニュー実態と admin 管理状態を突き合わせて返す。
// 一覧画面で「LINE 上には登録されているが admin 外」「現在の default」を可視化するために使う。
richMenuGroups.get('/api/rich-menu-groups/external', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const account = await getScopedLineAccount(c, accountId);
  if (!account) return c.json({ success: false, error: 'line account not found' }, 404);
  const accessToken = await resolveLineAccessToken(c, accountId);
  if (!accessToken) return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);
  const auth = `Bearer ${accessToken}`;

  type LineMenu = {
    richMenuId: string;
    name: string;
    chatBarText: string;
    selected: boolean;
    size: { width: number; height: number };
    areas: unknown[];
  };

  // 並列に問い合わせる
  const [listRes, defRes] = await Promise.all([
    fetch('https://api.line.me/v2/bot/richmenu/list', { headers: { Authorization: auth } }),
    fetch('https://api.line.me/v2/bot/user/all/richmenu', { headers: { Authorization: auth } }),
  ]);
  if (!listRes.ok) {
    return c.json(
      { success: false, error: `LINE rich menu list failed: ${listRes.status}` },
      500,
    );
  }
  const listJson = (await listRes.json()) as { richmenus?: LineMenu[] };
  const lineMenus = listJson.richmenus ?? [];

  let currentDefault: string | null = null;
  if (defRes.status === 200) {
    const j = (await defRes.json()) as { richMenuId?: string };
    currentDefault = j.richMenuId ?? null;
  }
  // 404 = default 未設定、それ以外の error は warn として無視 (画面が止まらないように)

  // admin 管理の line_richmenu_id を引いて、各 line menu に admin 情報を付与
  const adminRows = (
    await c.env.DB
      .prepare(
        `SELECT p.line_richmenu_id, p.name AS page_name,
                g.id AS group_id, g.name AS group_name, g.status AS group_status
           FROM rich_menu_pages p
           JOIN rich_menu_groups g ON g.id = p.group_id
          WHERE g.account_id = ? AND p.line_richmenu_id IS NOT NULL`,
      )
      .bind(accountId)
      .all<{
        line_richmenu_id: string;
        page_name: string;
        group_id: string;
        group_name: string;
        group_status: string;
      }>()
  ).results ?? [];
  const adminByRichMenuId = new Map(adminRows.map((r) => [r.line_richmenu_id, r]));

  return c.json({
    success: true,
    data: {
      currentDefault,
      lineMenus: lineMenus.map((m) => {
        const admin = adminByRichMenuId.get(m.richMenuId);
        return {
          richMenuId: m.richMenuId,
          name: m.name,
          chatBarText: m.chatBarText,
          selected: m.selected,
          size: m.size,
          areasCount: Array.isArray(m.areas) ? m.areas.length : 0,
          isCurrentDefault: currentDefault === m.richMenuId,
          adminManaged: !!admin,
          adminInfo: admin
            ? {
                groupId: admin.group_id,
                groupName: admin.group_name,
                pageName: admin.page_name,
                groupStatus: admin.group_status,
              }
            : null,
        };
      }),
    },
  });
});

// LINE 上の rich menu を直接削除する (admin 管理外の orphan を片付ける用)。
// admin 管理されている richMenuId を渡された場合は 409 で拒否
// (Unpublish 経由で消すべき)。
richMenuGroups.delete('/api/rich-menu-groups/external/:richMenuId', async (c) => {
  const richMenuId = c.req.param('richMenuId');
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const account = await getScopedLineAccount(c, accountId);
  if (!account) return c.json({ success: false, error: 'line account not found' }, 404);
  if ((await getPharmacyRichMenuLifecycleControl(c.env.DB, accountId)).state !== 'inactive') {
    return c.json({ success: false, error: 'pharmacy rich-menu legacy mutation disabled' }, 409);
  }
  const accessToken = await resolveLineAccessToken(c, accountId);
  if (!accessToken) return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);

  // admin 管理下の richmenu はここでは削除させない
  const adminRow = await c.env.DB
    .prepare(
      `SELECT g.id, g.name FROM rich_menu_pages p
         JOIN rich_menu_groups g ON g.id = p.group_id
        WHERE g.account_id = ? AND p.line_richmenu_id = ?`,
    )
    .bind(accountId, richMenuId)
    .first<{ id: string; name: string }>();
  if (adminRow) {
    return c.json(
      {
        success: false,
        error: `この richMenu は admin 管理下のメニュー「${adminRow.name}」に紐づいています。編集画面の「LINE から取り下げ」を使ってください。`,
      },
      409,
    );
  }

  const auth = `Bearer ${accessToken}`;
  const res = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
    method: 'DELETE',
    headers: { Authorization: auth },
  });
  if (!res.ok && res.status !== 404) {
    return c.json(
      { success: false, error: `LINE delete failed: ${res.status}` },
      500,
    );
  }
  return c.json({ success: true });
});

richMenuGroups.get('/api/rich-menu-groups', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!await getScopedLineAccount(c, accountId)) {
    return c.json({ success: false, error: 'line account not found' }, 404);
  }
  const groups = await getRichMenuGroups(c.env.DB, accountId);
  // 各 group の代表画像 (default_page_id の image_r2_key、なければ order_index=0 の page) を取得。
  // 一覧カードでサムネを出すために 1 クエリで JOIN する。
  let imageByGroupId = new Map<string, { key: string; contentType: string | null }>();
  if (groups.length > 0) {
    const placeholders = groups.map(() => '?').join(',');
    const result = await c.env.DB
      .prepare(
        `SELECT
            g.id AS group_id,
            COALESCE(
              (SELECT image_r2_key FROM rich_menu_pages WHERE id = g.default_page_id),
              (SELECT image_r2_key FROM rich_menu_pages WHERE group_id = g.id ORDER BY order_index LIMIT 1)
            ) AS image_r2_key,
            COALESCE(
              (SELECT image_content_type FROM rich_menu_pages WHERE id = g.default_page_id),
              (SELECT image_content_type FROM rich_menu_pages WHERE group_id = g.id ORDER BY order_index LIMIT 1)
            ) AS image_content_type
           FROM rich_menu_groups g
          WHERE g.id IN (${placeholders})`,
      )
      .bind(...groups.map((g) => g.id))
      .all<{ group_id: string; image_r2_key: string | null; image_content_type: string | null }>();
    for (const r of result.results ?? []) {
      if (r.image_r2_key) {
        imageByGroupId.set(r.group_id, {
          key: r.image_r2_key,
          contentType: r.image_content_type,
        });
      }
    }
  }
  return c.json({
    success: true,
    data: groups.map((g) => ({
      ...serializeGroup(g),
      thumbnailR2Key: imageByGroupId.get(g.id)?.key ?? null,
    })),
  });
});

richMenuGroups.get('/api/rich-menu-groups/:groupId', async (c) => {
  const groupId = c.req.param('groupId');
  const group = await getRichMenuGroupWithPages(c.env.DB, groupId);
  if (!group) return c.json({ success: false, error: 'not found' }, 404);
  if (!await groupMatchesAccountScope(c, group)) return c.json({ success: false, error: 'not found' }, 404);
  return c.json({ success: true, data: serializeGroupWithPages(group) });
});

richMenuGroups.post('/api/rich-menu-groups', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  const parsed = parseCreateBody(body);
  if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
  const requestedAccountId = c.req.query('accountId');
  if (requestedAccountId && requestedAccountId !== parsed.value.accountId) {
    return c.json({ success: false, error: 'accountId scope does not match request body' }, 403);
  }
  if (!await getScopedLineAccount(c, parsed.value.accountId)) {
    return c.json({ success: false, error: 'line account not found' }, 404);
  }
  const switcherRejection = rejectRichmenuswitchInCreate(parsed.value.pages);
  if (switcherRejection) return c.json({ success: false, error: switcherRejection }, 400);
  const created = await createRichMenuGroup(c.env.DB, parsed.value);
  return c.json({ success: true, data: serializeGroupWithPages(created) });
});

richMenuGroups.patch('/api/rich-menu-groups/:groupId', async (c) => {
  const groupId = c.req.param('groupId');
  const existing = await getRichMenuGroupById(c.env.DB, groupId);
  if (!existing) return c.json({ success: false, error: 'not found' }, 404);
  if (!await groupMatchesAccountScope(c, existing)) return c.json({ success: false, error: 'not found' }, 404);
  if (await isImmutablePharmacyRichMenuVersion(c.env.DB, groupId)) {
    return c.json({ success: false, error: 'immutable pharmacy rich-menu version cannot be edited' }, 409);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  const parsed = parsePatchBody(body);
  if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);

  await updateRichMenuGroupMeta(c.env.DB, groupId, parsed.value.meta);
  if (parsed.value.pages) {
    await replaceRichMenuPages(c.env.DB, groupId, parsed.value.pages);
  }
  const refreshed = await getRichMenuGroupWithPages(c.env.DB, groupId);
  if (!refreshed) return c.json({ success: false, error: 'group disappeared after update' }, 500);
  return c.json({ success: true, data: serializeGroupWithPages(refreshed) });
});

richMenuGroups.delete('/api/rich-menu-groups/:groupId', async (c) => {
  const groupId = c.req.param('groupId');
  // 公開中の group をいきなり削除すると LINE 上に richmenu / alias / default が
  // 残って復旧不能になる。デフォルトでは status='published' を 409 で reject し、
  // ?force=true (確信を持って残骸を残してもよい) でだけ進める。
  const force = c.req.query('force') === 'true';
  const existing = await getRichMenuGroupById(c.env.DB, groupId);
  if (!existing) return c.json({ success: false, error: 'not found' }, 404);
  if (!await groupMatchesAccountScope(c, existing)) return c.json({ success: false, error: 'not found' }, 404);
  if (await isImmutablePharmacyRichMenuVersion(c.env.DB, groupId)) {
    return c.json({
      success: false,
      error: 'saved pharmacy rich-menu versions must use the protected version delete endpoint',
    }, 409);
  }
  if (existing.status === 'published' && !force) {
    return c.json(
      {
        success: false,
        error: 'group is published. Unpublish (POST /unpublish) first, or pass ?force=true to delete D1 row anyway (LINE 側に残骸が残る点に注意)',
      },
      409,
    );
  }
  const ok = await deleteRichMenuGroup(c.env.DB, groupId);
  if (!ok) return c.json({ success: false, error: 'not found' }, 404);
  return c.json({ success: true });
});

// ----- Image upload -----

richMenuGroups.post('/api/rich-menu-groups/:groupId/pages/:pageId/image', async (c) => {
  const { groupId, pageId } = c.req.param();
  const contentType = c.req.header('content-type') ?? '';
  if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
    return c.json({ success: false, error: 'content-type must be image/png or image/jpeg' }, 400);
  }

  const exists = await pageBelongsToGroup(c.env.DB, groupId, pageId);
  if (!exists) return c.json({ success: false, error: 'page not found in group' }, 404);

  const buf = new Uint8Array(await c.req.arrayBuffer());
  const validation = validateRichMenuImage(buf, buf.byteLength);
  if (!validation.ok) return c.json({ success: false, error: validation.error }, 400);

  const group = await getRichMenuGroupById(c.env.DB, groupId);
  if (!group) return c.json({ success: false, error: 'group not found' }, 404);
  if (!await groupMatchesAccountScope(c, group)) return c.json({ success: false, error: 'group not found' }, 404);
  if (await isImmutablePharmacyRichMenuVersion(c.env.DB, groupId)) {
    return c.json({ success: false, error: 'immutable pharmacy rich-menu image cannot be replaced' }, 409);
  }

  // group.size と画像サイズが一致してないと publish 時に LINE API でコンテンツアップロードが
  // 弾かれる (richmenu の宣言サイズと content の dimensions は一致必須)。事前に拒否する。
  if (validation.size !== group.size) {
    return c.json(
      {
        success: false,
        error: `image size '${validation.size}' does not match group size '${group.size}'`,
      },
      400,
    );
  }

  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  const key = `rich-menus/${group.account_id}/${groupId}/${pageId}/${Date.now()}.${ext}`;
  await c.env.IMAGES.put(key, buf, { httpMetadata: { contentType } });
  await setRichMenuPageImage(c.env.DB, pageId, key, contentType);

  return c.json({
    success: true,
    data: { imageR2Key: key, imageContentType: contentType, size: validation.size },
  });
});

// 画像取得 — エディタからの <img src="..."> 用。Authorization ヘッダは付かないが、
// 管理画面の Worker セッション cookie を auth middleware が検証する。
richMenuGroups.get('/api/rich-menu-images/:key{.+}', async (c) => {
  let key: string;
  try {
    key = decodeURIComponent(c.req.param('key'));
  } catch {
    return c.notFound();
  }
  const accountId = /^rich-menus\/([^/]+)\//.exec(key)?.[1];
  if (!accountId) return c.notFound();
  if (!await getScopedLineAccount(c, accountId)) return c.notFound();

  // R2 keys are not an authority: serve only an image currently linked to a
  // rich-menu page in this account. This also prevents same-account orphan
  // objects from becoming an unintended private file store.
  const linked = await c.env.DB.prepare(
    `SELECT 1 AS ok
       FROM rich_menu_pages AS page
       INNER JOIN rich_menu_groups AS group_row ON group_row.id = page.group_id
      WHERE group_row.account_id = ? AND page.image_r2_key = ?
      LIMIT 1`,
  ).bind(accountId, key).first<{ ok: number }>();
  if (!linked) return c.notFound();

  const obj = await c.env.IMAGES.get(key);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=60',
    },
  });
});

// ----- Publish -----

function createLineClient(channelAccessToken: string): LineRichMenuClient {
  const auth = `Bearer ${channelAccessToken}`;
  return {
    async createRichMenu(payload) {
      const res = await fetch('https://api.line.me/v2/bot/richmenu', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`LINE createRichMenu failed: ${res.status}`);
      return res.json() as Promise<{ richMenuId: string }>;
    },
    async getRichMenuList() {
      const res = await fetch('https://api.line.me/v2/bot/richmenu/list', {
        method: 'GET', headers: { Authorization: auth },
      });
      if (!res.ok) throw new Error(`LINE getRichMenuList failed: ${res.status}`);
      const body = await res.json() as { richmenus?: unknown };
      if (!Array.isArray(body.richmenus)) throw new Error('LINE getRichMenuList returned invalid data');
      return body.richmenus;
    },
    async getRichMenuImage(richMenuId) {
      const res = await fetch(
        `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`,
        { method: 'GET', headers: { Authorization: auth } },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`LINE getRichMenuImage failed: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async getRichMenuAlias(aliasId) {
      const res = await fetch(
        `https://api.line.me/v2/bot/richmenu/alias/${encodeURIComponent(aliasId)}`,
        { method: 'GET', headers: { Authorization: auth } },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`LINE getRichMenuAlias failed: ${res.status}`);
      const body = await res.json() as { richMenuId?: unknown };
      if (typeof body.richMenuId !== 'string' || !body.richMenuId) {
        throw new Error('LINE getRichMenuAlias returned invalid data');
      }
      return body.richMenuId;
    },
    async uploadRichMenuImage(richMenuId, image, contentType) {
      const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': contentType },
        body: image,
      });
      if (!res.ok) throw new Error(`LINE uploadRichMenuImage failed: ${res.status}`);
    },
    async deleteRichMenuAlias(aliasId) {
      const res = await fetch(`https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`LINE deleteRichMenuAlias failed: ${res.status}`);
      }
    },
    async createRichMenuAlias(aliasId, richMenuId) {
      const res = await fetch('https://api.line.me/v2/bot/richmenu/alias', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId }),
      });
      if (!res.ok) throw new Error(`LINE createRichMenuAlias failed: ${res.status}`);
    },
    async deleteRichMenu(richMenuId) {
      const res = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`LINE deleteRichMenu failed: ${res.status}`);
      }
    },
    async setDefaultRichMenu(richMenuId) {
      const res = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
        method: 'POST',
        headers: { Authorization: auth },
      });
      if (!res.ok) throw new Error(`LINE setDefaultRichMenu failed: ${res.status}`);
    },
    async clearDefaultRichMenu() {
      // 既存 default を解除。default 未設定でも LINE は 200 を返すので冪等。
      const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`LINE clearDefaultRichMenu failed: ${res.status}`);
      }
    },
    async getCurrentDefaultRichMenuId() {
      const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        method: 'GET',
        headers: { Authorization: auth },
      });
      // 設定なしは 404 が返る — null として返す。
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`LINE getCurrentDefaultRichMenu failed: ${res.status}`);
      }
      const body = (await res.json()) as { richMenuId?: string };
      return body.richMenuId ?? null;
    },
    async linkRichMenuBulk(richMenuId, userIds) {
      // POST /v2/bot/richmenu/bulk/link  — 1 リクエスト最大 500 ユーザー
      const res = await fetch('https://api.line.me/v2/bot/richmenu/bulk/link', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuId, userIds }),
      });
      if (!res.ok) {
        throw new Error(`LINE linkRichMenuBulk failed: ${res.status}`);
      }
    },
  };
}

async function recordRichMenuDefaultProjection(
  db: D1Database,
  accountId: string,
  groupId: string,
  lockGroupId: string,
  lockToken: string,
): Promise<void> {
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE rich_menu_groups SET is_default_for_all = 0, updated_at = ?
        WHERE account_id = ? AND id != ?
          AND EXISTS (
            SELECT 1 FROM rich_menu_groups AS locked
             WHERE locked.id = ? AND locked.publishing_at = ?
          )`,
    ).bind(now, accountId, groupId, lockGroupId, lockToken),
    db.prepare(
      `UPDATE rich_menu_groups SET is_default_for_all = 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND EXISTS (
          SELECT 1 FROM rich_menu_groups AS locked
           WHERE locked.id = ? AND locked.publishing_at = ?
        )`,
    ).bind(now, groupId, accountId, lockGroupId, lockToken),
  ]);
  if ((results.at(-1)?.meta?.changes ?? 0) !== 1) {
    throw new Error('rich-menu account lock lost');
  }
}

richMenuGroups.post('/api/rich-menu-groups/:groupId/publish', async (c) => {
  const groupId = c.req.param('groupId');
  const group = await getRichMenuGroupWithPages(c.env.DB, groupId);
  if (!group) return c.json({ success: false, error: 'not found' }, 404);
  if (!await groupMatchesAccountScope(c, group)) return c.json({ success: false, error: 'not found' }, 404);
  const immutablePharmacyVersion = await isImmutablePharmacyRichMenuVersion(c.env.DB, groupId);
  const lifecycle = await getPharmacyRichMenuLifecycleControl(c.env.DB, group.account_id);
  if ((immutablePharmacyVersion && lifecycle.state !== 'active') ||
      (!immutablePharmacyVersion && lifecycle.state !== 'inactive')) {
    return c.json({ success: false, error: 'pharmacy rich-menu lifecycle mutation disabled' }, 409);
  }
  let pharmacyEvidenceDigest: string | null = null;
  let pharmacyConfirmationId: string | null = null;
  let publishRequest: { dryRun?: unknown; confirmationToken?: unknown } = {};
  if (immutablePharmacyVersion) {
    try {
      publishRequest = await c.req.json();
    } catch {
      // A bound version always requires an explicit dry-run or confirmed execution body.
    }
    if (publishRequest.dryRun !== true &&
        (publishRequest.dryRun !== false || typeof publishRequest.confirmationToken !== 'string')) {
      return c.json({
        success: false,
        error: 'valid confirmationToken from pharmacy publish dry-run is required',
      }, 428);
    }
  }

  const account = await getScopedLineAccount(c, group.account_id);
  if (!account) return c.json({ success: false, error: 'line account not found' }, 500);
  if (immutablePharmacyVersion) {
    const tenantId = c.get('tenantId');
    const secret = c.env.LINE_CREDENTIAL_KEY_V1;
    if (!tenantId || !secret || !account.liff_id) {
      return c.json({ success: false, error: 'pharmacy publish confirmation unavailable' }, 503);
    }
    const readiness = await getPharmacyRichMenuPublishReadiness({
      db: c.env.DB,
      images: c.env.IMAGES,
      accountId: group.account_id,
      liffId: account.liff_id,
      group,
    });
    if (readiness.status !== 'READY' || !readiness.evidenceDigest) {
      return c.json({ success: false, error: 'pharmacy rich-menu version is not ready', data: readiness }, 409);
    }
    pharmacyEvidenceDigest = readiness.evidenceDigest;
    if (publishRequest.dryRun === true) {
      const expiresAt = Date.now() + PHARMACY_RICH_MENU_PUBLISH_CONFIRMATION_TTL_MS;
      const confirmationToken = await signPharmacyRichMenuPublishConfirmation(secret, {
        tenantId,
        accountId: group.account_id,
        groupId,
        confirmationId: crypto.randomUUID(),
        evidenceDigest: readiness.evidenceDigest,
        expiresAt,
      });
      return c.json({
        success: true,
        data: { dryRun: true, confirmationToken, expiresAt, readiness },
      });
    }
    const confirmation = await verifyPharmacyRichMenuPublishConfirmation(
      secret, String(publishRequest.confirmationToken),
    );
    if (!confirmation) {
      return c.json({
        success: false,
        error: 'valid confirmationToken from pharmacy publish dry-run is required',
      }, 428);
    }
    if (confirmation.tenantId !== tenantId || confirmation.accountId !== group.account_id ||
        confirmation.groupId !== groupId || confirmation.evidenceDigest !== readiness.evidenceDigest) {
      return c.json({ success: false, error: 'pharmacy rich-menu changed after confirmation' }, 409);
    }
    pharmacyConfirmationId = confirmation.confirmationId;
  }
  const accessToken = await resolveLineAccessToken(c, group.account_id);
  if (!accessToken) return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);

  const accountLock = await acquireRichMenuAccountLock(c.env.DB, group.account_id);
  if (!accountLock) return c.json({ success: false, error: 'failed to acquire publish lock' }, 409);

  let pharmacyOperationId: string | null = null;
  let pharmacyPublishIdentityValue: ReturnType<typeof pharmacyPublishIdentity> | null = null;
  try {
    if (immutablePharmacyVersion) {
      const unresolved = await getUnresolvedPharmacyRichMenuOperation(c.env.DB, group.account_id);
      if (unresolved) {
        return c.json({
          success: false,
          error: 'previous pharmacy rich-menu operation requires reconciliation',
          data: { operationId: unresolved.id, status: unresolved.status },
        }, 409);
      }
      if (!pharmacyEvidenceDigest || !pharmacyConfirmationId || group.pages.length !== 1) {
        return c.json({ success: false, error: 'invalid pharmacy rich-menu publish evidence' }, 409);
      }
      pharmacyPublishIdentityValue = pharmacyPublishIdentity(groupId, pharmacyConfirmationId);
      const operation = await beginPharmacyRichMenuOperation(c.env.DB, {
        lineAccountId: group.account_id,
        groupId,
        confirmationId: pharmacyConfirmationId,
        kind: 'publish',
        evidenceDigest: pharmacyEvidenceDigest,
        expectedDefaultMenuId: null,
        publishAliasId: pharmacyPublishIdentityValue.aliasId,
        publishMenuName: pharmacyPublishIdentityValue.menuName,
      });
      pharmacyOperationId = operation.id;
    }
    const line = createLineClient(accessToken);
    const r2Adapter: R2Like = {
      async get(key) {
        const obj = await c.env.IMAGES.get(key);
        if (!obj) return null;
        return { body: obj.body as ReadableStream };
      },
    };
    const groupInput = toGroupInput(group);
    const result = await publishRichMenuGroup(
      groupInput,
      line,
      r2Adapter,
      pharmacyOperationId && pharmacyPublishIdentityValue
        ? {
          generation: pharmacyPublishIdentityValue.generation,
          remoteMenuName: pharmacyPublishIdentityValue.menuName,
          preserveRemoteOnError: true,
          onProgress: async (phase, _pageId, remoteRichMenuId) => {
            const expectedPhase = phase === 'remote_created'
              ? 'intent_recorded'
              : phase === 'image_uploaded' ? 'remote_created' : 'image_uploaded';
            await advancePharmacyRichMenuPublishPhase(c.env.DB, {
              lineAccountId: group.account_id,
              operationId: pharmacyOperationId!,
              expectedPhase,
              phase,
              ...(phase === 'remote_created' ? { remoteRichMenuId } : {}),
            });
          },
        }
        : undefined,
    );
    await markRichMenuGroupPublished(
      c.env.DB,
      groupId,
      accountLock.groupId,
      accountLock.token,
      result.pages.map((page) => ({
        pageId: page.pageId,
        aliasId: page.aliasId,
        lineRichMenuId: page.newRichMenuId,
      })),
    );
    if (pharmacyOperationId) {
      await advancePharmacyRichMenuPublishPhase(c.env.DB, {
        lineAccountId: group.account_id,
        operationId: pharmacyOperationId,
        expectedPhase: 'alias_created',
        phase: 'committed',
      });
      await finishPharmacyRichMenuOperation(c.env.DB, {
        lineAccountId: group.account_id,
        operationId: pharmacyOperationId,
        expectedStatus: 'running',
        status: 'succeeded',
      });
    }
    return c.json({ success: true, data: result });
  } catch (e) {
    if (pharmacyOperationId) {
      try {
        await finishPharmacyRichMenuOperation(c.env.DB, {
          lineAccountId: group.account_id,
          operationId: pharmacyOperationId,
          expectedStatus: 'running',
          status: 'unknown',
          reasonCode: 'LINE_RESULT_UNKNOWN',
        });
      } catch {
        // A concurrent reconciliation or succeeded terminal row remains authoritative.
      }
      return c.json({
        success: false,
        error: 'pharmacy rich-menu publish result is unknown; reconcile before retry',
        data: { operationId: pharmacyOperationId, status: 'unknown' },
      }, 500);
    }
    if (String(e).includes('pharmacy rich-menu confirmation already used')) {
      return c.json({
        success: false,
        error: 'pharmacy rich-menu confirmation already used',
      }, 409);
    }
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: message }, 500);
  } finally {
    await releasePublishLock(c.env.DB, accountLock.groupId, accountLock.token);
  }
});

richMenuGroups.post('/api/rich-menu-groups/operations/:operationId/reconcile', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const operation = await getPharmacyRichMenuOperation(
    c.env.DB, accountId, c.req.param('operationId'),
  );
  if (!operation) return c.json({ success: false, error: 'not found' }, 404);
  const group = await getRichMenuGroupWithPages(c.env.DB, operation.groupId);
  if (!group || group.account_id !== accountId || !await groupMatchesAccountScope(c, group)) {
    return c.json({ success: false, error: 'not found' }, 404);
  }
  if (operation.status === 'succeeded' || operation.status === 'failed') {
    return c.json({ success: true, data: { status: operation.status } });
  }
  if (operation.kind === 'publish') {
    if (!operation.publishPhase || !operation.publishAliasId || !operation.publishMenuName ||
        group.pages.length !== 1 || !group.pages[0].image_r2_key) {
      return c.json({
        success: false,
        error: 'publish operation evidence is incomplete',
        data: { status: operation.status, reasonCode: 'PUBLISH_EVIDENCE_INCOMPLETE' },
      }, 409);
    }
    const account = await getScopedLineAccount(c, accountId);
    if (!account?.liff_id) return c.json({ success: false, error: 'line account not found' }, 404);
    const readiness = await getPharmacyRichMenuPublishReadiness({
      db: c.env.DB,
      images: c.env.IMAGES,
      accountId,
      liffId: account.liff_id,
      group,
      requiredStatus: group.status,
    });
    if (readiness.status !== 'READY' || readiness.evidenceDigest !== operation.evidenceDigest) {
      return c.json({
        success: false,
        error: 'publish evidence changed after the original confirmation',
        data: { status: operation.status, reasonCode: 'PUBLISH_EVIDENCE_CHANGED' },
      }, 409);
    }
    const accessToken = await resolveLineAccessToken(c, accountId);
    if (!accessToken) return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);
    const accountLock = await acquireRichMenuAccountLock(c.env.DB, accountId);
    if (!accountLock) {
      return c.json({ success: false, error: 'another rich-menu operation is running' }, 409);
    }
    try {
      const line = createLineClient(accessToken);
      const groupInput = toGroupInput(group);
      const expectedPayload = buildLineRichMenuPayload(
        groupInput, groupInput.pages[0], operation.publishMenuName,
      );
      const remoteMenus = await line.getRichMenuList();
      const namedCandidates = remoteMenus.filter((candidate) =>
        remoteRichMenuNameOf(candidate) === operation.publishMenuName);
      const exactCandidates = namedCandidates.filter((candidate) =>
        matchesLineRichMenuPayload(candidate, expectedPayload));
      let remoteRichMenuId = operation.remoteRichMenuId;
      if (remoteRichMenuId) {
        const remote = remoteMenus.find((candidate) => remoteRichMenuIdOf(candidate) === remoteRichMenuId);
        if (!remote || !matchesLineRichMenuPayload(remote, expectedPayload)) {
          return c.json({
            success: false,
            error: 'remote publish candidate differs from confirmed evidence',
            data: { status: operation.status, reasonCode: 'PUBLISH_REMOTE_DIVERGED' },
          }, 409);
        }
      } else {
        if (namedCandidates.length !== 1 || exactCandidates.length !== 1 ||
            !remoteRichMenuIdOf(exactCandidates[0])) {
          const reasonCode = namedCandidates.length === 0
            ? 'PUBLISH_CREATE_MISSING' : namedCandidates.length === 1
              ? 'PUBLISH_REMOTE_DIVERGED' : 'PUBLISH_REMOTE_AMBIGUOUS';
          return c.json({
            success: false,
            error: 'remote publish candidate cannot be identified safely',
            data: {
              status: operation.status,
              reasonCode,
              publishPhase: operation.publishPhase,
              ...(reasonCode === 'PUBLISH_CREATE_MISSING' ? { resumableStage: 'create' } : {}),
            },
          }, 409);
        }
        remoteRichMenuId = remoteRichMenuIdOf(exactCandidates[0]);
      }
      if (!remoteRichMenuId) throw new Error('remote publish candidate has no id');

      let publishPhase = operation.publishPhase;
      if (publishPhase === 'intent_recorded') {
        await advancePharmacyRichMenuPublishPhase(c.env.DB, {
          lineAccountId: accountId,
          operationId: operation.id,
          expectedPhase: 'intent_recorded',
          phase: 'remote_created',
          remoteRichMenuId,
        });
        publishPhase = 'remote_created';
      }
      if (publishPhase === 'remote_created') {
        const remoteImage = await line.getRichMenuImage(remoteRichMenuId);
        if (!remoteImage) {
          return c.json({
            success: false,
            error: 'remote rich-menu image is missing',
            data: {
              status: operation.status,
              reasonCode: 'PUBLISH_IMAGE_MISSING',
              publishPhase,
              resumableStage: 'image_upload',
            },
          }, 409);
        }
        const saved = await c.env.IMAGES.get(group.pages[0].image_r2_key!);
        if (!saved) throw new Error('saved rich-menu image is missing');
        const savedImage = await readR2Bytes(saved);
        if (!sameBytes(remoteImage, savedImage)) {
          return c.json({
            success: false,
            error: 'remote rich-menu image differs from confirmed evidence',
            data: { status: operation.status, reasonCode: 'PUBLISH_IMAGE_DIVERGED' },
          }, 409);
        }
        await advancePharmacyRichMenuPublishPhase(c.env.DB, {
          lineAccountId: accountId,
          operationId: operation.id,
          expectedPhase: 'remote_created',
          phase: 'image_uploaded',
        });
        publishPhase = 'image_uploaded';
      }
      if (publishPhase === 'image_uploaded') {
        const aliasTarget = await line.getRichMenuAlias(operation.publishAliasId);
        if (!aliasTarget) {
          return c.json({
            success: false,
            error: 'remote rich-menu alias is missing',
            data: {
              status: operation.status,
              reasonCode: 'PUBLISH_ALIAS_MISSING',
              publishPhase,
              resumableStage: 'alias_create',
            },
          }, 409);
        }
        if (aliasTarget !== remoteRichMenuId) {
          return c.json({
            success: false,
            error: 'remote rich-menu alias points to another menu',
            data: { status: operation.status, reasonCode: 'PUBLISH_ALIAS_DIVERGED' },
          }, 409);
        }
        await advancePharmacyRichMenuPublishPhase(c.env.DB, {
          lineAccountId: accountId,
          operationId: operation.id,
          expectedPhase: 'image_uploaded',
          phase: 'alias_created',
        });
        publishPhase = 'alias_created';
      }
      if (publishPhase === 'alias_created') {
        await markRichMenuGroupPublished(
          c.env.DB,
          group.id,
          accountLock.groupId,
          accountLock.token,
          [{
            pageId: group.pages[0].id,
            aliasId: operation.publishAliasId,
            lineRichMenuId: remoteRichMenuId,
          }],
        );
        await advancePharmacyRichMenuPublishPhase(c.env.DB, {
          lineAccountId: accountId,
          operationId: operation.id,
          expectedPhase: 'alias_created',
          phase: 'committed',
        });
        publishPhase = 'committed';
      }
      await finishPharmacyRichMenuOperation(c.env.DB, {
        lineAccountId: accountId,
        operationId: operation.id,
        expectedStatus: operation.status,
        status: 'succeeded',
      });
      return c.json({ success: true, data: { status: 'succeeded', publishPhase } });
    } catch {
      return c.json({
        success: false,
        error: 'publish reconciliation failed without changing LINE',
        data: { status: operation.status, publishPhase: operation.publishPhase },
      }, 500);
    } finally {
      await releasePublishLock(c.env.DB, accountLock.groupId, accountLock.token);
    }
  }
  if (!operation.remoteRichMenuId || !operation.defaultReadAt) {
    return c.json({
      success: false,
      error: 'default operation evidence is incomplete',
      data: { status: operation.status, reasonCode: 'DEFAULT_EVIDENCE_INCOMPLETE' },
    }, 409);
  }
  const account = await getScopedLineAccount(c, accountId);
  if (!account) return c.json({ success: false, error: 'line account not found' }, 404);
  const accessToken = await resolveLineAccessToken(c, accountId);
  if (!accessToken) return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);
  const accountLock = await acquireRichMenuAccountLock(c.env.DB, accountId);
  if (!accountLock) {
    return c.json({ success: false, error: 'another rich-menu operation is running' }, 409);
  }
  try {
    const currentDefault = await createLineClient(accessToken).getCurrentDefaultRichMenuId();
    if (currentDefault === operation.remoteRichMenuId) {
      await recordRichMenuDefaultProjection(
        c.env.DB, accountId, group.id, accountLock.groupId, accountLock.token,
      );
      await finishPharmacyRichMenuOperation(c.env.DB, {
        lineAccountId: accountId,
        operationId: operation.id,
        expectedStatus: operation.status,
        status: 'succeeded',
        verifiedDefaultMenuId: operation.remoteRichMenuId,
      });
      return c.json({ success: true, data: { status: 'succeeded' } });
    }
    if (currentDefault === operation.expectedDefaultMenuId) {
      await finishPharmacyRichMenuOperation(c.env.DB, {
        lineAccountId: accountId,
        operationId: operation.id,
        expectedStatus: operation.status,
        status: 'failed',
        reasonCode: 'REMOTE_DEFAULT_UNCHANGED',
      });
      return c.json({ success: true, data: { status: 'failed' } });
    }
    return c.json({
      success: false,
      error: 'remote default diverged; manual review required',
      data: { status: operation.status, reasonCode: 'REMOTE_DEFAULT_DIVERGED' },
    }, 409);
  } catch {
    return c.json({
      success: false,
      error: 'rich-menu reconciliation failed without changing LINE',
      data: { status: operation.status },
    }, 500);
  } finally {
    await releasePublishLock(c.env.DB, accountLock.groupId, accountLock.token);
  }
});

richMenuGroups.post('/api/rich-menu-groups/operations/:operationId/resume', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  let body: { dryRun?: unknown; confirmationToken?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'valid JSON body required' }, 400);
  }
  if (body.dryRun !== true &&
      (body.dryRun !== false || typeof body.confirmationToken !== 'string')) {
    return c.json({ success: false, error: 'dryRun or confirmationToken is required' }, 400);
  }
  const operation = await getPharmacyRichMenuOperation(
    c.env.DB, accountId, c.req.param('operationId'),
  );
  if (!operation) return c.json({ success: false, error: 'not found' }, 404);
  const group = await getRichMenuGroupWithPages(c.env.DB, operation.groupId);
  if (!group || group.account_id !== accountId || !await groupMatchesAccountScope(c, group)) {
    return c.json({ success: false, error: 'not found' }, 404);
  }
  if ((await getPharmacyRichMenuLifecycleControl(c.env.DB, accountId)).state !== 'active') {
    return c.json({ success: false, error: 'pharmacy rich-menu lifecycle mutation disabled' }, 409);
  }
  if (operation.kind !== 'publish' || operation.status === 'succeeded' || operation.status === 'failed' ||
      !operation.publishPhase || operation.publishPhase === 'committed' ||
      !operation.publishAliasId || !operation.publishMenuName || group.pages.length !== 1 ||
      !group.pages[0].image_r2_key) {
    return c.json({ success: false, error: 'publish operation is not resumable' }, 409);
  }
  const account = await getScopedLineAccount(c, accountId);
  const tenantId = c.get('tenantId');
  const secret = c.env.LINE_CREDENTIAL_KEY_V1;
  if (!account?.liff_id || !tenantId || !secret) {
    return c.json({ success: false, error: 'publish resume confirmation unavailable' }, 503);
  }
  const readiness = await getPharmacyRichMenuPublishReadiness({
    db: c.env.DB,
    images: c.env.IMAGES,
    accountId,
    liffId: account.liff_id,
    group,
    requiredStatus: group.status,
  });
  if (readiness.status !== 'READY' || readiness.evidenceDigest !== operation.evidenceDigest) {
    return c.json({
      success: false,
      error: 'publish evidence changed after the original confirmation',
      data: { status: operation.status, reasonCode: 'PUBLISH_EVIDENCE_CHANGED' },
    }, 409);
  }
  const nextStage = operation.publishPhase === 'intent_recorded'
    ? 'create' : operation.publishPhase === 'remote_created' ? 'image_upload' :
      operation.publishPhase === 'image_uploaded' ? 'alias_create' : 'local_commit';
  if (operation.publishPhase === 'alias_created') {
    return c.json({
      success: false,
      error: 'LINE stages are complete; reconcile local evidence',
      data: { status: operation.status, publishPhase: operation.publishPhase, nextStage },
    }, 409);
  }
  if (body.dryRun === true) {
    const expiresAt = Date.now() + PHARMACY_RICH_MENU_PUBLISH_CONFIRMATION_TTL_MS;
    const confirmationToken = await signPharmacyRichMenuResumeConfirmation(secret, {
      tenantId,
      accountId,
      groupId: group.id,
      operationId: operation.id,
      confirmationId: crypto.randomUUID(),
      publishPhase: operation.publishPhase,
      evidenceDigest: operation.evidenceDigest,
      expiresAt,
    });
    return c.json({
      success: true,
      data: { dryRun: true, confirmationToken, expiresAt, publishPhase: operation.publishPhase, nextStage },
    });
  }
  const confirmation = await verifyPharmacyRichMenuResumeConfirmation(
    secret, String(body.confirmationToken),
  );
  if (!confirmation) {
    return c.json({ success: false, error: 'valid publish resume confirmation is required' }, 428);
  }
  if (confirmation.tenantId !== tenantId || confirmation.accountId !== accountId ||
      confirmation.groupId !== group.id || confirmation.operationId !== operation.id ||
      confirmation.publishPhase !== operation.publishPhase ||
      confirmation.evidenceDigest !== operation.evidenceDigest) {
    return c.json({ success: false, error: 'publish operation changed after resume confirmation' }, 409);
  }
  const accessToken = await resolveLineAccessToken(c, accountId);
  if (!accessToken) return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);
  const accountLock = await acquireRichMenuAccountLock(c.env.DB, accountId);
  if (!accountLock) {
    return c.json({ success: false, error: 'another rich-menu operation is running' }, 409);
  }
  try {
    await consumePharmacyRichMenuResumeConfirmation(c.env.DB, {
      lineAccountId: accountId,
      operationId: operation.id,
      confirmationId: confirmation.confirmationId,
      publishPhase: operation.publishPhase,
      evidenceDigest: operation.evidenceDigest,
    });
    const line = createLineClient(accessToken);
    const groupInput = toGroupInput(group);
    const expectedPayload = buildLineRichMenuPayload(
      groupInput, groupInput.pages[0], operation.publishMenuName,
    );
    const remoteMenus = await line.getRichMenuList();
    const namedCandidates = remoteMenus.filter((candidate) =>
      remoteRichMenuNameOf(candidate) === operation.publishMenuName);
    const exactCandidates = namedCandidates.filter((candidate) =>
      matchesLineRichMenuPayload(candidate, expectedPayload));

    if (operation.publishPhase === 'intent_recorded') {
      if (namedCandidates.length > 1 || (namedCandidates.length === 1 && exactCandidates.length !== 1)) {
        return c.json({ success: false, error: 'remote publish candidate differs or is ambiguous' }, 409);
      }
      const existingRemoteId = remoteRichMenuIdOf(exactCandidates[0]);
      const created = existingRemoteId ? null : await line.createRichMenu(expectedPayload);
      const remoteId = existingRemoteId ?? created?.richMenuId;
      if (!remoteId) throw new Error('LINE createRichMenu returned no id');
      await advancePharmacyRichMenuPublishPhase(c.env.DB, {
        lineAccountId: accountId,
        operationId: operation.id,
        expectedPhase: 'intent_recorded',
        phase: 'remote_created',
        remoteRichMenuId: remoteId,
      });
      return c.json({ success: true, data: { status: operation.status, publishPhase: 'remote_created' } });
    }

    const remoteId = operation.remoteRichMenuId;
    const remote = remoteMenus.find((candidate) => remoteRichMenuIdOf(candidate) === remoteId);
    if (!remoteId || !remote || !matchesLineRichMenuPayload(remote, expectedPayload)) {
      return c.json({ success: false, error: 'remote publish candidate differs from confirmed evidence' }, 409);
    }
    if (operation.publishPhase === 'remote_created') {
      const saved = await c.env.IMAGES.get(group.pages[0].image_r2_key!);
      if (!saved) throw new Error('saved rich-menu image is missing');
      const savedImage = await readR2Bytes(saved);
      const currentImage = await line.getRichMenuImage(remoteId);
      if (currentImage && !sameBytes(currentImage, savedImage)) {
        return c.json({ success: false, error: 'remote rich-menu image differs from confirmed evidence' }, 409);
      }
      if (!currentImage) await line.uploadRichMenuImage(remoteId, savedImage, 'image/jpeg');
      const verifiedImage = await line.getRichMenuImage(remoteId);
      if (!verifiedImage || !sameBytes(verifiedImage, savedImage)) {
        throw new Error('LINE rich-menu image read-back mismatch');
      }
      await advancePharmacyRichMenuPublishPhase(c.env.DB, {
        lineAccountId: accountId,
        operationId: operation.id,
        expectedPhase: 'remote_created',
        phase: 'image_uploaded',
      });
      return c.json({ success: true, data: { status: operation.status, publishPhase: 'image_uploaded' } });
    }

    const currentAliasTarget = await line.getRichMenuAlias(operation.publishAliasId);
    if (currentAliasTarget && currentAliasTarget !== remoteId) {
      return c.json({ success: false, error: 'remote rich-menu alias points to another menu' }, 409);
    }
    if (!currentAliasTarget) await line.createRichMenuAlias(operation.publishAliasId, remoteId);
    if (await line.getRichMenuAlias(operation.publishAliasId) !== remoteId) {
      throw new Error('LINE rich-menu alias read-back mismatch');
    }
    await advancePharmacyRichMenuPublishPhase(c.env.DB, {
      lineAccountId: accountId,
      operationId: operation.id,
      expectedPhase: 'image_uploaded',
      phase: 'alias_created',
    });
    return c.json({ success: true, data: { status: operation.status, publishPhase: 'alias_created' } });
  } catch (error) {
    if (String(error).includes('resume confirmation already used')) {
      return c.json({ success: false, error: 'publish resume confirmation already used' }, 409);
    }
    return c.json({
      success: false,
      error: 'publish resume result is unknown; reconcile before another resume',
      data: { operationId: operation.id, status: operation.status, publishPhase: operation.publishPhase },
    }, 500);
  } finally {
    await releasePublishLock(c.env.DB, accountLock.groupId, accountLock.token);
  }
});

// ----- Unpublish -----

// LINE 上の alias / richmenu / default を全削除して draft に戻す。
// 削除フローや、別 group を default にしたい時に使う。idempotent (既に消えてる
// alias / richmenu は 404 を許容)。
richMenuGroups.post('/api/rich-menu-groups/:groupId/unpublish', async (c) => {
  const groupId = c.req.param('groupId');
  const group = await getRichMenuGroupWithPages(c.env.DB, groupId);
  if (!group) return c.json({ success: false, error: 'not found' }, 404);
  if (!await groupMatchesAccountScope(c, group)) return c.json({ success: false, error: 'not found' }, 404);
  const immutablePharmacyVersion = await isImmutablePharmacyRichMenuVersion(c.env.DB, groupId);
  const lifecycle = await getPharmacyRichMenuLifecycleControl(c.env.DB, group.account_id);
  if (immutablePharmacyVersion || lifecycle.state !== 'inactive') {
    return c.json({ success: false, error: 'pharmacy rich-menu legacy mutation disabled' }, 409);
  }

  const accountLock = await acquireRichMenuAccountLock(c.env.DB, group.account_id);
  if (!accountLock) return c.json({ success: false, error: 'failed to acquire publish lock' }, 409);

  try {
    const account = await getScopedLineAccount(c, group.account_id);
    if (!account) return c.json({ success: false, error: 'line account not found' }, 500);
    const accessToken = await resolveLineAccessToken(c, group.account_id);
    if (!accessToken) return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);

    const line = createLineClient(accessToken);
    const groupInput: GroupInput = {
      id: group.id,
      size: group.size,
      chatBarText: group.chat_bar_text,
      isDefaultForAll: group.is_default_for_all === 1,
      selected: group.selected === 1,
      pages: group.pages.map((p) => ({
        id: p.id,
        aliasId: p.alias_id,
        orderIndex: p.order_index,
        name: p.name,
        imageR2Key: p.image_r2_key,
        imageContentType: p.image_content_type,
        lineRichMenuId: p.line_richmenu_id,
        areas: [],
      })),
    };
    const result = await unpublishRichMenuGroup(groupInput, line);
    if (result.warnings.length > 0) {
      // D1 のIDを残しておかないと、失敗した削除を再試行できなくなる。
      return c.json(
        {
          success: false,
          error: 'LINE上のメニューを完全に取り下げられませんでした。再試行してください。',
          data: result,
        },
        502,
      );
    }
    await markRichMenuGroupUnpublished(
      c.env.DB, groupId, accountLock.groupId, accountLock.token,
    );
    return c.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: message }, 500);
  } finally {
    await releasePublishLock(c.env.DB, accountLock.groupId, accountLock.token);
  }
});

// ----- Bulk apply by tag / set as account default -----

// 指定タグに紐づく友だち全員に、この group の default page の richmenu を割り当てる。
// LINE bulk link API (最大 500 ユーザー / リクエスト) を必要に応じて分割実行。
//
// body:
//   { mode?: 'bulk-link', tagId: string | null }
//     bulk-link (デフォルト): 該当 friends 全員に link。tagId=null は account 内全 follower。
//   { mode: 'set-default' }
//     enabled=true (既定): LINE 公式アカウントの初期表示に設定。新規 follower にも表示。
//     enabled=false: 現在の初期表示から解除。
//     有効化時は同 account 内の他 group の is_default_for_all を 0 にリセット。
//
// 前提: group が published かつ default_page に line_richmenu_id がセット済み。
const APPLY_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const confirmationEncoder = new TextEncoder();

type ApplyConfirmationPayload = {
  tenantId: string;
  accountId: string;
  groupId: string;
  groupUpdatedAt: string;
  confirmationId: string;
  targetRichMenuId: string | null;
  mode: 'bulk-link' | 'set-default';
  intent: 'switch' | 'rollback';
  tagId: string | null;
  enabled: boolean;
  audienceDigest: string | null;
  expiresAt: number;
};

function confirmationBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeConfirmationBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function confirmationHmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    confirmationEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return confirmationBase64Url(new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    confirmationEncoder.encode(value),
  )));
}

function sameConfirmationSignature(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function signApplyConfirmation(
  secret: string,
  payload: ApplyConfirmationPayload,
): Promise<string> {
  const encoded = confirmationBase64Url(confirmationEncoder.encode(JSON.stringify(payload)));
  const signed = `rmc1.${encoded}`;
  return `${signed}.${await confirmationHmac(secret, signed)}`;
}

async function verifyApplyConfirmation(
  secret: string,
  token: string,
): Promise<ApplyConfirmationPayload | null> {
  if (token.length > 4096) return null;
  const [version, encoded, signature, extra] = token.split('.');
  if (version !== 'rmc1' || !encoded || !signature || extra) return null;
  const signed = `${version}.${encoded}`;
  const expected = await confirmationHmac(secret, signed);
  if (!sameConfirmationSignature(expected, signature)) return null;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(decodeConfirmationBase64Url(encoded)),
    ) as Partial<ApplyConfirmationPayload>;
    if (
      typeof payload.tenantId !== 'string' ||
      typeof payload.accountId !== 'string' ||
      typeof payload.groupId !== 'string' ||
      typeof payload.groupUpdatedAt !== 'string' ||
      typeof payload.confirmationId !== 'string' || !payload.confirmationId ||
      payload.confirmationId.length > 128 ||
      (payload.targetRichMenuId !== null && typeof payload.targetRichMenuId !== 'string') ||
      (payload.mode !== 'bulk-link' && payload.mode !== 'set-default') ||
      (payload.intent !== 'switch' && payload.intent !== 'rollback') ||
      (payload.tagId !== null && typeof payload.tagId !== 'string') ||
      typeof payload.enabled !== 'boolean' ||
      (payload.audienceDigest !== null && typeof payload.audienceDigest !== 'string') ||
      typeof payload.expiresAt !== 'number' ||
      payload.expiresAt < Date.now()
    ) return null;
    return payload as ApplyConfirmationPayload;
  } catch {
    return null;
  }
}

async function richMenuAudienceDigest(userIds: string[]): Promise<string> {
  const uniqueSorted = [...new Set(userIds)].sort();
  const digest = await crypto.subtle.digest(
    'SHA-256',
    confirmationEncoder.encode(uniqueSorted.join('\n')),
  );
  return confirmationBase64Url(new Uint8Array(digest));
}

richMenuGroups.post('/api/rich-menu-groups/:groupId/apply-to-tag', async (c) => {
  const groupId = c.req.param('groupId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  const r = (body as {
    tagId?: unknown;
    mode?: unknown;
    enabled?: unknown;
    intent?: unknown;
    dryRun?: unknown;
    confirmationToken?: unknown;
  }) ?? {};
  const mode = (r.mode as string | undefined) ?? 'bulk-link';
  if (mode !== 'bulk-link' && mode !== 'set-default') {
    return c.json({ success: false, error: "mode must be 'bulk-link' or 'set-default'" }, 400);
  }
  if (mode === 'bulk-link') {
    if (r.tagId !== null && r.tagId !== undefined && typeof r.tagId !== 'string') {
      return c.json({ success: false, error: 'tagId must be string or null' }, 400);
    }
  }
  const tagId = (r.tagId as string | null | undefined) ?? null;
  if (mode === 'set-default' && r.enabled !== undefined && typeof r.enabled !== 'boolean') {
    return c.json({ success: false, error: 'enabled must be boolean for set-default' }, 400);
  }
  const enabled = mode === 'set-default' ? r.enabled !== false : true;
  const intent = mode === 'set-default' ? (r.intent ?? 'switch') : 'switch';
  if ((intent !== 'switch' && intent !== 'rollback') ||
      (mode !== 'set-default' && r.intent !== undefined) ||
      (intent === 'rollback' && !enabled)) {
    return c.json({ success: false, error: 'intent must be switch or rollback for enabled set-default' }, 400);
  }

  const group = await getRichMenuGroupWithPages(c.env.DB, groupId);
  if (!group) return c.json({ success: false, error: 'not found' }, 404);
  if (!await groupMatchesAccountScope(c, group)) return c.json({ success: false, error: 'not found' }, 404);
  if (group.status !== 'published') {
    return c.json(
      { success: false, error: 'group must be published before applying to friends' },
      400,
    );
  }
  const boundPharmacyVersion = await isImmutablePharmacyRichMenuVersion(c.env.DB, groupId);
  const lifecycle = await getPharmacyRichMenuLifecycleControl(c.env.DB, group.account_id);
  if ((boundPharmacyVersion && (lifecycle.state !== 'active' || mode !== 'set-default' || !enabled)) ||
      (!boundPharmacyVersion && lifecycle.state !== 'inactive')) {
    return c.json({ success: false, error: 'pharmacy rich-menu lifecycle mutation disabled' }, 409);
  }
  // default_page の line_richmenu_id を採用 (未設定なら order_index=0 の page)。
  // 初期表示を解除する場合は、下書きや古いD1状態からでも解除できるよう
  // target page を必須にしない。
  const targetPage =
    group.pages.find((p) => p.id === group.default_page_id) ??
    [...group.pages].sort((a, b) => a.order_index - b.order_index)[0];
  const targetRichMenuId = targetPage?.line_richmenu_id ?? null;
  if (enabled && !targetRichMenuId) {
    return c.json(
      { success: false, error: 'no published rich menu found for default page' },
      400,
    );
  }
  const immutablePharmacyVersion = boundPharmacyVersion;
  let pharmacySetDefaultEvidenceDigest: string | null = null;
  if (immutablePharmacyVersion) {
    const account = await getScopedLineAccount(c, group.account_id);
    if (!account?.liff_id) {
      return c.json({ success: false, error: 'pharmacy rich-menu readiness unavailable' }, 503);
    }
    const readiness = await getPharmacyRichMenuPublishReadiness({
      db: c.env.DB,
      images: c.env.IMAGES,
      accountId: group.account_id,
      liffId: account.liff_id,
      group,
      requiredStatus: 'published',
    });
    if (readiness.status !== 'READY' || !readiness.evidenceDigest) {
      return c.json({
        success: false,
        error: 'pharmacy rich-menu version is not ready',
        data: readiness,
      }, 409);
    }
    pharmacySetDefaultEvidenceDigest = readiness.evidenceDigest;
  }
  if (intent === 'rollback' && (!targetRichMenuId ||
      !await isPharmacyRichMenuKnownGood(c.env.DB, group.account_id, groupId, targetRichMenuId))) {
    return c.json({
      success: false,
      error: 'rollback target is not a verified same-account known-good version',
    }, 409);
  }

  const tenantId = c.get('tenantId');
  const confirmationSecret = c.env.LINE_CREDENTIAL_KEY_V1;
  if (!tenantId || !confirmationSecret) {
    return c.json({ success: false, error: 'confirmation signing unavailable' }, 503);
  }
  let confirmedUserIds: string[] | null = null;
  if (r.dryRun === true) {
    confirmedUserIds = mode === 'bulk-link'
      ? await getFollowingLineUserIdsByTag(c.env.DB, group.account_id, tagId)
      : [];
    const affected = confirmedUserIds.length;
    const confirmationToken = await signApplyConfirmation(confirmationSecret, {
      tenantId,
      accountId: group.account_id,
      groupId,
      groupUpdatedAt: group.updated_at,
      confirmationId: crypto.randomUUID(),
      targetRichMenuId,
      mode,
      intent,
      tagId,
      enabled,
      audienceDigest: mode === 'bulk-link'
        ? await richMenuAudienceDigest(confirmedUserIds)
        : null,
      expiresAt: Date.now() + APPLY_CONFIRMATION_TTL_MS,
    });
    return c.json({
      success: true,
      data: {
        dryRun: true,
        confirmationToken,
        mode,
        tagId: mode === 'bulk-link' ? tagId : undefined,
        enabled: mode === 'set-default' ? enabled : undefined,
        affected,
        chunks: Math.ceil(affected / 500),
      },
    });
  }
  if (r.dryRun !== false || typeof r.confirmationToken !== 'string') {
    return c.json({ success: false, error: 'valid confirmationToken from dry-run is required' }, 428);
  }
  const confirmation = await verifyApplyConfirmation(confirmationSecret, r.confirmationToken);
  if (!confirmation) {
    return c.json({ success: false, error: 'valid confirmationToken from dry-run is required' }, 428);
  }
  if (
    confirmation.tenantId !== tenantId ||
    confirmation.accountId !== group.account_id ||
    confirmation.groupId !== groupId ||
    confirmation.groupUpdatedAt !== group.updated_at ||
    confirmation.targetRichMenuId !== targetRichMenuId ||
    confirmation.mode !== mode ||
    confirmation.intent !== intent ||
    confirmation.tagId !== tagId ||
    confirmation.enabled !== enabled
  ) {
    return c.json({ success: false, error: 'rich menu changed after confirmation' }, 409);
  }
  if (mode === 'bulk-link') {
    confirmedUserIds = await getFollowingLineUserIdsByTag(c.env.DB, group.account_id, tagId);
    if (confirmation.audienceDigest !== await richMenuAudienceDigest(confirmedUserIds)) {
      return c.json({ success: false, error: 'follower audience changed after confirmation' }, 409);
    }
  }

  const account = await getScopedLineAccount(c, group.account_id);
  if (!account) return c.json({ success: false, error: 'line account not found' }, 500);
  const accessToken = await resolveLineAccessToken(c, group.account_id);
  if (!accessToken) return c.json({ success: false, error: 'LINE account credential unavailable' }, 403);

  // ---- mode: set-default (LINE 全員のデフォルトに設定) ----
  if (mode === 'set-default') {
    const accountLock = await acquireRichMenuAccountLock(c.env.DB, group.account_id);
    if (!accountLock) {
      return c.json({ success: false, error: 'another rich-menu operation is running' }, 409);
    }
    const line = createLineClient(accessToken);
    let previousDefault: string | null = null;
    let lineChanged = false;
    let d1Committed = false;
    let pharmacyOperationId: string | null = null;
    try {
      if (immutablePharmacyVersion) {
        const unresolved = await getUnresolvedPharmacyRichMenuOperation(c.env.DB, group.account_id);
        if (unresolved) {
          return c.json({
            success: false,
            error: 'previous pharmacy rich-menu operation requires reconciliation',
            data: { operationId: unresolved.id, status: unresolved.status },
          }, 409);
        }
        if (!pharmacySetDefaultEvidenceDigest || !targetRichMenuId) {
          return c.json({ success: false, error: 'invalid pharmacy rich-menu default evidence' }, 409);
        }
        const operation = await beginPharmacyRichMenuOperation(c.env.DB, {
          lineAccountId: group.account_id,
          groupId,
          confirmationId: confirmation.confirmationId,
          kind: intent === 'rollback' ? 'rollback' : 'set_default',
          evidenceDigest: pharmacySetDefaultEvidenceDigest,
          expectedDefaultMenuId: null,
        });
        pharmacyOperationId = operation.id;
        await recordPharmacyRichMenuRemoteId(
          c.env.DB, group.account_id, operation.id, targetRichMenuId,
        );
      }
      previousDefault = await line.getCurrentDefaultRichMenuId();
      if (pharmacyOperationId) {
        await recordPharmacyRichMenuExpectedDefault(
          c.env.DB, group.account_id, pharmacyOperationId, previousDefault,
        );
      }
      if (enabled) {
        if (previousDefault !== targetRichMenuId) {
          await line.setDefaultRichMenu(targetRichMenuId!);
          lineChanged = true;
        }
        if (await line.getCurrentDefaultRichMenuId() !== targetRichMenuId) {
          throw new Error('LINE default rich menu verification failed');
        }
      } else {
        const ownIds = new Set(group.pages.flatMap((page) => page.line_richmenu_id ? [page.line_richmenu_id] : []));
        if (previousDefault && ownIds.has(previousDefault)) {
          await line.clearDefaultRichMenu();
          lineChanged = true;
          if (await line.getCurrentDefaultRichMenuId() !== null) {
            throw new Error('LINE default rich menu clear verification failed');
          }
        }
      }
      // LINE側の反映が成功してから、同 account 内のD1表示状態を更新する。
      if (enabled) {
        await recordRichMenuDefaultProjection(
          c.env.DB, group.account_id, groupId, accountLock.groupId, accountLock.token,
        );
      } else {
        const now = new Date().toISOString();
        const result = await c.env.DB
          .prepare(
            `UPDATE rich_menu_groups SET is_default_for_all = 0, updated_at = ?
              WHERE id = ? AND EXISTS (
                SELECT 1 FROM rich_menu_groups AS locked
                 WHERE locked.id = ? AND locked.publishing_at = ?
              )`,
          )
          .bind(now, groupId, accountLock.groupId, accountLock.token)
          .run();
        if ((result.meta?.changes ?? 0) !== 1) throw new Error('rich-menu account lock lost');
      }
      d1Committed = true;
      if (pharmacyOperationId) {
        await finishPharmacyRichMenuOperation(c.env.DB, {
          lineAccountId: group.account_id,
          operationId: pharmacyOperationId,
          expectedStatus: 'running',
          status: 'succeeded',
          verifiedDefaultMenuId: targetRichMenuId,
        });
      }
      return c.json({
        success: true,
        data: {
          mode: 'set-default',
          enabled,
          total: 0,
          chunks: 0,
          message: enabled ? '全員の初期表示に設定しました' : '全員の初期表示から解除しました',
        },
      });
    } catch (e) {
      if (pharmacyOperationId) {
        try {
          await finishPharmacyRichMenuOperation(c.env.DB, {
            lineAccountId: group.account_id,
            operationId: pharmacyOperationId,
            expectedStatus: 'running',
            status: 'unknown',
            reasonCode: 'LINE_RESULT_UNKNOWN',
          });
        } catch {
          // A concurrent reconciliation or succeeded terminal row remains authoritative.
        }
        return c.json({
          success: false,
          error: 'pharmacy rich-menu default result is unknown; reconcile before retry',
          data: { operationId: pharmacyOperationId, status: 'unknown' },
        }, 500);
      }
      if (String(e).includes('pharmacy rich-menu confirmation already used')) {
        return c.json({
          success: false,
          error: 'pharmacy rich-menu confirmation already used',
        }, 409);
      }
      if (lineChanged && !d1Committed) {
        try {
          if (previousDefault) await line.setDefaultRichMenu(previousDefault);
          else await line.clearDefaultRichMenu();
        } catch {
          // Original error remains authoritative; the operation is safe to retry.
        }
      }
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ success: false, error: message }, 500);
    } finally {
      await releasePublishLock(c.env.DB, accountLock.groupId, accountLock.token);
    }
  }

  // ---- mode: bulk-link (タグ or 全 follower に link) ----
  const userIds = confirmedUserIds ?? [];
  if (userIds.length === 0) {
    return c.json({
      success: true,
      data: { chunks: 0, total: 0, message: 'no matching followers' },
    });
  }

  try {
    if (!targetRichMenuId) {
      return c.json({ success: false, error: 'no published rich menu found for default page' }, 400);
    }
    const line = createLineClient(accessToken);
    const result = await linkRichMenuBulkChunked(
      line,
      targetRichMenuId,
      userIds,
    );
    return c.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: message }, 500);
  }
});
