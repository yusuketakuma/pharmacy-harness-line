import { readFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Environment = Record<string, string | undefined>;
type Reader = (path: string) => Promise<Buffer>;
type Writer = (line: string) => void;
type CredentialReader = (service: string) => string | undefined;

const VALUE_FLAGS = new Set([
  'worker-url', 'tenant-id', 'method', 'path', 'input', 'content-type', 'rich-menu-default',
]);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_PATH_PREFIXES = [
  '/api/auth',
  '/api/integrations',
  '/api/liff',
  '/api/platform',
  '/api/public',
];

const HELP = `Usage:
  PHARMACY_PLATFORM_ADMIN_LOGIN_ID=... \\
  PHARMACY_PLATFORM_ADMIN_PASSWORD=... \\
  pnpm tenant:settings -- \\
    --worker-url https://api.example.jp \\
    --tenant-id TENANT_ID \\
    --path /api/account-settings/link-base-url

Mutation (dry-run by default):
  pnpm tenant:settings -- ... \\
    --method PUT \\
    --path /api/account-settings/link-base-url \\
    --input settings.json \\
    --apply

Set the published rich menu used by default:
  pnpm tenant:settings -- ... \\
    --rich-menu-default GROUP_ID \\
    --apply

Options:
  --method GET|POST|PUT|PATCH|DELETE (default: GET)
  --input FILE
  --content-type TYPE (default: application/json)
  --apply (required to send a mutation)
  --help

On macOS, ph-id and ph-pw are read from Keychain or ~/.config/pharmacy-harness when environment variables are unset.`;

export function readCredentialFile(path: string): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return undefined;
    return readFileSync(path, 'utf8').replace(/\r?\n$/u, '') || undefined;
  } catch {
    return undefined;
  }
}

function readKeychainCredential(service: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const value = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return value.replace(/\r?\n$/u, '') || undefined;
  } catch {
    return undefined;
  }
}

function readStoredCredential(service: string): string | undefined {
  return readKeychainCredential(service) ??
    readCredentialFile(join(homedir(), '.config', 'pharmacy-harness', service));
}

function parseArgs(argv: string[]) {
  const values: Record<string, string> = {};
  let apply = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--apply') {
      apply = true;
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
  return { values, apply, help };
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function endpoint(workerUrl: string, path: string): URL {
  const origin = new URL(workerUrl);
  if ((origin.protocol !== 'https:' && origin.hostname !== 'localhost') ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('--worker-url must be an HTTPS origin');
  }
  if (!path.startsWith('/api/') || path.startsWith('//')) {
    throw new Error('--path must be a relative /api/ tenant admin path');
  }
  const url = new URL(path, origin);
  if (url.origin !== origin.origin || !url.pathname.startsWith('/api/') ||
      BLOCKED_PATH_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
    throw new Error('--path must be a relative /api/ tenant admin path');
  }
  return url;
}

type PlatformSession = { token: string; cookie: string; csrfToken: string };

function setCookieValue(headers: Headers, name: string): string | null {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? [headers.get('set-cookie') ?? ''];
  const match = values.join(',').match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`, 'u'));
  return match?.[1] ?? null;
}

async function withPlatformSession<T>(
  workerUrl: string,
  loginId: string,
  password: string,
  fetcher: typeof fetch,
  action: (session: PlatformSession) => Promise<T>,
): Promise<T> {
  const login = await fetcher(new URL('/api/platform-admin/login', new URL(workerUrl).origin).toString(), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId, password }),
  });
  const payload = await login.json().catch(() => null) as {
    success?: boolean;
    csrfToken?: unknown;
    data?: { mustChangePassword?: unknown };
  } | null;
  const token = setCookieValue(login.headers, 'lh_platform_admin_session');
  const csrfToken = payload?.csrfToken;
  if (!login.ok || !payload?.success || payload.data?.mustChangePassword !== false ||
      typeof token !== 'string' || !/^pas_[A-Za-z0-9_-]{43}$/u.test(token) ||
      typeof csrfToken !== 'string' || !csrfToken) {
    throw new Error('Platform administrator login failed');
  }
  const session = {
    token,
    csrfToken,
    cookie: `lh_platform_admin_session=${token}; lh_platform_admin_csrf=${encodeURIComponent(csrfToken)}`,
  };
  try {
    return await action(session);
  } finally {
    await fetcher(new URL('/api/platform-admin/logout', new URL(workerUrl).origin).toString(), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
      headers: {
        Cookie: session.cookie,
        'X-Platform-Admin-CSRF-Token': session.csrfToken,
      },
    }).catch(() => null);
  }
}

export async function runTenantSettings(
  argv: string[],
  environment: Environment,
  fetcher: typeof fetch = fetch,
  reader: Reader = readFile,
  write: Writer = (line) => process.stdout.write(`${line}\n`),
  credentialReader: CredentialReader = readStoredCredential,
): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      write(HELP);
      return 0;
    }

    const loginId = (environment.PHARMACY_PLATFORM_ADMIN_LOGIN_ID ?? credentialReader('ph-id'))?.trim();
    const password = environment.PHARMACY_PLATFORM_ADMIN_PASSWORD ?? credentialReader('ph-pw');
    if (!loginId) throw new Error('PHARMACY_PLATFORM_ADMIN_LOGIN_ID is required');
    if (!password) throw new Error('PHARMACY_PLATFORM_ADMIN_PASSWORD is required');
    const tenantId = required(parsed.values, 'tenant-id');
    if (!/^[A-Za-z0-9_:-]{1,128}$/u.test(tenantId)) throw new Error('--tenant-id is invalid');
    const workerUrl = required(parsed.values, 'worker-url');
    const richMenuDefault = parsed.values['rich-menu-default']?.trim();
    if (richMenuDefault) {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(richMenuDefault)) {
        throw new Error('--rich-menu-default is invalid');
      }
      if (parsed.values.method || parsed.values.path || parsed.values.input || parsed.values['content-type']) {
        throw new Error('--rich-menu-default cannot be combined with request options');
      }
      const url = endpoint(
        workerUrl,
        `/api/rich-menu-groups/${encodeURIComponent(richMenuDefault)}/apply-to-tag`,
      );
      if (!parsed.apply) {
        write(`Dry run: set rich menu ${richMenuDefault} as default for tenant ${tenantId}. Add --apply to send.`);
        return 0;
      }
      return withPlatformSession(workerUrl, loginId, password, fetcher, async (session) => {
        const request = async (body: Record<string, unknown>) => fetcher(url.toString(), {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(60_000),
          headers: {
            Authorization: `Bearer ${session.token}`,
            'X-Tenant-Id': tenantId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const preview = await request({ mode: 'set-default', enabled: true, dryRun: true });
        const previewPayload = await preview.json().catch(() => null) as {
          success?: boolean;
          data?: { confirmationToken?: unknown };
        } | null;
        const confirmationToken = previewPayload?.data?.confirmationToken;
        if (!preview.ok || !previewPayload?.success || typeof confirmationToken !== 'string' || !confirmationToken) {
          write(preview.ok ? 'Rich menu confirmation token was not returned.' : `Request failed (${preview.status}).`);
          return 1;
        }
        const applied = await request({
          mode: 'set-default', enabled: true, dryRun: false, confirmationToken,
        });
        const appliedPayload = await applied.json().catch(() => null) as { success?: boolean } | null;
        if (!applied.ok || !appliedPayload?.success) {
          write(`Request failed (${applied.status}).`);
          return 1;
        }
        write(`Default rich menu updated for tenant ${tenantId}.`);
        return 0;
      });
    }

    const method = (parsed.values.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && !MUTATING_METHODS.has(method)) throw new Error('--method is invalid');
    const url = endpoint(workerUrl, required(parsed.values, 'path'));
    const inputPath = parsed.values.input;
    if (method === 'GET' && inputPath) throw new Error('--input cannot be used with GET');
    if (method === 'GET' && parsed.apply) throw new Error('--apply cannot be used with GET');

    let body: Buffer | undefined;
    const contentType = parsed.values['content-type'] ?? 'application/json';
    if (inputPath) {
      body = await reader(inputPath);
      if (contentType === 'application/json') {
        try {
          JSON.parse(body.toString('utf8'));
        } catch {
          throw new Error('--input must contain valid JSON');
        }
      }
    }

    if (MUTATING_METHODS.has(method) && !parsed.apply) {
      write(`Dry run: ${method} ${url.pathname} for tenant ${tenantId}. Add --apply to send.`);
      return 0;
    }

    return withPlatformSession(workerUrl, loginId, password, fetcher, async (session) => {
      const response = await fetcher(url.toString(), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `Bearer ${session.token}`,
          'X-Tenant-Id': tenantId,
          ...(body ? { 'Content-Type': contentType } : {}),
        },
        body,
      });
      if (!response.ok) {
        write(`Request failed (${response.status}).`);
        return 1;
      }
      if (method !== 'GET') {
        write(`${method} completed for tenant ${tenantId}.`);
        return 0;
      }

      const text = await response.text();
      if (!text) return 0;
      try {
        write(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        write(text);
      }
      return 0;
    });
  } catch (error) {
    write(error instanceof Error ? error.message : 'Tenant settings request failed');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runTenantSettings(process.argv.slice(2), process.env)
    .then((exitCode) => { process.exitCode = exitCode; });
}
