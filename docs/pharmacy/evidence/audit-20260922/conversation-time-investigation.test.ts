import { it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from '../../../../apps/worker/node_modules/hono/dist/index.js';
import { Sqlite, d1FromSqlite, DB_PACKAGE_ROOT } from '../../../../apps/worker/src/custom/pharmacy/test-sqlite.ts';
import { chats } from '../../../../apps/worker/src/routes/crm/chats.ts';
import { countUnanswered } from '../../../../apps/worker/src/services/unanswered-inbox.ts';
import { conversations } from '../../../../apps/worker/src/routes/crm/conversations.ts';
import type { Env } from '../../../../apps/worker/src/index.ts';
it('orders mixed stored offsets consistently across consumers', async () => {
const sqlite = new Sqlite(':memory:');
const queries: Array<{sql:string;params:unknown[]}> = [];
try {
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`INSERT INTO tenants(id,tenant_code,display_name) VALUES('synthetic-tenant','synthetic-tenant','Synthetic');
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('synthetic-account','synthetic-channel','Synthetic','synthetic-token','synthetic-secret');
    INSERT INTO tenant_line_accounts(tenant_id,line_account_id) VALUES('synthetic-tenant','synthetic-account');
    INSERT INTO friends(id,line_user_id,provider_line_user_id,display_name,line_account_id) VALUES('synthetic-friend','synthetic-user','synthetic-user','Synthetic','synthetic-account');`);
  sqlite.exec(`INSERT INTO staff_members(id,name,role,api_key,is_active) VALUES('synthetic-staff','Synthetic','admin','synthetic-key',1);
    INSERT INTO tenant_staff_memberships(tenant_id,staff_id,role,is_active) VALUES('synthetic-tenant','synthetic-staff','admin',1);
    INSERT INTO pharmacy_staff_accounts(line_account_id,staff_id,is_active,created_at,updated_at) VALUES('synthetic-account','synthetic-staff',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');`);
  const insert = sqlite.prepare(`INSERT INTO messages_log(id,friend_id,line_account_id,direction,message_type,content,created_at) VALUES(?,'synthetic-friend','synthetic-account',?,'text','synthetic',?)`);
  insert.run('earlier-incoming', 'incoming', '2023-01-01T09:00:00.000+09:00');
  insert.run('later-outgoing', 'outgoing', '2023-01-01T00:01:00.000Z');
  const app = new Hono<Env>();
  app.use('*', async (c,next) => {c.set('tenantId','synthetic-tenant'); c.set('staff',{id:'synthetic-staff',name:'Synthetic',role:'admin'}); await next();});
  app.route('/', conversations);
  app.route('/', chats);
  const baseDb = d1FromSqlite(sqlite);
  function statement(sql: string, params: unknown[] = []): D1PreparedStatement {
    const base = baseDb.prepare(sql).bind(...params);
    return { bind: (...values: unknown[]) => statement(sql,values),
      all: async () => {queries.push({sql,params}); return base.all();},
      first: async () => {queries.push({sql,params}); return base.first();},
      run: async () => {queries.push({sql,params}); return base.run();},
    } as D1PreparedStatement;
  }
  const env = {DB:{prepare:statement}} as Env['Bindings'];
  async function get(query: string) {
    const response = await app.request('/api/conversations/synthetic-friend'+query,{},env);
    if(response.status!==200) throw new Error('unexpected response '+response.status);
    return await response.json() as {data:{messages:Array<{id:string;createdAt:string}>}};
  }
  const first = await get('?limit=1');
  const second = await get('?limit=1&before='+encodeURIComponent(first.data.messages[0].createdAt));
  const all = await get('?limit=2');
  sqlite.prepare("UPDATE messages_log SET source = CASE WHEN direction='outgoing' THEN 'manual' ELSE 'user' END").run();
  const chatResponse = await app.request('/api/chats',{},env);
  expect(chatResponse.status).toBe(200);
  const chatList = await chatResponse.json() as {data:Array<{lastMessageDirection:string}>};
  const queue = await (await app.request('/api/conversations?minHoursSince=0',{},env)).json() as {data:{total:number}};
  const inbox = await countUnanswered(env.DB,'synthetic-tenant');
  const actual = {chatPreviewDirection:chatList.data[0]?.lastMessageDirection,queueTotal:queue.data.total,inboxTotal:inbox.total,first:first.data.messages.map(x=>x.id),second:second.data.messages.map(x=>x.id),chronological:all.data.messages.map(x=>x.id)};
  const expected = {chatPreviewDirection:'outgoing',queueTotal:0,inboxTotal:0,first:['later-outgoing'],second:['earlier-incoming'],chronological:['earlier-incoming','later-outgoing']};
  console.log(JSON.stringify({expected,actual,pass:JSON.stringify(expected)===JSON.stringify(actual)},null,2));
  expect(actual).toEqual(expected);
  if (process.env.F33_QUERY_CAPTURE) {
    insert.run('later-incoming', 'incoming', '2023-01-01T00:02:00.000Z');
    await countUnanswered(env.DB, 'synthetic-tenant');
  }
} finally {
 if (process.env.F33_QUERY_CAPTURE) writeFileSync(process.env.F33_QUERY_CAPTURE,JSON.stringify(queries,null,2));
 sqlite.close();
}

});
