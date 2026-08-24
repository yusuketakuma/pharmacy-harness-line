const LINE_CONTENT_API_BASE = 'https://api-data.line.me/v2/bot/message';
const MAX_INCOMING_IMAGE_BYTES = 10 * 1024 * 1024;
const INCOMING_IMAGE_FETCH_TIMEOUT_MS = 10_000;

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface FetchAndStoreOptions {
  r2: R2Bucket;
  /** workers 環境では globalThis.fetch を使う。テスト時に注入する。 */
  fetch?: typeof fetch;
  /** 公開 URL のベース (例: https://your-worker.your-subdomain.workers.dev) */
  workerUrl: string;
  channelAccessToken: string;
  tenantId: string;
  accountId: string;
  messageId: string;
}

export interface IncomingImageRefs {
  originalContentUrl: string;
  previewImageUrl: string;
  /** R2 key the binary was stored under, for retention tracking (NEXT-4). */
  r2Key: string;
}

/**
 * LINE Content API から incoming 画像バイナリを取得し R2 に保存して URL を返す。
 * 失敗時は null を返し、呼び出し元は `[画像]` ラベルフォールバックを使う。
 */
export async function fetchAndStoreIncomingImage(
  opts: FetchAndStoreOptions,
): Promise<IncomingImageRefs | null> {
  const fetcher = opts.fetch ?? fetch;

  let res: Response;
  try {
    res = await fetcher(`${LINE_CONTENT_API_BASE}/${opts.messageId}/content`, {
      headers: { Authorization: `Bearer ${opts.channelAccessToken}` },
      signal: AbortSignal.timeout(INCOMING_IMAGE_FETCH_TIMEOUT_MS),
    });
  } catch {
    console.error('incoming-image: fetch failed');
    return null;
  }

  if (!res.ok) {
    console.error('incoming-image: non-200', { status: res.status });
    return null;
  }

  const contentType = res.headers.get('Content-Type')?.split(';')[0].trim() ?? 'application/octet-stream';
  const ext = CONTENT_TYPE_TO_EXT[contentType];
  if (!ext) {
    console.error('incoming-image: unsupported content-type', { contentType });
    return null;
  }
  // Tenant/account/message identifiers are server-resolved, but sanitize them
  // R2 キーに不正な文字（スラッシュ等）が混入しないよう sanitize する。
  const safeTenantId = opts.tenantId.replace(/[^a-zA-Z0-9:-]/g, '_');
  const safeAccountId = opts.accountId.replace(/[^a-zA-Z0-9-]/g, '_');
  const safeMessageId = opts.messageId.replace(/[^a-zA-Z0-9-]/g, '_');
  const key = `tenants/${safeTenantId}/accounts/${safeAccountId}/incoming/${safeMessageId}.${ext}`;

  const declaredLength = Number.parseInt(res.headers.get('Content-Length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INCOMING_IMAGE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    console.error('incoming-image: body rejected', { reason: 'too-large' });
    return null;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    console.error('incoming-image: body rejected', { reason: 'missing' });
    return null;
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_INCOMING_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        console.error('incoming-image: body rejected', { reason: 'too-large' });
        return null;
      }
      chunks.push(value);
    }
  } catch {
    console.error('incoming-image: body read failed');
    return null;
  }

  const data = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    await opts.r2.put(key, data.buffer, { httpMetadata: { contentType } });
  } catch {
    console.error('incoming-image: R2 put failed');
    return null;
  }

  const base = opts.workerUrl.replace(/\/$/, '');
  const url = `${base}/api/images/${key}`;
  return { originalContentUrl: url, previewImageUrl: url, r2Key: key };
}
