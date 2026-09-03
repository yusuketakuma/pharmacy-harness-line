import { getIdToken, getLiffId } from '../../lib/liff-auth.js';

const BASE = import.meta.env.VITE_API_BASE ?? '';

export function pharmacyErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error &&
    typeof (error as Error & { status?: unknown }).status === 'number'
    ? error.message
    : fallback;
}

export function isUnsupportedPharmacyFeature(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const requestError = error as Error & {
    status?: unknown;
    body?: unknown;
    routeError?: unknown;
  };
  const body = requestError.body;
  const previousWorkerAuthGate = requestError.status === 401 &&
    typeof body === 'object' && body !== null &&
    (body as Record<string, unknown>).success === false &&
    (body as Record<string, unknown>).error === 'Unauthorized';
  return previousWorkerAuthGate ||
    (requestError.status === 404 && requestError.routeError === 'route_not_found');
}

export function requestPharmacyLiff(path: string, init: RequestInit = {}): Promise<Response> {
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const url = new URL(`${BASE}${path}`, origin);
  url.searchParams.set('liffId', getLiffId());
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${getIdToken()}`,
      ...init.headers,
    },
  });
}

export async function requestPharmacyJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await requestPharmacyLiff(path, init);
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const message = response.status === 401
      ? '認証の有効期限が切れました。LINEから開き直してください。'
      : response.status === 403
        ? 'この操作を行う権限がありません。'
        : response.status === 404
          ? '対象が見つかりませんでした。'
          : response.status === 409
            ? '内容が更新されています。画面を再読み込みしてください。'
            : response.status === 429
              ? '操作が集中しています。しばらく待って再度お試しください。'
              : response.status === 503
                ? 'この機能は現在利用できません。薬局にお問い合わせください。'
                : response.status >= 500
                  ? '薬局システムに接続できませんでした。時間をおいて再度お試しください。'
                  : '操作に失敗しました。内容を確認して再度お試しください。';
    throw Object.assign(new Error(message), {
      status: response.status,
      body,
      routeError: response.headers.get('X-Line-Harness-Error'),
    });
  }
  return body as T;
}
