import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('customer release workflow contract', () => {
  test('seller main dispatches the existing release workflow at an immutable tag', () => {
    const workflow = read('.github/workflows/customer-release.yml');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain("vars.LINE_HARNESS_SELLER_REPOSITORY == github.repository");
    expect(workflow).toContain('customer-release.json');
    expect(workflow).toContain('tag="pharmacy-v${version}"');
    expect(workflow).toContain('--validate-only true');
    expect(workflow.indexOf('--validate-only true')).toBeLessThan(workflow.indexOf('git tag -a'));
    expect(workflow).toContain("git rev-parse 'HEAD^{commit}'");
    expect(workflow).toContain('git config user.name "github-actions[bot]"');
    expect(workflow).toContain('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
    expect(workflow).toContain('gh workflow run release.yml');
    expect(workflow).toContain('--ref "$tag"');
    expect(workflow).toContain('source_sha="$source_sha"');
  });

  test('main promotion safely reuses an already-published ancestor tag', () => {
    const workflow = read('.github/workflows/customer-release.yml');
    expect(workflow).toContain('existing_sha=$(git rev-parse "$TAG^{commit}")');
    expect(workflow).toContain('git merge-base --is-ancestor "$existing_sha" "$SOURCE_SHA"');
    expect(workflow).toContain('gh release view "$TAG"');
  });

  test('release workflow accepts explicit source identity and emits customer metadata', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("'pharmacy-v*.*.*'");
    expect(workflow).toContain('source_sha:');
    expect(workflow).toContain('customer-source-update.ts');
    expect(workflow).toContain('customer_source_update');
  });

  test('release workflow includes custom migrations in customer metadata', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toContain('^custom_[0-9]+_');
  });

  test('official upstream ingestion is disabled outside the seller repository', () => {
    const workflow = read('.github/workflows/update-from-upstream.yml');
    expect(workflow).toContain("vars.LINE_HARNESS_SELLER_REPOSITORY == github.repository");
  });
});
