import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const read = (path: string) => readFileSync(path, 'utf8');

describe('development deployment workflow contract', () => {
  const customerDeploy = read('.github/workflows/deploy-cloudflare.yml');
  const workflow = parse(customerDeploy) as any;
  const deploy = workflow.jobs.deploy;
  const stepIndex = (name: string) =>
    deploy.steps.findIndex((step: { name?: string }) => step.name === name);

  test('uses one environment-serialized deployment for main and dev', () => {
    expect(workflow.on.push.branches).toEqual(['main', 'dev']);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.concurrency.group).toContain('${{ github.repository }}');
    expect(workflow.concurrency.group).toContain('${{ github.ref_name }}');
    expect(deploy.environment.name).toContain("github.ref_name == 'main'");
    expect(deploy.env.DEPLOY_TARGET).toBe('${{ vars.DEPLOY_TARGET }}');
    expect(customerDeploy).toContain('test "$DEPLOY_TARGET" = "$expected_target"');
    expect(customerDeploy).not.toContain('harness-test-pharmacy');
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  test('builds every artifact before mutation and deploys Admin only after Worker health succeeds', () => {
    const migrate = stepIndex('Run pending D1 migrations');
    expect(stepIndex('Build Worker and LIFF assets')).toBeLessThan(migrate);
    expect(stepIndex('Build Admin Panel')).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(stepIndex('Deploy to Cloudflare Workers'));
    expect(stepIndex('Deploy to Cloudflare Workers')).toBeLessThan(
      stepIndex('Verify Worker health'),
    );
    expect(stepIndex('Verify Worker health')).toBeLessThan(
      stepIndex('Deploy to Cloudflare Pages'),
    );
    expect(stepIndex('Deploy to Cloudflare Pages')).toBeLessThan(
      stepIndex('Verify Admin health'),
    );
    expect(stepIndex('Capture pre-migration release state')).toBeLessThan(migrate);
    expect(stepIndex('Verify Admin health')).toBeLessThan(
      stepIndex('Record release evidence'),
    );
  });

  test('checks out and deploys the exact source SHA with pinned actions', () => {
    expect(customerDeploy).toContain('ref: ${{ github.sha }}');
    expect(customerDeploy).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    const uses = deploy.steps
      .filter((step: { uses?: string }) => step.uses)
      .map((step: { uses: string }) => step.uses);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((value: string) => /@[0-9a-f]{40}$/.test(value))).toBe(true);
  });

  test('removes independent Worker and Admin push deployers', () => {
    expect(existsSync('.github/workflows/deploy-cloudflare-worker.yml')).toBe(false);
    expect(existsSync('.github/workflows/deploy-cloudflare-admin.yml')).toBe(false);
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
    expect(customerDeploy).toContain('R2_BUCKET_NAME: ${{ vars.R2_BUCKET_NAME }}');
    expect(customerDeploy).toContain('Development R2 bucket name must end in -dev');
    expect(customerDeploy).toContain('.r2_buckets |= map(if .binding == "IMAGES" then .bucket_name = $bucket else . end)');
  });

  test('uses the checksum-enforced migration runner without inferring a baseline', () => {
    expect(customerDeploy).toContain('pnpm tsx scripts/deploy/apply-migrations.ts');
    expect(customerDeploy).not.toContain("name='_migrations'");
    expect(customerDeploy).not.toContain('packages/db/bootstrap.sql');
    expect(customerDeploy).not.toContain('CREATE TABLE IF NOT EXISTS _migrations');
  });

  test('records a pre-migration D1 bookmark and post-smoke deployment evidence', () => {
    expect(customerDeploy).toContain('scripts/deploy/release-state.ts --with-bookmark');
    expect(customerDeploy).toContain('scripts/deploy/record-release-evidence.ts');
    expect(customerDeploy).toContain('BEFORE_STATE: ${{ steps.before.outputs.state }}');
    expect(customerDeploy).toContain('MIGRATION_RESULT: ${{ steps.migrations.outputs.result }}');
    expect(customerDeploy).toContain('SOURCE_SHA: ${{ github.sha }}');
  });

  test('Web CI gates Admin changes before deployment', () => {
    const workflow = read('.github/workflows/web-ci.yml');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('branches: [main, dev]');
    expect(workflow).toContain('pnpm --filter web test');
    expect(workflow).toContain('pnpm --filter web build');
  });
});
