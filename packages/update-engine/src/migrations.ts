import { createHash } from 'node:crypto';
import type { CfApiCreds } from './types.js';
import { executeD1Query } from './cf-api/d1.js';
import { isBenignSchemaErrorText } from './materialize.js';

export const MIGRATION_STATE_TABLE = '_line_harness_migrations';

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
 * Each migration and its checksum ledger insert share one D1 query request.
 * D1 executes multi-statement queries transactionally, so a failed statement
 * cannot leave schema changes without their ledger row. A missing ledger is
 * never inferred from schema shape; setup must establish the trusted baseline.
 */
export async function applyD1Migrations(
  opts: ApplyD1MigrationsOptions,
): Promise<MigrationApplyResult[]> {
  const execute = opts.execute ?? executeD1Query;
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
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    params: [MIGRATION_STATE_TABLE],
  });
  const legacyBaseline = firstResultValue(ledger, 'name') !== MIGRATION_STATE_TABLE;
  const recordedNames = new Set<string>();
  if (legacyBaseline) {
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
        'name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
    });
  } else {
    // Complete every checksum read and pending SQL safety check before the
    // first migration write. Historical bytes are trusted only by exact
    // ledger checksum and are never reinterpreted under newer SQL policy.
    for (const name of opts.names) {
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
    const atomicSql = [...statements, ledgerInsert]
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
      executedStatements: statements.length,
      skippedStatements: 0,
    };
    results.push(result);
    await opts.onMigrationDone?.(result);
  }
  return results;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function pushSqlStatement(statements: string[], candidate: string): void {
  const trimmed = candidate.trim();
  if (trimmed && stripSqlComments(trimmed).trim()) statements.push(trimmed);
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function firstResultValue(
  response: { result: any[] },
  key: string,
): unknown {
  const first = response.result?.[0];
  const rows = first && typeof first === 'object' ? first.results : undefined;
  return Array.isArray(rows) && rows.length > 0 ? rows[0]?.[key] : undefined;
}
