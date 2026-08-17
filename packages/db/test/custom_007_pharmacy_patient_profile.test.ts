import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  return db;
}

describe('custom_007_pharmacy_patient_profile.sql', () => {
  let db: Database.Database;

  beforeEach(() => { db = loadDb(); });

  it('adds contact and optional delivery address fields without changing existing patient identity', () => {
    const columns = db.prepare('PRAGMA table_info(pharmacy_patients)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'contact_phone', 'postal_code', 'prefecture', 'city', 'address_line1', 'address_line2',
    ]));
  });
});
