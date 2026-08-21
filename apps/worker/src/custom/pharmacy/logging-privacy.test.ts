import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/worker/src — every production module, tests excluded.
const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url).href);
const sources = readdirSync(SRC_ROOT, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
  .map((file) => ({ file, text: readFileSync(join(SRC_ROOT, file), 'utf8') }));

// A console call whose argument list carries a sensitive identifier or value.
const SENSITIVE_IDENT = 'userId|lineUserId|password|token|secret|answers|line_user_id';
const PATTERNS = [
  new RegExp(`console\\.(?:log|error|warn|info|debug)\\([^\\n]*,\\s*(?:${SENSITIVE_IDENT})\\b`),
  new RegExp(`console\\.(?:log|error|warn|info|debug)\\([^\\n]*\\$\\{(?:${SENSITIVE_IDENT})\\}`),
  /console\.(?:log|error|warn|info|debug)\([^\n]*\.(?:line_user_id|password|answers)\b/,
  /console\.(?:log|error|warn|info|debug)\([^\n]*JSON\.stringify\((?:data|answers|body)\)/,
];

describe('pharmacy log privacy contract', () => {
  it('scans the whole worker source tree', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some(({ file }) => file === join('routes', 'webhook.ts'))).toBe(true);
  });

  it('does not write LINE user identifiers, credentials, or form answers to application logs', () => {
    const offenders = sources.flatMap(({ file, text }) =>
      PATTERNS.some((pattern) => pattern.test(text)) ? [file] : []);
    expect(offenders).toEqual([]);
  });
});
