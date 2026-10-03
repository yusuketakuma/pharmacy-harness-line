import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTagsForFriends, tagBelongsToTenant } from '../src/tags.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = sqlite.prepare(query);
          return {
            async all<T>() {
              return { results: stmt.all(...params) as T[], success: true, meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('tagBelongsToTenant', () => {
  it('binds tagId and tenantId and reports existence', async () => {
    const bind = vi.fn(() => ({ first: async () => ({ id: 'tag-1' }) }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;
    await expect(tagBelongsToTenant(db, 'tag-1', 'tenant-a')).resolves.toBe(true);
    expect(prepare.mock.calls[0][0]).toMatch(/tenant_id IS \?/);
    expect(bind).toHaveBeenCalledWith('tag-1', 'tenant-a');
  });
  it('returns false when no row', async () => {
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    } as unknown as D1Database;
    await expect(tagBelongsToTenant(db, 'tag-x', 'tenant-a')).resolves.toBe(false);
  });
});

describe('getTagsForFriends', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(__dirname, '../schema.sql'), 'utf8'));
    db = asD1(sqlite);
  });

  function insertFriend(id: string): void {
    sqlite
      .prepare(
        `INSERT INTO friends (id, line_user_id, display_name, created_at, updated_at)
         VALUES (?, ?, 'F', '2024-01-01T00:00:00.000+09:00', '2024-01-01T00:00:00.000+09:00')`,
      )
      .run(id, `U${id.padEnd(32, '0').replace(/[^0-9a-fA-F]/g, '0')}`);
  }

  function insertTag(id: string, name: string): void {
    sqlite.prepare(`INSERT INTO tags (id, name) VALUES (?, ?)`).run(id, name);
  }

  it('returns tags grouped by friend in a single chunked query', async () => {
    insertFriend('f1');
    insertFriend('f2');
    insertFriend('f3');
    insertTag('t1', 'b-tag');
    insertTag('t2', 'a-tag');
    sqlite.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES ('f1', 't1'), ('f1', 't2'), ('f3', 't1')`).run();

    const result = await getTagsForFriends(db, ['f1', 'f2', 'f3']);
    expect(result.get('f1')?.map((t) => t.name)).toEqual(['a-tag', 'b-tag']);
    expect(result.get('f2')).toBeUndefined();
    expect(result.get('f3')?.map((t) => t.name)).toEqual(['b-tag']);
  });

  it('chunks beyond the D1 bind limit and returns empty map for no ids', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 95; i++) {
      const id = `f${String(i).padStart(3, '0')}`;
      insertFriend(id);
      ids.push(id);
    }
    insertTag('t1', 'x');
    sqlite.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES ('f094', 't1')`).run();

    const result = await getTagsForFriends(db, ids);
    expect(result.size).toBe(1);
    expect(result.get('f094')?.[0]?.name).toBe('x');
    expect((await getTagsForFriends(db, [])).size).toBe(0);
  });
});
