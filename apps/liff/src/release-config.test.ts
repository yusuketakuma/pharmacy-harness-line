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

describe('LIFF Pages production release configuration', () => {
  it('targets the configured production project explicitly', () => {
    expect(wranglerSource).toContain('[env.production]\nname = "line-crm-liff-prod"');
    expect(packageJson.scripts['deploy:production']).toBe(
      'pnpm build && wrangler pages deploy dist --project-name line-crm-liff-prod --branch main',
    );
  });
});
