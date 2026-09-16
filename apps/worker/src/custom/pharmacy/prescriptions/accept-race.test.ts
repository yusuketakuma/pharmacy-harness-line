import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyAdminPrescriptionAction } from './repository.js'
import { savePrescriptionValidity } from '../growth-loop/repository.js'
import { createFulfillmentQuote } from '../fulfillment/repository.js'

type Gate = { ready: Promise<void>; open: () => void }
function gate(): Gate {
  let open!: () => void
  const ready = new Promise<void>((resolve) => { open = resolve })
  return { ready, open }
}

const schema = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db/schema.sql'), 'utf8')
function tableSql(name: string): string {
  const match = schema.match(new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\n\\);`))
  if (!match) throw new Error(`missing schema table: ${name}`)
  return match[0]
}

function execute(sqlite: DatabaseSync, sql: string, values: SQLInputValue[]) {
  const returning = /\bRETURNING\b/i.test(sql)
  const rows = returning
    ? sqlite.prepare(sql).all(...values)
    : (() => { sqlite.prepare(sql).run(...values); return [] })()
  const changes = Number((sqlite.prepare('SELECT changes() AS changes').get() as { changes: number }).changes)
  return { success: true, results: rows, meta: { changes } }
}

function makeDb(options: { gateOn: 'validity' | 'quote'; intakeRequired: number }) {
  const sqlite = new DatabaseSync(':memory:')
  // Foreign-key enforcement is off for this disposable reduced fixture; shipped table DDL is unchanged.
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec('CREATE TABLE line_accounts (id TEXT PRIMARY KEY)')
  for (const name of [
    'pharmacy_prescription_submissions',
    'pharmacy_prescription_validities',
    'pharmacy_account_capabilities',
    'pharmacy_growth_events',
    'pharmacy_fulfillment_quotes',
    'pharmacy_myna_handoffs',
    'pharmacy_myna_events',
    'pharmacy_prescription_events',
  ]) sqlite.exec(tableSql(name))
  sqlite.exec(`
    INSERT INTO line_accounts (id) VALUES ('account-a');
    INSERT INTO pharmacy_prescription_submissions
      (id, line_account_id, friend_id, idempotency_key, status, upload_revision,
       intake_required, intake_method, created_at, updated_at)
      VALUES ('submission-a', 'account-a', 'friend-a', 'submission-key-a', 'received', 1,
              ${options.intakeRequired}, 'PAPER', '2026-08-16T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
    INSERT INTO pharmacy_prescription_validities
      (submission_id, line_account_id, issued_on, valid_until, validity_basis,
       verification_status, verified_by, verified_at, created_at, updated_at)
      VALUES ('submission-a', 'account-a', '2026-08-16', '2999-12-31', 'prescriber_specified',
              'verified', 'staff-old', '2026-08-16T00:00:00.000Z',
              '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');
    INSERT INTO pharmacy_fulfillment_quotes
      (id, submission_id, line_account_id, revision, decision, reason_codes_json,
       requirements_json, estimated_ready_at, valid_until, created_by, created_at,
       status, fulfillment_method, constraints_json, reservation_expires_at)
      VALUES ('quote-a', 'submission-a', 'account-a', 1, 'fulfillable', '[]', '[]',
              NULL, '2999-12-31', 'staff-old', '2026-08-16T00:00:00.000Z',
              'AVAILABLE', NULL, '[]', NULL);
  `)
  const reached = gate()
  const release = gate()
  let gateUsed = false
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          return {
            sql,
            values,
            async first() {
              const row = sqlite.prepare(sql).get(...values) ?? null
              const isTarget = sql.includes(options.gateOn === 'validity'
                ? 'FROM pharmacy_prescription_validities'
                : 'FROM pharmacy_fulfillment_quotes')
              if (isTarget && !gateUsed) {
                gateUsed = true
                reached.open()
                await release.ready
              }
              return row
            },
            run: async () => execute(sqlite, sql, values),
            all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
          }
        },
      }
    },
    async batch<T = Record<string, unknown>>(statements: Array<{ sql?: string; values?: SQLInputValue[]; run?: () => unknown }>) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((statement) => {
          if (statement.sql && statement.values) return execute(sqlite, statement.sql, statement.values)
          if (statement.run) return statement.run()
          throw new Error('invalid synthetic statement')
        })
        sqlite.exec('COMMIT')
        return results as T[]
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
  return { sqlite, db, reached, release }
}

async function runValidityRace() {
  const { sqlite, db, reached, release } = makeDb({ gateOn: 'validity', intakeRequired: 0 })
  const action = applyAdminPrescriptionAction(
    db, 'account-a', 'submission-a', 'admin_accept',
    '2026-08-17T00:00:00.000Z', 'staff-a', null,
    new Date('2026-08-17T01:00:00.000Z'),
  )
  await reached.ready
  const writer = await savePrescriptionValidity(db, {
    lineAccountId: 'account-a', submissionId: 'submission-a',
    issuedOn: null, validUntil: null, validityBasis: 'prescriber_specified',
    verificationStatus: 'unverified', staffId: null,
  }).then(() => 'fulfilled', (error: unknown) => `rejected: ${String(error)}`)
  release.open()
  const result = await action.then(
    (value) => ({ outcome: 'fulfilled', value }),
    (error: unknown) => ({ outcome: 'rejected', error: String(error) }),
  )
  const state = sqlite.prepare(`SELECT status FROM pharmacy_prescription_submissions WHERE id = 'submission-a'`).get() as { status: string }
  const validity = sqlite.prepare(`SELECT verification_status FROM pharmacy_prescription_validities WHERE submission_id = 'submission-a'`).get() as { verification_status: string }
  const events = sqlite.prepare(`SELECT count(*) AS count FROM pharmacy_prescription_events`).get() as { count: number }
  sqlite.close()
  return { race: 'validity', writer, result, status: state.status, finalValidity: validity.verification_status, statusEventCount: Number(events.count) }
}

async function runQuoteRace() {
  const { sqlite, db, reached, release } = makeDb({ gateOn: 'quote', intakeRequired: 1 })
  const action = applyAdminPrescriptionAction(
    db, 'account-a', 'submission-a', 'admin_accept',
    '2026-08-17T00:00:00.000Z', 'staff-a', null,
    new Date('2026-08-17T01:00:00.000Z'),
  )
  await reached.ready
  const writer = await createFulfillmentQuote(db, 'account-a', 'submission-a', 'staff-b', {
    decision: 'not_fulfillable', reasonCodes: ['stock_unavailable'], requirements: [],
    estimatedReadyAt: null, validUntil: null, status: 'UNAVAILABLE',
  }).then((quote) => ({ outcome: 'fulfilled', revision: quote.revision, status: quote.status }),
    (error: unknown) => ({ outcome: 'rejected', error: String(error) }))
  release.open()
  const result = await action.then(
    (value) => ({ outcome: 'fulfilled', value }),
    (error: unknown) => ({ outcome: 'rejected', error: String(error) }),
  )
  const state = sqlite.prepare(`SELECT status FROM pharmacy_prescription_submissions WHERE id = 'submission-a'`).get() as { status: string }
  const quote = sqlite.prepare(`SELECT revision, decision, status FROM pharmacy_fulfillment_quotes ORDER BY revision DESC LIMIT 1`).get() as { revision: number; decision: string; status: string }
  const events = sqlite.prepare(`SELECT count(*) AS count FROM pharmacy_prescription_events`).get() as { count: number }
  sqlite.close()
  return { race: 'quote', writer, result, status: state.status, latestQuote: quote, statusEventCount: Number(events.count) }
}

describe("prescription acceptance keeps its checked records current", () => {
  it.each([0, 1])("accepts unchanged records with intake_required=%i", async (intakeRequired) => {
    const { sqlite, db, release } = makeDb({ gateOn: intakeRequired ? 'quote' : 'validity', intakeRequired })
    if (intakeRequired === 0) sqlite.exec('DELETE FROM pharmacy_fulfillment_quotes')
    release.open()
    try {
      const result = await applyAdminPrescriptionAction(
        db, 'account-a', 'submission-a', 'admin_accept',
        '2026-08-17T00:00:00.000Z', 'staff-a', null,
        new Date('2026-08-17T01:00:00.000Z'),
      )
      expect(result.status).toBe('accepted')
      expect(sqlite.prepare('SELECT count(*) AS n FROM pharmacy_prescription_events').get()!.n).toBe(1)
    } finally { sqlite.close() }
  })

  it("rejects when validity is changed by the shipped writer before accept", async () => {
    const result = await runValidityRace()
    expect(result.writer).toBe("fulfilled")
    expect(result.result).toMatchObject({ outcome: "rejected", error: expect.stringContaining("prescription admin action conflict") })
    expect(result).toMatchObject({ status: "received", finalValidity: "unverified", statusEventCount: 0 })
  })

  it("rejects when a newer quote is created by the shipped writer before accept", async () => {
    const result = await runQuoteRace()
    expect(result.writer).toMatchObject({ outcome: "fulfilled", revision: 2, status: "UNAVAILABLE" })
    expect(result.result).toMatchObject({ outcome: "rejected", error: expect.stringContaining("prescription admin action conflict") })
    expect(result).toMatchObject({ status: "received", statusEventCount: 0, latestQuote: { decision: "not_fulfillable" } })
  })
})
