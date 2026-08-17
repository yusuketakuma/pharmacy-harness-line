import { getIdToken, getLiffId } from '../../lib/liff-auth.js';

const BASE = import.meta.env.VITE_API_BASE ?? '';

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
  errorLabel: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await requestPharmacyLiff(path, init);
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    throw Object.assign(new Error(`${errorLabel} ${response.status}`), {
      status: response.status,
      body,
    });
  }
  return body as T;
}
