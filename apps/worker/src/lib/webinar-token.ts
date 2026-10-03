import { toBase64Url } from './base64.js';
// HLS アセット配信用の短命 HMAC トークン。URL パスに埋め込むので base64url。
// 完全な DRM ではなく「友だち以外の直リンク視聴の抑止」が目的 (spec 参照)。

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toBase64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

export async function signWebinarToken(secret: string, slug: string, expEpochSeconds: number): Promise<string> {
  const sig = await hmac(secret, `${slug}:${expEpochSeconds}`);
  return `${expEpochSeconds}.${sig}`;
}

export async function verifyWebinarToken(
  secret: string,
  slug: string,
  token: string,
  nowEpochSeconds: number,
): Promise<boolean> {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < nowEpochSeconds) return false;
  const expected = await hmac(secret, `${slug}:${exp}`);
  const actual = token.slice(dot + 1);
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}
