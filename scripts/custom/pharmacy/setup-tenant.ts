import { createHmac, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

type Writer = (line: string) => void;
type Environment = Record<string, string | undefined>;

const VALUE_FLAGS = new Set([
  'worker-url',
  'tenant-name',
  'admin-id',
  'admin-name',
  'admin-email',
  'line-channel-id',
  'line-name',
  'line-login-channel-id',
  'liff-id',
  'idempotency-key',
]);

const HELP = `Usage:
  pnpm tenant:setup -- \\
    --worker-url https://api.example.jp \\
    --tenant-name "Example Pharmacy" \\
    --admin-id admin \\
    --admin-name "Owner" \\
    --line-channel-id 2000000000 \\
    --line-name "Example Pharmacy LINE"

Required secret environment variables:
  PHARMACY_PLATFORM_ADMIN_KEY
  PHARMACY_LINE_CHANNEL_ACCESS_TOKEN
  PHARMACY_LINE_CHANNEL_SECRET
  PHARMACY_LINE_LOGIN_CHANNEL_SECRET

Platform Worker prerequisites (set once with wrangler secret put):
  PLATFORM_ADMIN_KEY
  CROSS_ACCOUNT_TOKEN_KEY
  LINE_CREDENTIAL_KEY_V1

Options:
  --admin-email EMAIL
  --line-login-channel-id ID (required)
  --liff-id ID (required; must belong to the Login channel)
  --idempotency-key KEY (optional; reuse when a response is lost)
  --dry-run
  --help`;

function parseArgs(argv: string[]): { values: Record<string, string>; dryRun: boolean; help: boolean } {
  const values: Record<string, string> = {};
  let dryRun = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (!argument.startsWith('--') || !VALUE_FLAGS.has(argument.slice(2))) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${argument}`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  return { values, dryRun, help };
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function secret(environment: Environment, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function requestId(values: Record<string, string>): string {
  const supplied = values['idempotency-key']?.trim();
  if (supplied && !IDEMPOTENCY_KEY_PATTERN.test(supplied)) {
    throw new Error('--idempotency-key must be 8 to 128 ASCII characters');
  }
  return supplied || randomUUID();
}

// Keyed on the LINE channel id, not the pharmacy code: the code is now assigned by the
// server and does not exist yet at this point. The channel id is the tenant identity the
// caller does hold, and the server enforces it unique on line_accounts.channel_id — so two
// pharmacies that reuse one idempotency key still derive different initial passwords.
function temporaryPassword(
  platformKey: string,
  lineChannelId: string,
  idempotencyKey: string,
): string {
  const digest = createHmac('sha256', platformKey)
    .update(`pharmacy-tenant-setup:${lineChannelId}:${idempotencyKey}`)
    .digest('base64url');
  return `Tmp-${digest.slice(0, 32)}`;
}

function workerEndpoint(raw: string): string {
  const url = new URL(raw);
  if ((url.protocol !== 'https:' && url.hostname !== 'localhost') ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('--worker-url must be an HTTPS origin');
  }
  return new URL('/api/platform/pharmacy/tenants', url.origin).toString();
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value) return fallback;
  return value.replace(/[\u0000-\u001F\u007F]/gu, ' ').slice(0, 300);
}

export async function runTenantSetup(
  argv: string[],
  environment: Environment,
  fetcher: typeof fetch = fetch,
  write: Writer = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    write(error instanceof Error ? error.message : 'Invalid arguments');
    return 1;
  }
  if (parsed.help) {
    write(HELP);
    return 0;
  }

  try {
    const platformKey = secret(environment, 'PHARMACY_PLATFORM_ADMIN_KEY');
    const channelAccessToken = secret(environment, 'PHARMACY_LINE_CHANNEL_ACCESS_TOKEN');
    const channelSecret = secret(environment, 'PHARMACY_LINE_CHANNEL_SECRET');
    const loginChannelId = required(parsed.values, 'line-login-channel-id');
    const loginChannelSecret = secret(environment, 'PHARMACY_LINE_LOGIN_CHANNEL_SECRET');
    const liffId = required(parsed.values, 'liff-id');
    if (!liffId.startsWith(`${loginChannelId}-`)) {
      throw new Error('LIFF ID must belong to --line-login-channel-id');
    }

    const endpoint = workerEndpoint(required(parsed.values, 'worker-url'));
    const channelId = required(parsed.values, 'line-channel-id');
    const idempotencyKey = requestId(parsed.values);
    const generatedTemporaryPassword = temporaryPassword(platformKey, channelId, idempotencyKey);
    const body = {
      tenantName: required(parsed.values, 'tenant-name'),
      admin: {
        loginId: required(parsed.values, 'admin-id'),
        displayName: required(parsed.values, 'admin-name'),
        email: parsed.values['admin-email']?.trim() || null,
        temporaryPassword: generatedTemporaryPassword,
      },
      line: {
        channelId,
        displayName: required(parsed.values, 'line-name'),
        channelAccessToken,
        channelSecret,
        loginChannelId,
        loginChannelSecret,
        liffId,
      },
    };

    if (parsed.dryRun) {
      write('Dry run passed: required values and secrets are present. No request was sent.');
      return 0;
    }

    write(`再実行キー（保存）: ${idempotencyKey}`);

    let response: Response | null = null;
    let networkError = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(60_000),
          headers: {
            Authorization: `Bearer ${platformKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        });
        networkError = false;
        break;
      } catch {
        networkError = true;
      }
    }
    if (!response || networkError) {
      write('Tenant setup failed: network request failed. No credentials were printed.');
      return 1;
    }

    const payload = await response.json().catch(() => null) as {
      success?: boolean;
      error?: unknown;
      data?: {
        tenantCode?: unknown;
        adminLoginId?: unknown;
        urls?: Record<string, unknown>;
        line?: Record<string, unknown>;
        manualSteps?: unknown;
      };
    } | null;
    if (!response.ok || !payload?.success || !payload.data) {
      write(`Tenant setup failed (${response.status}): ${safeText(payload?.error, 'Unknown server error')}`);
      return 1;
    }

    const urls = payload.data.urls ?? {};
    const line = payload.data.line ?? {};
    write('初期テナント設定が完了しました。');
    write(`薬局コード: ${safeText(payload.data.tenantCode, '未取得')}`);
    write('薬局コードはサーバーが発行します。控え忘れた場合は同じ --idempotency-key で再実行してください。');
    write(`管理者ID: ${safeText(payload.data.adminLoginId, body.admin.loginId)}`);
    write(`仮パスワード（初回のみ表示）: ${generatedTemporaryPassword}`);
    write(`管理画面: ${safeText(urls.admin, '未設定')}`);
    write(`Webhook URL: ${safeText(urls.webhook, '未設定')}`);
    write(`LIFF Endpoint URL: ${safeText(urls.liffEndpoint, '未設定')}`);
    write(`LINEトークン検証: ${line.tokenValidated === true ? '成功' : '未確認'}`);
    write(`Webhook自動設定: ${line.webhookConfigured === true ? '成功' : '要手動確認'}`);
    if (Array.isArray(payload.data.manualSteps)) {
      for (const step of payload.data.manualSteps) {
        write(`手動確認: ${safeText(step, 'LINE Developersを確認してください')}`);
      }
    }
    write('初回ログイン後、仮パスワードの変更が必要です。');
    return 0;
  } catch (error) {
    write(error instanceof Error ? error.message : 'Tenant setup failed');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runTenantSetup(process.argv.slice(2), process.env)
    .then((exitCode) => { process.exitCode = exitCode; });
}
