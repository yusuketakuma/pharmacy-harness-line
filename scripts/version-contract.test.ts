import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const unifiedVersion = '0.26.0';
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

  test('keeps the pharmacy release metadata and changelog on the same version', () => {
    const release = JSON.parse(readFileSync('customer-release.json', 'utf8')) as {
      version?: string;
      minimum_client_version?: string;
      rollback_compatible_from?: string;
    };
    const changelog = readFileSync('CHANGELOG.md', 'utf8');

    expect(release.version).toBe(unifiedVersion);
    expect(changelog).toContain(`## Pharmacy v${unifiedVersion}`);
    expect(release.minimum_client_version).toBe('0.21.3');
    expect(release.rollback_compatible_from).toBe('0.21.3');
  });
});
