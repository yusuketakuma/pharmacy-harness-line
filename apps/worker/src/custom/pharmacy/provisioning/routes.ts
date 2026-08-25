import { LineClient } from '@line-crm/line-sdk';
import { Hono, type Context } from 'hono';
import type { Env } from '../../../index.js';
import { DEFAULT_PHARMACY_CAPABILITIES } from '../growth-loop/access.js';
import {
  generateTenantAdminSessionToken,
  hashTenantAdminSessionToken,
  hashTenantPassword,
  isValidAdminPassword,
} from './credentials.js';
import { requireLineBotUserId } from './line-connection.js';
import {
  encryptLineCredential,
  type LineCredentialKind,
} from './line-credentials.js';
import {
  backfillLineCredentials,
  restoreLegacyLineCredentials,
  scrubLegacyLineCredentials,
} from './line-credential-backfill.js';
import {
  backfillPatientIntakeEnvelopes,
  inspectPatientIntakeCoverage,
  restorePatientIntakeLegacyFields,
  scrubPatientIntakeLegacyFields,
} from '../intake/migration.js';
import { resolvePatientIntakeCryptoScope } from '../intake/envelopes.js';
import {
  platformAdminSessionTokenFromCookie,
  resolvePlatformAdminSession,
} from '../platform-admin/auth.js';
import {
  platformAdminAccessStatement,
  recordPlatformAdminAccess,
} from '../platform-admin/audit.js';

type ProvisioningInput = {
  tenantName: string;
  admin: {
    loginId: string;
    displayName: string;
    email: string | null;
    temporaryPassword: string;
  };
  line: {
    channelId: string;
    displayName: string;
    channelAccessToken: string;
    channelSecret: string;
    loginChannelId: string | null;
    loginChannelSecret: string | null;
    liffId: string | null;
  };
};

type ProvisioningReceipt = {
  request_hash: string;
  tenant_id: string;
  line_account_id: string;
  staff_id: string;
  tenant_code: string;
  display_name: string;
  login_id: string;
  line_account_name: string;
  liff_id: string | null;
};

type AdminBootstrapInput = ProvisioningInput['admin'];

type CliBreakGlassInput = {
  platformAdminLoginId: string;
  reason: string;
  ticketReference: string | null;
};

type TenantAdminBootstrap = {
  id: string;
  tenant_code: string;
  display_name: string;
  line_account_id: string;
  bootstrap_staff_id: string | null;
  login_id: string | null;
  password_hash: string | null;
  must_change_password: number | null;
};

const encoder = new TextEncoder();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key].trim() : '';
}

function optionalStringField(record: Record<string, unknown>, key: string): string | null {
  const value = stringField(record, key);
  return value || null;
}

const LEGACY_RECOVERY_IDENTITY_FIELDS = new Set([
  'approvedBy', 'approved_by', 'approver', 'approverSubject', 'approver_subject',
  'executor', 'executorBy', 'executorSubject', 'executor_subject',
]);

function containsLegacyRecoveryIdentity(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsLegacyRecoveryIdentity);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    LEGACY_RECOVERY_IDENTITY_FIELDS.has(key) || containsLegacyRecoveryIdentity(nested));
}

function parseInput(value: unknown): ProvisioningInput | null {
  const body = asRecord(value);
  const admin = asRecord(body?.admin);
  const line = asRecord(body?.line);
  if (!body || !admin || !line) return null;

  const input: ProvisioningInput = {
    tenantName: stringField(body, 'tenantName'),
    admin: {
      loginId: stringField(admin, 'loginId'),
      displayName: stringField(admin, 'displayName'),
      email: optionalStringField(admin, 'email'),
      // Password whitespace is significant. Never trim a credential.
      temporaryPassword: typeof admin.temporaryPassword === 'string'
        ? admin.temporaryPassword
        : '',
    },
    line: {
      channelId: stringField(line, 'channelId'),
      displayName: stringField(line, 'displayName'),
      channelAccessToken: stringField(line, 'channelAccessToken'),
      channelSecret: stringField(line, 'channelSecret'),
      loginChannelId: optionalStringField(line, 'loginChannelId'),
      loginChannelSecret: optionalStringField(line, 'loginChannelSecret'),
      liffId: optionalStringField(line, 'liffId'),
    },
  };

  if (!input.tenantName || input.tenantName.length > 120 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(input.admin.loginId) ||
      !input.admin.displayName || input.admin.displayName.length > 120 ||
      !isValidAdminPassword(input.admin.temporaryPassword) ||
      (input.admin.email !== null &&
        (input.admin.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.admin.email))) ||
      !/^\d{6,32}$/u.test(input.line.channelId) ||
      !input.line.displayName || input.line.displayName.length > 120 ||
      input.line.channelAccessToken.length < 32 || input.line.channelAccessToken.length > 2048 ||
      !/^[\x21-\x7E]+$/u.test(input.line.channelAccessToken) ||
      !/^[A-Fa-f0-9]{32}$/u.test(input.line.channelSecret)) {
    return null;
  }
  // A pharmacy tenant cannot open the patient intake or prescription LIFF
  // without a LINE Login channel and LIFF app. Reject incomplete setup before
  // calling LINE or mutating D1 so a tenant cannot be provisioned unusable.
  if (!input.line.loginChannelId || !input.line.loginChannelSecret || !input.line.liffId) {
    return null;
  }
  const hasLoginId = input.line.loginChannelId !== null;
  const hasLoginSecret = input.line.loginChannelSecret !== null;
  if (hasLoginId !== hasLoginSecret ||
      (input.line.loginChannelId !== null && !/^\d{6,32}$/u.test(input.line.loginChannelId)) ||
      (input.line.loginChannelSecret !== null && !/^[A-Fa-f0-9]{32}$/u.test(input.line.loginChannelSecret)) ||
      (input.line.liffId !== null &&
        (!/^\d{6,32}-[A-Za-z0-9_-]{8,64}$/u.test(input.line.liffId) ||
         !input.line.loginChannelId ||
         !input.line.liffId.startsWith(`${input.line.loginChannelId}-`)))) {
    return null;
  }
  return input;
}

function parseAdminBootstrapInput(value: unknown): AdminBootstrapInput | null {
  const body = asRecord(value);
  if (!body) return null;
  const input = {
    loginId: stringField(body, 'loginId'),
    displayName: stringField(body, 'displayName'),
    email: optionalStringField(body, 'email'),
    temporaryPassword: typeof body.temporaryPassword === 'string'
      ? body.temporaryPassword
      : '',
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(input.loginId) ||
      !input.displayName || input.displayName.length > 120 ||
      !isValidAdminPassword(input.temporaryPassword) ||
      (input.email !== null &&
        (input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.email)))) {
    return null;
  }
  return input;
}

function parseCliBreakGlassInput(value: unknown): CliBreakGlassInput | null {
  const body = asRecord(value);
  if (!body) return null;
  const input = {
    platformAdminLoginId: stringField(body, 'platformAdminLoginId'),
    reason: stringField(body, 'reason'),
    ticketReference: optionalStringField(body, 'ticketReference'),
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(input.platformAdminLoginId) ||
      !input.reason || input.reason.length > 500 ||
      (input.ticketReference !== null && input.ticketReference.length > 120)) {
    return null;
  }
  return input;
}

function baseUrl(value: string | undefined, fallback?: string): string | null {
  try {
    const url = new URL(value || fallback || '');
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

// The pharmacy code a pharmacist types at login. Server-assigned so two pharmacies
// never get confusable codes and a caller cannot squat one it does not own.
// Rejection sampling rather than a plain `% 1e6`: the modulo would favour 0..967295.
// Not a secret — login also requires loginId + password, and admin-auth.ts compares
// against a dummy hash on a miss so a wrong code is indistinguishable from a wrong
// password. It is a tenant selector, so 6 digits is a UX choice, not a key length.
const TENANT_CODE_MODULUS = 1_000_000;
const TENANT_CODE_REJECT_ABOVE = 4_294_000_000;

function generateTenantCode(): string {
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= TENANT_CODE_REJECT_ABOVE);
  // padStart keeps "004821" six characters wide; the column is TEXT, so the leading
  // zero survives storage and the COLLATE NOCASE login lookup.
  return String(buffer[0] % TENANT_CODE_MODULUS).padStart(6, '0');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sameSecret(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

async function requestHash(input: ProvisioningInput): Promise<string> {
  // The CLI generates a fresh random temporary password on every run, so the
  // password must not take part in replay matching (a retry would 409 forever).
  const admin = { ...input.admin, temporaryPassword: undefined };
  return hex(await sha256(JSON.stringify({ ...input, admin })));
}

async function findReceipt(
  db: D1Database,
  idempotencyKeyHash: string,
): Promise<ProvisioningReceipt | null> {
  return db.prepare(
    `SELECT request.request_hash, request.tenant_id, request.line_account_id,
            request.staff_id, tenant.tenant_code, tenant.display_name,
            credential.login_id, account.name AS line_account_name, account.liff_id
       FROM pharmacy_tenant_provisioning_requests AS request
       INNER JOIN tenants AS tenant ON tenant.id = request.tenant_id
       INNER JOIN line_accounts AS account ON account.id = request.line_account_id
       INNER JOIN tenant_admin_credentials AS credential
               ON credential.tenant_id = request.tenant_id
              AND credential.staff_id = request.staff_id
      WHERE request.idempotency_key_hash = ?
      LIMIT 1`,
  ).bind(idempotencyKeyHash).first<ProvisioningReceipt>();
}

async function findTenantAdminBootstrap(
  db: D1Database,
  tenantId: string,
): Promise<TenantAdminBootstrap | null> {
  return db.prepare(
    `SELECT tenant.id, tenant.tenant_code, tenant.display_name,
            mapping.line_account_id,
            bootstrap.staff_id AS bootstrap_staff_id,
            credential.login_id, credential.password_hash,
            credential.must_change_password
       FROM tenants AS tenant
       INNER JOIN tenant_line_accounts AS mapping
               ON mapping.tenant_id = tenant.id
       LEFT JOIN pharmacy_tenant_admin_bootstraps AS bootstrap
              ON bootstrap.tenant_id = tenant.id
       LEFT JOIN tenant_admin_credentials AS credential
              ON credential.tenant_id = bootstrap.tenant_id
             AND credential.staff_id = bootstrap.staff_id
      WHERE tenant.id = ? AND tenant.status = 'active'
      ORDER BY mapping.line_account_id
      LIMIT 1`,
  ).bind(tenantId).first<TenantAdminBootstrap>();
}

function adminBootstrapResponse(
  tenant: TenantAdminBootstrap,
  staffId: string,
  loginId: string,
  replayed: boolean,
) {
  return {
    tenantId: tenant.id,
    tenantCode: tenant.tenant_code,
    tenantName: tenant.display_name,
    staffId,
    adminLoginId: loginId,
    replayed,
  };
}

function setupUrls(c: Context<Env>, liffId: string | null) {
  const requestOrigin = new URL(c.req.url).origin;
  const worker = baseUrl(c.env.WORKER_PUBLIC_URL ?? c.env.WORKER_URL, requestOrigin);
  const admin = baseUrl(c.env.ADMIN_PUBLIC_URL);
  const liff = baseUrl(c.env.LIFF_PUBLIC_URL);
  if (!worker || !admin || !liff) return null;
  const liffEndpoint = new URL('/', liff);
  if (liffId) liffEndpoint.searchParams.set('liffId', liffId);
  return {
    admin,
    webhook: `${worker}/webhook`,
    liffEndpoint: liffEndpoint.toString(),
  };
}

function responseData(
  receipt: ProvisioningReceipt,
  urls: NonNullable<ReturnType<typeof setupUrls>>,
  replayed: boolean,
) {
  return {
    tenantId: receipt.tenant_id,
    tenantCode: receipt.tenant_code,
    tenantName: receipt.display_name,
    lineAccountId: receipt.line_account_id,
    lineAccountName: receipt.line_account_name,
    staffId: receipt.staff_id,
    adminLoginId: receipt.login_id,
    replayed,
    urls,
  };
}

export const tenantProvisioningRoutes = new Hono<Env>();

async function rejectUnauthorizedPlatformRequest(
  c: Context<Env>,
  requireCredentialRoot = true,
): Promise<Response | null> {
  if (!c.env.PLATFORM_ADMIN_KEY) {
    return c.json({ success: false, error: 'Platform provisioning is not configured' }, 503);
  }
  const credentialRootSecret = c.env.LINE_CREDENTIAL_KEY_V1;
  if (requireCredentialRoot && (
    !credentialRootSecret ||
    encoder.encode(credentialRootSecret).length < 32 ||
    credentialRootSecret.length > 4096
  )) {
    return c.json({ success: false, error: 'LINE credential encryption is not configured' }, 503);
  }
  if (c.req.header('origin')) {
    return c.json({ success: false, error: 'CLI access only' }, 403);
  }
  const authorization = c.req.header('authorization') ?? '';
  const suppliedKey = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!suppliedKey || !(await sameSecret(suppliedKey, c.env.PLATFORM_ADMIN_KEY))) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  for (const tenantSecret of [
    c.env.API_KEY,
    c.env.LEGACY_API_KEY,
    c.env.LINE_CHANNEL_ACCESS_TOKEN,
    c.env.LINE_CHANNEL_SECRET,
    c.env.CROSS_ACCOUNT_TOKEN_KEY,
    c.env.LINE_CREDENTIAL_KEY_V1,
    c.env.PHARMACY_PHI_KEY_V1,
    c.env.PHARMACY_PHI_KEY_V2,
  ]) {
    if (tenantSecret && await sameSecret(c.env.PLATFORM_ADMIN_KEY, tenantSecret)) {
      return c.json({ success: false, error: 'Platform provisioning key is not isolated' }, 503);
    }
  }
  return null;
}

async function provisionTenant(
  c: Context<Env>,
  actorKeyHash: string,
  platformAdminId: string | null,
) {
  const credentialRootSecret = c.env.LINE_CREDENTIAL_KEY_V1!;
  const idempotencyKey = c.req.header('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)) {
    return c.json({ success: false, error: 'Valid Idempotency-Key is required' }, 400);
  }
  const idempotencyKeyHash = hex(await sha256(idempotencyKey));
  const input = parseInput(await c.req.json().catch(() => null));
  if (!input) return c.json({ success: false, error: 'Invalid tenant setup data' }, 400);
  const urls = setupUrls(c, input.line.liffId);
  if (!urls) {
    return c.json({ success: false, error: 'Public setup URLs are not configured' }, 503);
  }
  const hash = await requestHash(input);
  const existing = await findReceipt(c.env.DB, idempotencyKeyHash);
  if (existing) {
    if (existing.request_hash !== hash) {
      return c.json({ success: false, error: 'Idempotency key already used for different data' }, 409);
    }
    if (platformAdminId) {
      await recordPlatformAdminAccess(
        c.env.DB, platformAdminId, existing.tenant_id,
        'tenant_provision_replay', 'tenant', existing.tenant_id,
      );
    }
    return c.json({
      success: true,
      data: {
        ...responseData(existing, setupUrls(c, existing.liff_id) ?? urls, true),
        line: { tokenValidated: true, webhookConfigured: null, replayed: true },
      },
    });
  }

  const lineClient = new LineClient(input.line.channelAccessToken);
  let botUserId: string;
  try {
    const botInfo = await lineClient.request('GET', '/v2/bot/info');
    botUserId = requireLineBotUserId(botInfo.data);
  } catch {
    return c.json({ success: false, error: 'LINE access token validation failed' }, 400);
  }

  const tenantId = `tenant:${crypto.randomUUID()}`;
  const lineAccountId = crypto.randomUUID();
  const staffId = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await hashTenantPassword(input.admin.temporaryPassword);
  const hiddenApiKey = `disabled:${crypto.randomUUID()}`;
  const credentials: Array<{ kind: LineCredentialKind; credential: string }> = [
    { kind: 'channel_access_token', credential: input.line.channelAccessToken },
    { kind: 'channel_secret', credential: input.line.channelSecret },
  ];
  if (input.line.loginChannelSecret) {
    credentials.push({ kind: 'login_channel_secret', credential: input.line.loginChannelSecret });
  }
  let encryptedCredentials: Array<{
    kind: LineCredentialKind;
    keyVersion: number;
    nonce: string;
    ciphertext: string;
    lookupDigest: string | null;
  }>;
  try {
    encryptedCredentials = await Promise.all(credentials.map(async ({ kind, credential }) => ({
      kind,
      ...await encryptLineCredential({
        rootSecret: credentialRootSecret,
        tenantId,
        lineAccountId,
        kind,
        credential,
      }),
    })));
  } catch {
    return c.json({ success: false, error: 'LINE credential encryption is not configured' }, 503);
  }
  // Generated here, after the idempotency early-return, and deliberately NOT part of
  // `hash` (requestHash covers `input` only). A replay must re-match the stored hash
  // and return the code assigned on the first attempt, which it reads back from the
  // receipt join; folding a fresh random value into the hash would 409 every retry.
  //
  // 6 digits is 1e6 codes, so a collision with an existing tenant is the case worth
  // handling; two provisions racing on the same free code is not. The pre-check below
  // covers the former, and the latter still fails closed on the UNIQUE constraint into
  // the retryable 409 in the catch — no receipt is written, so the operator's retry
  // simply draws a new code.
  let tenantCode = generateTenantCode();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const taken = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM tenants WHERE tenant_code = ? COLLATE NOCASE LIMIT 1`,
    ).bind(tenantCode).first<{ ok: number }>();
    if (!taken) break;
    tenantCode = generateTenantCode();
  }

  const receipt: ProvisioningReceipt = {
    request_hash: hash,
    tenant_id: tenantId,
    line_account_id: lineAccountId,
    staff_id: staffId,
    tenant_code: tenantCode,
    display_name: input.tenantName,
    login_id: input.admin.loginId,
    line_account_name: input.line.displayName,
    liff_id: input.line.liffId,
  };

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).bind(tenantId, tenantCode, input.tenantName, now, now),
      c.env.DB.prepare(
        `INSERT INTO line_accounts
          (id, channel_id, name, channel_access_token, channel_secret,
           login_channel_id, login_channel_secret, liff_id,
           is_active, display_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      ).bind(
        lineAccountId, input.line.channelId, input.line.displayName,
        'encrypted:v1', 'encrypted:v1',
        input.line.loginChannelId, input.line.loginChannelSecret ? 'encrypted:v1' : null,
        input.line.liffId,
        now, now,
      ),
      c.env.DB.prepare(
        `INSERT INTO tenant_line_accounts
          (tenant_id, line_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(tenantId, lineAccountId, now, now),
      ...encryptedCredentials.map((credential) => c.env.DB.prepare(
        `INSERT INTO pharmacy_line_credentials
          (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
           key_version, revision, lookup_digest, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        tenantId, lineAccountId, credential.kind, credential.nonce,
        credential.ciphertext, credential.keyVersion, credential.lookupDigest, now, now,
      )),
      c.env.DB.prepare(
        `INSERT INTO pharmacy_line_channel_identities
          (line_account_id, bot_user_id, created_at)
         VALUES (?, ?, ?)`,
      ).bind(lineAccountId, botUserId, now),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO pharmacy_account_capabilities
          (line_account_id, mode, capabilities_json, proactive_monthly_limit,
           unfollow_alert_state, created_at, updated_at)
         VALUES (?, 'pharmacy', ?, 1, 'alert_only', ?, ?)`,
      ).bind(lineAccountId, JSON.stringify(DEFAULT_PHARMACY_CAPABILITIES), now, now),
      c.env.DB.prepare(
        `INSERT INTO staff_members
          (id, name, email, role, api_key, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', ?, 1, ?, ?)`,
      ).bind(staffId, input.admin.displayName, input.admin.email, hiddenApiKey, now, now),
      c.env.DB.prepare(
        `INSERT INTO tenant_staff_memberships
          (tenant_id, staff_id, role, is_active, created_at, updated_at)
         VALUES (?, ?, 'owner', 1, ?, ?)`,
      ).bind(tenantId, staffId, now, now),
      c.env.DB.prepare(
        `INSERT INTO pharmacy_staff_accounts
          (line_account_id, staff_id, is_active, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      ).bind(lineAccountId, staffId, now, now),
      c.env.DB.prepare(
        `INSERT INTO tenant_admin_credentials
          (tenant_id, staff_id, login_id, password_hash, must_change_password,
           credential_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
      ).bind(tenantId, staffId, input.admin.loginId, passwordHash, now, now),
      c.env.DB.prepare(
        `INSERT INTO pharmacy_tenant_admin_bootstraps
          (tenant_id, staff_id, created_at)
         VALUES (?, ?, ?)`,
      ).bind(tenantId, staffId, now),
      c.env.DB.prepare(
        `INSERT INTO pharmacy_tenant_provisioning_requests
          (idempotency_key_hash, request_hash, actor_key_hash,
           tenant_id, line_account_id, staff_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        idempotencyKeyHash, hash, actorKeyHash,
        tenantId, lineAccountId, staffId, now,
      ),
      c.env.DB.prepare(
        `INSERT INTO pharmacy_growth_events
          (id, line_account_id, event_type, aggregate_id, subject_key,
           schema_version, occurred_at, idempotency_key, metadata_json, created_at)
         VALUES (?, ?, 'tenant_provisioned', ?, NULL, 1, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), lineAccountId, tenantId, now,
        `provision:${idempotencyKeyHash}`,
        JSON.stringify({ actor_key_hash: actorKeyHash.slice(0, 16) }),
        now,
      ),
      ...(platformAdminId ? [platformAdminAccessStatement(
        c.env.DB, platformAdminId, tenantId,
        'tenant_provision', 'tenant', tenantId,
        { lineAccountId },
      )] : []),
    ]);
  } catch (error) {
    const raced = await findReceipt(c.env.DB, idempotencyKeyHash);
    if (raced?.request_hash === hash) {
      if (platformAdminId) {
        await recordPlatformAdminAccess(
          c.env.DB, platformAdminId, raced.tenant_id,
          'tenant_provision_replay', 'tenant', raced.tenant_id,
        );
      }
      return c.json({
        success: true,
        data: {
          ...responseData(raced, setupUrls(c, raced.liff_id) ?? urls, true),
          line: { tokenValidated: true, webhookConfigured: false, replayed: true },
        },
      });
    }
    const constraint = error instanceof Error && /constraint|unique/i.test(error.message);
    return c.json({
      success: false,
      error: constraint ? 'Tenant or LINE account already exists' : 'Tenant provisioning failed',
    }, constraint ? 409 : 500);
  }

  let webhookConfigured = true;
  try {
    await lineClient.request('PUT', '/v2/bot/channel/webhook/endpoint', {
      endpoint: urls.webhook,
    });
  } catch {
    webhookConfigured = false;
  }

  return c.json({
    success: true,
    data: {
      ...responseData(receipt, urls, false),
      line: {
        tokenValidated: true,
        webhookConfigured,
        channelSecretVerification: 'pending_first_webhook',
      },
      manualSteps: [
        'Enable webhook use in LINE Developers if it is disabled.',
        'Register the LIFF endpoint in the LINE Login channel when LIFF is used.',
      ],
    },
  }, 201);
}

tenantProvisioningRoutes.post('/api/platform/pharmacy/tenants', async (c) => {
  const rejected = await rejectUnauthorizedPlatformRequest(c);
  if (rejected) return rejected;
  return provisionTenant(c, hex(await sha256(c.env.PLATFORM_ADMIN_KEY!)), null);
});

tenantProvisioningRoutes.post('/api/platform-admin/tenants', async (c) => {
  const admin = c.get('platformAdmin');
  if (!admin) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const rootSecret = c.env.LINE_CREDENTIAL_KEY_V1;
  if (!rootSecret || encoder.encode(rootSecret).length < 32 || rootSecret.length > 4096) {
    return c.json({ success: false, error: 'LINE credential encryption is not configured' }, 503);
  }
  return provisionTenant(c, hex(await sha256(`platform-admin:${admin.id}`)), admin.id);
});

tenantProvisioningRoutes.post(
  '/api/platform/pharmacy/tenants/:tenantId/admin-bootstrap',
  async (c) => {
    const rejected = await rejectUnauthorizedPlatformRequest(c);
    if (rejected) return rejected;
    const input = parseAdminBootstrapInput(await c.req.json().catch(() => null));
    if (!input) return c.json({ success: false, error: 'Invalid admin bootstrap data' }, 400);

    const tenantId = c.req.param('tenantId');
    const tenant = await findTenantAdminBootstrap(c.env.DB, tenantId);
    if (!tenant) return c.json({ success: false, error: 'Tenant not found' }, 404);

    if (tenant.bootstrap_staff_id) {
      // Replay is recognized from (tenantId, loginId) while the bootstrap
      // credential is still unused — same rule as the platform-admins route.
      // The CLI password is random per run, so it is deliberately not
      // re-verified and the stored password is not rotated.
      const replayed = tenant.login_id === input.loginId &&
        tenant.must_change_password === 1;
      if (!replayed) {
        return c.json({ success: false, error: 'Tenant admin is already configured' }, 409);
      }
      return c.json({
        success: true,
        data: adminBootstrapResponse(tenant, tenant.bootstrap_staff_id, tenant.login_id!, true),
      });
    }

    const existing = await c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM tenant_admin_credentials WHERE tenant_id = ?`,
    ).bind(tenantId).first<{ count: number }>();
    if ((existing?.count ?? 0) > 0) {
      return c.json({ success: false, error: 'Tenant admin is already configured' }, 409);
    }

    const staffId = crypto.randomUUID();
    const now = new Date().toISOString();
    let passwordHash: string;
    try {
      passwordHash = await hashTenantPassword(input.temporaryPassword);
    } catch (error) {
      console.error(
        '[tenant-admin-bootstrap] password hashing failed',
        error instanceof Error ? error.message : 'unknown error',
      );
      return c.json({ success: false, error: 'Tenant admin bootstrap failed' }, 500);
    }
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO staff_members
            (id, name, email, role, api_key, is_active, created_at, updated_at)
           VALUES (?, ?, ?, 'owner', ?, 1, ?, ?)`,
        ).bind(
          staffId, input.displayName, input.email,
          `disabled:${crypto.randomUUID()}`, now, now,
        ),
        c.env.DB.prepare(
          `INSERT INTO tenant_staff_memberships
            (tenant_id, staff_id, role, is_active, created_at, updated_at)
           VALUES (?, ?, 'owner', 1, ?, ?)`,
        ).bind(tenantId, staffId, now, now),
        c.env.DB.prepare(
          `INSERT INTO pharmacy_staff_accounts
            (line_account_id, staff_id, is_active, created_at, updated_at)
           SELECT line_account_id, ?, 1, ?, ?
             FROM tenant_line_accounts
            WHERE tenant_id = ?`,
        ).bind(staffId, now, now, tenantId),
        c.env.DB.prepare(
          `INSERT INTO tenant_admin_credentials
            (tenant_id, staff_id, login_id, password_hash, must_change_password,
             credential_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
        ).bind(tenantId, staffId, input.loginId, passwordHash, now, now),
        c.env.DB.prepare(
          `INSERT INTO pharmacy_tenant_admin_bootstraps
            (tenant_id, staff_id, created_at)
           VALUES (?, ?, ?)`,
        ).bind(tenantId, staffId, now),
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO pharmacy_growth_events
            (id, line_account_id, event_type, aggregate_id, subject_key,
             schema_version, occurred_at, idempotency_key, metadata_json, created_at)
           VALUES (?, ?, 'tenant_admin_bootstrapped', ?, NULL, 1, ?, ?, '{}', ?)`,
        ).bind(
          crypto.randomUUID(), tenant.line_account_id, staffId, now,
          `tenant-admin-bootstrap:${tenantId}`, now,
        ),
      ]);
    } catch (error) {
      console.error(
        '[tenant-admin-bootstrap] database batch failed',
        error instanceof Error ? error.message : 'unknown error',
      );
      const raced = await findTenantAdminBootstrap(c.env.DB, tenantId);
      const replayed = raced?.bootstrap_staff_id && raced.login_id === input.loginId &&
        raced.must_change_password === 1;
      if (replayed) {
        return c.json({
          success: true,
          data: adminBootstrapResponse(raced, raced.bootstrap_staff_id!, raced.login_id!, true),
        });
      }
      return c.json({ success: false, error: 'Tenant admin bootstrap failed' }, 409);
    }

    return c.json({
      success: true,
      data: adminBootstrapResponse(tenant, staffId, input.loginId, false),
    }, 201);
  },
);

tenantProvisioningRoutes.post(
  '/api/platform/pharmacy/tenants/:tenantId/cli-sessions',
  async (c) => {
    c.header('Cache-Control', 'no-store, private');
    const rejected = await rejectUnauthorizedPlatformRequest(c, false);
    if (rejected) return rejected;

    const tenantId = c.req.param('tenantId');
    const input = parseCliBreakGlassInput(await c.req.json().catch(() => null));
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(tenantId) || !input) {
      return c.json({ success: false, error: 'Invalid CLI session request' }, 400);
    }

    const platformAdmin = await c.env.DB.prepare(
      `SELECT credential.staff_id, staff.name
         FROM platform_admin_credentials AS credential
         INNER JOIN platform_admins AS admin
                 ON admin.staff_id = credential.staff_id AND admin.is_active = 1
         INNER JOIN staff_members AS staff
                 ON staff.id = credential.staff_id AND staff.is_active = 1
        WHERE credential.login_id = ? COLLATE NOCASE
        LIMIT 1`,
    ).bind(input.platformAdminLoginId).first<{ staff_id: string; name: string }>();
    if (!platformAdmin) return c.json({ success: false, error: 'Platform admin not found' }, 404);

    const owner = await c.env.DB.prepare(
      `SELECT credential.staff_id, credential.credential_version
         FROM tenant_admin_credentials AS credential
         INNER JOIN tenants AS tenant
                 ON tenant.id = credential.tenant_id AND tenant.status = 'active'
         INNER JOIN staff_members AS staff
                 ON staff.id = credential.staff_id AND staff.is_active = 1
         INNER JOIN tenant_staff_memberships AS membership
                 ON membership.tenant_id = credential.tenant_id
                AND membership.staff_id = credential.staff_id
                AND membership.role = 'owner' AND membership.is_active = 1
        WHERE credential.tenant_id = ?
          AND credential.must_change_password = 0
          AND NOT EXISTS (
            SELECT 1
              FROM tenant_line_accounts AS mapping
              LEFT JOIN pharmacy_staff_accounts AS assignment
                     ON assignment.line_account_id = mapping.line_account_id
                    AND assignment.staff_id = credential.staff_id
                    AND assignment.is_active = 1
             WHERE mapping.tenant_id = credential.tenant_id
               AND assignment.staff_id IS NULL
          )
        ORDER BY credential.created_at
        LIMIT 1`,
    ).bind(tenantId).first<{ staff_id: string; credential_version: number }>();
    if (!owner) return c.json({ success: false, error: 'Active tenant owner not found' }, 404);

    const sessionToken = generateTenantAdminSessionToken();
    const tokenHash = await hashTenantAdminSessionToken(sessionToken);
    const csrfToken = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 120 * 60_000).toISOString();
    const now = issuedAt.toISOString();
    try {
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO tenant_admin_sessions
            (token_hash, tenant_id, staff_id, credential_version, session_kind,
             expires_at, revoked_at, created_at)
           VALUES (?, ?, ?, ?, 'standard', ?, NULL, ?)`,
        ).bind(tokenHash, tenantId, owner.staff_id, owner.credential_version, expiresAt, now),
        c.env.DB.prepare(
          `INSERT INTO pharmacy_cli_break_glass_sessions
            (id, token_hash, platform_admin_id, tenant_id, staff_id, operation_scope,
             reason, ticket_reference, issued_at, expires_at, revoked_at, revoked_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        ).bind(
          sessionId, tokenHash, platformAdmin.staff_id, tenantId, owner.staff_id,
          'all', input.reason, input.ticketReference, now, expiresAt,
        ),
        platformAdminAccessStatement(
          c.env.DB,
          platformAdmin.staff_id,
          tenantId,
          'cli_break_glass_started',
          'cli_session',
          sessionId,
          {
            authentication: 'platform_admin_key',
            operationScope: 'all',
            reason: input.reason,
            ticketReference: input.ticketReference,
            expiresAt,
          },
        ),
      ]);
      if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
        return c.json({ success: false, error: 'CLI session creation conflicted' }, 409);
      }
    } catch {
      return c.json({ success: false, error: 'CLI session creation failed' }, 409);
    }

    return c.json({
      success: true,
      data: {
        sessionId,
        sessionToken,
        csrfToken,
        tenantId,
        expiresAt,
        operationScope: 'all',
      },
    }, 201);
  },
);

tenantProvisioningRoutes.post(
  '/api/platform/pharmacy/tenants/:tenantId/cli-sessions/:sessionId/revoke',
  async (c) => {
    c.header('Cache-Control', 'no-store, private');
    const rejected = await rejectUnauthorizedPlatformRequest(c, false);
    if (rejected) return rejected;

    const tenantId = c.req.param('tenantId');
    const sessionId = c.req.param('sessionId');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(tenantId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)) {
      return c.json({ success: false, error: 'Invalid CLI session' }, 400);
    }

    const session = await c.env.DB.prepare(
      `SELECT cli.token_hash, cli.platform_admin_id
         FROM pharmacy_cli_break_glass_sessions AS cli
         INNER JOIN platform_admins AS admin
                 ON admin.staff_id = cli.platform_admin_id AND admin.is_active = 1
        WHERE cli.id = ? AND cli.tenant_id = ? AND cli.revoked_at IS NULL
        LIMIT 1`,
    ).bind(sessionId, tenantId).first<{
      token_hash: string;
      platform_admin_id: string;
    }>();
    if (!session) return c.json({ success: false, error: 'Active CLI session not found' }, 404);

    const now = new Date().toISOString();
    try {
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE tenant_admin_sessions SET revoked_at = ?
            WHERE token_hash = ? AND revoked_at IS NULL`,
        ).bind(now, session.token_hash),
        c.env.DB.prepare(
          `UPDATE pharmacy_cli_break_glass_sessions
              SET revoked_at = ?, revoked_by = ?
            WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
        ).bind(now, session.platform_admin_id, sessionId, tenantId),
        platformAdminAccessStatement(
          c.env.DB,
          session.platform_admin_id,
          tenantId,
          'cli_break_glass_ended',
          'cli_session',
          sessionId,
        ),
      ]);
      if (results[1].meta.changes !== 1) {
        return c.json({ success: false, error: 'CLI session revocation conflicted' }, 409);
      }
    } catch {
      return c.json({ success: false, error: 'CLI session revocation failed' }, 409);
    }
    return c.json({ success: true, data: { sessionId, revokedAt: now } });
  },
);

/**
 * POST /api/platform/pharmacy/platform-admins
 *
 * Bootstraps the FIRST platform administrator — the chicken-and-egg case, since
 * /api/platform-admin/login needs a platform_admin_credentials row to exist.
 * Deliberately lives under the CLI provisioning namespace and is gated by
 * PLATFORM_ADMIN_KEY: the two prefixes serve two different audiences (CLI
 * operator vs. logged-in human).
 *
 * PLATFORM_ADMIN_KEY alone is sufficient ONLY while zero active platform
 * admins exist. Once at least one does, minting another additionally
 * requires the caller to already be an authenticated, active platform
 * admin (their own session cookie, checked below) — a shared CLI secret is
 * not, by itself, enough to keep growing the set of standing superusers
 * with cross-tenant PHI access. This does not block the sibling tenant-
 * provisioning routes below, which stay PLATFORM_ADMIN_KEY-only: creating a
 * tenant is routine operator work, minting a platform admin is not.
 *
 * That "zero admins exist" test is a check-then-act read, so two concurrent
 * key-only runs could both pass it. The invariant is enforced in the database
 * instead: migration custom_032 adds a partial unique index over
 * platform_admins.granted_by = 'platform-admin-key' — the value this route
 * writes for the key-only path, as opposed to the acting admin's staff id for
 * the session-authorized path. The loser of the race fails the insert batch
 * and falls into the catch below as a 409.
 *
 * Replay is keyed on the login id, not on the password: see the comment at
 * the existing-credential branch.
 */
tenantProvisioningRoutes.post('/api/platform/pharmacy/platform-admins', async (c) => {
  const rejected = await rejectUnauthorizedPlatformRequest(c);
  if (rejected) return rejected;
  const input = parseAdminBootstrapInput(await c.req.json().catch(() => null));
  if (!input) return c.json({ success: false, error: 'Invalid platform admin data' }, 400);

  const anyActiveAdmin = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM platform_admins WHERE is_active = 1 LIMIT 1`,
  ).first<{ ok: number }>();
  let actingAdminId = 'platform-admin-key';
  if (anyActiveAdmin) {
    const token = platformAdminSessionTokenFromCookie(c);
    const resolved = token ? await resolvePlatformAdminSession(c.env.DB, token) : null;
    if (!resolved || resolved.mustChangePassword) {
      return c.json({
        success: false,
        error: 'A platform admin already exists; creating another requires an authenticated ' +
          'platform-admin session in addition to PLATFORM_ADMIN_KEY',
      }, 403);
    }
    actingAdminId = resolved.admin.id;
  }

  const existing = await c.env.DB.prepare(
    `SELECT credential.staff_id, credential.password_hash, credential.must_change_password
       FROM platform_admin_credentials AS credential
      WHERE credential.login_id = ? COLLATE NOCASE
      LIMIT 1`,
  ).bind(input.loginId).first<{
    staff_id: string;
    password_hash: string;
    must_change_password: number;
  }>();
  if (existing) {
    // Replay is recognized from the login id alone. The CLI now generates a
    // random temporary password (it used to derive one from the platform key,
    // which made it recomputable offline by anyone holding that key), so a
    // retry cannot re-present the stored credential and re-verifying it here
    // would turn every lost response into a permanent 409. An unused bootstrap
    // credential is a replay; one already in use is a genuine collision.
    if (existing.must_change_password !== 1) {
      return c.json({ success: false, error: 'Platform admin login is already taken' }, 409);
    }
    // Deliberately does NOT rotate the stored password to the one just
    // submitted: the operator may already be holding the original.
    return c.json({
      success: true,
      data: { staffId: existing.staff_id, adminLoginId: input.loginId, replayed: true },
    });
  }

  const staffId = crypto.randomUUID();
  const now = new Date().toISOString();
  let passwordHash: string;
  try {
    passwordHash = await hashTenantPassword(input.temporaryPassword);
  } catch (error) {
    console.error(
      '[platform-admin-bootstrap] password hashing failed',
      error instanceof Error ? error.message : 'unknown error',
    );
    return c.json({ success: false, error: 'Platform admin bootstrap failed' }, 500);
  }
  try {
    await c.env.DB.batch([
      // role 'owner' plus a disabled api_key: the staff row exists to satisfy
      // the platform_admins FK and carry the display name, never to grant a
      // Bearer identity or any tenant membership.
      c.env.DB.prepare(
        `INSERT INTO staff_members
          (id, name, email, role, api_key, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', ?, 1, ?, ?)`,
      ).bind(
        staffId, input.displayName, input.email,
        `disabled:${crypto.randomUUID()}`, now, now,
      ),
      c.env.DB.prepare(
        `INSERT INTO platform_admins (staff_id, granted_by, is_active, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      ).bind(staffId, actingAdminId, now, now),
      c.env.DB.prepare(
        `INSERT INTO platform_admin_credentials
          (staff_id, login_id, password_hash, must_change_password,
           credential_version, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?)`,
      ).bind(staffId, input.loginId, passwordHash, now, now),
    ]);
  } catch (error) {
    console.error(
      '[platform-admin-bootstrap] database batch failed',
      error instanceof Error ? error.message : 'unknown error',
    );
    return c.json({ success: false, error: 'Platform admin bootstrap failed' }, 409);
  }

  return c.json({
    success: true,
    data: { staffId, adminLoginId: input.loginId, replayed: false },
  }, 201);
});

for (const phase of ['backfill', 'scrub', 'restore'] as const) {
  tenantProvisioningRoutes.post(
    `/api/platform/pharmacy/tenants/:tenantId/line-accounts/:lineAccountId/credentials/${phase}`,
    async (c) => {
      const rejected = await rejectUnauthorizedPlatformRequest(c);
      if (rejected) return rejected;
      const input = {
        tenantId: c.req.param('tenantId'),
        lineAccountId: c.req.param('lineAccountId'),
      };
      try {
        const result = phase === 'backfill'
          ? await backfillLineCredentials(c.env.DB, c.env.LINE_CREDENTIAL_KEY_V1!, input)
          : phase === 'scrub'
            ? await scrubLegacyLineCredentials(c.env.DB, c.env.LINE_CREDENTIAL_KEY_V1!, input)
            : await restoreLegacyLineCredentials(c.env.DB, c.env.LINE_CREDENTIAL_KEY_V1!, input);
        const now = new Date().toISOString();
        await c.env.DB.prepare(
          `INSERT OR IGNORE INTO pharmacy_growth_events
            (id, line_account_id, event_type, aggregate_id, subject_key,
             schema_version, occurred_at, idempotency_key, metadata_json, created_at)
           VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          input.lineAccountId,
          `line_credentials_${phase}`,
          input.tenantId,
          now,
          `line-credentials:${phase}:v1`,
          JSON.stringify(result),
          now,
        ).run();
        return c.json({ success: true, data: result });
      } catch {
        return c.json({ success: false, error: `LINE credential ${phase} failed` }, 409);
      }
    },
  );
}

for (const phase of ['coverage', 'backfill', 'freeze', 'scrub', 'restore'] as const) {
  tenantProvisioningRoutes.post(
    `/api/platform/pharmacy/tenants/:tenantId/line-accounts/:lineAccountId/intake-encryption/${phase}`,
    async (c) => {
      const rejected = await rejectUnauthorizedPlatformRequest(c);
      if (rejected) return rejected;
      if (phase === 'freeze') {
        return c.json({ success: false, error: 'Legacy intake freeze route is disabled' }, 409);
      }
      const cryptoScope = resolvePatientIntakeCryptoScope(c.env, c.req.param('tenantId'));
      if (!cryptoScope) {
        return c.json({ success: false, error: 'Patient intake encryption is not configured' }, 503);
      }
      const scope = {
        ...cryptoScope,
        lineAccountId: c.req.param('lineAccountId'),
      };
      const rawBody = await c.req.json().catch(() => null);
      const body = phase === 'coverage' && rawBody === null ? {} : asRecord(rawBody);
      if (!body) return c.json({ success: false, error: 'Invalid migration input' }, 400);
      if (containsLegacyRecoveryIdentity(body)) {
        return c.json({ success: false, error: 'Legacy recovery identity fields are not accepted' }, 400);
      }
      const cursor = body.cursor === null || body.cursor === undefined
        ? null
        : typeof body.cursor === 'string' ? body.cursor : undefined;
      const limit = body.limit === undefined ? 50 : body.limit;
      if (cursor === undefined || !Number.isSafeInteger(limit)) {
        return c.json({ success: false, error: 'Invalid migration input' }, 400);
      }
      const dryRun = true;
      const result = phase === 'coverage'
        ? await inspectPatientIntakeCoverage(c.env.DB, scope)
        : phase === 'backfill'
            ? await backfillPatientIntakeEnvelopes(c.env.DB, { ...scope, cursor, limit: limit as number, dryRun })
            : phase === 'scrub'
              ? await scrubPatientIntakeLegacyFields(c.env.DB, {
                ...scope, cursor, limit: limit as number, dryRun,
              })
              : await restorePatientIntakeLegacyFields(c.env.DB, {
                ...scope, cursor, limit: limit as number, dryRun,
              });
      return result.errorCode
        ? c.json({ success: false, error: result.errorCode, data: result }, 409)
        : c.json({ success: true, data: result });
    },
  );
}
