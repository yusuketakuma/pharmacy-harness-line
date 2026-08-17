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

describe('custom_005_pharmacy_myna.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
  });

  it('adds Myna handoff, verification, endpoint and expectation tables', () => {
    for (const table of [
      'pharmacy_myna_endpoint_configs',
      'pharmacy_myna_handoffs',
      'pharmacy_myna_verifications',
      'pharmacy_myna_events',
      'pharmacy_prescription_expectations',
    ]) {
      expect(db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(table)).toEqual({ name: table });
    }
  });

  it('extends the existing FulfillmentQuote table without replacing its decision contract', () => {
    const columns = db.prepare('PRAGMA table_info(pharmacy_fulfillment_quotes)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining([
      'decision', 'reason_codes_json', 'requirements_json', 'status',
      'fulfillment_method', 'constraints_json', 'reservation_expires_at',
      'confirmed_by', 'confirmed_at',
    ]));
  });

  it('does not create Myna or prescription-content storage fields', () => {
    const sensitiveNames = db.prepare('PRAGMA table_info(pharmacy_myna_handoffs)').all() as Array<{ name: string }>;
    expect(sensitiveNames.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'myna_number', 'card_number', 'pin', 'prescription_json', 'screenshot_url',
    ]));
  });
});
