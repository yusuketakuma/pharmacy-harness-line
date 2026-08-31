import { createHash } from 'node:crypto';
import type { CfApiCreds } from './types.js';
import { assertD1Success, executeD1Query } from './cf-api/d1.js';
import { createTriggerName, isBenignSchemaErrorText, normalizeTriggerSql } from './materialize.js';

export const MIGRATION_STATE_TABLE = '_line_harness_migrations';
const LEGACY_BASELINE_MARKER = '__line_harness_legacy_baseline_in_progress__';

type D1Executor = typeof executeD1Query;

export interface MigrationApplyResult {
  name: string;
  alreadyApplied: boolean;
  executedStatements: number;
  skippedStatements: number;
}

export interface ApplyD1MigrationsOptions {
  creds: CfApiCreds;
  databaseId: string;
  names: string[];
  migrations: Map<string, Buffer>;
  onMigrationStart?: (name: string) => void | Promise<void>;
  onMigrationDone?: (result: MigrationApplyResult) => void | Promise<void>;
  /** Customer deployment paths require a setup-created checksum baseline. */
  requireChecksumLedger?: boolean;
  /** Test seam. Production callers use the Cloudflare D1 HTTP API. */
  execute?: D1Executor;
}

export function migrationChecksum(source: Buffer): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

export function buildMigrationLedgerSql(
  names: string[],
  migrations: Map<string, Buffer>,
): string {
  const rows = names.map((name) => {
    const source = migrations.get(name);
    if (!source) throw new Error(`migration ${name} missing while building checksum ledger`);
    return (
      `INSERT OR IGNORE INTO ${MIGRATION_STATE_TABLE} (name, checksum, applied_at) VALUES (` +
      `${sqlLiteral(name)}, ${sqlLiteral(migrationChecksum(source))}, ` +
      "strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));"
    );
  });
  return [
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_STATE_TABLE} (` +
      'name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);',
    ...rows,
  ].join('\n');
}

/**
 * Split a SQLite migration into individual statements.
 *
 * D1 executes a multi-statement SQL string atomically. That is unsafe for
 * legacy LINE Harness installs: one duplicate ALTER TABLE rolls back later
 * statements in the same file. This scanner splits only on semicolons that
 * are outside strings, quoted identifiers, and comments.
 *
 * Simple SQLite trigger bodies are kept as one statement. CASE-bearing
 * triggers fail closed because distinguishing their END token needs a full
 * SQL parser.
 */
export function splitSqlStatements(sql: string): string[] {
  const uncommented = stripSqlComments(sql);
  if (
    /\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(uncommented)
    && /\bCASE\b/i.test(uncommented)
  ) {
    // ponytail: add a real SQL parser only when a CASE-bearing trigger is required.
    throw new Error('CASE-bearing CREATE TRIGGER requires a full SQL parser');
  }
  if (
    /\bDROP\s+(?:TABLE|COLUMN)\b/i.test(uncommented) ||
    /\bRENAME\s+(?:TO|COLUMN)\b/i.test(uncommented)
  ) {
    throw new Error('destructive schema changes are not supported by safe D1 updates');
  }

  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === '\n' || ch === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      const closing = quote;
      if (ch === closing) {
        // SQLite escapes quote characters by doubling them.
        if (next === closing && closing !== ']') {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      quote = ']';
      continue;
    }
    if (ch === ';') {
      const candidate = stripSqlComments(sql.slice(start, i)).trim();
      const isTrigger = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(candidate);
      if (isTrigger && !/\bEND\s*$/i.test(candidate)) continue;
      pushSqlStatement(statements, sql.slice(start, i));
      start = i + 1;
    }
  }

  if (quote || blockComment) {
    throw new Error('migration contains an unterminated SQL quote or block comment');
  }
  pushSqlStatement(statements, sql.slice(start));
  return statements;
}

/**
 * Apply cumulative release migrations safely across fresh, fully-applied,
 * and partially-applied databases.
 *
 * Two paths, with different atomicity:
 *
 * - Trusted-ledger path: each migration and its checksum ledger insert share
 *   ONE D1 query request. D1 executes that multi-statement query as a single
 *   batch, so a failed statement cannot leave schema changes without their
 *   ledger row — and because a lost response is indistinguishable from a
 *   failure, the ledger row is re-read before deciding.
 * - Legacy-baseline path: statements are applied ONE AT A TIME (a legacy
 *   install may already hold part of a file, and one duplicate ALTER TABLE
 *   would roll back the rest of a batch). That is deliberately NOT atomic:
 *   partial application is possible. It is safe because the ledger row is
 *   written only after every statement of the file was executed or skipped as
 *   a duplicate, so an interrupted file leaves no ledger row and the next run
 *   re-applies it, and because duplicate objects that could differ in body
 *   (triggers) are verified against the live definition instead of assumed.
 *
 * A missing ledger is never inferred from schema shape; setup must establish
 * the trusted baseline.
 */
export async function applyD1Migrations(
  opts: ApplyD1MigrationsOptions,
): Promise<MigrationApplyResult[]> {
  const raw = opts.execute ?? executeD1Query;
  // A `success: false` envelope is a failure whichever executor produced it.
  const execute: D1Executor = async (args) => assertD1Success(await raw(args));
  const base = { creds: opts.creds, databaseId: opts.databaseId };

  // Validate manifest structure before D1 access. SQL safety checks happen
  // after the trusted ledger identifies which migrations are still pending.
  if (new Set(opts.names).size !== opts.names.length) {
    throw new Error('migration manifest contains duplicate names');
  }
  const checksums = new Map<string, string>();
  const parsedStatements = new Map<string, string[]>();
  for (const name of opts.names) {
    const source = opts.migrations.get(name);
    if (!source) throw new Error(`migration ${name} missing in bundle`);
    checksums.set(name, migrationChecksum(source));
  }
  if (opts.names.length === 0) return [];

  const ledger = await execute({
    ...base,
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)",
    params: [MIGRATION_STATE_TABLE, LEGACY_BASELINE_MARKER],
  });
  const ledgerTables = new Set<string>(
    (ledger.result?.[0]?.results ?? []).map((row: any) => row.name),
  );
  const ledgerMissing = !ledgerTables.has(MIGRATION_STATE_TABLE);
  const legacyMarkerPresent = ledgerTables.has(LEGACY_BASELINE_MARKER);
  const legacyBaseline = ledgerMissing || legacyMarkerPresent;
  if (legacyMarkerPresent && opts.requireChecksumLedger) {
    throw new Error('legacy migration baseline is incomplete; resume trusted setup first');
  }
  const recordedNames = new Set<string>();
  if (ledgerMissing) {
    if (opts.requireChecksumLedger) {
      throw new Error(
        'migration checksum ledger missing; run trusted setup/baseline initialization before deployment',
      );
    }
    for (const name of opts.names) {
      parsedStatements.set(
        name,
        splitSqlStatements((opts.migrations.get(name) as Buffer).toString('utf8')),
      );
    }
    await execute({
      ...base,
      sql:
        `CREATE TABLE ${MIGRATION_STATE_TABLE} (` +
        'name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);' +
        `CREATE TABLE ${LEGACY_BASELINE_MARKER} (` +
        'id INTEGER PRIMARY KEY CHECK (id = 1));',
    });
  } else {
    // Complete every checksum read and pending SQL safety check before the
    // first migration write. Historical bytes are trusted only by exact
    // ledger checksum and are never reinterpreted under newer SQL policy.
    const v033Epoch = !legacyBaseline &&
      opts.requireChecksumLedger && opts.names[0] === '001_v033_baseline.sql';
    if (v033Epoch) {
      const stored = await execute({
        ...base,
        sql: `SELECT name, checksum FROM ${MIGRATION_STATE_TABLE}`,
      });
      const rows = stored.result?.[0]?.results;
      const recorded = new Map<string, string>(
        (Array.isArray(rows) ? rows : []).map((row: any) => [row.name, row.checksum]),
      );
      for (const name of recorded.keys()) {
        if (!checksums.has(name)) {
          throw new Error(`wrong migration epoch: unknown ledger entry ${name}`);
        }
      }
      let missing = false;
      for (const name of opts.names) {
        const priorChecksum = recorded.get(name);
        if (priorChecksum === undefined) {
          missing = true;
          continue;
        }
        if (missing) {
          throw new Error(`migration ledger is not an exact manifest prefix at ${name}`);
        }
        const checksum = checksums.get(name) as string;
        if (priorChecksum !== checksum) {
          throw new Error(
            `migration ${name} changed after it was applied (${priorChecksum} != ${checksum})`,
          );
        }
        recordedNames.add(name);
      }
    }
    for (const name of opts.names) {
      if (v033Epoch) {
        if (!recordedNames.has(name)) {
          parsedStatements.set(
            name,
            splitSqlStatements((opts.migrations.get(name) as Buffer).toString('utf8')),
          );
        }
        continue;
      }
      const recorded = await execute({
        ...base,
        sql: `SELECT checksum FROM ${MIGRATION_STATE_TABLE} WHERE name = ?`,
        params: [name],
      });
      const priorChecksum = firstResultValue(recorded, 'checksum');
      const checksum = checksums.get(name) as string;
      if (typeof priorChecksum === 'string') {
        if (priorChecksum !== checksum) {
          throw new Error(
            `migration ${name} changed after it was applied (${priorChecksum} != ${checksum})`,
          );
        }
        recordedNames.add(name);
      } else {
        parsedStatements.set(
          name,
          splitSqlStatements((opts.migrations.get(name) as Buffer).toString('utf8')),
        );
      }
    }
  }

  const atomicStatementsByMigration = new Map<string, string[]>();
  if (!legacyBaseline) {
    for (const name of opts.names) {
      if (recordedNames.has(name)) continue;
      const atomicStatements: string[] = [];
      const droppedTriggers = new Set<string>();
      for (const statement of parsedStatements.get(name) as string[]) {
        const bare = stripSqlComments(statement).trim();
        const droppedTrigger = dropTriggerName(bare);
        if (droppedTrigger) droppedTriggers.add(droppedTrigger.toLowerCase());
        const createdTrigger = createTriggerName(bare);
        const isReplacement = createdTrigger
          ? droppedTriggers.delete(createdTrigger.toLowerCase())
          : false;
        if (createdTrigger && !isReplacement && await triggerAlreadyMatches(execute, base, name, statement)) {
          throw new Error(
            `migration ${name}: preexisting trigger without ledger entry`,
          );
        }
        atomicStatements.push(strictCreateTrigger(statement));
      }
      atomicStatementsByMigration.set(name, atomicStatements);
    }
  }

  const results: MigrationApplyResult[] = [];
  for (const name of opts.names) {
    await opts.onMigrationStart?.(name);
    const checksum = checksums.get(name) as string;
    if (recordedNames.has(name)) {
      const result: MigrationApplyResult = {
        name,
        alreadyApplied: true,
        executedStatements: 0,
        skippedStatements: 0,
      };
      results.push(result);
      await opts.onMigrationDone?.(result);
      continue;
    }

    const statements = parsedStatements.get(name) as string[];
    if (legacyBaseline) {
      let executedStatements = 0;
      let skippedStatements = 0;
      for (const statement of statements) {
        if (await triggerAlreadyMatches(execute, base, name, statement)) {
          skippedStatements += 1;
          continue;
        }
        try {
          await execute({ ...base, sql: statement });
          executedStatements += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isBenignSchemaErrorText(message)) throw error;
          skippedStatements += 1;
        }
      }
      await execute({
        ...base,
        sql:
          `INSERT INTO ${MIGRATION_STATE_TABLE} (name, checksum, applied_at) ` +
          "VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params: [name, checksum],
      });
      const result = {
        name,
        alreadyApplied: false,
        executedStatements,
        skippedStatements,
      };
      results.push(result);
      await opts.onMigrationDone?.(result);
      continue;
    }
    const ledgerInsert =
        `INSERT INTO ${MIGRATION_STATE_TABLE} (name, checksum, applied_at) ` +
        `VALUES (${sqlLiteral(name)}, ${sqlLiteral(checksum)}, ` +
        "strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
    const atomicStatements = atomicStatementsByMigration.get(name) as string[];
    const skippedStatements = 0;
    const atomicSql = [...atomicStatements, ledgerInsert]
      .map((statement) => `${statement.replace(/;\s*$/, '')};`)
      .join('\n');
    try {
      await execute({ ...base, sql: atomicSql });
    } catch (error) {
      const reconciled = await execute({
        ...base,
        sql: `SELECT checksum FROM ${MIGRATION_STATE_TABLE} WHERE name = ?`,
        params: [name],
      });
      const reconciledChecksum = firstResultValue(reconciled, 'checksum');
      if (reconciledChecksum !== checksum) {
        const message = error instanceof Error ? error.message : String(error);
        if (typeof reconciledChecksum === 'string') {
          throw new Error(
            `migration ${name} changed after it was applied (${reconciledChecksum} != ${checksum})`,
          );
        }
        throw new Error(`migration ${name} failed atomically: ${message}`, { cause: error });
      }
    }
    const result: MigrationApplyResult = {
      name,
      alreadyApplied: false,
      executedStatements: atomicStatements.length,
      skippedStatements,
    };
    results.push(result);
    await opts.onMigrationDone?.(result);
  }
  if (legacyBaseline) {
    await execute({
      ...base,
      sql: `DROP TABLE ${LEGACY_BASELINE_MARKER}`,
    });
  }
  return results;
}

/**
 * Decide whether a pending statement is a CREATE TRIGGER whose live definition
 * already matches, i.e. genuinely applied by a prior interrupted attempt.
 *
 * `CREATE TRIGGER IF NOT EXISTS` is silent when a trigger of that name exists
 * with a DIFFERENT body — no error to classify as benign — so the tenant
 * integrity triggers (custom_016/017/022) could be recorded as applied while
 * the database enforces something else. Compare the stored definition and
 * fail closed on a mismatch: an operator resolves it explicitly with a new
 * versioned DROP TRIGGER + CREATE TRIGGER migration.
 *
 * Returns false for every non-trigger statement, so duplicate CREATE TABLE /
 * CREATE INDEX keep their existing benign-error handling.
 */
async function triggerAlreadyMatches(
  execute: D1Executor,
  base: { creds: CfApiCreds; databaseId: string },
  migration: string,
  statement: string,
): Promise<boolean> {
  const bare = stripSqlComments(statement).trim();
  const trigger = createTriggerName(bare);
  if (!trigger) return false;

  const live = await execute({
    ...base,
    sql: "SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ? COLLATE NOCASE",
    params: [trigger],
  });
  const liveSql = firstResultValue(live, 'sql');
  if (typeof liveSql !== 'string') return false;
  if (normalizeTriggerSql(liveSql) === normalizeTriggerSql(bare)) return true;

  throw new Error(
    `migration ${migration}: trigger ${trigger} already exists with a different definition. ` +
      `Resolve it with a new migration that drops and recreates the trigger. ` +
      `expected: ${bare} | actual: ${liveSql}`,
  );
}

function strictCreateTrigger(statement: string): string {
  const bare = stripSqlComments(statement).trim();
  if (!createTriggerName(bare)) return statement;
  return bare.replace(
    /^(CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER)\s+IF\s+NOT\s+EXISTS\s+/i,
    '$1 ',
  );
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function pushSqlStatement(statements: string[], candidate: string): void {
  const trimmed = candidate.trim();
  if (trimmed && stripSqlComments(trimmed).trim()) statements.push(trimmed);
}

function stripSqlComments(sql: string): string {
  let stripped = '';
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === '\n' || ch === '\r') {
        lineComment = false;
        stripped += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      } else if (ch === '\n' || ch === '\r') {
        stripped += ch;
      }
      continue;
    }
    if (quote) {
      stripped += ch;
      if (ch === quote) {
        if (next === quote && quote !== ']') {
          stripped += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      stripped += ' ';
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      stripped += ' ';
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '[') {
      quote = ']';
    }
    stripped += ch;
  }

  return stripped;
}

const DROP_TRIGGER_HEAD =
  /^\s*DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/i;

function dropTriggerName(statement: string): string | null {
  const match = DROP_TRIGGER_HEAD.exec(statement);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? match[4] ?? null;
}

function firstResultValue(
  response: { result: any[] },
  key: string,
): unknown {
  const first = response.result?.[0];
  const rows = first && typeof first === 'object' ? first.results : undefined;
  return Array.isArray(rows) && rows.length > 0 ? rows[0]?.[key] : undefined;
}
