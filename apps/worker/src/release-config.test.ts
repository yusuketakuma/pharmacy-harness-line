import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(
  fileURLToPath(new URL('../package.json', import.meta.url).href),
  'utf8',
)) as { scripts: Record<string, string> };
const wranglerSource = readFileSync(
  fileURLToPath(new URL('../wrangler.toml', import.meta.url).href),
  'utf8',
);

describe('Worker production release configuration', () => {
  it('builds the selected environment and preserves provisioned production vars', () => {
    expect(packageJson.scripts).toMatchObject({
      'build:production': 'CLOUDFLARE_ENV=production vite build',
      'deploy:production': 'pnpm build:production && wrangler deploy --env production --keep-vars',
      'deploy:production:dry-run':
        'pnpm build:production && wrangler deploy --env production --keep-vars --dry-run',
    });

    const production = wranglerSource.slice(wranglerSource.indexOf('[env.production]'));
    expect(production).toContain('database_name = "line-crm"');
    expect(production).toContain('bucket_name = "line-harness-images"');
    expect(production).not.toContain('line-harness-images-dev');
  });
});
