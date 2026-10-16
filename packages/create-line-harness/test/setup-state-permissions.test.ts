import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { saveState } from '../src/commands/setup.js';

test('new and existing setup state files are readable only by their owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-setup-'));
  try {
    const path = join(directory, '.line-harness-setup.json');
    saveState(directory, { completedSteps: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, '{}', { mode: 0o644 });
    // chmod is needed because writeFile's mode does not change an existing file.
    chmodSync(path, 0o644);
    saveState(directory, { completedSteps: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
