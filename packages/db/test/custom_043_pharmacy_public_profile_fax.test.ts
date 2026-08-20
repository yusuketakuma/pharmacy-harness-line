import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('custom_043 pharmacy public profile fax', () => {
  it('adds a bounded fax number', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    const column = db.prepare('PRAGMA table_info(pharmacy_public_profiles)').all()
      .find((value) => (value as { name: string }).name === 'fax_number');
    expect(column).toBeDefined();
  });
});
