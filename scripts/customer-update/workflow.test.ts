import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/customer-update.yml', 'utf8');
const policyWorkflow = readFileSync('.github/workflows/customer-update-policy.yml', 'utf8');

describe('customer update workflow', () => {
  it('uses separate seller-read and customer-write credentials', () => {
    expect(workflow).toContain('secrets.LINE_HARNESS_SELLER_READ_TOKEN');
    expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toContain('LINE_HARNESS_SELLER_READ_TOKEN: ${{ github.token }}');
  });

  it('runs only in customer repositories and never executes the candidate before PR CI', () => {
    expect(workflow).toContain("vars.LINE_HARNESS_SELLER_REPOSITORY != github.repository");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('scripts/customer-update/prepare.ts');
    expect(workflow).not.toMatch(/pnpm --dir seller (?:run|exec)/);
  });

  it('reuses one update branch and pull request', () => {
    expect(workflow).toContain("'vendor/update-*'");
    expect(workflow).toContain('gh pr view');
    expect(workflow).toContain('gh pr create');
    expect(workflow).toContain("fromJson(steps.prepare.outputs.result).kind == 'update'");
  });

  it('pins the only third-party action to a full commit SHA', () => {
    const uses = [...workflow.matchAll(/uses:\s+([^\s]+)/g)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((use) => /^actions\/checkout@[0-9a-f]{40}$/.test(use))).toBe(true);
  });

  it('enables compatible auto-merge only after the explicit canary gate', () => {
    expect(workflow).toContain("vars.CUSTOMER_UPDATE_MODE == 'compatible-auto'");
    expect(workflow).toContain("vars.CUSTOMER_UPDATE_CANARY_PASSED == 'true'");
    expect(workflow).toContain("steps.classification.outputs.update_class == 'compatible'");
    expect(workflow).toContain('gh pr merge');
    expect(workflow).toContain('--auto --merge');
  });
});

describe('customer update policy workflow', () => {
  it('always runs secretless from trusted customer main', () => {
    expect(policyWorkflow).toContain('pull_request:');
    expect(policyWorkflow).toContain('branches: [main]');
    expect(policyWorkflow).not.toContain('paths:');
    expect(policyWorkflow).toContain('contents: read');
    expect(policyWorkflow).not.toContain('secrets.');
    expect(policyWorkflow).not.toContain('environment:');
    expect(policyWorkflow).toContain('github.event.pull_request.base.sha');
    expect(policyWorkflow).toContain('github.event.pull_request.head.sha');
    expect(policyWorkflow).toContain('scripts/customer-update/policy.ts');
  });
});
