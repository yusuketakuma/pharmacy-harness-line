import type { Message } from '@line-crm/line-sdk';

export type HarnessProxyDispatch = (request: Request) => Promise<Response>;

const LINE_PUSH_TIMEOUT_MS = 10_000;

export class LineHarnessUnknownOutcomeError extends Error {
  readonly name = 'LineHarnessUnknownOutcomeError';
}

export type HarnessProxyPushOptions = {
  pharmacyNotificationEventId?: string;
  lineAccountId?: string;
};

/**
 * LINE の push は必ず Harness の互換プロキシを通す。
 * プロキシ側が送信履歴の記録も担当するため、呼び出し元で messages_log を
 * 二重に書かないこと。
 */
export async function pushViaHarnessProxy(
  proxyBaseUrl: string,
  accessToken: string,
  to: string,
  messages: Message[],
  retryKey?: string,
  dispatch?: HarnessProxyDispatch,
  options?: HarnessProxyPushOptions,
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  if (retryKey) headers['X-Line-Retry-Key'] = retryKey;
  if (options?.pharmacyNotificationEventId) {
    headers['X-Pharmacy-Notification-Event-Id'] = options.pharmacyNotificationEventId;
  }
  if (options?.lineAccountId) headers['X-Line-Account-Id'] = options.lineAccountId;

  const url = `${proxyBaseUrl.replace(/\/$/, '')}/line-api/v2/bot/message/push`;
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify({ to, messages }),
  };
  // Worker 自身の公開 URL へ fetch すると自己接続が失敗する環境がある。
  // 内部呼び出しは同じ Hono proxy handler へ直接 dispatch し、外部利用時だけ fetch。
  const signal = AbortSignal.timeout(LINE_PUSH_TIMEOUT_MS);
  let response: Response;
  try {
    const operation = dispatch
      ? dispatch(new Request(url, { ...init, signal }))
      : fetch(url, { ...init, signal });
    response = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
  } catch {
    throw new LineHarnessUnknownOutcomeError('LINE Harness proxy outcome is unknown');
  }

  // 同じ retry key がすでに LINE に受理済みなら、再送の 409 も成功扱い。
  const alreadyAccepted =
    response.status === 409 && Boolean(response.headers.get('x-line-accepted-request-id'));
  if (response.ok || alreadyAccepted) return;
  if (response.status >= 500) {
    throw new LineHarnessUnknownOutcomeError(
      `LINE Harness proxy outcome is unknown: ${response.status} ${response.statusText}`,
    );
  }

  throw new Error(`LINE Harness proxy error: ${response.status} ${response.statusText}`);
}

/**
 * LINE の reply も Harness の互換プロキシを通す。
 * replyToken から受信者を逆引きできないため、messages_log は呼び出し元が記録する。
 */
export async function replyViaHarnessProxy(
  proxyBaseUrl: string,
  accessToken: string,
  replyToken: string,
  messages: Message[],
  dispatch?: HarnessProxyDispatch,
): Promise<void> {
  const url = `${proxyBaseUrl.replace(/\/$/, '')}/line-api/v2/bot/message/reply`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages }),
  };
  const response = dispatch ? await dispatch(new Request(url, init)) : await fetch(url, init);
  if (response.ok) return;

  throw new Error(`LINE Harness proxy error: ${response.status} ${response.statusText}`);
}
