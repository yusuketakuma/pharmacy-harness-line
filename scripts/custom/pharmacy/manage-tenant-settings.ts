import { open, readFile, unlink } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { required } from './cli-common.js';
import {
  findPharmacyAdminApiCoverage,
  type PharmacyAdminApiCoverage,
} from '../../../apps/worker/src/custom/pharmacy/platform-admin/api-coverage.js';

type Environment = Record<string, string | undefined>;
type Reader = (path: string) => Promise<Buffer>;
type Writer = (line: string) => void;
type CredentialReader = (service: string) => string | undefined;

const VALUE_FLAGS = new Set([
  'worker-url', 'tenant-id', 'account-id', 'method', 'path', 'input', 'content-type',
  'secret-output',
  'rich-menu-default', 'rich-menu-publish', 'rich-menu-rollback',
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

Staff creation and password reset responses contain a one-time password. Save them to a new
owner-only file with --secret-output FILE; the secret is never printed to stdout.
If the response is lost, the file records UNKNOWN_OUTCOME and the command exits 2. Do not retry
blindly; verify the staff record and issue an explicit password reset when recovery is needed.

Set the published rich menu used by default:
  pnpm tenant:settings -- ... \\
    --account-id LINE_ACCOUNT_ID \\
    --rich-menu-default GROUP_ID \\
    --apply

Publish a saved rich-menu version:
  pnpm tenant:settings -- ... \\
    --account-id LINE_ACCOUNT_ID \\
    --rich-menu-publish GROUP_ID \\
    --apply

Roll back to a known-good rich-menu version:
  pnpm tenant:settings -- ... \\
    --account-id LINE_ACCOUNT_ID \\
    --rich-menu-rollback GROUP_ID \\
    --apply

Options:
  --method GET|POST|PUT|PATCH|DELETE (default: GET)
  --input FILE
  --content-type TYPE (default: application/json)
  --secret-output FILE (required with --apply when the response contains a one-time password)
  --preflight --account-id LINE_ACCOUNT_ID (read-only activation check)
  --doctor --account-id LINE_ACCOUNT_ID (read-only config check; exits 0/2/3)
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
  let preflight = false;
  let doctor = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--preflight') {
      preflight = true;
      continue;
    }
    if (argument === '--doctor') {
      doctor = true;
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
  if (preflight && doctor) throw new Error('--preflight and --doctor cannot be combined');
  return { values, apply, preflight, doctor, help };
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

function accountPin(
  coverage: PharmacyAdminApiCoverage,
  url: URL,
  values: Record<string, string>,
): string | undefined {
  const supplied = values['account-id']?.trim();
  if (coverage.accountScope === 'tenant') {
    if (supplied) throw new Error('--account-id is not supported for this tenant-scoped path');
    return undefined;
  }
  const accountId = required(values, 'account-id');
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(accountId)) throw new Error('--account-id is invalid');
  if (coverage.accountScope === 'path:last') {
    const pathAccountId = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1));
    if (pathAccountId !== accountId) throw new Error('--path account does not match --account-id');
    return accountId;
  }
  if (coverage.accountScope === 'path:before-last') {
    const segments = url.pathname.split('/').filter(Boolean);
    const pathAccountId = decodeURIComponent(segments.at(-2) ?? '');
    if (pathAccountId !== accountId) throw new Error('--path account does not match --account-id');
    return accountId;
  }
  const queryKey = coverage.accountScope.slice('query:'.length);
  const scoped = ['accountId', 'account_id', 'line_account_id']
    .flatMap((key) => url.searchParams.getAll(key));
  if (url.searchParams.getAll(queryKey).length !== 1 ||
      scoped.length === 0 || scoped.some((value) => value !== accountId)) {
    throw new Error('--path account does not match --account-id');
  }
  return accountId;
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
  const doctorRequested = argv.includes('--doctor');
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
    if (parsed.preflight || parsed.doctor) {
      const command = parsed.doctor ? '--doctor' : '--preflight';
      if (parsed.apply) throw new Error(`${command} cannot be combined with --apply`);
      if (parsed.values.method || parsed.values.path || parsed.values.input ||
          parsed.values['content-type'] || parsed.values['secret-output'] ||
          parsed.values['rich-menu-default'] ||
          parsed.values['rich-menu-publish'] || parsed.values['rich-menu-rollback']) {
        throw new Error(`${command} cannot be combined with request or mutation options`);
      }
      const accountId = required(parsed.values, 'account-id');
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(accountId)) throw new Error('--account-id is invalid');
      const url = new URL(
        `/api/platform-admin/tenants/${encodeURIComponent(tenantId)}/line-status`,
        endpoint(workerUrl, '/api/settings').origin,
      );
      if (parsed.doctor) url.searchParams.set('verifyLiffEndpoint', accountId);
      return await withPlatformSession(workerUrl, loginId, password, fetcher, async (session) => {
        const response = await fetcher(url.toString(), {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000),
          headers: { Cookie: session.cookie },
        });
        const payload = await response.json().catch(() => null) as {
          success?: boolean;
          data?: Array<{
            id?: unknown;
            configurationDoctor?: {
              accountId?: unknown;
              checkedAt?: unknown;
              status?: unknown;
              reasonCodes?: unknown;
              checks?: unknown;
            };
          }>;
        } | null;
        const account = payload?.data?.find((candidate) => candidate.id === accountId);
        if (!response.ok || !payload?.success || !account) {
          write(response.ok ? 'Preflight account was not found.' : `Request failed (${response.status}).`);
          return parsed.doctor ? 3 : 1;
        }
        const projection = account.configurationDoctor;
        if (projection?.accountId !== accountId || typeof projection.checkedAt !== 'string' ||
            !['READY', 'BLOCKED', 'UNVERIFIED'].includes(String(projection.status)) ||
            !Array.isArray(projection.reasonCodes) ||
            !projection.reasonCodes.every((value) => typeof value === 'string') ||
            !Array.isArray(projection.checks)) {
          write('Configuration doctor projection unavailable.');
          return parsed.doctor ? 3 : 1;
        }
        const status = projection.status as 'READY' | 'BLOCKED' | 'UNVERIFIED';
        write(JSON.stringify({
          accountId: projection.accountId,
          checkedAt: projection.checkedAt,
          status,
          reasonCodes: projection.reasonCodes,
          checks: projection.checks,
          localCredentials: {
            loginIdConfigured: Boolean(loginId),
            passwordConfigured: Boolean(password),
          },
        }, null, 2));
        if (parsed.doctor) return status === 'READY' ? 0 : status === 'BLOCKED' ? 2 : 3;
        return status === 'READY' ? 0 : 1;
      });
    }
    const richMenuDefault = parsed.values['rich-menu-default']?.trim();
    const richMenuPublish = parsed.values['rich-menu-publish']?.trim();
    const richMenuRollback = parsed.values['rich-menu-rollback']?.trim();
    if ([richMenuDefault, richMenuPublish, richMenuRollback].filter(Boolean).length > 1) {
      throw new Error('rich-menu publish, default, and rollback options cannot be combined');
    }
    const richMenuGroupId = richMenuDefault ?? richMenuPublish ?? richMenuRollback;
    if (richMenuGroupId) {
      const option = richMenuDefault ? '--rich-menu-default'
        : richMenuPublish ? '--rich-menu-publish' : '--rich-menu-rollback';
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(richMenuGroupId)) {
        throw new Error(`${option} is invalid`);
      }
      if (parsed.values.method || parsed.values.path || parsed.values.input ||
          parsed.values['content-type'] || parsed.values['secret-output']) {
        throw new Error(`${option} cannot be combined with request options`);
      }
      const accountId = required(parsed.values, 'account-id');
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(accountId)) throw new Error('--account-id is invalid');
      const url = endpoint(
        workerUrl,
        `/api/rich-menu-groups/${encodeURIComponent(richMenuGroupId)}/${richMenuPublish ? 'publish' : 'apply-to-tag'}?accountId=${encodeURIComponent(accountId)}`,
      );
      if (!findPharmacyAdminApiCoverage('POST', url.pathname)) {
        throw new Error('Rich menu operation is not in pharmacy admin API coverage');
      }
      if (!parsed.apply) {
        const action = richMenuPublish ? 'publish' : richMenuRollback ? 'rollback' : 'set default';
        write(`Dry run: ${action} rich menu ${richMenuGroupId} for tenant ${tenantId}. Add --apply to send.`);
        return 0;
      }
      return await withPlatformSession(workerUrl, loginId, password, fetcher, async (session) => {
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
        const previewBody = !richMenuPublish
          ? {
              mode: 'set-default', enabled: true,
              ...(richMenuRollback ? { intent: 'rollback' } : {}), dryRun: true,
            }
          : { dryRun: true };
        const preview = await request(previewBody);
        const previewPayload = await preview.json().catch(() => null) as {
          success?: boolean;
          data?: { confirmationToken?: unknown };
        } | null;
        const confirmationToken = previewPayload?.data?.confirmationToken;
        if (!preview.ok || !previewPayload?.success || typeof confirmationToken !== 'string' || !confirmationToken) {
          write(preview.ok ? 'Rich menu confirmation token was not returned.' : `Request failed (${preview.status}).`);
          return 1;
        }
        const applied = await request(!richMenuPublish
          ? {
              mode: 'set-default', enabled: true,
              ...(richMenuRollback ? { intent: 'rollback' } : {}),
              dryRun: false, confirmationToken,
            }
          : { dryRun: false, confirmationToken });
        const appliedPayload = await applied.json().catch(() => null) as { success?: boolean } | null;
        if (!applied.ok || !appliedPayload?.success) {
          write(`Request failed (${applied.status}).`);
          return 1;
        }
        write(richMenuPublish
          ? `Rich menu version published for tenant ${tenantId}.`
          : richMenuRollback
            ? `Rich menu rolled back for tenant ${tenantId}.`
            : `Default rich menu updated for tenant ${tenantId}.`);
        return 0;
      });
    }

    const method = (parsed.values.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && !MUTATING_METHODS.has(method)) throw new Error('--method is invalid');
    const url = endpoint(workerUrl, required(parsed.values, 'path'));
    const coverage = findPharmacyAdminApiCoverage(method, url.pathname);
    if (!coverage || (!coverage.safeOutput && !coverage.secretOutput)) {
      throw new Error('--path is not in pharmacy admin API coverage');
    }
    if (coverage.mutationGate === 'confirmation') {
      throw new Error('Use the dedicated rich-menu option for confirmation-gated operations');
    }
    const accountId = accountPin(coverage, url, parsed.values);
    const inputPath = parsed.values.input;
    const secretOutputPath = parsed.values['secret-output']?.trim();
    if (method === 'GET' && inputPath) throw new Error('--input cannot be used with GET');
    if (method === 'GET' && parsed.apply) throw new Error('--apply cannot be used with GET');
    if (secretOutputPath && !coverage.secretOutput) {
      throw new Error('--secret-output is only supported for one-time credential responses');
    }
    if (coverage.secretOutput && parsed.apply && !secretOutputPath) {
      throw new Error('--secret-output is required for this credential mutation');
    }

    let body: Buffer | undefined;
    const contentType = parsed.values['content-type'] ?? 'application/json';
    if (inputPath) {
      body = await reader(inputPath);
      if (contentType === 'application/json') {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        } catch {
          throw new Error('--input must contain valid JSON');
        }
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
          throw new Error('--input must contain a JSON object');
        }
        if (accountId && ['accountId', 'account_id', 'line_account_id'].some((key) =>
          input[key] !== undefined && input[key] !== accountId)) {
          throw new Error('--input account does not match --account-id');
        }
      }
    }

    if (MUTATING_METHODS.has(method) && !parsed.apply) {
      write(`Dry run: ${method} ${url.pathname} for tenant ${tenantId}. Add --apply to send.`);
      return 0;
    }

    let secretFile: Awaited<ReturnType<typeof open>> | undefined;
    let keepSecretFile = false;
    try {
      if (secretOutputPath) {
        try {
          secretFile = await open(secretOutputPath, 'wx', 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error('--secret-output already exists');
          }
          throw new Error('--secret-output could not be created');
        }
      }
      return await withPlatformSession(workerUrl, loginId, password, fetcher, async (session) => {
        const writeUnknownCredentialOutcome = async (reason: string): Promise<number> => {
          await secretFile!.writeFile(`${JSON.stringify({
            status: 'UNKNOWN_OUTCOME',
            reason,
            tenantId,
            method,
            path: url.pathname,
            recovery: 'verify_staff_then_reset_password',
            recordedAt: new Date().toISOString(),
          }, null, 2)}\n`, { encoding: 'utf8' });
          await secretFile!.sync();
          keepSecretFile = true;
          write(`Credential mutation outcome is unknown. Marker written to ${secretOutputPath}. Do not retry blindly; verify staff state and issue an explicit password reset if needed.`);
          return 2;
        };
        let response: Response;
        try {
          response = await fetcher(url.toString(), {
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
        } catch {
          if (coverage.secretOutput) return writeUnknownCredentialOutcome('response_lost');
          throw new Error('Tenant settings request failed');
        }
        if (!response.ok) {
          write(`Request failed (${response.status}).`);
          return 1;
        }
        if (coverage.secretOutput) {
          let responseText: string;
          try {
            responseText = await response.text();
          } catch {
            return writeUnknownCredentialOutcome('response_body_lost');
          }
          const payload = (() => {
            try {
              return JSON.parse(responseText) as { success?: unknown; data?: { temporaryPassword?: unknown } };
            } catch {
              return null;
            }
          })();
          if (payload?.success !== true || typeof payload.data?.temporaryPassword !== 'string' ||
              !payload.data.temporaryPassword) {
            return writeUnknownCredentialOutcome('unexpected_response');
          }
          await secretFile!.writeFile(`${responseText}\n`, { encoding: 'utf8' });
          await secretFile!.sync();
          keepSecretFile = true;
          write(`${method} completed for tenant ${tenantId}. Secret response written to ${secretOutputPath}.`);
          return 0;
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
          write('Response was not safe JSON.');
          return 1;
        }
        return 0;
      });
    } finally {
      if (secretFile) {
        await secretFile.close().catch(() => undefined);
        if (!keepSecretFile && secretOutputPath) await unlink(secretOutputPath).catch(() => undefined);
      }
    }
  } catch (error) {
    write(error instanceof Error ? error.message : 'Tenant settings request failed');
    return doctorRequested ? 3 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runTenantSettings(process.argv.slice(2), process.env)
    .then((exitCode) => { process.exitCode = exitCode; });
}
