import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

type Writer = (line: string) => void;
type Environment = Record<string, string | undefined>;

const HELP = `Usage:
  pnpm tenant:admin-bootstrap -- \\
    --worker-url https://api.example.jp \\
    --tenant-id tenant-id \\
    --admin-id admin \\
    --admin-name "Owner"

Required environment variable:
  PHARMACY_PLATFORM_ADMIN_KEY

Options:
  --admin-email EMAIL
  --idempotency-key KEY (optional; reuse when a response is lost)
  --dry-run
  --help`;

function parseArgs(argv: string[]) {
  const values: Record<string, string> = {};
  let dryRun = false;
  let help = false;
  const names = new Set(['--worker-url', '--tenant-id', '--admin-id', '--admin-name', '--admin-email', '--idempotency-key']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--dry-run') { dryRun = true; continue; }
    if (argument === '--help' || argument === '-h') { help = true; continue; }
    if (!names.has(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${argument}`);
    values[argument.slice(2)] = value;
  }
  return { values, dryRun, help };
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`--${key} is required`);
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

// Random per run: never derivable from the platform key + printed idempotency key.
// A replay (lost response) therefore cannot re-present the stored password; the
// server recognizes the replay by (tenantId, loginId) and leaves the original intact.
function temporaryPassword(): string {
  return `Tmp-${randomBytes(24).toString('base64url')}`;
}

function endpoint(values: Record<string, string>): string {
  const worker = new URL(required(values, 'worker-url'));
  if ((worker.protocol !== 'https:' && worker.hostname !== 'localhost') ||
      worker.username || worker.password || worker.search || worker.hash) {
    throw new Error('--worker-url must be an HTTPS origin');
  }
  return new URL(
    `/api/platform/pharmacy/tenants/${encodeURIComponent(required(values, 'tenant-id'))}/admin-bootstrap`,
    worker.origin,
  ).toString();
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value
    ? value.replace(/[\u0000-\u001F\u007F]/gu, ' ').slice(0, 300)
    : fallback;
}

export async function runTenantAdminBootstrap(
  argv: string[],
  environment: Environment,
  fetcher: typeof fetch = fetch,
  write: Writer = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) { write(HELP); return 0; }
    const platformKey = environment.PHARMACY_PLATFORM_ADMIN_KEY?.trim();
    if (!platformKey) throw new Error('PHARMACY_PLATFORM_ADMIN_KEY is required');
    const url = endpoint(parsed.values);
    required(parsed.values, 'tenant-id');
    const idempotencyKey = requestId(parsed.values);
    const body = {
      loginId: required(parsed.values, 'admin-id'),
      displayName: required(parsed.values, 'admin-name'),
      email: parsed.values['admin-email']?.trim() || null,
      temporaryPassword: temporaryPassword(),
    };
    if (parsed.dryRun) {
      write('Dry run passed. No request was sent.');
      return 0;
    }

    write(`再実行キー（保存）: ${idempotencyKey}`);

    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetcher(url, {
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
        break;
      } catch {
        response = null;
      }
    }
    if (!response) {
      write('Tenant admin bootstrap failed: network request failed. No credentials were printed.');
      return 1;
    }
    const payload = await response.json().catch(() => null) as {
      success?: boolean;
      error?: unknown;
      data?: { tenantCode?: unknown; adminLoginId?: unknown; replayed?: unknown };
    } | null;
    if (!response.ok || !payload?.success || !payload.data) {
      write(`Tenant admin bootstrap failed (${response.status}): ${safeText(payload?.error, 'Unknown server error')}`);
      return 1;
    }

    if (payload.data.replayed === true) {
      // The server kept the original credential; this run's password was never stored.
      write('管理者ログインは既に発行済みです（再実行のため新規発行なし）。');
      write(`薬局コード: ${safeText(payload.data.tenantCode, '未設定')}`);
      write(`管理者ID: ${safeText(payload.data.adminLoginId, body.loginId)}`);
      write('仮パスワードは作成時の1回だけ表示されます。控えが無い場合は管理画面のパスワード再発行を使ってください。');
      return 0;
    }

    write('既存テナントの管理者ログインを発行しました。');
    write(`薬局コード: ${safeText(payload.data.tenantCode, '未設定')}`);
    write(`管理者ID: ${safeText(payload.data.adminLoginId, body.loginId)}`);
    write(`仮パスワード（初回のみ表示）: ${body.temporaryPassword}`);
    write('初回ログイン後、仮パスワードの変更が必要です。');
    return 0;
  } catch (error) {
    write(error instanceof Error ? error.message : 'Tenant admin bootstrap failed');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runTenantAdminBootstrap(process.argv.slice(2), process.env)
    .then((exitCode) => { process.exitCode = exitCode; });
}
