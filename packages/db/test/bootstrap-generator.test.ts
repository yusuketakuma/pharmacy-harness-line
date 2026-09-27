import { execFileSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../scripts/split-sql-statements.mjs';

describe('bootstrap migration statement boundaries', () => {
  it('writes the complete bootstrap to a pipe before exiting', () => {
    const root = resolve('.');
    const output = execFileSync(process.execPath, [join(root, 'scripts/generate-bootstrap.mjs'), '--stdout'], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    });
    expect(output.equals(readFileSync(join(root, 'bootstrap.sql')))).toBe(true);
  });

  it('preserves multiline trigger bodies, CASE, comments and quoted semicolons in the generated database', () => {
    const root = resolve('.');
    const scratch = mkdtempSync(join(root, '.audit-bootstrap-'));
    const db = new Database(':memory:');
    try {
      cpSync(join(root, 'scripts'), join(scratch, 'scripts'), { recursive: true });
      cpSync(join(root, 'schema.sql'), join(scratch, 'schema.sql'));
      mkdirSync(join(scratch, 'migrations'));
      symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
      writeFileSync(
        join(scratch, 'migrations/002_synthetic.sql'),
        `
        CREATE TABLE audit_source (id TEXT);
        CREATE TABLE audit_copy (id TEXT, note TEXT);
        -- Benign duplicate must not skip subsequent statements.
        CREATE TABLE audit_source (id TEXT);
        CREATE TRIGGER audit_copy_on_insert AFTER INSERT ON audit_source
        BEGIN
          INSERT INTO audit_copy VALUES (NEW.id, CASE WHEN NEW.id = 'one'
            THEN 'quoted;\nEND; -- still literal' ELSE 'other' END);
          /* comment ; END; */
          INSERT INTO audit_copy VALUES (NEW.id, 'it''s;\nsecond');
        END;
        CREATE INDEX audit_copy_id ON audit_copy(id);
      `,
      );
      const output = join(scratch, 'output.sql');
      const fd = openSync(output, 'w');
      try {
        execFileSync(process.execPath, [join(scratch, 'scripts/generate-bootstrap.mjs'), '--stdout'], {
          stdio: ['ignore', fd, 'pipe'],
          env: { PATH: process.env.PATH, TMPDIR: scratch },
        });
      } finally {
        closeSync(fd);
      }
      db.exec(readFileSync(output, 'utf8'));
      db.prepare('INSERT INTO audit_source VALUES (?)').run('one');
      expect(db.prepare('SELECT id, note FROM audit_copy ORDER BY rowid').all()).toEqual([
        { id: 'one', note: 'quoted;\nEND; -- still literal' },
        { id: 'one', note: "it's;\nsecond" },
      ]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='audit_copy_id'").get()).toBeTruthy();
    } finally {
      db.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('keeps quoted identifiers and escaped delimiters while discarding comment-only fragments', () => {
    const db = new Database(':memory:');
    try {
      for (const statement of splitSqlStatements(`
        -- ignored ;
        CREATE TABLE "a;\nb" ("x" TEXT); /* ; */
        INSERT INTO "a;\nb" VALUES ('it''s;\ntext'); -- last comment
      `))
        db.exec(statement);
      expect(db.prepare('SELECT x FROM "a;\nb"').get()).toEqual({ x: "it's;\ntext" });
      expect(splitSqlStatements('-- only comment\n/* ; */')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each(["SELECT 'unterminated", 'SELECT 1; /* unterminated'])('rejects incomplete lexical input %s', (sql) => {
    expect(() => splitSqlStatements(sql)).toThrow(/unterminated/);
  });
});
