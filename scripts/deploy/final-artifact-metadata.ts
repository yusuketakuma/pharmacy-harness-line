#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectVersion } from '../../apps/worker/scripts/inject-version.js';

export function finalArtifactMetadata(
  metadata: Record<string, unknown>,
  configPath: string,
): Record<string, unknown> {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    main?: unknown;
    no_bundle?: unknown;
    assets?: { directory?: unknown };
  };
  if (config.no_bundle !== true || typeof config.main !== 'string' ||
      typeof config.assets?.directory !== 'string') {
    throw new Error('final Worker artifact paths are missing or bundled by Wrangler');
  }
  const base = dirname(resolve(configPath));
  return {
    ...metadata,
    workerHash: injectVersion.hashArtifact('worker', resolve(base, config.main)),
    workerAssetsHash: injectVersion.hashArtifact('worker-assets', resolve(base, config.assets.directory)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const raw = process.env.ARTIFACT_METADATA;
  if (!raw) throw new Error('ARTIFACT_METADATA is required');
  const metadata = JSON.parse(raw) as Record<string, unknown>;
  process.stdout.write(JSON.stringify(finalArtifactMetadata(
    metadata,
    'apps/worker/dist/line_harness/wrangler.json',
  )) + '\n');
}
