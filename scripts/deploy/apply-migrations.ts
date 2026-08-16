#!/usr/bin/env tsx

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyD1Migrations, migrationChecksum } from '../../packages/update-engine/src/index.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error('missing ' + name);
  return value;
};

const directory = join(process.cwd(), 'packages/db/migrations');
const names = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
const migrations = new Map(
  names.map((name) => [name, readFileSync(join(directory, name))]),
);

applyD1Migrations({
  creds: {
    accountId: required('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: required('CLOUDFLARE_API_TOKEN'),
  },
  databaseId: required('D1_DATABASE_ID'),
  names,
  migrations,
  requireChecksumLedger: true,
  onMigrationDone(result) {
    console.error(result.name + (result.alreadyApplied ? ': already applied' : ': applied'));
  },
}).then((results) => {
  console.log(JSON.stringify({
    migrations: names.map((name) => ({
      name,
      checksum: migrationChecksum(migrations.get(name) as Buffer),
    })),
    appliedNames: results.filter((result) => !result.alreadyApplied).map((result) => result.name),
  }));
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
