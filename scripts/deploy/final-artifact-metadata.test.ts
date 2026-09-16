import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectVersion } from '../../apps/worker/scripts/inject-version.js';
import { finalArtifactMetadata } from './final-artifact-metadata.js';

describe('finalArtifactMetadata', () => {
  it('uses the built Wrangler config to hash final deploy bytes while retaining other metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'final-worker-hash-'));
    try {
      const workerDir = join(root, 'dist', 'line_harness');
      const assetsDir = join(root, 'dist', 'client');
      mkdirSync(workerDir, { recursive: true });
      mkdirSync(assetsDir);
      const configPath = join(workerDir, 'wrangler.json');
      const workerPath = join(workerDir, 'index.js');
      writeFileSync(configPath, JSON.stringify({ main: 'index.js', no_bundle: true, assets: { directory: '../client' } }));
      writeFileSync(workerPath, 'first build');
      writeFileSync(join(assetsDir, 'index.html'), 'first assets');
      const before = {
        version: '0.35.1',
        workerHash: injectVersion.hashFile(workerPath),
        workerAssetsHash: injectVersion.hashDirectory(assetsDir),
        adminHash: 'admin-unchanged',
      };
      writeFileSync(workerPath, 'final build');
      writeFileSync(join(assetsDir, 'index.html'), 'final assets');

      expect(finalArtifactMetadata(before, configPath)).toEqual({
        ...before,
        workerHash: injectVersion.hashFile(workerPath),
        workerAssetsHash: injectVersion.hashDirectory(assetsDir),
      });
      expect(before.workerHash).not.toBe(injectVersion.hashFile(workerPath));
      writeFileSync(configPath, JSON.stringify({ main: 'index.js', assets: { directory: '../client' } }));
      expect(() => finalArtifactMetadata(before, configPath)).toThrow(/bundled by Wrangler/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
