import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureRepo } from '../src/steps/clone-repo.js';

describe('customer custom checkout', () => {
  it('reuses the delivered checkout instead of cloning the official OSS repository', async () => {
    const checkout = mkdtempSync(join(tmpdir(), 'line-harness-customer-checkout-'));
    writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'packages: []\n');

    await expect(ensureRepo(checkout)).resolves.toBe(checkout);
  });
});
