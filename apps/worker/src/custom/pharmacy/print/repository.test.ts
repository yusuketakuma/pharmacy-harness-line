import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgePrescriptionPrintTask,
  claimPrescriptionPrintTask,
  preparePrescriptionPrintTask,
} from './repository.js';

function db(options: { first?: unknown[]; changes?: number[] } = {}) {
  const sql: string[] = [];
  const first = [...(options.first ?? [])];
  const changes = [...(options.changes ?? [])];
  const prepare = vi.fn((statement: string) => {
    sql.push(statement);
    const bound = {
      bind: (..._values: unknown[]) => bound,
      first: async () => first.shift() ?? null,
      run: async () => ({ meta: { changes: changes.shift() ?? 1 } }),
    };
    return bound;
  });
  return {
    value: {
      prepare,
      batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((statement) => statement.run())),
    } as unknown as D1Database,
    sql,
  };
}

describe('pharmacy web print repository', () => {
  it('prepares one revision task using only a server-resolved account-scoped submission', async () => {
    const fake = db({ first: [{ id: 'task-1', line_account_id: 'account-a', revision: 2, status: 'pending' }] });
    await preparePrescriptionPrintTask(fake.value, 'account-a', 'submission-a');
    expect(fake.sql.join('\n')).toContain('s.line_account_id = ?');
    expect(fake.sql.join('\n')).toContain('s.active_revision');
    expect(fake.sql.join('\n')).not.toContain('r2_key');
  });

  it('requires the current active revision when claiming and acknowledging', async () => {
    const fake = db({
      first: [
        { id: 'task-1', status: 'handling', handling_token: 'session-a' },
        { id: 'task-1', status: 'acknowledged', handling_token: 'session-a' },
      ],
    });
    await claimPrescriptionPrintTask(fake.value, 'account-a', 'task-1', 'staff-a', 'session-a');
    await acknowledgePrescriptionPrintTask(fake.value, 'account-a', 'task-1', 'staff-a', 'session-a');
    const mutationSql = fake.sql.filter((statement) => statement.startsWith('UPDATE')).join('\n');
    expect(mutationSql).toContain('active_revision');
    expect(mutationSql).toContain('line_account_id = ?');
  });
});
