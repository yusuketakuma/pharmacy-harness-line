// LIFF id_token verification. The unverified JWT audience is only a lookup
// selector; LINE's verify endpoint remains the authentication authority.

export interface VerifyEnv {
  LINE_LOGIN_CHANNEL_ID?: string;
  DB: D1Database;
}

export interface VerifiedLineIdentity {
  lineUserId: string;
  loginChannelId: string;
  lineAccountId: string;
  tenantId: string;
}

function tokenAudience(token: string): string | null {
  if (token.length > 16_384) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { aud?: unknown };
    return typeof payload.aud === 'string' && payload.aud.length > 0 ? payload.aud : null;
  } catch {
    return null;
  }
}

export async function verifyCallerLineIdentity(
  authHeader: string | undefined,
  env: VerifyEnv,
): Promise<VerifiedLineIdentity | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) return null;

  const audience = tokenAudience(idToken);
  if (!audience) return null;
  try {
    const accounts = await env.DB.prepare(
      `SELECT account.id, mapping.tenant_id, account.login_channel_id
         FROM line_accounts AS account
         INNER JOIN tenant_line_accounts AS mapping
                 ON mapping.line_account_id = account.id
         INNER JOIN tenants AS tenant
                 ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
        WHERE account.login_channel_id = ? AND account.is_active = 1
        LIMIT 2`,
    ).bind(audience).all<{
      id: string;
      tenant_id: string;
      login_channel_id: string;
    }>();
    if (accounts.results.length !== 1) return null;
    const account = accounts.results[0];
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: audience }),
    });
    if (!res.ok) return null;
    const verified = (await res.json()) as { sub?: unknown; aud?: unknown };
    if (typeof verified.sub !== 'string' || verified.aud !== audience) return null;
    return {
      lineUserId: verified.sub,
      loginChannelId: audience,
      lineAccountId: account.id,
      tenantId: account.tenant_id,
    };
  } catch {
    return null;
  }
}

export async function verifyCallerLineUserId(
  authHeader: string | undefined,
  env: VerifyEnv,
): Promise<string | null> {
  return (await verifyCallerLineIdentity(authHeader, env))?.lineUserId ?? null;
}
