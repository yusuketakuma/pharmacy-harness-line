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
});
