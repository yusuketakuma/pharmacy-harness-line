import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('custom_042 pharmacy public profile details', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  });

  it('adds bounded patient-facing detail fields', () => {
    const columns = db.prepare('PRAGMA table_info(pharmacy_public_profiles)').all()
      .map((column) => (column as { name: string }).name);
    expect(columns).toEqual(expect.arrayContaining([
      'prescription_reception_hours', 'after_hours_note', 'services_note',
      'accessibility_note', 'supported_languages', 'payment_methods', 'website_url',
    ]));
  });
});
