import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const read = (path: string) => readFileSync(path, 'utf8');

describe('development deployment workflow contract', () => {
  const sharedDeploy = read('.github/workflows/deploy-cloudflare.yml');
  const workflow = parse(sharedDeploy) as any;
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
    expect(sharedDeploy).toContain('test "$DEPLOY_TARGET" = "$expected_target"');
    expect(sharedDeploy).not.toContain('harness-test-pharmacy');
    expect(workflow.name).toBe('Deploy Shared Pharmacy Cloudflare');
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
    const workerDeploy = stepIndex('Deploy to Cloudflare Workers');
    const verifyVersion = stepIndex('Verify deployed runtime version');

    expect(buildMeta).toBeLessThan(stepIndex('Build Admin Panel'));
    expect(inject).toBeGreaterThan(stepIndex('Build Admin Panel'));
    expect(inject).toBeLessThan(rebuild);
    expect(rebuild).toBeLessThan(workerDeploy);
    expect(verifyVersion).toBeGreaterThan(stepIndex('Verify Worker health'));
    expect(verifyVersion).toBeLessThan(stepIndex('Deploy Pharmacy LIFF Pages'));
    expect(sharedDeploy).toContain('release_version=$(node -p');
    expect(sharedDeploy).toContain("node -p 'require(\"./apps/worker/package.json\").version'");
    expect(sharedDeploy).toContain('apps/worker/scripts/inject-version.ts');
    expect(sharedDeploy).toContain('--worker-package-version');
    expect(sharedDeploy).toContain('--web-package-version');
    expect(sharedDeploy).toContain('--liff-package-version');
    expect(sharedDeploy).toContain('--worker apps/worker/dist/line_harness/index.js');
    expect(sharedDeploy).toContain('--worker-assets apps/worker/dist/client');
    expect(sharedDeploy).toContain('--admin apps/web/out');
    expect(sharedDeploy).toContain('--liff apps/liff/dist');
    expect(sharedDeploy).toContain('for attempt in {1..12}');
    expect(sharedDeploy).toContain('sleep 5');
    expect(sharedDeploy).toContain('test "$actual_version" = "$EXPECTED_VERSION"');
  });

  test('publishes the immutable pharmacy rich-menu catalog before the Worker', () => {
    const detect = stepIndex('Detect Pharmacy rich-menu catalog changes');
    const generate = stepIndex('Generate Pharmacy rich-menu catalog');
    const publish = stepIndex('Publish Pharmacy rich-menu catalog');
    const workerDeploy = stepIndex('Deploy to Cloudflare Workers');

    expect(detect).toBeGreaterThan(-1);
    expect(detect).toBeLessThan(generate);
    expect(generate).toBeLessThan(publish);
    expect(publish).toBeLessThan(workerDeploy);
    expect(deploy.steps[generate].if).toBe(
      "steps.rich-menu-catalog.outputs.changed == 'true'",
    );
    expect(deploy.steps[publish].if).toBe(
      "steps.rich-menu-catalog.outputs.changed == 'true'",
    );
    expect(sharedDeploy).toContain('git diff --quiet "$BEFORE_SHA" "$GITHUB_SHA"');
    expect(sharedDeploy).toContain('initial-large-3x2-v4.jpg');
    expect(sharedDeploy).toContain('generate-rich-menu-catalog.ts');
    expect(sharedDeploy).toContain('pnpm rich-menu:catalog');
    expect(sharedDeploy).toContain('r2 object get');
    expect(sharedDeploy).toContain('cmp --silent');
    expect(sharedDeploy).toContain('r2 object put');
    expect(sharedDeploy).toContain('manifest.json');
    expect(sharedDeploy).toContain('catalog_total_bytes');
    expect(sharedDeploy).toContain('50000000');
    expect(sharedDeploy).toContain('remote_image="$(mktemp)"');
    expect(sharedDeploy).toContain('Existing rich-menu catalog image differs');
  });

  test('checks out and deploys the exact source SHA with pinned actions', () => {
    expect(sharedDeploy).toContain('ref: ${{ github.sha }}');
    expect(sharedDeploy).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
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
    expect(workflow).not.toContain('VITE_LIFF_ID');
    expect(workflow).not.toContain('VITE_BOT_BASIC_ID');
  });

  test('development Worker uses an isolated R2 bucket', () => {
    expect(sharedDeploy).toContain('R2_BUCKET_NAME: ${{ vars.R2_BUCKET_NAME }}');
    expect(sharedDeploy).toContain('Development R2 bucket name must end in -dev');
    expect(sharedDeploy).toContain('.r2_buckets |= map(if .binding == "IMAGES" then .bucket_name = $bucket else . end)');
  });

  test('bakes the configured LIFF origin into the Worker CORS config', () => {
    expect(sharedDeploy).toContain('LIFF_ORIGIN: ${{ vars.LIFF_ORIGIN }}');
    expect(sharedDeploy).toContain('.vars.LIFF_ORIGIN = $o');
    expect(sharedDeploy).toContain('test -n "$LIFF_ORIGIN"');
  });

  test('passes the dedicated LIFF origin to the Admin build for setup URLs', () => {
    expect(sharedDeploy).toContain('NEXT_PUBLIC_LIFF_ORIGIN: ${{ vars.LIFF_ORIGIN }}');
    expect(sharedDeploy).toContain('grep -R -Fq "$NEXT_PUBLIC_LIFF_ORIGIN" apps/web/.next');
  });

  test('builds and publishes the separate pharmacy LIFF Pages artifact', () => {
    expect(sharedDeploy).toContain('LIFF_PAGES_PROJECT: ${{ vars.LIFF_PAGES_PROJECT }}');
    expect(sharedDeploy).toContain('VITE_API_BASE: ${{ vars.WORKER_URL }}');
    expect(sharedDeploy).toContain('pnpm --filter liff build');
    expect(sharedDeploy).toContain('npx wrangler pages deploy apps/liff/dist');
    expect(sharedDeploy).toContain('--project-name="$LIFF_PAGES_PROJECT"');
    expect(sharedDeploy).not.toContain('VITE_DEFAULT_LIFF_ID');
    expect(sharedDeploy).not.toContain('vars.VITE_LIFF_ID');
  });

  test('does not bake or validate one tenant LIFF ID in the shared deployment', () => {
    expect(stepIndex('Verify LINE LIFF endpoint topology')).toBe(-1);
    expect(sharedDeploy).not.toContain('https://liff.line.me/${VITE_LIFF_ID}/');
    expect(sharedDeploy).toContain('Verify Pharmacy LIFF health');
  });

  test('rejects a pharmacy LIFF build without its runtime contract', () => {
    expect(sharedDeploy).toContain('grep -R -Fq "$VITE_API_BASE" apps/liff/dist/assets');
    expect(sharedDeploy).toContain('grep -R -Fq "pharmacy-receive" apps/liff/dist/assets');
    expect(sharedDeploy).toContain('grep -R -Fq "pharmacy-liff-multitenant-v1" apps/liff/dist/assets');
  });

  test('checks the deployed LIFF asset instead of accepting only an HTTP 200 shell', () => {
    const health = stepIndex('Verify Pharmacy LIFF health');
    expect(health).toBeGreaterThan(stepIndex('Deploy Pharmacy LIFF Pages'));
    expect(deploy.steps[health].run).toContain('for attempt in 1 2 3 4 5');
    expect(deploy.steps[health].run).toContain('sleep 5');
    expect(sharedDeploy).toContain('LIFF_ASSET_PATH=');
    expect(sharedDeploy).toContain('pharmacy-liff-multitenant-v1');
    expect(sharedDeploy).toContain('pharmacy-receive');
    expect(sharedDeploy).toContain('LIFF asset does not contain the expected Worker API URL');
  });

  test('checks the deployed Admin account bundle for the dedicated LIFF origin', () => {
    const health = stepIndex('Verify Admin health');
    expect(deploy.steps[health].run).toContain('for attempt in 1 2 3 4 5');
    expect(deploy.steps[health].run).toContain('sleep 5');
    expect(sharedDeploy).toContain('ADMIN_ASSET_PATHS=');
    expect(sharedDeploy).toContain('LIFF_ORIGIN%/');
    expect(sharedDeploy).toContain('Admin bundle does not contain the configured LIFF origin');
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
    expect(sharedDeploy).toContain('scripts/deploy/customer-config.ts prepare');
    expect(sharedDeploy).toContain('scripts/deploy/customer-config.ts verify');
    expect(sharedDeploy).toContain('Missing required deployment configuration');
    expect(sharedDeploy).not.toContain("|| 'your-worker-name'");
    expect(sharedDeploy).not.toContain("|| 'your-admin-name'");
    expect(deploy.steps[verify].env).toMatchObject({
      D1_DATABASE_ID: '${{ secrets.D1_DATABASE_ID }}',
      R2_BUCKET_NAME: '${{ vars.R2_BUCKET_NAME }}',
      PAGES_PROJECT_NAME: '${{ vars.PAGES_PROJECT_NAME }}',
      ADMIN_ORIGIN: '${{ vars.ADMIN_ORIGIN }}',
      LIFF_ORIGIN: '${{ vars.LIFF_ORIGIN }}',
      WORKER_URL: '${{ vars.WORKER_URL }}',
    });
  });

  test('uses the checksum-enforced migration runner without inferring a baseline', () => {
    expect(sharedDeploy).toContain('pnpm tsx scripts/deploy/apply-migrations.ts');
    expect(sharedDeploy).not.toContain("name='_migrations'");
    expect(sharedDeploy).not.toContain('packages/db/bootstrap.sql');
    expect(sharedDeploy).not.toContain('CREATE TABLE IF NOT EXISTS _migrations');
  });

  test('checks additive migration safety before any customer mutation', () => {
    const safety = stepIndex('Check additive migration safety');
    const migrate = stepIndex('Run pending D1 migrations');

    expect(safety).toBeGreaterThan(stepIndex('Build Pharmacy LIFF Pages'));
    expect(safety).toBeLessThan(migrate);
    expect(sharedDeploy).toContain('pnpm tsx scripts/check-migrations.ts');
  });

  test('requires stable platform-only secrets before applying tenant migrations', () => {
    const verifySecrets = stepIndex('Verify shared Worker secrets');
    const migrate = stepIndex('Run pending D1 migrations');

    expect(verifySecrets).toBeGreaterThan(stepIndex('Check additive migration safety'));
    expect(verifySecrets).toBeLessThan(migrate);
    expect(sharedDeploy).toContain('wrangler secret list');
    for (const name of [
      'PLATFORM_ADMIN_KEY',
      'CROSS_ACCOUNT_TOKEN_KEY',
      'LINE_CREDENTIAL_KEY_V1',
      'PHARMACY_PHI_KEY_V1',
    ]) {
      expect(sharedDeploy).toContain(name);
    }
    expect(sharedDeploy).not.toContain('wrangler secret put LINE_CREDENTIAL_KEY_V1');
  });

  test('records a pre-migration D1 bookmark and post-smoke deployment evidence', () => {
    expect(sharedDeploy).toContain('scripts/deploy/release-state.ts --with-bookmark');
    expect(sharedDeploy).toContain('scripts/deploy/record-release-evidence.ts');
    expect(sharedDeploy).toContain('BEFORE_STATE: ${{ steps.before.outputs.state }}');
    expect(sharedDeploy).toContain('MIGRATION_RESULT: ${{ steps.migrations.outputs.result }}');
    expect(sharedDeploy).toContain('SOURCE_SHA: ${{ github.sha }}');
  });

  test('publishes and verifies the Admin route on the configured Pages branch', () => {
    expect(sharedDeploy).toContain('--branch="$GITHUB_REF_NAME"');
    expect(sharedDeploy).toContain('${ADMIN_ORIGIN%/}/prescriptions');
  });

  test('Web CI gates Admin changes before deployment', () => {
    const workflow = read('.github/workflows/web-ci.yml');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('branches: [main, dev]');
    expect(workflow).toContain('pnpm --filter web test');
    expect(workflow).toContain('pnpm --filter web build');
  });

  test('builds the update engine before release workspace tests import it', () => {
    const release = parse(read('.github/workflows/release.yml')) as any;
    const steps = release.jobs.release.steps;
    const build = steps.find((step: { name?: string }) => step.name === 'Build shared packages');

    expect(build.run).toContain('--filter @line-harness/update-engine');
    expect(steps.indexOf(build)).toBeLessThan(
      steps.findIndex((step: { name?: string }) => step.name === 'Test workspace'),
    );
  });
});
