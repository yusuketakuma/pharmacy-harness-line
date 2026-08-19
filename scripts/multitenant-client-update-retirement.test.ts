import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('central multi-tenant deployment contract', () => {
  it('does not ship customer repository update automation', () => {
    for (const path of [
      '.github/workflows/customer-update.yml',
      '.github/workflows/customer-update-policy.yml',
      '.github/workflows/customer-release.yml',
      '.github/workflows/publish-update-cli.yml',
      'customer-release.json',
      'scripts/customer-update/prepare.ts',
      'scripts/customer-onboarding/configure.ts',
      'scripts/release/customer-source-update.ts',
    ]) {
      expect(existsSync(path), path).toBe(false);
    }
    expect(read('.github/workflows/release.yml')).not.toMatch(
      /customer-source-update|customer-release\.json|customer_source_update|release-manifest\.json|release-entry\.json|bundle\.tar\.gz|required_secrets/,
    );
  });

  it('does not expose infrastructure self-update controls to tenant admins', () => {
    const worker = read('apps/worker/src/index.ts');
    const shell = read('apps/web/src/components/app-shell.tsx');
    const sidebar = read('apps/web/src/components/layout/sidebar.tsx');

    expect(worker).not.toMatch(/adminUpdate|\/admin\/update/);
    expect(shell).not.toContain('UpdateBanner');
    expect(sidebar).not.toContain("href: '/updates'");
  });
});
