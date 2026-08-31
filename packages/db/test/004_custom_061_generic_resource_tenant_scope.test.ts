import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMessageTemplate,
  deleteMessageTemplate,
  getMessageTemplateById,
  listMessageTemplates,
  updateMessageTemplate,
} from '../src/message-templates.js';
import {
  createTemplate,
  deleteTemplate,
  getTemplateById,
  getTemplates,
  getTemplatesWithUsageCount,
  updateTemplate,
} from '../src/templates.js';
import {
  createEntryRoute,
  deleteEntryRoute,
  getEntryRouteById,
  getEntryRouteByRefCode,
  getEntryRoutes,
  updateEntryRoute,
} from '../src/entry-routes.js';
import {
  createForm,
  createFormSubmission,
  deleteForm,
  getFormById,
  getForms,
  getFormsWithStats,
  updateForm,
} from '../src/forms.js';
import {
  addPoolAccount,
  createTrafficPool,
  deleteTrafficPool,
  getTrafficPoolById,
  getTrafficPoolBySlug,
  getTrafficPools,
  updateTrafficPool,
} from '../src/traffic-pools.js';
import {
  createCalendarBooking,
  createCalendarConnection,
  deleteCalendarConnection,
  getCalendarBookingById,
  getCalendarBookings,
  getCalendarConnectionById,
  getCalendarConnections,
  updateCalendarBookingStatus,
} from '../src/calendar.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...values) as T[],
      meta: {},
    }) as D1Result<T>,
    raw: async <T>() => sqlite.prepare(sql).raw().all(...values) as T[],
    run: async () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  }) as unknown as D1PreparedStatement;
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: D1PreparedStatement[]) => Promise.all(
      statements.map((prepared) => prepared.run()),
    ),
  } as unknown as D1Database;
}

describe('004 custom_061 generic resource tenant scope', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO tenants (id, tenant_code, display_name) VALUES
        ('tenant-a', 'a', 'A'), ('tenant-b', 'b', 'B');
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret) VALUES
        ('account-a', 'channel-a', 'A', 'token-a', 'secret-a'),
        ('account-b', 'channel-b', 'B', 'token-b', 'secret-b');
      INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES
        ('tenant-a', 'account-a'), ('tenant-b', 'account-b');
      INSERT INTO friends (id, line_user_id, line_account_id) VALUES
        ('friend-a', 'line-a', 'account-a'), ('friend-b', 'line-b', 'account-b');
    `);
    db = d1From(sqlite);
  });

  it('keeps message-template CRUD inside the authenticated tenant', async () => {
    const own = await createMessageTemplate(db, {
      name: 'own', messageType: 'text', messageContent: 'A', tenantId: 'tenant-a',
    });
    await createMessageTemplate(db, {
      name: 'other', messageType: 'text', messageContent: 'B', tenantId: 'tenant-b',
    });

    expect((await listMessageTemplates(db, 'tenant-a')).map((row) => row.name)).toEqual(['own']);
    await expect(getMessageTemplateById(db, own.id, 'tenant-b')).resolves.toBeNull();
    await expect(updateMessageTemplate(db, own.id, { name: 'stolen' }, 'tenant-b'))
      .resolves.toBeNull();
    await expect(deleteMessageTemplate(db, own.id, 'tenant-b')).resolves.toBe(false);
    await expect(getMessageTemplateById(db, own.id, 'tenant-a'))
      .resolves.toMatchObject({ name: 'own', tenant_id: 'tenant-a' });
    await expect(getMessageTemplateById(db, own.id)).resolves.toMatchObject({ id: own.id });
  });

  it('keeps template CRUD and references inside the authenticated tenant', async () => {
    const own = await createTemplate(db, {
      name: 'own', messageType: 'text', messageContent: 'A', tenantId: 'tenant-a',
    });
    const other = await createTemplate(db, {
      name: 'other', messageType: 'text', messageContent: 'B', tenantId: 'tenant-b',
    });

    expect((await getTemplates(db, undefined, 'tenant-a')).map((row) => row.name))
      .toEqual(['own']);
    expect((await getTemplatesWithUsageCount(db, undefined, 'tenant-a')).map((row) => row.name))
      .toEqual(['own']);
    await expect(getTemplateById(db, own.id, 'tenant-b')).resolves.toBeNull();
    await expect(updateTemplate(db, own.id, { name: 'stolen' }, 'tenant-b'))
      .resolves.toBe(false);
    await expect(deleteTemplate(db, own.id, 'tenant-b')).resolves.toBe(false);
    await expect(getTemplateById(db, own.id, 'tenant-a'))
      .resolves.toMatchObject({ name: 'own', tenant_id: 'tenant-a' });

    sqlite.prepare(`INSERT INTO scenarios
      (id, name, trigger_type, tenant_id) VALUES ('scenario-a-template', 'A', 'manual', 'tenant-a')`).run();
    expect(() => sqlite.prepare(`INSERT INTO auto_replies
      (id, keyword, response_type, response_content, template_id, line_account_id)
      VALUES ('reply-cross-template', 'cross', 'text', 'fallback', ?, 'account-a')`)
      .run(other.id)).toThrow(/AUTO_REPLY_TEMPLATE_TENANT_SCOPE_MISMATCH/);
    expect(() => sqlite.prepare(`INSERT INTO scenario_steps
      (id, scenario_id, step_order, delay_minutes, message_type, message_content, template_id)
      VALUES ('step-cross-template', 'scenario-a-template', 1, 0, 'text', 'fallback', ?)`)
      .run(other.id)).toThrow(/SCENARIO_TEMPLATE_TENANT_SCOPE_MISMATCH/);
  });

  it('keeps entry-route admin CRUD inside the authenticated tenant', async () => {
    const own = await createEntryRoute(db, {
      refCode: 'own-ref', name: 'own', tenantId: 'tenant-a',
    });
    await createEntryRoute(db, {
      refCode: 'other-ref', name: 'other', tenantId: 'tenant-b',
    });

    expect((await getEntryRoutes(db, 'tenant-a')).map((row) => row.name)).toEqual(['own']);
    await expect(getEntryRouteById(db, own.id, 'tenant-b')).resolves.toBeNull();
    await expect(updateEntryRoute(db, own.id, { name: 'stolen' }, 'tenant-b'))
      .resolves.toBeNull();
    await expect(deleteEntryRoute(db, own.id, 'tenant-b')).resolves.toBe(false);
    await expect(getEntryRouteById(db, own.id, 'tenant-a'))
      .resolves.toMatchObject({ name: 'own', tenant_id: 'tenant-a' });
    // The globally unique ref code is the public lookup authority.
    await expect(getEntryRouteByRefCode(db, 'own-ref')).resolves.toMatchObject({ id: own.id });
  });

  it('keeps form admin CRUD and submissions inside the authenticated tenant', async () => {
    const own = await createForm(db, {
      name: 'own', fields: '[]', tenantId: 'tenant-a',
    });
    await createForm(db, {
      name: 'other', fields: '[]', tenantId: 'tenant-b',
    });

    expect((await getForms(db, 'tenant-a')).map((row) => row.name)).toEqual(['own']);
    expect((await getFormsWithStats(db, 'tenant-a')).map((row) => row.name)).toEqual(['own']);
    await expect(getFormById(db, own.id, 'tenant-b')).resolves.toBeNull();
    await expect(updateForm(db, own.id, { name: 'stolen' }, 'tenant-b')).resolves.toBeNull();
    await expect(deleteForm(db, own.id, 'tenant-b')).resolves.toBe(false);
    await expect(getFormById(db, own.id, 'tenant-a'))
      .resolves.toMatchObject({ name: 'own', tenant_id: 'tenant-a' });
    await expect(getFormById(db, own.id)).resolves.toMatchObject({ id: own.id });
    await expect(createFormSubmission(db, {
      formId: own.id,
      friendId: 'friend-b',
      data: '{}',
    })).rejects.toThrow(/FORM_SUBMISSION_TENANT_SCOPE_MISMATCH/);
  });

  it('keeps traffic-pool CRUD and account membership inside one tenant', async () => {
    const own = await createTrafficPool(db, {
      slug: 'own-pool', name: 'own', activeAccountId: 'account-a', tenantId: 'tenant-a',
    });
    await createTrafficPool(db, {
      slug: 'other-pool', name: 'other', activeAccountId: 'account-b', tenantId: 'tenant-b',
    });

    expect((await getTrafficPools(db, 'tenant-a')).map((row) => row.name)).toEqual(['own']);
    await expect(getTrafficPoolById(db, own.id, 'tenant-b')).resolves.toBeNull();
    await expect(updateTrafficPool(db, own.id, { name: 'stolen' }, 'tenant-b'))
      .resolves.toBeNull();
    await expect(deleteTrafficPool(db, own.id, 'tenant-b')).resolves.toBe(false);
    await expect(getTrafficPoolById(db, own.id, 'tenant-a'))
      .resolves.toMatchObject({ name: 'own', tenant_id: 'tenant-a' });
    await expect(getTrafficPoolBySlug(db, 'own-pool')).resolves.toMatchObject({ id: own.id });
    await expect(addPoolAccount(db, own.id, 'account-b', 'tenant-a'))
      .rejects.toThrow(/TRAFFIC_POOL_ACCOUNT_TENANT_SCOPE_MISMATCH/);
  });

  it('derives calendar-booking ownership from its tenant-scoped connection', async () => {
    const own = await createCalendarConnection(db, {
      calendarId: 'calendar-a', authType: 'api_key', apiKey: 'key-a',
      lineAccountId: 'account-a', tenantId: 'tenant-a',
    });
    await createCalendarConnection(db, {
      calendarId: 'calendar-b', authType: 'api_key', apiKey: 'key-b',
      lineAccountId: 'account-b', tenantId: 'tenant-b',
    });

    expect((await getCalendarConnections(db, 'tenant-a')).map((row) => row.calendar_id))
      .toEqual(['calendar-a']);
    await expect(getCalendarConnectionById(db, own.id, 'tenant-b')).resolves.toBeNull();
    await expect(deleteCalendarConnection(db, own.id, 'tenant-b')).resolves.toBe(false);
    await expect(createCalendarBooking(db, {
      connectionId: own.id,
      friendId: 'friend-b',
      title: 'cross-tenant',
      startAt: '2026-09-01T10:00:00+09:00',
      endAt: '2026-09-01T11:00:00+09:00',
      tenantId: 'tenant-a',
    })).rejects.toThrow(/CALENDAR_BOOKING_ACCOUNT_SCOPE_MISMATCH/);

    const booking = await createCalendarBooking(db, {
      connectionId: own.id,
      friendId: 'friend-a',
      title: 'own',
      startAt: '2026-09-01T10:00:00+09:00',
      endAt: '2026-09-01T11:00:00+09:00',
      tenantId: 'tenant-a',
    });
    await expect(getCalendarBookingById(db, booking.id, 'tenant-b')).resolves.toBeNull();
    expect(await getCalendarBookings(db, { tenantId: 'tenant-b' })).toEqual([]);
    await expect(updateCalendarBookingStatus(db, booking.id, 'cancelled', 'tenant-b'))
      .resolves.toBe(false);
  });

  it('rejects cross-tenant references from forms and entry routes', async () => {
    sqlite.exec(`
      INSERT INTO tags (id, name, tenant_id) VALUES
        ('tag-a', 'tag-a', 'tenant-a'), ('tag-b', 'tag-b', 'tenant-b');
      INSERT INTO scenarios (id, name, trigger_type, tenant_id) VALUES
        ('scenario-a', 'A', 'manual', 'tenant-a'),
        ('scenario-b', 'B', 'manual', 'tenant-b');
    `);
    const templateB = await createMessageTemplate(db, {
      name: 'template-b', messageType: 'text', messageContent: 'B', tenantId: 'tenant-b',
    });
    const poolB = await createTrafficPool(db, {
      slug: 'pool-b-ref', name: 'B', activeAccountId: 'account-b', tenantId: 'tenant-b',
    });

    for (const [suffix, reference] of [
      ['tag', { tagId: 'tag-b' }],
      ['scenario', { scenarioId: 'scenario-b' }],
      ['template', { introTemplateId: templateB.id }],
      ['pool', { poolId: poolB.id }],
    ] as const) {
      await expect(createEntryRoute(db, {
        refCode: `cross-${suffix}`,
        name: `cross-${suffix}`,
        tenantId: 'tenant-a',
        ...reference,
      })).rejects.toThrow(/ENTRY_ROUTE_RESOURCE_TENANT_SCOPE_MISMATCH/);
    }

    await expect(createForm(db, {
      name: 'cross-tag', fields: '[]', tenantId: 'tenant-a', onSubmitTagId: 'tag-b',
    })).rejects.toThrow(/FORM_RESOURCE_TENANT_SCOPE_MISMATCH/);
    await expect(createForm(db, {
      name: 'cross-scenario', fields: '[]', tenantId: 'tenant-a',
      onSubmitScenarioId: 'scenario-b',
    })).rejects.toThrow(/FORM_RESOURCE_TENANT_SCOPE_MISMATCH/);

    for (const [suffix, column, value] of [
      ['tag', 'tag_id', 'tag-b'],
      ['scenario', 'scenario_id', 'scenario-b'],
      ['intro', 'intro_template_id', templateB.id],
      ['reward', 'reward_template_id', templateB.id],
    ]) {
      expect(() => sqlite.prepare(
        `INSERT INTO tracked_links
          (id, name, original_url, line_account_id, ${column})
         VALUES (?, ?, 'https://example.test', 'account-a', ?)`,
      ).run(`tracked-${suffix}`, `tracked-${suffix}`, value))
        .toThrow(/TRACKED_LINK_RESOURCE_TENANT_SCOPE_MISMATCH/);
    }
  });

  it('preserves the isolated legacy-global scope for resources without a tenant mapping', async () => {
    sqlite.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-global', 'channel-global', 'Global', 'token-global', 'secret-global')`).run();

    await expect(createTrafficPool(db, {
      slug: 'global-pool', name: 'Global', activeAccountId: 'account-global',
    })).resolves.toMatchObject({ tenant_id: null });
    await expect(createCalendarConnection(db, {
      calendarId: 'global-calendar', authType: 'api_key', apiKey: 'global-key',
    })).resolves.toMatchObject({ tenant_id: null, line_account_id: null });
  });
});
