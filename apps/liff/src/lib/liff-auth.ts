import liff from '@line/liff';

// Deployment contract marker. The shared Pages workflow checks for this exact
// value so an old generic LIFF bundle cannot pass the pharmacy build gate.
export const PHARMACY_LIFF_BUILD_MARKER = 'pharmacy-liff-multitenant-v1';

let _liffId: string | null = null;
let _lineUserId: string | null = null;
let _idToken: string | null = null;

export async function initLiff(): Promise<boolean> {
  const url = new URL(window.location.href);
  const liffId = url.searchParams.get('liffId');
  if (!liffId) {
    throw new Error('liffId not provided. Append ?liffId=... to the URL.');
  }
  _liffId = liffId;
  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: window.location.href });
    return false;
  }
  const profile = await liff.getProfile();
  _lineUserId = profile.userId;
  // id_token は Worker 側で LINE Login verify API を叩いて caller を確定するために使う。
  const idToken = liff.getIDToken();
  if (!idToken) throw new Error('LINE id_token unavailable');
  _idToken = idToken;
  return true;
}

export function getLiffId(): string {
  if (!_liffId) throw new Error('LIFF not initialized');
  return _liffId;
}

export function getLineUserId(): string {
  if (!_lineUserId) throw new Error('LIFF not initialized');
  return _lineUserId;
}

export function getIdToken(): string {
  if (!_idToken) throw new Error('LIFF not initialized or id_token not available');
  return _idToken;
}
