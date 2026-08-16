import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('development deployment workflow contract', () => {
  const workerDeploy = read('.github/workflows/deploy-cloudflare-worker.yml');
  const adminDeploy = read('.github/workflows/deploy-cloudflare-admin.yml');

  test.each([
    ['Worker', workerDeploy],
    ['Admin', adminDeploy],
  ])('%s deploys only main and dev to branch-matched GitHub Environments', (_name, workflow) => {
    expect(workflow).toContain('branches: [main, dev]');
    expect(workflow).toContain("github.ref_name == 'main' || github.ref_name == 'dev'");
    expect(workflow).toContain("github.ref_name == 'main' && 'production' || 'development'");
    expect(workflow).toContain('DEPLOY_TARGET: ${{ vars.DEPLOY_TARGET }}');
    expect(workflow).toContain('test "$DEPLOY_TARGET" = "$expected_target"');
    expect(workflow).not.toContain('harness-test-pharmacy');
  });

  test('upstream updates enter dev before production', () => {
    const workflow = read('.github/workflows/update-from-upstream.yml');
    expect(workflow).toContain('ref: dev');
    expect(workflow).toContain('--base dev');
  });

  test('Worker CI runs for integration and production pushes', () => {
    const workflow = read('.github/workflows/worker-ci.yml');
    expect(workflow).toContain('branches: [main, dev]');
  });

  test('development Worker uses an isolated R2 bucket', () => {
    expect(workerDeploy).toContain('R2_BUCKET_NAME: ${{ vars.R2_BUCKET_NAME }}');
    expect(workerDeploy).toContain('Development R2 bucket name must end in -dev');
    expect(workerDeploy).toContain('.r2_buckets |= map(if .binding == "IMAGES" then .bucket_name = $bucket else . end)');
  });

  test('Worker bootstraps an empty D1 before applying future migrations', () => {
    expect(workerDeploy).toContain("name='line_accounts'");
    expect(workerDeploy).toContain('packages/db/bootstrap.sql');
    expect(workerDeploy).toContain("name='_migrations'");
    expect(workerDeploy).toContain('packages/db/bootstrap-meta.json');
    expect(workerDeploy).toContain('if [ "$schema_exists" = "0" ] || [ "$ledger_exists" = "0" ]; then');
  });

  test('Web CI gates Admin changes before deployment', () => {
    const workflow = read('.github/workflows/web-ci.yml');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('branches: [main, dev]');
    expect(workflow).toContain('pnpm --filter web test');
    expect(workflow).toContain('pnpm --filter web build');
  });
});
