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
    expect(stepIndex('Build Pharmacy LIFF Pages')).toBeLessThan(migrate);
    expect(stepIndex('Build Admin Panel')).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(stepIndex('Deploy to Cloudflare Workers'));
    expect(stepIndex('Deploy to Cloudflare Workers')).toBeLessThan(
      stepIndex('Verify Worker health'),
    );
    expect(stepIndex('Verify Worker health')).toBeLessThan(
      stepIndex('Deploy to Cloudflare Pages'),
    );
    expect(stepIndex('Verify Worker health')).toBeLessThan(
      stepIndex('Deploy Pharmacy LIFF Pages'),
    );
    expect(stepIndex('Deploy Pharmacy LIFF Pages')).toBeLessThan(
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

  test('injects and verifies the runtime release version before production deployment', () => {
    const buildMeta = stepIndex('Capture build metadata');
    const inject = stepIndex('Inject runtime release metadata');
    const rebuild = stepIndex('Rebuild Worker with runtime release metadata');
    const deploy = stepIndex('Deploy to Cloudflare Workers');
    const verifyVersion = stepIndex('Verify deployed runtime version');

    expect(buildMeta).toBeLessThan(stepIndex('Build Admin Panel'));
    expect(inject).toBeGreaterThan(stepIndex('Build Admin Panel'));
    expect(inject).toBeLessThan(rebuild);
    expect(rebuild).toBeLessThan(stepIndex('Verify LINE LIFF endpoint topology'));
    expect(rebuild).toBeLessThan(deploy);
    expect(verifyVersion).toBeGreaterThan(stepIndex('Verify Worker health'));
    expect(verifyVersion).toBeLessThan(stepIndex('Deploy Pharmacy LIFF Pages'));
    expect(customerDeploy).toContain('release_version=$(node -p');
    expect(customerDeploy).toContain('apps/worker/scripts/inject-version.ts');
    expect(customerDeploy).toContain('--worker apps/worker/dist/line_harness/index.js');
    expect(customerDeploy).toContain('--worker-assets apps/worker/dist/client');
    expect(customerDeploy).toContain('--admin apps/web/out');
    expect(customerDeploy).toContain('--liff apps/liff/dist');
    expect(customerDeploy).toContain('test "$actual_version" = "$EXPECTED_VERSION"');
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

  test('bakes the configured LIFF origin into the Worker CORS config', () => {
    expect(customerDeploy).toContain('LIFF_ORIGIN: ${{ vars.LIFF_ORIGIN }}');
    expect(customerDeploy).toContain('.vars.LIFF_ORIGIN = $o');
    expect(customerDeploy).toContain('test -n "$LIFF_ORIGIN"');
  });

  test('builds and publishes the separate pharmacy LIFF Pages artifact', () => {
    expect(customerDeploy).toContain('LIFF_PAGES_PROJECT: ${{ vars.LIFF_PAGES_PROJECT }}');
    expect(customerDeploy).toContain('VITE_DEFAULT_LIFF_ID: ${{ vars.VITE_LIFF_ID }}');
    expect(customerDeploy).toContain('VITE_API_BASE: ${{ vars.WORKER_URL }}');
    expect(customerDeploy).toContain('pnpm --filter liff build');
    expect(customerDeploy).toContain('npx wrangler pages deploy apps/liff/dist');
    expect(customerDeploy).toContain('--project-name="$LIFF_PAGES_PROJECT"');
  });

  test('fails before mutation when the LINE LIFF endpoint drifts from Pages', () => {
    const validate = stepIndex('Validate required deployment configuration');
    const topology = stepIndex('Verify LINE LIFF endpoint topology');
    const migrate = stepIndex('Run pending D1 migrations');

    expect(topology).toBeGreaterThan(validate);
    expect(topology).toBeLessThan(migrate);
    expect(customerDeploy).toContain('https://liff.line.me/${VITE_LIFF_ID}/');
    expect(customerDeploy).toContain('grep -Fq "$LIFF_ORIGIN"');
    expect(customerDeploy).toContain('grep -Fq "$WORKER_URL"');
    expect(customerDeploy).toContain('LINE LIFF endpoint must point to LIFF_ORIGIN');
  });

  test('rejects a pharmacy LIFF build without its runtime contract', () => {
    expect(customerDeploy).toContain('grep -R -Fq "$VITE_DEFAULT_LIFF_ID" apps/liff/dist/assets');
    expect(customerDeploy).toContain('grep -R -Fq "$VITE_API_BASE" apps/liff/dist/assets');
    expect(customerDeploy).toContain('grep -R -Fq "pharmacy-receive" apps/liff/dist/assets');
  });

  test('preserves customer bindings and verifies them before recording success', () => {
    const validate = stepIndex('Validate required deployment configuration');
    const protect = stepIndex('Protect customer configuration');
    const verify = stepIndex('Verify customer configuration preserved');

    expect(validate).toBeLessThan(stepIndex('Build Worker and LIFF assets'));
    expect(protect).toBeGreaterThan(stepIndex('Patch wrangler config'));
    expect(protect).toBeLessThan(stepIndex('Run pending D1 migrations'));
    expect(verify).toBeGreaterThan(stepIndex('Deploy to Cloudflare Workers'));
    expect(verify).toBeLessThan(stepIndex('Record release evidence'));
    expect(customerDeploy).toContain('scripts/deploy/customer-config.ts prepare');
    expect(customerDeploy).toContain('scripts/deploy/customer-config.ts verify');
    expect(customerDeploy).toContain('Missing required deployment configuration');
    expect(customerDeploy).not.toContain("|| 'your-worker-name'");
    expect(customerDeploy).not.toContain("|| 'your-admin-name'");
  });

  test('uses the checksum-enforced migration runner without inferring a baseline', () => {
    expect(customerDeploy).toContain('pnpm tsx scripts/deploy/apply-migrations.ts');
    expect(customerDeploy).not.toContain("name='_migrations'");
    expect(customerDeploy).not.toContain('packages/db/bootstrap.sql');
    expect(customerDeploy).not.toContain('CREATE TABLE IF NOT EXISTS _migrations');
  });

  test('checks additive migration safety before any customer mutation', () => {
    const safety = stepIndex('Check additive migration safety');
    const migrate = stepIndex('Run pending D1 migrations');

    expect(safety).toBeGreaterThan(stepIndex('Verify LINE LIFF endpoint topology'));
    expect(safety).toBeLessThan(migrate);
    expect(customerDeploy).toContain('pnpm tsx scripts/check-migrations.ts');
  });

  test('records a pre-migration D1 bookmark and post-smoke deployment evidence', () => {
    expect(customerDeploy).toContain('scripts/deploy/release-state.ts --with-bookmark');
    expect(customerDeploy).toContain('scripts/deploy/record-release-evidence.ts');
    expect(customerDeploy).toContain('BEFORE_STATE: ${{ steps.before.outputs.state }}');
    expect(customerDeploy).toContain('MIGRATION_RESULT: ${{ steps.migrations.outputs.result }}');
    expect(customerDeploy).toContain('SOURCE_SHA: ${{ github.sha }}');
  });

  test('publishes and verifies the Admin route on the configured Pages branch', () => {
    expect(customerDeploy).toContain('--branch="$GITHUB_REF_NAME"');
    expect(customerDeploy).toContain('${ADMIN_ORIGIN%/}/prescriptions');
  });

  test('Web CI gates Admin changes before deployment', () => {
    const workflow = read('.github/workflows/web-ci.yml');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('branches: [main, dev]');
    expect(workflow).toContain('pnpm --filter web test');
    expect(workflow).toContain('pnpm --filter web build');
  });
});
