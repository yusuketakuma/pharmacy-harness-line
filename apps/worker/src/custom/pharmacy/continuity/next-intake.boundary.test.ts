import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('next-intake integration boundary', () => {
  it('reuses the existing continuity cron without running legacy inferred reminders', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
    expect(source).toContain(
      "import { claimDueNextIntakeExpectations } from './custom/pharmacy/continuity/next-intake.js'; // custom:pharmacy-continuity",
    );
    expect(source).toContain('await claimDueNextIntakeExpectations(env.DB, new Date(event.scheduledTime))');
    expect(source).not.toContain('claimDueContinuityReminders');
  });

  it('keeps reminder claims tenant/account keyed without selecting plaintext tokens', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'custom', 'pharmacy', 'continuity', 'next-intake.ts'), 'utf8');
    expect(source).toContain('tenant_line_accounts');
    expect(source).toContain('mapping.tenant_id AS tenant_id');
    expect(source).not.toContain('channel_access_token');
  });
});
