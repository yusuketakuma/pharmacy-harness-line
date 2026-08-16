#!/usr/bin/env tsx

import { existsSync, readFileSync } from 'node:fs';
import {
  createSnapshot,
  executeD1Query,
  setReleaseEvidence,
  updateStatus,
  type CfApiCreds,
  type D1Like,
  type ReleaseEvidence,
} from '../../packages/update-engine/src/index.js';

interface DeploymentState {
  workerVersionId: string;
  adminDeploymentId: string;
  d1Bookmark?: string;
}

interface EvidenceInput {
  sourceSha: string;
  vendorSha: string;
  updateClass: 'compatible' | 'manual';
  before: DeploymentState & { d1Bookmark: string };
  after: DeploymentState;
  migrations: Array<{ name: string; checksum: string }>;
  appliedNames: string[];
}

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function buildReleaseEvidence(input: EvidenceInput): ReleaseEvidence {
  if (!SHA.test(input.sourceSha)) throw new Error('invalid source SHA');
  if (!SHA.test(input.vendorSha)) throw new Error('invalid vendor SHA');
  if (input.updateClass !== 'compatible' && input.updateClass !== 'manual') {
    throw new Error('invalid update class');
  }
  for (const value of [
    input.before.workerVersionId,
    input.before.adminDeploymentId,
    input.before.d1Bookmark,
    input.after.workerVersionId,
    input.after.adminDeploymentId,
  ]) {
    if (!value) throw new Error('deployment evidence is incomplete');
  }
  if (input.migrations.some((item) => !item.name || !DIGEST.test(item.checksum))) {
    throw new Error('invalid migration evidence');
  }
  const knownNames = new Set(input.migrations.map((item) => item.name));
  if (input.appliedNames.some((name) => !knownNames.has(name))) {
    throw new Error('applied migration is absent from evidence');
  }

  return {
    sourceSha: input.sourceSha,
    vendorSha: input.vendorSha,
    migrations: input.migrations,
    d1Bookmark: input.before.d1Bookmark,
    previousWorkerVersionId: input.before.workerVersionId,
    newWorkerVersionId: input.after.workerVersionId,
    previousAdminDeploymentId: input.before.adminDeploymentId,
    newAdminDeploymentId: input.after.adminDeploymentId,
    smokeResults: { worker: 'passed', admin: 'passed' },
    updateClass: input.updateClass,
    rollbackEligible:
      input.updateClass === 'compatible' && input.appliedNames.length === 0,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('missing ' + name);
  return value;
}

function d1Adapter(creds: CfApiCreds, databaseId: string): D1Like {
  return {
    prepare: (sql) => ({
      bind: (...params) => {
        const query = () => executeD1Query({ creds, databaseId, sql, params });
        return {
          run: query,
          first: async <T>() => {
            const response = await query();
            return (response.result[0]?.results?.[0] as T | undefined) ?? null;
          },
          all: async <T>() => {
            const response = await query();
            return { results: (response.result[0]?.results ?? []) as T[] };
          },
        };
      },
    }),
  };
}

async function main(): Promise<void> {
  const sourceSha = required('SOURCE_SHA');
  const vendorFile = '.line-harness-vendor.json';
  const vendor = existsSync(vendorFile)
    ? JSON.parse(readFileSync(vendorFile, 'utf8')) as {
        commit: string;
        version: string;
        release: { customer_source_update?: { update_class?: string } };
      }
    : null;
  const before = JSON.parse(required('BEFORE_STATE')) as EvidenceInput['before'];
  const after = JSON.parse(required('AFTER_STATE')) as EvidenceInput['after'];
  const migration = JSON.parse(required('MIGRATION_RESULT')) as {
    migrations: EvidenceInput['migrations'];
    appliedNames: string[];
  };
  const evidence = buildReleaseEvidence({
    sourceSha,
    vendorSha: vendor?.commit ?? sourceSha,
    updateClass:
      vendor?.release.customer_source_update?.update_class === 'compatible'
        ? 'compatible'
        : 'manual',
    before,
    after,
    migrations: migration.migrations,
    appliedNames: migration.appliedNames,
  });
  const creds = {
    accountId: required('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: required('CLOUDFLARE_API_TOKEN'),
  };
  const d1 = d1Adapter(creds, required('D1_DATABASE_ID'));
  const id = await createSnapshot(d1, {
    from: before.workerVersionId,
    to: vendor?.version ?? sourceSha,
    snapshotAdminDeployment: before.adminDeploymentId,
  });
  await setReleaseEvidence(d1, id, evidence);
  await updateStatus(d1, id, 'success');
  console.log(id);
}

if (process.argv[1]?.includes('record-release-evidence')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
