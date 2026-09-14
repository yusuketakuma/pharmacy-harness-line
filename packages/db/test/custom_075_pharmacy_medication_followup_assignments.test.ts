import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('custom_075 pharmacy follow-up assignments', () => {
  it('adds an optional human assignee reference to follow-up events', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));

    const columns = sqlite.prepare(
      `PRAGMA table_info(pharmacy_medication_followup_events)`,
    ).all() as Array<{ name: string; notnull: number }>;
    expect(columns.find((column) => column.name === 'assignee_staff_id')).toMatchObject({ notnull: 0 });

    const foreignKeys = sqlite.prepare(
      `PRAGMA foreign_key_list(pharmacy_medication_followup_events)`,
    ).all() as Array<{ table: string; from: string; to: string }>;
    expect(foreignKeys.some((foreignKey) =>
      foreignKey.table === 'staff_members' &&
      foreignKey.from === 'assignee_staff_id' &&
      foreignKey.to === 'id')).toBe(true);
  });
});
