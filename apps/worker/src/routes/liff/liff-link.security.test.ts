import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';
import { d1FromSqlite, DB_PACKAGE_ROOT, openTestSqlite } from '../../custom/pharmacy/test-sqlite.js';
import { expandVariablesWithSignedLinks } from '../../services/step-delivery.js';
import { signCrossAccountToken, verifyCrossAccountToken } from '../../lib/cross-account-token.js';
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

test.each(['bare-uuid', 'signed-token'])(
  'OAuth state never treats an unsigned UUID as link authority: %s',
  async (mode) => {
    const sqlite = openTestSqlite();
    try {
      sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
      sqlite.exec(
        "INSERT INTO users (id) VALUES ('target-user'); INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,login_channel_id) VALUES ('target-account','channel','Synthetic','synthetic','synthetic','login');",
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async (url: string) =>
            new Response(
              JSON.stringify(
                url.includes('/token')
                  ? { access_token: 'synthetic', id_token: 'synthetic' }
                  : { sub: 'synthetic-line', name: 'Synthetic', displayName: 'Synthetic' },
              ),
              { status: 200 },
            ),
        ),
      );
      const key = 'synthetic-signing-key';
      sqlite.exec(
        "INSERT INTO friends (id,line_user_id,provider_line_user_id,user_id) VALUES ('source-friend','source-line','source-line','target-user')",
      );
      const expanded = await expandVariablesWithSignedLinks(
        d1FromSqlite(sqlite),
        key,
        '{{auth_url:channel}}',
        { id: 'source-friend', user_id: 'target-user', display_name: 'Synthetic' },
        'https://worker.example.test',
      );
      const link = new URL(expanded);
      expect(link.searchParams.has('uid')).toBe(false);
      const signed = link.searchParams.get('crossAccountToken')!;
      expect(await verifyCrossAccountToken(key, signed, Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60)).toEqual({
        userId: 'target-user',
        targetAccountId: 'target-account',
      });
      const uid = mode === 'bare-uuid' ? 'target-user' : signed;
      const state = btoa(JSON.stringify({ uid }));
      const app = new Hono<Env>();
      app.route('/', liffRoutes);
      const response = await app.request(`/auth/callback?code=synthetic&state=${encodeURIComponent(state)}`, {}, {
        DB: d1FromSqlite(sqlite),
        LINE_LOGIN_CHANNEL_ID: 'login',
        LINE_LOGIN_CHANNEL_SECRET: 'synthetic',
        CROSS_ACCOUNT_TOKEN_KEY: key,
      } as Env['Bindings']);
      expect(response.status).toBe(200);
      const linked = sqlite
        .prepare("SELECT user_id FROM friends WHERE provider_line_user_id='synthetic-line'")
        .get() as { user_id: string };
      if (mode === 'signed-token') expect(linked.user_id).toBe('target-user');
      else expect(linked.user_id).not.toBe('target-user');
    } finally {
      sqlite.close();
    }
  },
);
