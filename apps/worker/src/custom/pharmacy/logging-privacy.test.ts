import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = (relative: string) => readFileSync(
  fileURLToPath(new URL(relative, import.meta.url).href),
  'utf8',
);

describe('pharmacy log privacy contract', () => {
  it('does not write LINE user identifiers to application logs', () => {
    const combined = [
      source('../../routes/webhook.ts'),
      source('../../routes/line-proxy.ts'),
      source('../../routes/forms.ts'),
    ].join('\n');

    expect(combined).not.toMatch(/console\.(?:log|error|warn|info)\([^\n]*,\s*userId\b/);
    expect(combined).not.toMatch(/console\.(?:log|error|warn|info)\([^\n]*\$\{userId\}/);
    expect(combined).not.toMatch(/console\.(?:log|error|warn|info)\([^\n]*friend\.line_user_id/);
  });
});
