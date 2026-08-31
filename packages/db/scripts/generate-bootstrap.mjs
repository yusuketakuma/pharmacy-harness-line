import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const SCHEMA_PATH = join(PKG_ROOT, "schema.sql");
const MIGRATIONS_DIR = join(PKG_ROOT, "migrations");
const BOOTSTRAP_PATH = join(PKG_ROOT, "bootstrap.sql");
const BOOTSTRAP_META_PATH = join(PKG_ROOT, "bootstrap-meta.json");
const BASELINE_MIGRATION = "001_v033_baseline.sql";
const BASELINE_PATH = join(MIGRATIONS_DIR, BASELINE_MIGRATION);
const BASELINE_STATUS = "mutable-prerelease";

const BENIGN_SQLITE_ERROR = /duplicate column name|already exists/i;

function listPostBaselineMigrations() {
  mkdirSync(MIGRATIONS_DIR, { recursive: true });
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => file !== BASELINE_MIGRATION)
    .sort();
  const invalid = files.filter(
    (file) => !/^\d{3}_(?:custom_\d{3}_)?[a-z0-9_]+\.sql$/.test(file) || file < "002_",
  );
  if (invalid.length > 0) {
    throw new Error(
      `post-baseline migrations require one global ordinal: ${invalid.join(", ")}`,
    );
  }
  return files;
}

function isBenignSqliteError(error) {
  return error instanceof Error && BENIGN_SQLITE_ERROR.test(error.message);
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function applyMigrationFile(db, fileName) {
  const sql = readFileSync(join(MIGRATIONS_DIR, fileName), "utf8");
  for (const statement of splitSqlStatements(sql)) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!isBenignSqliteError(error)) {
        throw new Error(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildBuiltinSeeds(db) {
  const seeds = [
    ["auto_replies", "id LIKE 'builtin-%'"],
    ["mileage_programs", "id = 'default'"],
    ["mileage_rules", "id LIKE 'builtin-%'"],
  ];

  return seeds
    .flatMap(([table, where]) => {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
      return db
        .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`)
        .all()
        .map((row) => {
          const values = columns
            .map((column) => {
              if (
                table.startsWith("mileage_") &&
                (column === "created_at" || column === "updated_at")
              ) {
                return sqlLiteral("2026-08-30T00:00:00.000Z");
              }
              return sqlLiteral(row[column]);
            })
            .join(", ");
          return `INSERT INTO ${table} (${columns.join(", ")})\nVALUES (${values});`;
        });
    })
    .join("\n\n");
}

function buildBootstrapSql() {
  const sqlitePath = join(
    tmpdir(),
    `line-harness-bootstrap-${process.pid}-${Date.now()}.sqlite`,
  );
  const db = new Database(sqlitePath);
  const postBaselineMigrations = listPostBaselineMigrations();
  const migrationFiles = [BASELINE_MIGRATION, ...postBaselineMigrations];

  try {
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));

    for (const file of postBaselineMigrations) {
      applyMigrationFile(db, file);
    }

    const rows = db
      .prepare(
        `
          SELECT type, name, sql
          FROM sqlite_master
          WHERE sql IS NOT NULL
            AND name NOT LIKE 'sqlite_%'
          ORDER BY
            CASE type
              WHEN 'table' THEN 0
              WHEN 'index' THEN 1
              WHEN 'trigger' THEN 2
              WHEN 'view' THEN 3
              ELSE 4
            END,
            name
        `,
      )
      .all();

    const header = [
      "-- Generated from schema.sql + migrations by scripts/generate-bootstrap.mjs.",
      "-- Do not edit manually. Run `pnpm --dir packages/db generate:bootstrap`.",
      "",
    ].join("\n");

    const body = rows
      .map((row) => `${String(row.sql).trim()};`)
      .join("\n\n");
    const builtinSeeds = buildBuiltinSeeds(db);

    return {
      sql: `${header}${body}${builtinSeeds ? `\n\n${builtinSeeds}` : ""}\n`,
      meta: {
        schemaEpoch: "v0.33",
        schemaMode: "pharmacy-multitenant",
        baselineMigration: BASELINE_MIGRATION,
        baselineStatus: BASELINE_STATUS,
        includedMigrations: migrationFiles,
        migrationCount: migrationFiles.length,
      },
    };
  } finally {
    db.close();
    if (existsSync(sqlitePath)) {
      rmSync(sqlitePath, { force: true });
    }
  }
}

const generated = buildBootstrapSql();
const baselineSql = readFileSync(SCHEMA_PATH, "utf8");
const wantsStdout = process.argv.includes("--stdout");
const wantsCheck = process.argv.includes("--check");

if (wantsStdout) {
  process.stdout.write(generated.sql);
  process.exit(0);
}

if (wantsCheck) {
  const current = existsSync(BOOTSTRAP_PATH)
    ? readFileSync(BOOTSTRAP_PATH, "utf8")
    : "";
  const currentMeta = existsSync(BOOTSTRAP_META_PATH)
    ? readFileSync(BOOTSTRAP_META_PATH, "utf8")
    : "";
  const currentBaseline = existsSync(BASELINE_PATH)
    ? readFileSync(BASELINE_PATH, "utf8")
    : "";
  const nextMeta = `${JSON.stringify(generated.meta, null, 2)}\n`;
  if (
    current !== generated.sql ||
    currentMeta !== nextMeta ||
    currentBaseline !== baselineSql
  ) {
    console.error(
      "v0.33 baseline, bootstrap.sql, or bootstrap-meta.json is out of date. Run `pnpm --dir packages/db generate:bootstrap`.",
    );
    process.exit(1);
  }
  process.exit(0);
}

if (
  BASELINE_STATUS === "frozen" &&
  existsSync(BASELINE_PATH) &&
  readFileSync(BASELINE_PATH, "utf8") !== baselineSql
) {
  throw new Error("frozen v0.33 baseline differs from schema.sql");
}
writeFileSync(BASELINE_PATH, baselineSql);
writeFileSync(BOOTSTRAP_PATH, generated.sql);
writeFileSync(BOOTSTRAP_META_PATH, `${JSON.stringify(generated.meta, null, 2)}\n`);
