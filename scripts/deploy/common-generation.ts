#!/usr/bin/env tsx

import {
  createHash,
  createPublicKey,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  openPatientIntakeField,
  type PatientIntakeEncryptedField,
} from '../../apps/worker/src/custom/pharmacy/intake/encryption.js';

const SCHEMA_VERSION = 1 as const;
const MANIFEST_VERSION = 1 as const;
const ALGORITHM = 'ed25519' as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const COMMON_GENERATION_FLE_FIELDS = [
  'pharmacy_patient_intake_responses.patient_snapshot_json',
  'pharmacy_patient_intake_responses.answers_json',
] as const;

export type Sha256 = `sha256:${string}`;

export interface ScopeIdentity {
  accountId: string;
  tenantId: string;
  lineAccountId: string;
}

export interface SourceBinding {
  environmentId: string;
  bindingFingerprint: string;
  production: boolean;
}

export interface GenerationFence {
  id: string;
  epoch: number;
  cutId: string;
  startedAt: string;
  completedAt: string;
  activeJobDigest: Sha256;
}

export interface D1ExportInventory {
  byteLength: number;
  sha256: Sha256;
  embeddedGeneration: string;
  embeddedFenceId: string;
  embeddedFenceEpoch: number;
  embeddedCutId: string;
}

export interface D1SchemaInventory {
  version: number;
  fingerprint: Sha256;
}

export interface OrderedMigration {
  order: number;
  name: string;
  checksum: Sha256;
}

export interface D1LogicalInventory {
  rootSha256: Sha256;
  tableCounts: Record<string, number>;
}

export interface D1GenerationArtifact {
  export: D1ExportInventory;
  schema: D1SchemaInventory;
  orderedMigrations: OrderedMigration[];
  logicalInventory: D1LogicalInventory;
}

export interface R2ObjectInventory {
  key: string;
  contentSha256: Sha256;
  byteLength: number;
  embeddedGeneration: string;
  embeddedFenceId: string;
  embeddedFenceEpoch: number;
  embeddedCutId: string;
}

export interface R2Inventory {
  sha256: Sha256;
  byteLength: number;
  objectCount: number;
  totalBytes: number;
  embeddedGeneration: string;
  embeddedFenceId: string;
  embeddedFenceEpoch: number;
  embeddedCutId: string;
  objects: R2ObjectInventory[];
}

export interface R2GenerationArtifact {
  namespace: string;
  prefix: string;
  inventory: R2Inventory;
}

export interface FLEFieldInventory {
  field: string;
  encrypted: true;
  envelopeVersion: number;
  keyVersion: number;
  referenceCount: number;
}

export interface FLEInventory {
  fieldInventory: FLEFieldInventory[];
  envelopeVersions: number[];
  keyVersions: number[];
  pinnedKeyFingerprint: Sha256;
  referenceCounts: Record<string, number>;
}

export interface Watermark {
  maxCommitted: number | string | null;
  maxProcessed: number | string | null;
  pendingCount: number;
  pendingSetDigest: Sha256;
}

export interface GenerationWatermarks {
  outbox: Watermark;
  webhook: Watermark;
}

export interface RestorePolicy {
  mode: 'isolated-only';
  production_side_effects_allowed: false;
}

export interface CommonGenerationManifest {
  manifestId: string;
  manifestVersion: 1;
  generation: string;
  scope: ScopeIdentity;
  source: SourceBinding;
  fence: GenerationFence;
  d1: D1GenerationArtifact;
  r2: R2GenerationArtifact;
  fle: FLEInventory;
  watermarks: GenerationWatermarks;
  restorePolicy: RestorePolicy;
}

export interface SignedCommonGenerationManifest {
  schemaVersion: 1;
  algorithm: 'ed25519';
  signingKeyId: string;
  payloadSha256: Sha256;
  signature: string;
  payload: CommonGenerationManifest;
}

export interface VerificationResult {
  valid: boolean;
  payload?: CommonGenerationManifest;
  reason?: string;
}

export interface CommonGenerationSigner {
  readonly signingKeyId: string;
  readonly publicKey: string;
  sign(payload: CommonGenerationManifest): SignedCommonGenerationManifest;
  verify(
    input: SignedCommonGenerationManifest | string,
    pinnedTrustStore: Record<string, string>,
  ): VerificationResult;
}

export interface D1CaptureArtifact {
  bytes: Uint8Array;
  embeddedGeneration: string;
  embeddedFenceId: string;
  embeddedFenceEpoch: number;
  embeddedCutId: string;
  schema: D1SchemaInventory;
  orderedMigrations: OrderedMigration[];
  logicalInventory: D1LogicalInventory;
}

export interface R2CaptureObject {
  key: string;
  bytes: Uint8Array;
  embeddedGeneration: string;
  embeddedFenceId: string;
  embeddedFenceEpoch: number;
  embeddedCutId: string;
}

export interface R2CaptureArtifact {
  namespace: string;
  prefix: string;
  embeddedGeneration: string;
  embeddedFenceId: string;
  embeddedFenceEpoch: number;
  embeddedCutId: string;
  objects: R2CaptureObject[];
}

export interface CommonGenerationReaders {
  readFence(): Promise<GenerationFence> | GenerationFence;
  readD1(): Promise<D1CaptureArtifact> | D1CaptureArtifact;
  readR2(): Promise<R2CaptureArtifact> | R2CaptureArtifact;
  readFle(): Promise<FLEInventory> | FLEInventory;
  readWatermarks(): Promise<GenerationWatermarks> | GenerationWatermarks;
}

export interface CaptureInput {
  manifestId: string;
  generation: string;
  scope: ScopeIdentity;
  source: SourceBinding;
  fence: GenerationFence;
  readers: CommonGenerationReaders;
}

export interface CapturedArtifactsForValidation {
  d1: D1CaptureArtifact;
  r2: R2CaptureArtifact;
  fle: FLEInventory;
  watermarks: GenerationWatermarks;
}

export interface RetainedGeneration {
  generation: string;
  completedAt: string;
  location: {
    provider: string;
    accountId: string;
    container: string;
    failureDomain: string;
  };
}

export interface NoSendIsolatedRestoreTarget {
  readonly environmentId: string;
  readonly bindingFingerprint: string;
  readonly production: false;
}

export interface IsolatedRestoreInput {
  signedManifest: SignedCommonGenerationManifest | string;
  pinnedTrustStore: Record<string, string>;
  target: NoSendIsolatedRestoreTarget;
  artifacts: CapturedArtifactsForValidation;
  fleRootSecret: string;
  retainedGenerations: RetainedGeneration[];
}

export interface IsolatedRehearsalReport {
  schemaVersion: 1;
  manifestHash: Sha256;
  targetBindingFingerprint: string;
  startedAt: string;
  endedAt: string;
  readbackResult: 'passed';
  referentialIntegrity: true;
  r2Ownership: true;
  fleReadback: true;
  prescriptionsReadback: true;
  intakeReadback: true;
  followUpReadback: true;
  watermarksReconciled: true;
  outboundAttemptCount: 0;
  productionBindingCount: 0;
  quarantinedOutboxCount: number;
  quarantinedWebhookCount: number;
  rpoHours: number;
  rtoHours: number;
  retainedGenerationCount: number;
  independentBackupLocationCount: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path} has unknown field ${key}`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`);
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(`${path} must be boolean`);
}

function assertInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${path} must be a non-negative integer`);
  }
}

function assertDigest(value: unknown, path: string): asserts value is Sha256 {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${path} must be sha256`);
}

function assertTimestamp(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (!Number.isFinite(Date.parse(value))) fail(`${path} must be an ISO timestamp`);
}

function assertMarker(value: Record<string, unknown>, path: string, expected: {
  generation: string;
  fenceId: string;
  fenceEpoch: number;
  cutId: string;
}): void {
  assertString(value.embeddedGeneration, `${path}.embeddedGeneration`);
  assertString(value.embeddedFenceId, `${path}.embeddedFenceId`);
  assertInteger(value.embeddedFenceEpoch, `${path}.embeddedFenceEpoch`);
  assertString(value.embeddedCutId, `${path}.embeddedCutId`);
  if (value.embeddedGeneration !== expected.generation ||
      value.embeddedFenceId !== expected.fenceId ||
      value.embeddedFenceEpoch !== expected.fenceEpoch ||
      value.embeddedCutId !== expected.cutId) {
    fail(`${path} has mixed generation or fence`);
  }
}

function validateWatermark(value: unknown, path: string): void {
  assertRecord(value, path);
  assertExactKeys(value, ['maxCommitted', 'maxProcessed', 'pendingCount', 'pendingSetDigest'], path);
  for (const key of ['maxCommitted', 'maxProcessed']) {
    const item = value[key];
    if (item !== null && typeof item !== 'string' &&
        (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) {
      fail(`${path}.${key} must be null, a non-negative integer, or a string`);
    }
  }
  assertInteger(value.pendingCount, `${path}.pendingCount`);
  assertDigest(value.pendingSetDigest, `${path}.pendingSetDigest`);
}

function validatePayload(value: unknown): asserts value is CommonGenerationManifest {
  assertRecord(value, 'payload');
  assertExactKeys(value, [
    'manifestId', 'manifestVersion', 'generation', 'scope', 'source', 'fence',
    'd1', 'r2', 'fle', 'watermarks', 'restorePolicy',
  ], 'payload');
  assertString(value.manifestId, 'payload.manifestId');
  if (value.manifestVersion !== MANIFEST_VERSION) fail('unsupported manifest version');
  assertString(value.generation, 'payload.generation');

  assertRecord(value.scope, 'payload.scope');
  assertExactKeys(value.scope, ['accountId', 'tenantId', 'lineAccountId'], 'payload.scope');
  assertString(value.scope.accountId, 'payload.scope.accountId');
  assertString(value.scope.tenantId, 'payload.scope.tenantId');
  assertString(value.scope.lineAccountId, 'payload.scope.lineAccountId');

  assertRecord(value.source, 'payload.source');
  assertExactKeys(value.source, ['environmentId', 'bindingFingerprint', 'production'], 'payload.source');
  assertString(value.source.environmentId, 'payload.source.environmentId');
  assertString(value.source.bindingFingerprint, 'payload.source.bindingFingerprint');
  assertBoolean(value.source.production, 'payload.source.production');

  assertRecord(value.fence, 'payload.fence');
  assertExactKeys(value.fence, ['id', 'epoch', 'cutId', 'startedAt', 'completedAt', 'activeJobDigest'], 'payload.fence');
  assertString(value.fence.id, 'payload.fence.id');
  assertInteger(value.fence.epoch, 'payload.fence.epoch');
  assertString(value.fence.cutId, 'payload.fence.cutId');
  assertTimestamp(value.fence.startedAt, 'payload.fence.startedAt');
  assertTimestamp(value.fence.completedAt, 'payload.fence.completedAt');
  assertDigest(value.fence.activeJobDigest, 'payload.fence.activeJobDigest');
  if (Date.parse(value.fence.completedAt) < Date.parse(value.fence.startedAt)) {
    fail('payload.fence completedAt precedes startedAt');
  }

  assertRecord(value.d1, 'payload.d1');
  assertExactKeys(value.d1, ['export', 'schema', 'orderedMigrations', 'logicalInventory'], 'payload.d1');
  assertRecord(value.d1.export, 'payload.d1.export');
  assertExactKeys(value.d1.export, [
    'byteLength', 'sha256', 'embeddedGeneration', 'embeddedFenceId', 'embeddedFenceEpoch',
    'embeddedCutId',
  ], 'payload.d1.export');
  assertInteger(value.d1.export.byteLength, 'payload.d1.export.byteLength');
  assertDigest(value.d1.export.sha256, 'payload.d1.export.sha256');
  assertMarker(value.d1.export, 'payload.d1.export', {
    generation: value.generation,
    fenceId: value.fence.id,
    fenceEpoch: value.fence.epoch,
    cutId: value.fence.cutId,
  });
  assertRecord(value.d1.schema, 'payload.d1.schema');
  assertExactKeys(value.d1.schema, ['version', 'fingerprint'], 'payload.d1.schema');
  assertInteger(value.d1.schema.version, 'payload.d1.schema.version');
  assertDigest(value.d1.schema.fingerprint, 'payload.d1.schema.fingerprint');
  if (!Array.isArray(value.d1.orderedMigrations)) fail('payload.d1.orderedMigrations must be an array');
  let previousOrder = -1;
  const migrationNames = new Set<string>();
  for (const [index, migration] of value.d1.orderedMigrations.entries()) {
    assertRecord(migration, `payload.d1.orderedMigrations[${index}]`);
    assertExactKeys(migration, ['order', 'name', 'checksum'], `payload.d1.orderedMigrations[${index}]`);
    assertInteger(migration.order, `payload.d1.orderedMigrations[${index}].order`);
    assertString(migration.name, `payload.d1.orderedMigrations[${index}].name`);
    assertDigest(migration.checksum, `payload.d1.orderedMigrations[${index}].checksum`);
    if (migration.order <= previousOrder || migrationNames.has(migration.name)) fail('D1 migrations are not ordered and unique');
    previousOrder = migration.order;
    migrationNames.add(migration.name);
  }
  assertRecord(value.d1.logicalInventory, 'payload.d1.logicalInventory');
  assertExactKeys(value.d1.logicalInventory, ['rootSha256', 'tableCounts'], 'payload.d1.logicalInventory');
  assertDigest(value.d1.logicalInventory.rootSha256, 'payload.d1.logicalInventory.rootSha256');
  assertRecord(value.d1.logicalInventory.tableCounts, 'payload.d1.logicalInventory.tableCounts');
  for (const [table, count] of Object.entries(value.d1.logicalInventory.tableCounts)) {
    assertString(table, 'payload.d1.logicalInventory.tableCounts key');
    assertInteger(count, `payload.d1.logicalInventory.tableCounts.${table}`);
  }
  const tableCounts = value.d1.logicalInventory.tableCounts as Record<string, number>;
  if (value.d1.logicalInventory.rootSha256 !== logicalInventoryRoot(tableCounts)) {
    fail('D1 logical inventory root mismatch');
  }

  assertRecord(value.r2, 'payload.r2');
  assertExactKeys(value.r2, ['namespace', 'prefix', 'inventory'], 'payload.r2');
  assertString(value.r2.namespace, 'payload.r2.namespace');
  assertString(value.r2.prefix, 'payload.r2.prefix');
  assertRecord(value.r2.inventory, 'payload.r2.inventory');
  assertExactKeys(value.r2.inventory, [
    'sha256', 'byteLength', 'objectCount', 'totalBytes', 'embeddedGeneration',
    'embeddedFenceId', 'embeddedFenceEpoch', 'embeddedCutId', 'objects',
  ], 'payload.r2.inventory');
  assertDigest(value.r2.inventory.sha256, 'payload.r2.inventory.sha256');
  assertInteger(value.r2.inventory.byteLength, 'payload.r2.inventory.byteLength');
  assertInteger(value.r2.inventory.objectCount, 'payload.r2.inventory.objectCount');
  assertInteger(value.r2.inventory.totalBytes, 'payload.r2.inventory.totalBytes');
  assertMarker(value.r2.inventory, 'payload.r2.inventory', {
    generation: value.generation,
    fenceId: value.fence.id,
    fenceEpoch: value.fence.epoch,
    cutId: value.fence.cutId,
  });
  if (!Array.isArray(value.r2.inventory.objects)) fail('payload.r2.inventory.objects must be an array');
  const objectKeys = new Set<string>();
  for (const [index, object] of value.r2.inventory.objects.entries()) {
    assertRecord(object, `payload.r2.inventory.objects[${index}]`);
    assertExactKeys(object, [
      'key', 'contentSha256', 'byteLength', 'embeddedGeneration', 'embeddedFenceId', 'embeddedFenceEpoch',
      'embeddedCutId',
    ], `payload.r2.inventory.objects[${index}]`);
    assertString(object.key, `payload.r2.inventory.objects[${index}].key`);
    assertDigest(object.contentSha256, `payload.r2.inventory.objects[${index}].contentSha256`);
    assertInteger(object.byteLength, `payload.r2.inventory.objects[${index}].byteLength`);
    assertMarker(object, `payload.r2.inventory.objects[${index}]`, {
      generation: value.generation,
      fenceId: value.fence.id,
      fenceEpoch: value.fence.epoch,
      cutId: value.fence.cutId,
    });
    if (objectKeys.has(object.key)) fail('R2 inventory contains a duplicate object key');
    objectKeys.add(object.key);
    if (!object.key.startsWith(value.r2.prefix)) fail('R2 object is outside the declared namespace prefix');
  }
  if (value.r2.inventory.objectCount !== value.r2.inventory.objects.length) fail('R2 object count mismatch');
  if (value.r2.inventory.totalBytes !== value.r2.inventory.objects.reduce((sum, object) => sum + object.byteLength, 0)) {
    fail('R2 total bytes mismatch');
  }
  const canonicalR2Inventory = canonicalizeCommonGeneration(
    [...value.r2.inventory.objects]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ key, contentSha256, byteLength }) => ({ key, contentSha256, byteLength })),
  );
  if (value.r2.inventory.sha256 !== hash(canonicalR2Inventory) ||
      value.r2.inventory.byteLength !== Buffer.byteLength(canonicalR2Inventory)) {
    fail('R2 inventory SHA256 or byte length mismatch');
  }

  assertRecord(value.fle, 'payload.fle');
  assertExactKeys(value.fle, ['fieldInventory', 'envelopeVersions', 'keyVersions', 'pinnedKeyFingerprint', 'referenceCounts'], 'payload.fle');
  if (!Array.isArray(value.fle.fieldInventory)) fail('payload.fle.fieldInventory must be an array');
  const fields = new Set<string>();
  for (const [index, field] of value.fle.fieldInventory.entries()) {
    assertRecord(field, `payload.fle.fieldInventory[${index}]`);
    assertExactKeys(field, ['field', 'encrypted', 'envelopeVersion', 'keyVersion', 'referenceCount'], `payload.fle.fieldInventory[${index}]`);
    assertString(field.field, `payload.fle.fieldInventory[${index}].field`);
    if (field.encrypted !== true) fail('FLE field inventory contains plaintext fallback');
    assertInteger(field.envelopeVersion, `payload.fle.fieldInventory[${index}].envelopeVersion`);
    assertInteger(field.keyVersion, `payload.fle.fieldInventory[${index}].keyVersion`);
    assertInteger(field.referenceCount, `payload.fle.fieldInventory[${index}].referenceCount`);
    if (fields.has(field.field)) fail('FLE field inventory is not unique');
    fields.add(field.field);
  }
  const envelopeVersions = value.fle.envelopeVersions;
  const keyVersions = value.fle.keyVersions;
  if (!Array.isArray(envelopeVersions) || envelopeVersions.length === 0 || envelopeVersions.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    fail('payload.fle.envelopeVersions must contain versions');
  }
  if (!Array.isArray(keyVersions) || keyVersions.length === 0 || keyVersions.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    fail('payload.fle.keyVersions must contain versions');
  }
  assertDigest(value.fle.pinnedKeyFingerprint, 'payload.fle.pinnedKeyFingerprint');
  assertRecord(value.fle.referenceCounts, 'payload.fle.referenceCounts');
  for (const [field, count] of Object.entries(value.fle.referenceCounts)) assertInteger(count, `payload.fle.referenceCounts.${field}`);
  for (const field of value.fle.fieldInventory) {
    if (!(envelopeVersions as number[]).includes(field.envelopeVersion) || !(keyVersions as number[]).includes(field.keyVersion)) {
      fail('FLE field references an unpinned envelope or key version');
    }
    if (value.fle.referenceCounts[field.field] !== field.referenceCount) {
      fail('FLE field reference count mismatch');
    }
  }
  for (const field of Object.keys(value.fle.referenceCounts)) {
    if (!fields.has(field)) fail('FLE reference count has no field inventory entry');
  }
  if (fields.size !== COMMON_GENERATION_FLE_FIELDS.length ||
      COMMON_GENERATION_FLE_FIELDS.some((field) => !fields.has(field))) {
    fail('FLE field inventory does not cover the canonical encrypted fields');
  }

  assertRecord(value.watermarks, 'payload.watermarks');
  assertExactKeys(value.watermarks, ['outbox', 'webhook'], 'payload.watermarks');
  validateWatermark(value.watermarks.outbox, 'payload.watermarks.outbox');
  validateWatermark(value.watermarks.webhook, 'payload.watermarks.webhook');

  assertRecord(value.restorePolicy, 'payload.restorePolicy');
  assertExactKeys(value.restorePolicy, ['mode', 'production_side_effects_allowed'], 'payload.restorePolicy');
  if (value.restorePolicy.mode !== 'isolated-only' || value.restorePolicy.production_side_effects_allowed !== false) {
    fail('restore policy permits production side effects');
  }
}

function validateSignedEnvelope(value: unknown): asserts value is SignedCommonGenerationManifest {
  assertRecord(value, 'signed manifest');
  assertExactKeys(value, ['schemaVersion', 'algorithm', 'signingKeyId', 'payloadSha256', 'signature', 'payload'], 'signed manifest');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('unsupported signed manifest version');
  if (value.algorithm !== ALGORITHM) fail('unsupported signing algorithm');
  assertString(value.signingKeyId, 'signed manifest.signingKeyId');
  assertDigest(value.payloadSha256, 'signed manifest.payloadSha256');
  assertString(value.signature, 'signed manifest.signature');
  if (!BASE64URL.test(value.signature)) fail('signed manifest.signature is not base64url');
  validatePayload(value.payload);
}

function parseRawCanonicalJson(raw: string): unknown {
  let position = 0;

  const whitespace = () => {
    while (position < raw.length && /\s/.test(raw[position])) position += 1;
  };
  const parseString = (): string => {
    const start = position;
    if (raw[position] !== '"') fail('invalid JSON string');
    position += 1;
    let escaped = false;
    while (position < raw.length) {
      const char = raw[position++];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        const token = raw.slice(start, position);
        try {
          return JSON.parse(token) as string;
        } catch {
          fail('invalid JSON string');
        }
      }
    }
    fail('unterminated JSON string');
  };
  const parseValue = (): unknown => {
    whitespace();
    const char = raw[position];
    if (char === '"') return parseString();
    if (char === '{') {
      position += 1;
      const object: Record<string, unknown> = {};
      const keys = new Set<string>();
      whitespace();
      if (raw[position] === '}') {
        position += 1;
        return object;
      }
      while (position < raw.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) fail('duplicate JSON object key');
        keys.add(key);
        whitespace();
        if (raw[position++] !== ':') fail('invalid JSON object separator');
        object[key] = parseValue();
        whitespace();
        const separator = raw[position++];
        if (separator === '}') return object;
        if (separator !== ',') fail('invalid JSON object delimiter');
      }
      fail('unterminated JSON object');
    }
    if (char === '[') {
      position += 1;
      const array: unknown[] = [];
      whitespace();
      if (raw[position] === ']') {
        position += 1;
        return array;
      }
      while (position < raw.length) {
        array.push(parseValue());
        whitespace();
        const separator = raw[position++];
        if (separator === ']') return array;
        if (separator !== ',') fail('invalid JSON array delimiter');
      }
      fail('unterminated JSON array');
    }
    const start = position;
    while (position < raw.length && !/[\s,\]}]/.test(raw[position])) position += 1;
    const token = raw.slice(start, position);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token)) fail('invalid JSON value');
    const number = Number(token);
    if (!Number.isFinite(number)) fail('invalid JSON number');
    return number;
  };

  const parsed = parseValue();
  whitespace();
  if (position !== raw.length) fail('trailing JSON input');
  if (canonicalizeCommonGeneration(parsed) !== raw) fail('non-canonical JSON input');
  return parsed;
}

export function canonicalizeCommonGeneration(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeCommonGeneration(item)).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalizeCommonGeneration(value[key])}`,
    );
    return `{${entries.join(',')}}`;
  }
  fail('canonical JSON contains an unsupported value');
}

function hash(value: string | Uint8Array): Sha256 {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256;
}

export function sha256CommonGeneration(value: string | Uint8Array): Sha256 {
  return hash(value);
}

function logicalInventoryRoot(tableCounts: Record<string, number>): Sha256 {
  return hash(canonicalizeCommonGeneration(tableCounts));
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decode(value: string, path: string): Buffer {
  if (!BASE64URL.test(value)) fail(`${path} is not base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0) fail(`${path} is empty`);
  if (encode(decoded) !== value) fail(`${path} is not canonical base64url`);
  return decoded;
}

function publicKeyBytes(key: KeyObject): string {
  return encode(key.export({ format: 'der', type: 'spki' }));
}

export function readArtifactFile(filePath: string): Uint8Array {
  return new Uint8Array(readFileSync(filePath));
}

export function validateCommonGenerationManifest(value: unknown): asserts value is CommonGenerationManifest {
  validatePayload(value);
}

export function signCommonGenerationManifest(
  payload: CommonGenerationManifest,
  privateKey: KeyObject,
  signingKeyId: string,
): SignedCommonGenerationManifest {
  validatePayload(payload);
  assertString(signingKeyId, 'signingKeyId');
  const payloadSha256 = hash(canonicalizeCommonGeneration(payload));
  const signature = encode(signBytes(null, Buffer.from(payloadSha256, 'utf8'), privateKey));
  return {
    schemaVersion: SCHEMA_VERSION,
    algorithm: ALGORITHM,
    signingKeyId,
    payloadSha256,
    signature,
    payload,
  };
}

export function verifyCommonGenerationManifest(
  input: SignedCommonGenerationManifest | string,
  pinnedTrustStore: Record<string, string>,
): VerificationResult {
  try {
    const value = typeof input === 'string' ? parseRawCanonicalJson(input) : input;
    validateSignedEnvelope(value);
    const payloadSha256 = hash(canonicalizeCommonGeneration(value.payload));
    if (payloadSha256 !== value.payloadSha256) fail('signed payload hash mismatch');
    const pinned = pinnedTrustStore[value.signingKeyId];
    if (typeof pinned !== 'string') fail('signing key is not pinned by caller');
    const publicKey = createPublicKey({ key: decode(pinned, 'pinned trust key'), format: 'der', type: 'spki' });
    const verified = verifyBytes(
      null,
      Buffer.from(value.payloadSha256, 'utf8'),
      publicKey,
      decode(value.signature, 'signed manifest.signature'),
    );
    if (!verified) fail('signature verification failed');
    return { valid: true, payload: value.payload };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'manifest verification failed' };
  }
}

export function createCommonGenerationSigner(options: {
  signingKeyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}): CommonGenerationSigner {
  assertString(options.signingKeyId, 'signingKeyId');
  if (options.privateKey.type !== 'private' || options.privateKey.asymmetricKeyType !== 'ed25519' ||
      options.publicKey.type !== 'public' || options.publicKey.asymmetricKeyType !== 'ed25519') {
    fail('common generation signing keys must be an Ed25519 private/public pair');
  }
  const derivedPublicKey = publicKeyBytes(createPublicKey(options.privateKey));
  const publicKey = publicKeyBytes(options.publicKey);
  if (derivedPublicKey !== publicKey) fail('common generation signing key pair does not match');
  return {
    signingKeyId: options.signingKeyId,
    publicKey,
    sign: (payload) => signCommonGenerationManifest(payload, options.privateKey, options.signingKeyId),
    verify: (input, pinnedTrustStore) => verifyCommonGenerationManifest(input, pinnedTrustStore),
  };
}

function assertFenceSnapshot(actual: GenerationFence, expected: GenerationFence, path: string): void {
  if (canonicalizeCommonGeneration(actual) !== canonicalizeCommonGeneration(expected)) {
    fail(`${path} fence or active job changed`);
  }
}

function assertCaptureMarker(
  actual: { embeddedGeneration: string; embeddedFenceId: string; embeddedFenceEpoch: number; embeddedCutId: string },
  expected: { generation: string; fence: GenerationFence },
  path: string,
): void {
  if (actual.embeddedGeneration !== expected.generation ||
      actual.embeddedFenceId !== expected.fence.id ||
      actual.embeddedFenceEpoch !== expected.fence.epoch ||
      actual.embeddedCutId !== expected.fence.cutId) {
    fail(`${path} is not from the requested common generation fence`);
  }
}

export async function captureCommonGeneration(input: CaptureInput): Promise<CommonGenerationManifest> {
  assertString(input.manifestId, 'manifestId');
  assertString(input.generation, 'generation');
  validatePayload({
    manifestId: input.manifestId,
    manifestVersion: MANIFEST_VERSION,
    generation: input.generation,
    scope: input.scope,
    source: input.source,
    fence: input.fence,
    d1: {
      export: {
        byteLength: 0,
        sha256: hash(new Uint8Array()),
        embeddedGeneration: input.generation,
        embeddedFenceId: input.fence.id,
        embeddedFenceEpoch: input.fence.epoch,
        embeddedCutId: input.fence.cutId,
      },
      schema: { version: 1, fingerprint: hash(new Uint8Array()) },
      orderedMigrations: [],
      logicalInventory: { rootSha256: logicalInventoryRoot({}), tableCounts: {} },
    },
    r2: {
      namespace: 'placeholder',
      prefix: 'placeholder/',
      inventory: {
        sha256: hash('[]'),
        byteLength: 2,
        objectCount: 0,
        totalBytes: 0,
        embeddedGeneration: input.generation,
        embeddedFenceId: input.fence.id,
        embeddedFenceEpoch: input.fence.epoch,
        embeddedCutId: input.fence.cutId,
        objects: [],
      },
    },
    fle: {
      fieldInventory: COMMON_GENERATION_FLE_FIELDS.map((field) => ({
        field,
        encrypted: true as const,
        envelopeVersion: 1,
        keyVersion: 1,
        referenceCount: 0,
      })),
      envelopeVersions: [1],
      keyVersions: [1],
      pinnedKeyFingerprint: hash('placeholder'),
      referenceCounts: Object.fromEntries(COMMON_GENERATION_FLE_FIELDS.map((field) => [field, 0])),
    },
    watermarks: {
      outbox: { maxCommitted: null, maxProcessed: null, pendingCount: 0, pendingSetDigest: hash('outbox') },
      webhook: { maxCommitted: null, maxProcessed: null, pendingCount: 0, pendingSetDigest: hash('webhook') },
    },
    restorePolicy: { mode: 'isolated-only', production_side_effects_allowed: false },
  });

  const fenceBefore = await input.readers.readFence();
  assertFenceSnapshot(fenceBefore, input.fence, 'pre-capture');
  const [d1, r2, fle, watermarks] = await Promise.all([
    input.readers.readD1(),
    input.readers.readR2(),
    input.readers.readFle(),
    input.readers.readWatermarks(),
  ]);
  const fenceAfter = await input.readers.readFence();
  assertFenceSnapshot(fenceAfter, fenceBefore, 'post-capture');
  assertCaptureMarker(d1, input, 'D1 export');
  assertCaptureMarker(r2, input, 'R2 inventory');
  for (const [index, object] of r2.objects.entries()) assertCaptureMarker(object, input, `R2 object ${index}`);

  const d1Bytes = new Uint8Array(d1.bytes);
  const r2Objects = r2.objects.map((object) => ({
    key: object.key,
    contentSha256: hash(object.bytes),
    byteLength: object.bytes.byteLength,
    embeddedGeneration: object.embeddedGeneration,
    embeddedFenceId: object.embeddedFenceId,
    embeddedFenceEpoch: object.embeddedFenceEpoch,
    embeddedCutId: object.embeddedCutId,
  })).sort((left, right) => left.key.localeCompare(right.key));
  const inventoryCanonical = canonicalizeCommonGeneration(r2Objects.map(({ key, contentSha256, byteLength }) => ({ key, contentSha256, byteLength })));
  const payload: CommonGenerationManifest = {
    manifestId: input.manifestId,
    manifestVersion: MANIFEST_VERSION,
    generation: input.generation,
    scope: input.scope,
    source: input.source,
    fence: input.fence,
    d1: {
      export: {
        byteLength: d1Bytes.byteLength,
        sha256: hash(d1Bytes),
        embeddedGeneration: d1.embeddedGeneration,
        embeddedFenceId: d1.embeddedFenceId,
        embeddedFenceEpoch: d1.embeddedFenceEpoch,
        embeddedCutId: d1.embeddedCutId,
      },
      schema: d1.schema,
      orderedMigrations: d1.orderedMigrations,
      logicalInventory: d1.logicalInventory,
    },
    r2: {
      namespace: r2.namespace,
      prefix: r2.prefix,
      inventory: {
        sha256: hash(inventoryCanonical),
        byteLength: Buffer.byteLength(inventoryCanonical),
        objectCount: r2Objects.length,
        totalBytes: r2Objects.reduce((sum, object) => sum + object.byteLength, 0),
        embeddedGeneration: r2.embeddedGeneration,
        embeddedFenceId: r2.embeddedFenceId,
        embeddedFenceEpoch: r2.embeddedFenceEpoch,
        embeddedCutId: r2.embeddedCutId,
        objects: r2Objects,
      },
    },
    fle,
    watermarks,
    restorePolicy: { mode: 'isolated-only', production_side_effects_allowed: false },
  };
  validatePayload(payload);
  return payload;
}

export function validateCapturedArtifacts(
  manifest: CommonGenerationManifest,
  artifacts: CapturedArtifactsForValidation,
): void {
  validatePayload(manifest);
  const expectedMarker = {
    generation: manifest.generation,
    fenceId: manifest.fence.id,
    fenceEpoch: manifest.fence.epoch,
  };
  assertCaptureMarker(artifacts.d1, { generation: manifest.generation, fence: manifest.fence }, 'D1 export');
  assertCaptureMarker(artifacts.r2, { generation: manifest.generation, fence: manifest.fence }, 'R2 inventory');
  for (const [index, object] of artifacts.r2.objects.entries()) {
    assertCaptureMarker(object, { generation: manifest.generation, fence: manifest.fence }, `R2 object ${index}`);
  }

  const d1Bytes = new Uint8Array(artifacts.d1.bytes);
  if (manifest.d1.export.byteLength !== d1Bytes.byteLength || manifest.d1.export.sha256 !== hash(d1Bytes)) {
    fail('D1 export byte length or SHA256 mismatch');
  }
  if (canonicalizeCommonGeneration(manifest.d1.schema) !== canonicalizeCommonGeneration(artifacts.d1.schema)) {
    fail('D1 schema inventory mismatch');
  }
  if (canonicalizeCommonGeneration(manifest.d1.orderedMigrations) !== canonicalizeCommonGeneration(artifacts.d1.orderedMigrations)) {
    fail('D1 ordered migration inventory mismatch');
  }
  if (canonicalizeCommonGeneration(manifest.d1.logicalInventory) !== canonicalizeCommonGeneration(artifacts.d1.logicalInventory)) {
    fail('D1 logical inventory mismatch');
  }

  const r2Objects = artifacts.r2.objects.map((object) => ({
    key: object.key,
    contentSha256: hash(object.bytes),
    byteLength: object.bytes.byteLength,
    embeddedGeneration: object.embeddedGeneration,
    embeddedFenceId: object.embeddedFenceId,
    embeddedFenceEpoch: object.embeddedFenceEpoch,
    embeddedCutId: object.embeddedCutId,
  })).sort((left, right) => left.key.localeCompare(right.key));
  const inventoryCanonical = canonicalizeCommonGeneration(r2Objects.map(({ key, contentSha256, byteLength }) => ({ key, contentSha256, byteLength })));
  const actualR2Inventory: R2Inventory = {
    sha256: hash(inventoryCanonical),
    byteLength: Buffer.byteLength(inventoryCanonical),
    objectCount: r2Objects.length,
    totalBytes: r2Objects.reduce((sum, object) => sum + object.byteLength, 0),
    embeddedGeneration: artifacts.r2.embeddedGeneration,
    embeddedFenceId: artifacts.r2.embeddedFenceId,
    embeddedFenceEpoch: artifacts.r2.embeddedFenceEpoch,
    embeddedCutId: artifacts.r2.embeddedCutId,
    objects: r2Objects,
  };
  const actualR2: R2GenerationArtifact = {
    namespace: artifacts.r2.namespace,
    prefix: artifacts.r2.prefix,
    inventory: actualR2Inventory,
  };
  if (canonicalizeCommonGeneration(manifest.r2) !== canonicalizeCommonGeneration(actualR2)) {
    fail('R2 inventory mismatch');
  }
  if (canonicalizeCommonGeneration(manifest.fle) !== canonicalizeCommonGeneration(artifacts.fle)) {
    fail('FLE field or key inventory mismatch');
  }
  if (canonicalizeCommonGeneration(manifest.watermarks) !== canonicalizeCommonGeneration(artifacts.watermarks)) {
    fail('outbox or webhook watermark mismatch');
  }
  for (const field of manifest.fle.fieldInventory) {
    if (field.encrypted !== true) fail('FLE plaintext fallback is not allowed');
  }
  if (manifest.r2.inventory.embeddedGeneration !== expectedMarker.generation ||
      manifest.r2.inventory.embeddedFenceId !== expectedMarker.fenceId ||
      manifest.r2.inventory.embeddedFenceEpoch !== expectedMarker.fenceEpoch ||
      manifest.r2.inventory.embeddedCutId !== manifest.fence.cutId) {
    fail('R2 inventory marker mismatch');
  }
}

export function hashSignedCommonGenerationManifest(
  input: SignedCommonGenerationManifest | string,
): Sha256 {
  const value = typeof input === 'string' ? parseRawCanonicalJson(input) : input;
  validateSignedEnvelope(value);
  return hash(canonicalizeCommonGeneration(value));
}

type NoSendTargetStatus = 'fresh' | 'restoring' | 'verified' | 'failed';

const noSendTargetStates = new WeakMap<object, { status: NoSendTargetStatus }>();

export function createNoSendIsolatedRestoreTarget(): NoSendIsolatedRestoreTarget {
  const nonce = randomUUID();
  const target = Object.freeze({
    environmentId: `synthetic-memory://${nonce}`,
    bindingFingerprint: hash(`synthetic-memory-binding:${nonce}`),
    production: false as const,
  });
  noSendTargetStates.set(target, { status: 'fresh' });
  return target;
}

function validateRetainedGenerations(
  value: unknown,
  manifest: CommonGenerationManifest,
): { generationCount: number; independentLocationCount: number } {
  if (!Array.isArray(value)) fail('retained generations must be an array');
  const generations = new Set<string>();
  const failureDomains = new Set<string>();
  let currentGenerationFound = false;
  for (const [index, item] of value.entries()) {
    assertRecord(item, `retained generations[${index}]`);
    assertExactKeys(item, ['generation', 'completedAt', 'location'], `retained generations[${index}]`);
    assertString(item.generation, `retained generations[${index}].generation`);
    assertTimestamp(item.completedAt, `retained generations[${index}].completedAt`);
    assertRecord(item.location, `retained generations[${index}].location`);
    assertExactKeys(
      item.location,
      ['provider', 'accountId', 'container', 'failureDomain'],
      `retained generations[${index}].location`,
    );
    for (const key of ['provider', 'accountId', 'container', 'failureDomain']) {
      assertString(item.location[key], `retained generations[${index}].location.${key}`);
    }
    if (generations.has(item.generation)) fail('retained generations must be unique');
    generations.add(item.generation);
    failureDomains.add(`${item.location.provider}\u0000${item.location.accountId}\u0000${item.location.failureDomain}`);
    if (item.generation === manifest.generation && item.completedAt === manifest.fence.completedAt) {
      currentGenerationFound = true;
    }
  }
  if (generations.size < 3) fail('at least three retained generations are required');
  if (!currentGenerationFound) fail('the signed generation is not present in retained backups');
  if (failureDomains.size < 2) fail('retained generations require an independent backup failure domain');
  return { generationCount: generations.size, independentLocationCount: failureDomains.size };
}

function assertSafeD1Sql(sql: string): void {
  if (/\b(?:ATTACH|DETACH|VACUUM|load_extension|readfile|writefile)\b|CREATE\s+VIRTUAL\s+TABLE/iu.test(sql)) {
    fail('D1 SQL export contains an operation forbidden in a no-send memory target');
  }
}

function importD1IntoMemory(bytes: Uint8Array): DatabaseSync {
  let sql: string;
  try {
    sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('D1 SQL export is not valid UTF-8');
  }
  assertSafeD1Sql(sql);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql);
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  } catch {
    db.close();
    fail('D1 SQL import failed');
  }
}

function safeTableName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) || value.startsWith('sqlite_')) {
    fail('D1 logical inventory contains an unsafe table name');
  }
  return `"${value}"`;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function scalarCount(db: DatabaseSync, sql: string, ...values: Array<string | number>): number {
  const row = db.prepare(sql).get(...values) as { count?: number | bigint } | undefined;
  const count = Number(row?.count);
  if (!Number.isSafeInteger(count) || count < 0) fail('D1 readback returned an invalid count');
  return count;
}

function validateD1Readback(db: DatabaseSync, manifest: CommonGenerationManifest): void {
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
  if (integrity?.integrity_check !== 'ok') fail('D1 integrity check failed');
  if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) fail('D1 referential integrity check failed');

  for (const [table, expectedCount] of Object.entries(manifest.d1.logicalInventory.tableCounts)) {
    if (!tableExists(db, table)) fail('D1 logical inventory table is missing after restore');
    if (scalarCount(db, `SELECT COUNT(*) AS count FROM ${safeTableName(table)}`) !== expectedCount) {
      fail('D1 logical inventory count mismatch after restore');
    }
  }

  const criticalTables = [
    'pharmacy_prescription_submissions',
    'pharmacy_patient_intake_responses',
    'pharmacy_medication_followups',
  ];
  for (const table of criticalTables) {
    if (!(table in manifest.d1.logicalInventory.tableCounts) || !tableExists(db, table)) {
      fail('D1 critical readback table is missing');
    }
    const outsideScope = scalarCount(
      db,
      `SELECT COUNT(*) AS count FROM ${safeTableName(table)} WHERE line_account_id IS NULL OR line_account_id <> ?`,
      manifest.scope.lineAccountId,
    );
    if (outsideScope !== 0) fail('D1 critical readback crossed the signed LINE account scope');
  }
}

function validateWatermarkReadback(db: DatabaseSync, manifest: CommonGenerationManifest): void {
  if (!tableExists(db, 'pharmacy_notification_events') ||
      !tableExists(db, 'pharmacy_webhook_event_receipts')) {
    fail('outbox or webhook watermark table is missing after restore');
  }
  if (scalarCount(
    db,
    'SELECT COUNT(*) AS count FROM pharmacy_notification_events WHERE line_account_id IS NULL OR line_account_id <> ?',
    manifest.scope.lineAccountId,
  ) !== 0 || scalarCount(
    db,
    `SELECT COUNT(*) AS count FROM pharmacy_webhook_event_receipts
      WHERE tenant_id IS NULL OR tenant_id <> ? OR line_account_id IS NULL OR line_account_id <> ?`,
    manifest.scope.tenantId,
    manifest.scope.lineAccountId,
  ) !== 0) {
    fail('outbox or webhook watermark crossed the signed tenant or LINE account scope');
  }

  const outboxRange = db.prepare(`
    SELECT MAX(created_at) AS maxCommitted,
           MAX(CASE WHEN outcome <> 'attempted' THEN occurred_at END) AS maxProcessed
      FROM pharmacy_notification_events
     WHERE line_account_id = ?
  `).get(manifest.scope.lineAccountId) as { maxCommitted: string | null; maxProcessed: string | null };
  const outboxRows = db.prepare(`
    SELECT id, idempotency_key AS idempotencyKey, occurred_at AS occurredAt, outcome
      FROM pharmacy_notification_events
     WHERE line_account_id = ? AND outcome = 'attempted'
     ORDER BY id
  `).all(manifest.scope.lineAccountId) as unknown as Array<{
    id: string;
    idempotencyKey: string;
    occurredAt: string;
    outcome: string;
  }>;
  const webhookRange = db.prepare(`
    SELECT MAX(received_at) AS maxCommitted,
           MAX(CASE WHEN status = 'completed' THEN received_at END) AS maxProcessed
      FROM pharmacy_webhook_event_receipts
     WHERE tenant_id = ? AND line_account_id = ?
  `).get(manifest.scope.tenantId, manifest.scope.lineAccountId) as {
    maxCommitted: string | null;
    maxProcessed: string | null;
  };
  const webhookRows = db.prepare(`
    SELECT webhook_event_id AS webhookEventId, status, retry_count AS retryCount,
           dead_lettered_at AS deadLetteredAt
      FROM pharmacy_webhook_event_receipts
     WHERE tenant_id = ? AND line_account_id = ? AND status <> 'completed'
     ORDER BY webhook_event_id
  `).all(manifest.scope.tenantId, manifest.scope.lineAccountId) as unknown as Array<{
    webhookEventId: string;
    status: string;
    retryCount: number;
    deadLetteredAt: string | null;
  }>;
  const restored: GenerationWatermarks = {
    outbox: {
      ...outboxRange,
      pendingCount: outboxRows.length,
      pendingSetDigest: hash(canonicalizeCommonGeneration({ kind: 'outbox', rows: outboxRows })),
    },
    webhook: {
      ...webhookRange,
      pendingCount: webhookRows.length,
      pendingSetDigest: hash(canonicalizeCommonGeneration({ kind: 'webhook', rows: webhookRows })),
    },
  };
  if (canonicalizeCommonGeneration(restored) !== canonicalizeCommonGeneration(manifest.watermarks)) {
    fail('outbox or webhook watermark readback mismatch');
  }
}

interface FleReadbackRow {
  response_id: string;
  tenant_id: string;
  line_account_id: string;
  owner_friend_id: string;
  patient_id: string;
  field_name: string;
  schema_version: number;
  source_revision: number;
  envelope_version: number;
  key_version: number;
  nonce: string;
  ciphertext: string;
  legacy_value: string;
}

async function validateFleReadback(
  db: DatabaseSync,
  manifest: CommonGenerationManifest,
  rootSecret: string,
): Promise<void> {
  if (!tableExists(db, 'pharmacy_patient_intake_envelopes')) fail('FLE envelope table is missing');
  const rows = db.prepare(`
    SELECT envelope.response_id, envelope.tenant_id, envelope.line_account_id,
           envelope.owner_friend_id, envelope.patient_id, envelope.field_name,
           envelope.schema_version, envelope.source_revision, envelope.envelope_version,
           envelope.key_version, envelope.nonce, envelope.ciphertext,
           CASE envelope.field_name
             WHEN 'patient_snapshot_json' THEN response.patient_snapshot_json
             WHEN 'answers_json' THEN response.answers_json
           END AS legacy_value
      FROM pharmacy_patient_intake_envelopes AS envelope
      JOIN pharmacy_patient_intake_responses AS response
        ON response.id = envelope.response_id
       AND response.patient_id = envelope.patient_id
       AND response.line_account_id = envelope.line_account_id
       AND response.owner_friend_id = envelope.owner_friend_id
       AND response.schema_version = envelope.schema_version
       AND response.revision = envelope.source_revision
     ORDER BY envelope.response_id, envelope.field_name
  `).all() as unknown as FleReadbackRow[];
  const counts = new Map<string, number>();
  const nonceKeys = new Set<string>();
  for (const row of rows) {
    if (row.tenant_id !== manifest.scope.tenantId || row.line_account_id !== manifest.scope.lineAccountId) {
      fail('FLE readback crossed the signed tenant or LINE account scope');
    }
    if (row.field_name !== 'patient_snapshot_json' && row.field_name !== 'answers_json') {
      fail('FLE readback found an unknown encrypted field');
    }
    const fieldName = row.field_name as PatientIntakeEncryptedField;
    const inventoryName = `pharmacy_patient_intake_responses.${fieldName}`;
    const nonceKey = `${row.key_version}:${row.nonce}`;
    if (nonceKeys.has(nonceKey)) fail('FLE readback found a reused nonce');
    nonceKeys.add(nonceKey);
    let plaintext: string;
    try {
      plaintext = await openPatientIntakeField({
        envelopeVersion: row.envelope_version,
        keyVersion: row.key_version,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
      }, rootSecret, {
        tenantId: row.tenant_id,
        lineAccountId: row.line_account_id,
        ownerFriendId: row.owner_friend_id,
        patientId: row.patient_id,
        responseId: row.response_id,
        schemaVersion: row.schema_version,
        sourceRevision: row.source_revision,
        fieldName,
        envelopeVersion: row.envelope_version,
        keyVersion: row.key_version,
      });
    } catch {
      fail('FLE envelope readback failed');
    }
    if (row.legacy_value !== '{}' && plaintext !== row.legacy_value) fail('FLE plaintext/envelope readback mismatch');
    counts.set(inventoryName, (counts.get(inventoryName) ?? 0) + 1);
  }
  for (const field of COMMON_GENERATION_FLE_FIELDS) {
    if ((counts.get(field) ?? 0) !== manifest.fle.referenceCounts[field]) {
      fail('FLE readback coverage does not match the signed inventory');
    }
  }
}

function validateR2Readback(
  db: DatabaseSync,
  manifest: CommonGenerationManifest,
  artifacts: CapturedArtifactsForValidation,
): void {
  const restored = new Map(artifacts.r2.objects.map((object) => [object.key, new Uint8Array(object.bytes)]));
  if (restored.size !== manifest.r2.inventory.objectCount) fail('R2 object count mismatch after restore');
  const ownedKeys = new Set<string>();
  if (tableExists(db, 'pharmacy_prescription_files')) {
    const rows = db.prepare(`
      SELECT file.r2_key, submission.line_account_id
        FROM pharmacy_prescription_files AS file
        JOIN pharmacy_prescription_submissions AS submission ON submission.id = file.submission_id
    `).all() as unknown as Array<{ r2_key: string; line_account_id: string }>;
    for (const row of rows) {
      if (row.line_account_id !== manifest.scope.lineAccountId || !restored.has(row.r2_key)) {
        fail('R2 prescription ownership readback failed');
      }
      ownedKeys.add(row.r2_key);
    }
  }
  if (tableExists(db, 'pharmacy_incoming_image_objects')) {
    const rows = db.prepare('SELECT r2_key, tenant_id, line_account_id FROM pharmacy_incoming_image_objects')
      .all() as unknown as Array<{ r2_key: string; tenant_id: string; line_account_id: string }>;
    for (const row of rows) {
      if (row.tenant_id !== manifest.scope.tenantId || row.line_account_id !== manifest.scope.lineAccountId ||
          !restored.has(row.r2_key)) fail('R2 incoming-image ownership readback failed');
      ownedKeys.add(row.r2_key);
    }
  }
  for (const key of restored.keys()) {
    if (!ownedKeys.has(key)) fail('R2 restore contains an orphan object');
  }
}

export async function runIsolatedRestoreRehearsal(
  input: IsolatedRestoreInput,
): Promise<IsolatedRehearsalReport> {
  assertRecord(input, 'restore input');
  assertExactKeys(input, [
    'signedManifest', 'pinnedTrustStore', 'target', 'artifacts', 'fleRootSecret',
    'retainedGenerations',
  ], 'restore input');
  assertRecord(input.target, 'restore input.target');
  assertExactKeys(input.target, ['environmentId', 'bindingFingerprint', 'production'], 'restore input.target');
  assertString(input.target.environmentId, 'restore input.target.environmentId');
  assertString(input.target.bindingFingerprint, 'restore input.target.bindingFingerprint');
  if (input.target.production !== false) fail('isolated restore target cannot be production');
  const targetState = noSendTargetStates.get(input.target);
  if (!targetState) fail('isolated target was not created by the no-send factory');
  if (targetState.status !== 'fresh') fail('isolated restore requires a fresh target');
  assertString(input.fleRootSecret, 'restore input.fleRootSecret');
  const verification = verifyCommonGenerationManifest(input.signedManifest, input.pinnedTrustStore);
  if (!verification.valid || !verification.payload) fail(`manifest verification failed: ${verification.reason ?? 'invalid manifest'}`);
  const manifest = verification.payload;
  if (manifest.source.environmentId === input.target.environmentId) fail('isolated restore target must differ from source environment');
  if (manifest.source.bindingFingerprint === input.target.bindingFingerprint) fail('isolated restore target must differ from source binding');
  if (manifest.restorePolicy.production_side_effects_allowed !== false || manifest.restorePolicy.mode !== 'isolated-only') {
    fail('manifest restore policy is not isolated-only');
  }
  validateCapturedArtifacts(manifest, input.artifacts);
  const retention = validateRetainedGenerations(input.retainedGenerations, manifest);
  const startedMs = Date.now();
  const rpoHours = (startedMs - Date.parse(manifest.fence.completedAt)) / 3_600_000;
  if (!Number.isFinite(rpoHours) || rpoHours < 0 || rpoHours > 24) fail('RPO exceeds 24 hours');
  const manifestHash = hashSignedCommonGenerationManifest(input.signedManifest);
  targetState.status = 'restoring';
  let db: DatabaseSync | undefined;
  try {
    if (hash(input.fleRootSecret) !== manifest.fle.pinnedKeyFingerprint) fail('FLE root key fingerprint mismatch');
    db = importD1IntoMemory(input.artifacts.d1.bytes);
    validateD1Readback(db, manifest);
    validateWatermarkReadback(db, manifest);
    validateR2Readback(db, manifest, input.artifacts);
    await validateFleReadback(db, manifest, input.fleRootSecret);
    const endedMs = Date.now();
    const rtoHours = (endedMs - startedMs) / 3_600_000;
    if (!Number.isFinite(rtoHours) || rtoHours < 0 || rtoHours > 4) fail('RTO exceeds 4 hours');
    targetState.status = 'verified';
    return {
      schemaVersion: SCHEMA_VERSION,
      manifestHash,
      targetBindingFingerprint: input.target.bindingFingerprint,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(endedMs).toISOString(),
      readbackResult: 'passed',
      referentialIntegrity: true,
      r2Ownership: true,
      fleReadback: true,
      prescriptionsReadback: true,
      intakeReadback: true,
      followUpReadback: true,
      watermarksReconciled: true,
      outboundAttemptCount: 0,
      productionBindingCount: 0,
      quarantinedOutboxCount: manifest.watermarks.outbox.pendingCount,
      quarantinedWebhookCount: manifest.watermarks.webhook.pendingCount,
      rpoHours,
      rtoHours,
      retainedGenerationCount: retention.generationCount,
      independentBackupLocationCount: retention.independentLocationCount,
    };
  } catch (error) {
    targetState.status = 'failed';
    throw error;
  } finally {
    db?.close();
  }
}
