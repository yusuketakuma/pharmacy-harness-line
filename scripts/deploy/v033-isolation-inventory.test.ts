import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildV032RouteInventory } from './v032-route-inventory.js';
import { buildV033IsolationInventory, V033_SCHEDULED_JOB_TOKENS } from './v033-isolation-inventory.js';

const repoRoot = process.cwd();

describe('V033 isolation evidence inventory', () => {
  it('extends every route/page with job, storage, and patient evidence rows', () => {
    const rows = buildV033IsolationInventory(repoRoot);
    const routeInventory = buildV032RouteInventory(repoRoot);
    expect(rows.filter(({ kind }) => kind === 'route' || kind === 'page')).toHaveLength(
      routeInventory.pages.length + routeInventory.apis.length,
    );
    expect(rows.filter(({ kind }) => kind === 'job')).toHaveLength(33);
    expect(rows.filter(({ kind }) => kind === 'storage')).toHaveLength(8);
    expect(rows.filter(({ kind }) => kind === 'patient')).toHaveLength(6);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);

    for (const row of rows) {
      expect(row.fixture, `${row.id} fixture`).toMatch(/\S/u);
      expect(row.expectedHttp, `${row.id} HTTP`).toMatch(/\S/u);
      expect(row.expectedDb, `${row.id} DB`).toMatch(/\S/u);
      expect(row.expectedLog, `${row.id} log`).toMatch(/\S/u);
      expect(row.evidenceId).toBe(`V033-G4:${row.id}`);
      expect(existsSync(join(repoRoot, row.source)), `${row.id} source`).toBe(true);
      for (const testReference of row.testReferences) {
        expect(existsSync(join(repoRoot, testReference)), `${row.id} ${testReference}`).toBe(true);
      }
    }
  });

  it('keeps every scheduled job token in the Worker composition root', () => {
    const source = readFileSync(join(repoRoot, 'apps/worker/src/index.ts'), 'utf8');
    for (const token of V033_SCHEDULED_JOB_TOKENS) {
      expect(source, token).toContain(token);
    }
  });

  it('keeps every storage and patient boundary attached to its declared source', () => {
    for (const row of buildV033IsolationInventory(repoRoot)
      .filter(({ kind }) => kind === 'storage' || kind === 'patient')) {
      const source = readFileSync(join(repoRoot, row.source), 'utf8');
      expect(source, `${row.id} ${row.sourceToken}`).toContain(row.sourceToken);
    }
  });
});
