import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const unifiedVersion = '0.27.1';
const runtimePackages = [
  'package.json',
  'apps/worker/package.json',
  'apps/web/package.json',
  'apps/liff/package.json',
  'packages/sdk/package.json',
  'packages/mcp-server/package.json',
] as const;

describe('pharmacy version contract', () => {
  test('keeps all runtime application packages on the unified release version', () => {
    for (const path of runtimePackages) {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
      expect(manifest.version, path).toBe(unifiedVersion);
    }
  });

  test('keeps the pharmacy changelog on the same version', () => {
    const changelog = readFileSync('CHANGELOG.md', 'utf8');

    expect(changelog).toContain(`## Pharmacy v${unifiedVersion}`);
  });
});
