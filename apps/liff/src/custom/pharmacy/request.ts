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
