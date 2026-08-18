import { pathToFileURL } from 'node:url';

type Writer = (line: string) => void;
type Environment = Record<string, string | undefined>;

const HELP = `Usage:
  pnpm tenant:line-credentials -- \\
    --worker-url https://api.example.jp \\
    --tenant-id tenant:example \\
    --line-account-id account-id \\
    --phase backfill

Required environment variable:
  PHARMACY_PLATFORM_ADMIN_KEY

Options:
  --phase backfill|scrub|restore
  --confirm-scrub  Required only for scrub
  --confirm-restore  Required only for restore
  --dry-run
  --help`;

function parseArgs(argv: string[]) {
  const values: Record<string, string> = {};
  let confirmScrub = false;
  let confirmRestore = false;
  let dryRun = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--confirm-scrub') { confirmScrub = true; continue; }
    if (argument === '--confirm-restore') { confirmRestore = true; continue; }
    if (argument === '--dry-run') { dryRun = true; continue; }
    if (argument === '--help' || argument === '-h') { help = true; continue; }
    if (!['--worker-url', '--tenant-id', '--line-account-id', '--phase'].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${argument}`);
    values[argument.slice(2)] = value;
  }
  return { values, confirmScrub, confirmRestore, dryRun, help };
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function endpoint(values: Record<string, string>): string {
  const worker = new URL(required(values, 'worker-url'));
  if ((worker.protocol !== 'https:' && worker.hostname !== 'localhost') ||
      worker.username || worker.password || worker.search || worker.hash) {
    throw new Error('--worker-url must be an HTTPS origin');
  }
  const phase = required(values, 'phase');
  if (phase !== 'backfill' && phase !== 'scrub' && phase !== 'restore') {
    throw new Error('--phase must be backfill, scrub, or restore');
  }
  const tenantId = encodeURIComponent(required(values, 'tenant-id'));
  const accountId = encodeURIComponent(required(values, 'line-account-id'));
  return new URL(
    `/api/platform/pharmacy/tenants/${tenantId}/line-accounts/${accountId}/credentials/${phase}`,
    worker.origin,
  ).toString();
}

export async function runLineCredentialMigration(
  argv: string[],
  environment: Environment,
  fetcher: typeof fetch = fetch,
  write: Writer = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) { write(HELP); return 0; }
    const phase = required(parsed.values, 'phase');
    if (phase === 'scrub' && !parsed.confirmScrub) {
      throw new Error('scrub requires --confirm-scrub after encrypted credential verification');
    }
    if (phase === 'restore' && !parsed.confirmRestore) {
      throw new Error('restore requires --confirm-restore before a legacy Worker rollback');
    }
    const platformKey = environment.PHARMACY_PLATFORM_ADMIN_KEY?.trim();
    if (!platformKey) throw new Error('PHARMACY_PLATFORM_ADMIN_KEY is required');
    const url = endpoint(parsed.values);
    if (parsed.dryRun) { write(`Dry run passed: ${phase}. No request was sent.`); return 0; }

    const response = await fetcher(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${platformKey}` },
    });
    const payload = await response.json().catch(() => null) as {
      success?: boolean;
      error?: unknown;
      data?: { written?: number; verified?: number; scrubbed?: boolean; restored?: boolean };
    } | null;
    if (!response.ok || !payload?.success || !payload.data) {
      write(`LINE credential ${phase} failed (${response.status}).`);
      return 1;
    }
    write(`LINE credential ${phase} completed: ${JSON.stringify(payload.data)}`);
    return 0;
  } catch (error) {
    write(error instanceof Error ? error.message : 'LINE credential migration failed');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runLineCredentialMigration(process.argv.slice(2), process.env)
    .then((exitCode) => { process.exitCode = exitCode; });
}
