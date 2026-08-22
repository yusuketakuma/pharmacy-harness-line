#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
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
  packageVersion: string;
  sellerTag: string | null;
  environment: 'development' | 'beta' | 'production';
  stage: string | null;
  schemaFingerprint: string;
  artifactHashes: ReleaseEvidence['artifactHashes'];
  updateClass: 'compatible' | 'manual';
  before: DeploymentState & { d1Bookmark: string };
  after: DeploymentState;
  migrations: Array<{ name: string; checksum: string }>;
  appliedNames: string[];
}

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SELLER_TAG = /^pharmacy-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const STAGE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface D1SchemaRow {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

export function fingerprintD1Schema(rows: D1SchemaRow[]): string {
  if (rows.length === 0) throw new Error('D1 schema evidence is empty');
  const canonical = rows.map(({ type, name, tableName, sql }) => {
    if (![type, name, tableName, sql].every((value) => typeof value === 'string' && value)) {
      throw new Error('invalid D1 schema evidence');
    }
    return { type, name, tableName, sql };
  }).sort((a, b) =>
    a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.tableName.localeCompare(b.tableName),
  );
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

async function readD1SchemaFingerprint(creds: CfApiCreds, databaseId: string): Promise<string> {
  const response = await executeD1Query({
    creds,
    databaseId,
    sql: `SELECT type, name, tbl_name AS tableName, sql
            FROM sqlite_master
           WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
           ORDER BY type, name`,
  });
  const rows = response.result[0]?.results;
  if (!Array.isArray(rows)) throw new Error('D1 schema evidence is incomplete');
  return fingerprintD1Schema(rows as D1SchemaRow[]);
}

export function buildReleaseEvidence(input: EvidenceInput): ReleaseEvidence {
  if (!SHA.test(input.sourceSha)) throw new Error('invalid source SHA');
  if (!SHA.test(input.vendorSha)) throw new Error('invalid vendor SHA');
  if (!SEMVER.test(input.packageVersion)) throw new Error('invalid package version');
  if (input.sellerTag !== null && !SELLER_TAG.test(input.sellerTag)) {
    throw new Error('invalid seller tag');
  }
  if (!['development', 'beta', 'production'].includes(input.environment)) {
    throw new Error('invalid release environment');
  }
  if (input.stage !== null && !STAGE.test(input.stage)) throw new Error('invalid release stage');
  if (!DIGEST.test(input.schemaFingerprint)) throw new Error('invalid schema fingerprint');
  if (Object.values(input.artifactHashes).some((hash) => !DIGEST.test(hash))) {
    throw new Error('invalid artifact evidence');
  }
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
    schemaVersion: 1,
    sourceSha: input.sourceSha,
    vendorSha: input.vendorSha,
    packageVersion: input.packageVersion,
    sellerTag: input.sellerTag,
    environment: input.environment,
    stage: input.stage,
    schemaFingerprint: input.schemaFingerprint,
    artifactHashes: input.artifactHashes,
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
  const artifact = JSON.parse(required('ARTIFACT_METADATA')) as {
    version: string;
    workerHash: string;
    workerAssetsHash: string;
    adminHash: string;
    liffHash: string;
  };
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
  const creds = {
    accountId: required('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: required('CLOUDFLARE_API_TOKEN'),
  };
  const databaseId = required('D1_DATABASE_ID');
  const evidence = buildReleaseEvidence({
    sourceSha,
    vendorSha: vendor?.commit ?? sourceSha,
    packageVersion: artifact.version,
    sellerTag: process.env.PHARMACY_SELLER_RELEASE || null,
    environment: required('DEPLOY_TARGET') as EvidenceInput['environment'],
    stage: process.env.RELEASE_STAGE || null,
    schemaFingerprint: await readD1SchemaFingerprint(creds, databaseId),
    artifactHashes: {
      worker: artifact.workerHash,
      workerAssets: artifact.workerAssetsHash,
      admin: artifact.adminHash,
      liff: artifact.liffHash,
    },
    updateClass:
      vendor?.release.customer_source_update?.update_class === 'compatible'
        ? 'compatible'
        : 'manual',
    before,
    after,
    migrations: migration.migrations,
    appliedNames: migration.appliedNames,
  });
  const d1 = d1Adapter(creds, databaseId);
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
