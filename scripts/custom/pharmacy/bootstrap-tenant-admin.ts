import { pathToFileURL } from 'node:url';

type Writer = (line: string) => void;

const HELP = `Usage:
  pnpm tenant:admin-bootstrap -- --help

このコマンドは廃止されています。共通パスワードはplatform admin画面から発行・再発行してください。`;

export async function runTenantAdminBootstrap(
  argv: string[],
  _environment: Record<string, string | undefined>,
  _fetcher: typeof fetch = fetch,
  write: Writer = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(HELP);
    return 0;
  }
  write('tenant:admin-bootstrap は廃止されています。共通パスワードはplatform admin画面から発行・再発行してください。');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runTenantAdminBootstrap(process.argv.slice(2), process.env)
    .then((exitCode) => { process.exitCode = exitCode; });
}
