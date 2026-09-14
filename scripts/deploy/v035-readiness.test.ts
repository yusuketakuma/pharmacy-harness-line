import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildV032RouteInventory } from './v032-route-inventory.js';

describe('v0.35 readiness evidence inventory', () => {
  it('maps the current mandatory tasks, human gates and all seven workflows without promoting missing evidence', () => {
    const root = resolve(import.meta.dirname, '../..');
    const plan = readFileSync(resolve(root, 'PLANS.md'), 'utf8');
    const evidence = JSON.parse(readFileSync(resolve(root, 'docs/pharmacy/evidence/v0.35.0-beta-staff-readiness.json'), 'utf8'));
    const unfinished = [...plan.matchAll(/^- \[ \] \*\*((?:V03[1-9]|V040-D0)-[A-Z0-9-]+)/gm)].map((match) => match[1]);
    const required = [...unfinished, ...Array.from({ length: 5 }, (_, i) => `V032-${i + 1}`),
      ...Array.from({ length: 10 }, (_, i) => `V033-G${i + 1}`), ...Array.from({ length: 7 }, (_, i) => `CB-P0-0${i + 1}`)];
    const mapped = new Set(evidence.mandatoryHandoff.map((row: { id: string }) => row.id));
    expect(mapped.size).toBe(evidence.mandatoryHandoff.length);
    for (const id of required) expect(mapped.has(id), id).toBe(true);
    for (const row of evidence.mandatoryHandoff) {
      expect(row.handoffTo.length, row.id).toBeGreaterThan(0);
      expect(row.ownerRole, row.id).toBeTruthy();
      for (const id of row.handoffTo) expect(plan.includes(id), id).toBe(true);
    }
    const sourceGates = plan.split('| gate | 担当 | 実施条件 | 状態 |')[1].split('### V029')[0]
      .split('\n').filter((line) => line.startsWith('| ')).map((line) => line.split('|')[1].trim());
    expect(evidence.humanGates.map((row: { sourceGate: string }) => row.sourceGate)).toEqual(sourceGates);
    const inventory = buildV032RouteInventory();
    const entries = new Map([...inventory.pages, ...inventory.apis].map((row) => [row.id, row]));
    expect(evidence.workflows).toHaveLength(7);
    for (const flow of evidence.workflows) for (const id of flow.inventoryIds) {
      expect(entries.has(id), id).toBe(true);
      for (const path of entries.get(id)!.testReferences) expect(existsSync(resolve(root, path)), path).toBe(true);
    }
    expect(evidence.staffTrial.tasks).toHaveLength(6);
    expect(evidence.staffTrial.auxiliary.gate).toBe(false);
    if (evidence.staffTrial.status !== 'PASS' || !evidence.freeze.exactCandidateSha || !evidence.freeze.exactArtifactDigest ||
      evidence.humanGates.some((row: { candidateStatus: string }) => row.candidateStatus !== 'PASS')) {
      expect(evidence.releaseReadiness).not.toBe('PASS');
    }
  });
});
