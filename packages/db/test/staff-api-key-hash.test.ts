import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaffMember, getStaffByApiKey, hashStaffApiKey } from '../src/staff.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'synthetic-staff-api-key-hash-secret-v1';
const LEGACY_KEY = 'lh_0123456789abcdef0123456789abcdef';

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      const stmt = sqlite.prepare(query);
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              const info = stmt.run(...params);
              return { results: [], success: true, meta: { changes: info.changes } };
            },
            async first<T>() {
              return (stmt.get(...params) as T) ?? null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function readHash(sqlite: Database.Database, id: string): string | null {
  return (sqlite
    .prepare('SELECT api_key_hash FROM staff_members WHERE id = ?')
    .get(id) as { api_key_hash: string | null }).api_key_hash;
}

describe('staff API key keyed-hash storage', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db = asD1(sqlite);
  });

  it('authenticates a newly issued key through the hash lookup', async () => {
    const created = await createStaffMember(
      db,
      { name: 'New Staff', role: 'staff' },
      SECRET,
    );

    expect(readHash(sqlite, created.id))
      .toBe(await hashStaffApiKey(SECRET, created.api_key));

    // Only the hashed column can satisfy the lookup once the plaintext moves.
    sqlite.prepare('UPDATE staff_members SET api_key = ? WHERE id = ?')
      .run(`disabled:${created.id}`, created.id);

    const found = await getStaffByApiKey(db, created.api_key, SECRET);
    expect(found?.id).toBe(created.id);
  });

  it('still authenticates a pre-existing plaintext-only record', async () => {
    sqlite.prepare(
      `INSERT INTO staff_members (id, name, role, api_key, is_active, created_at, updated_at)
       VALUES ('legacy-staff', 'Legacy Staff', 'staff', ?, 1, '2026-08-19', '2026-08-19')`,
    ).run(LEGACY_KEY);

    const found = await getStaffByApiKey(db, LEGACY_KEY, SECRET);
    expect(found?.id).toBe('legacy-staff');
  });

  it('backfills the hash on a successful plaintext lookup', async () => {
    sqlite.prepare(
      `INSERT INTO staff_members (id, name, role, api_key, is_active, created_at, updated_at)
       VALUES ('legacy-staff', 'Legacy Staff', 'staff', ?, 1, '2026-08-19', '2026-08-19')`,
    ).run(LEGACY_KEY);
    expect(readHash(sqlite, 'legacy-staff')).toBeNull();

    await getStaffByApiKey(db, LEGACY_KEY, SECRET);
    expect(readHash(sqlite, 'legacy-staff')).toBe(await hashStaffApiKey(SECRET, LEGACY_KEY));

    // The plaintext column is no longer needed for the next lookup.
    sqlite.prepare("UPDATE staff_members SET api_key = 'disabled:rotated' WHERE id = 'legacy-staff'")
      .run();
    const found = await getStaffByApiKey(db, LEGACY_KEY, SECRET);
    expect(found?.id).toBe('legacy-staff');
  });

  it('rejects an unknown key on both the hash and the plaintext path', async () => {
    const created = await createStaffMember(db, { name: 'New Staff', role: 'staff' }, SECRET);
    sqlite.prepare(
      `INSERT INTO staff_members (id, name, role, api_key, is_active, created_at, updated_at)
       VALUES ('legacy-staff', 'Legacy Staff', 'staff', ?, 1, '2026-08-19', '2026-08-19')`,
    ).run(LEGACY_KEY);

    expect(await getStaffByApiKey(db, 'lh_unknown', SECRET)).toBeNull();
    expect(await getStaffByApiKey(db, 'lh_unknown', undefined)).toBeNull();
    // A hash presented as the bearer token is not itself a credential.
    expect(await getStaffByApiKey(db, await hashStaffApiKey(SECRET, created.api_key), SECRET))
      .toBeNull();

    // A hash written under a different secret must not authenticate.
    sqlite.prepare('UPDATE staff_members SET api_key = ? WHERE id = ?')
      .run(`disabled:${created.id}`, created.id);
    expect(await getStaffByApiKey(db, created.api_key, 'another-secret')).toBeNull();
  });

  it('keeps working with no secret configured', async () => {
    const created = await createStaffMember(db, { name: 'New Staff', role: 'staff' });

    expect(readHash(sqlite, created.id)).toBeNull();
    expect((await getStaffByApiKey(db, created.api_key))?.id).toBe(created.id);
  });
});
