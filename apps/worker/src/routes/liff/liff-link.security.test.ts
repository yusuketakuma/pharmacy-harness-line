import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';
import { d1FromSqlite, DB_PACKAGE_ROOT, openTestSqlite } from '../../custom/pharmacy/test-sqlite.js';
import { signCrossAccountToken } from '../../lib/cross-account-token.js';
import { liffRoutes } from './liff.js';

vi.mock('../../custom/pharmacy/growth-loop/access.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasPharmacyModeAccount: async () => false,
}));

afterEach(() => vi.unstubAllGlobals());
test.each([null, 'original-user', 'target-user'])(
  'cross-account linking preserves an existing identity (%s)',
  async (existing) => {
    const sqlite = openTestSqlite();
    try {
      sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
      sqlite.exec(
        "INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,login_channel_id) VALUES ('target-account','channel','Synthetic','synthetic','synthetic','login'); INSERT INTO users (id) VALUES ('original-user'),('target-user');",
      );
      sqlite
        .prepare(
          "INSERT INTO friends (id,line_user_id,provider_line_user_id,line_account_id,user_id) VALUES ('friend','synthetic-line','synthetic-line','target-account',?)",
        )
        .run(existing);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ sub: 'synthetic-line' }), { status: 200 })),
      );
      const app = new Hono<Env>();
      app.route('/', liffRoutes);
      const key = 'synthetic-signing-key';
      const token = await signCrossAccountToken(key, { userId: 'target-user', targetAccountId: 'target-account' });
      const response = await app.request(
        '/api/liff/link',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: 'synthetic', crossAccountToken: token }),
        },
        { DB: d1FromSqlite(sqlite), LINE_LOGIN_CHANNEL_ID: 'login', CROSS_ACCOUNT_TOKEN_KEY: key } as Env['Bindings'],
      );
      expect(response.status).toBe(existing === 'original-user' ? 409 : 200);
      expect(sqlite.prepare("SELECT user_id FROM friends WHERE id='friend'").get()).toEqual({
        user_id: existing === 'original-user' ? existing : 'target-user',
      });
    } finally {
      sqlite.close();
    }
  },
);

test('normal linking cannot overwrite a link committed after its initial read', async () => {
  const sqlite = openTestSqlite();
  try {
    sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.exec(
      "INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,login_channel_id) VALUES ('target-account','channel','Synthetic','synthetic','synthetic','login'); INSERT INTO users (id) VALUES ('concurrent-user'); INSERT INTO friends (id,line_user_id,provider_line_user_id,line_account_id,user_id) VALUES ('friend','synthetic-line','synthetic-line','target-account',NULL);",
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ sub: 'synthetic-line' }), { status: 200 })),
    );
    const db = d1FromSqlite(sqlite);
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.includes('UPDATE friends SET user_id'))
        sqlite.exec("UPDATE friends SET user_id='concurrent-user' WHERE id='friend'");
      return prepare(sql);
    };
    const app = new Hono<Env>();
    app.route('/', liffRoutes);
    const response = await app.request(
      '/api/liff/link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: 'synthetic' }),
      },
      { DB: db, LINE_LOGIN_CHANNEL_ID: 'login' } as Env['Bindings'],
    );
    expect(response.status).toBe(409);
    expect(sqlite.prepare("SELECT user_id FROM friends WHERE id='friend'").get()).toEqual({
      user_id: 'concurrent-user',
    });
  } finally {
    sqlite.close();
  }
});
