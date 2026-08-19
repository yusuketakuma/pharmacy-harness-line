import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

type Writer = (line: string) => void;
type Environment = Record<string, string | undefined>;

const HELP = `Usage:
  pnpm platform:admin-bootstrap -- \\
    --worker-url https://api.example.jp \\
    --admin-id platform-owner \\
    --admin-name "Platform Owner"

Creates the first platform administrator — an identity above every tenant admin
that can read and edit across all tenants. Every access it later makes is
recorded in platform_admin_access_events.

Required environment variable:
  PHARMACY_PLATFORM_ADMIN_KEY

Options:
  --admin-email EMAIL
  --idempotency-key KEY (optional request id; replay is keyed on --admin-id)
  --dry-run
  --help`;

function parseArgs(argv: string[]) {
  const values: Record<string, string> = {};
  let dryRun = false;
  let help = false;
  const names = new Set(['--worker-url', '--admin-id', '--admin-name', '--admin-email', '--idempotency-key']);
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

/**
 * Random, never derived. A password computed from PHARMACY_PLATFORM_ADMIN_KEY
 * plus the (printed) login id and idempotency key can be recomputed offline by
 * anyone who later obtains that key, and it still works until the operator's
 * first login clears must_change_password — a platform-superuser takeover from
 * a leaked CI secret with no online guessing.
 *
 * Account-creation idempotency does not depend on the password: the server
 * recognizes a replay from the login id (see the platform-admins route).
 */
function temporaryPassword(): string {
  return `Tmp-${randomBytes(24).toString('base64url')}`;
}

function endpoint(values: Record<string, string>): string {
  const worker = new URL(required(values, 'worker-url'));
  if ((worker.protocol !== 'https:' && worker.hostname !== 'localhost') ||
      worker.username || worker.password || worker.search || worker.hash) {
    throw new Error('--worker-url must be an HTTPS origin');
  }
  return new URL('/api/platform/pharmacy/platform-admins', worker.origin).toString();
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value
    ? value.replace(/[\u0000-\u001F\u007F]/gu, ' ').slice(0, 300)
    : fallback;
}

export async function runPlatformAdminBootstrap(
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
    const loginId = required(parsed.values, 'admin-id');
    const idempotencyKey = requestId(parsed.values);
    const body = {
      loginId,
      displayName: required(parsed.values, 'admin-name'),
      email: parsed.values['admin-email']?.trim() || null,
      temporaryPassword: temporaryPassword(),
    };
    if (parsed.dryRun) {
      write('Dry run passed. No request was sent.');
      return 0;
    }

    write(`再実行キー: ${idempotencyKey}`);

    let response: Response | null = null;
    // True once the first attempt failed before we saw a response. If the
    // resend then comes back as a replay, that lost first attempt is what
    // created the account, so this run's password is the stored one.
    let resent = false;
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
        resent = true;
      }
    }
    if (!response) {
      write('Platform admin bootstrap failed: network request failed. No credentials were printed.');
      return 1;
    }
    const payload = await response.json().catch(() => null) as {
      success?: boolean;
      error?: unknown;
      data?: { adminLoginId?: unknown; replayed?: unknown };
    } | null;
    if (!response.ok || !payload?.success || !payload.data) {
      write(`Platform admin bootstrap failed (${response.status}): ${safeText(payload?.error, 'Unknown server error')}`);
      return 1;
    }

    const adminId = safeText(payload.data.adminLoginId, body.loginId);
    if (payload.data.replayed === true) {
      // The server left the existing credential untouched, so the password
      // this run generated is only real when our own lost first attempt is
      // what created the account.
      write('プラットフォーム管理者は既に作成済みです（再実行のため新規発行なし）。');
      write(`管理者ID: ${adminId}`);
      write(resent
        ? `仮パスワード（この実行で発行した値）: ${body.temporaryPassword}`
        : '仮パスワードは作成時の1回だけ表示されます。控えが無い場合は資格情報の再発行手順が必要です。');
      return 0;
    }

    write('プラットフォーム管理者を発行しました（全テナントを横断して閲覧・編集できます）。');
    write(`管理者ID: ${adminId}`);
    write(`仮パスワード（初回のみ表示）: ${body.temporaryPassword}`);
    write('初回ログイン後、仮パスワードの変更が必要です。');
    return 0;
  } catch (error) {
    write(error instanceof Error ? error.message : 'Platform admin bootstrap failed');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runPlatformAdminBootstrap(process.argv.slice(2), process.env)
    .then((exitCode) => { process.exitCode = exitCode; });
}
