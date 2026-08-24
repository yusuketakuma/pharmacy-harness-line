import {
  decryptPatientIntakeEnvelopeFields,
  preparePatientIntakeEnvelopeStatements,
  type PatientIntakeEncryptedRow,
  type StoredPatientIntakeEnvelope,
} from './envelopes.js';

export const PATIENT_INTAKE_LEGACY_SENTINEL = '{}';

export interface PatientIntakeMigrationScope {
  tenantId: string;
  lineAccountId: string;
  rootSecret: string;
}

export interface PatientIntakeMigrationApproval {
  approvedBy: string;
  approvalReference: string;
  coverageTotal: number;
  coverageDigest: string;
}

interface MigrationInput extends PatientIntakeMigrationScope {
  cursor: string | null;
  limit: number;
  dryRun?: boolean;
  approval?: PatientIntakeMigrationApproval;
}

type ErrorCode =
  | 'INVALID_INPUT' | 'INVALID_LIMIT' | 'SCOPE_NOT_FOUND' | 'PARTIAL_ENVELOPE'
  | 'CORRUPT_ENVELOPE' | 'MISMATCH' | 'CAS_CONFLICT' | 'APPROVAL_REQUIRED'
  | 'COVERAGE_MISMATCH' | 'INVALID_STATE' | 'MIXED_SENTINEL' | 'STORAGE_FAILED';

export interface PatientIntakeMigrationReport {
  counts: {
    scanned: number;
    verified: number;
    inserted: number;
    skipped: number;
    scrubbed: number;
    restored: number;
    conflicts: number;
  };
  errorCode: ErrorCode | null;
  nextCursor: string | null;
}

export interface PatientIntakeCoverageReport {
  counts: { scanned: number; covered: number };
  errorCode: ErrorCode | null;
  coverageTotal: number;
  coverageDigest: string;
}

interface MigrationState {
  phase: 'frozen' | 'scrubbing' | 'scrubbed' | 'restoring' | 'restored';
  coverage_total: number;
  coverage_digest: string;
  approved_by: string;
  approval_reference: string;
}

const encoder = new TextEncoder();

function counts(): PatientIntakeMigrationReport['counts'] {
  return { scanned: 0, verified: 0, inserted: 0, skipped: 0, scrubbed: 0, restored: 0, conflicts: 0 };
}

function failed(errorCode: ErrorCode, operationCounts = counts(), cursor: string | null = null): PatientIntakeMigrationReport {
  return { counts: operationCounts, errorCode, nextCursor: cursor };
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/[\u0000-\u001F\u007F]/u.test(value);
}

function validScope(scope: PatientIntakeMigrationScope): boolean {
  const secretLength = typeof scope.rootSecret === 'string' ? encoder.encode(scope.rootSecret).length : 0;
  return validIdentifier(scope.tenantId) && validIdentifier(scope.lineAccountId) &&
    secretLength >= 32 && secretLength <= 4096;
}

function migrationInputError(input: MigrationInput): ErrorCode | null {
  if (!validScope(input)) return 'INVALID_INPUT';
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) return 'INVALID_LIMIT';
  return input.cursor !== null && !validIdentifier(input.cursor) ? 'INVALID_INPUT' : null;
}

function validApproval(value: PatientIntakeMigrationApproval | undefined): value is PatientIntakeMigrationApproval {
  return Boolean(value && typeof value.approvedBy === 'string' && value.approvedBy.trim().length > 0 &&
    value.approvedBy === value.approvedBy.trim() && value.approvedBy.length <= 120 &&
    typeof value.approvalReference === 'string' && value.approvalReference.trim().length > 0 &&
    value.approvalReference === value.approvalReference.trim() && value.approvalReference.length <= 240 &&
    Number.isSafeInteger(value.coverageTotal) && value.coverageTotal >= 0 &&
    /^[0-9a-f]{64}$/u.test(value.coverageDigest));
}

async function hasActiveScope(db: D1Database, scope: PatientIntakeMigrationScope): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS found
    FROM tenant_line_accounts mapping
    INNER JOIN tenants tenant ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
    WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?`).bind(
    scope.tenantId, scope.lineAccountId,
  ).first<{ found: number }>();
  return row?.found === 1;
}

async function readRows(
  db: D1Database,
  scope: PatientIntakeMigrationScope,
  cursor: string | null,
  limit?: number,
): Promise<PatientIntakeEncryptedRow[]> {
  const limitSql = limit === undefined ? '' : 'LIMIT ?';
  const values: unknown[] = [scope.lineAccountId, scope.tenantId, scope.lineAccountId, cursor ?? ''];
  if (limit !== undefined) values.push(limit);
  const result = await db.prepare(`SELECT
      response.id, response.line_account_id, response.owner_friend_id, response.patient_id,
      response.revision, response.schema_version, response.patient_snapshot_json, response.answers_json
    FROM pharmacy_patient_intake_responses response
    WHERE response.line_account_id = ?
      AND EXISTS (SELECT 1 FROM tenant_line_accounts mapping
        WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?)
      AND response.id > ?
    ORDER BY response.id
    ${limitSql}`).bind(...values).all<PatientIntakeEncryptedRow>();
  return result.results ?? [];
}

async function readEnvelopes(db: D1Database, responseId: string): Promise<StoredPatientIntakeEnvelope[]> {
  const result = await db.prepare(`SELECT field_name, envelope_version, key_version, nonce, ciphertext
    FROM pharmacy_patient_intake_envelopes WHERE response_id = ? ORDER BY field_name`)
    .bind(responseId).all<StoredPatientIntakeEnvelope>();
  return result.results ?? [];
}

async function decryptStored(
  row: PatientIntakeEncryptedRow,
  scope: PatientIntakeMigrationScope,
  envelopes: StoredPatientIntakeEnvelope[],
): Promise<{ patient_snapshot_json: string; answers_json: string } | ErrorCode> {
  if (envelopes.length === 1) return 'PARTIAL_ENVELOPE';
  try {
    return await decryptPatientIntakeEnvelopeFields(row, scope, envelopes);
  } catch {
    return 'CORRUPT_ENVELOPE';
  }
}

export async function backfillPatientIntakeEnvelopes(
  db: D1Database,
  input: MigrationInput,
): Promise<PatientIntakeMigrationReport> {
  const resultCounts = counts();
  const inputError = migrationInputError(input);
  if (inputError) return failed(inputError);
  if (!await hasActiveScope(db, input)) return failed('SCOPE_NOT_FOUND');
  const rows = await readRows(db, input, input.cursor, input.limit + 1);
  const batch = rows.slice(0, input.limit);
  for (const row of batch) {
    resultCounts.scanned += 1;
    const envelopes = await readEnvelopes(db, row.id);
    if (envelopes.length === 0) {
      if (row.patient_snapshot_json === PATIENT_INTAKE_LEGACY_SENTINEL ||
          row.answers_json === PATIENT_INTAKE_LEGACY_SENTINEL) return failed('MISMATCH', resultCounts, input.cursor);
      let statements: D1PreparedStatement[];
      try {
        statements = await preparePatientIntakeEnvelopeStatements(
          db,
          row,
          input,
          new Date().toISOString(),
          true,
        );
      } catch {
        return failed('CORRUPT_ENVELOPE', resultCounts, input.cursor);
      }
      resultCounts.verified += 1;
      if (input.dryRun === false) {
        try {
          const results = await db.batch(statements);
          if (results.length !== 2 || results.some((item) => item.meta?.changes !== 1)) {
            resultCounts.conflicts += 1;
            return failed('CAS_CONFLICT', resultCounts, input.cursor);
          }
        } catch {
          resultCounts.conflicts += 1;
          return failed('CAS_CONFLICT', resultCounts, input.cursor);
        }
        resultCounts.inserted += 1;
      }
      continue;
    }
    const decrypted = await decryptStored(row, input, envelopes);
    if (typeof decrypted === 'string') return failed(decrypted, resultCounts, input.cursor);
    if (decrypted.patient_snapshot_json !== row.patient_snapshot_json ||
        decrypted.answers_json !== row.answers_json) return failed('MISMATCH', resultCounts, input.cursor);
    resultCounts.verified += 1;
    resultCounts.skipped += 1;
  }
  return {
    counts: resultCounts,
    errorCode: null,
    nextCursor: rows.length > input.limit ? batch.at(-1)?.id ?? input.cursor : null,
  };
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map((item) => item.toString(16).padStart(2, '0')).join('');
}

export async function inspectPatientIntakeCoverage(
  db: D1Database,
  scope: PatientIntakeMigrationScope,
): Promise<PatientIntakeCoverageReport> {
  const report: PatientIntakeCoverageReport = {
    counts: { scanned: 0, covered: 0 }, errorCode: null, coverageTotal: 0, coverageDigest: '',
  };
  if (!validScope(scope) || !await hasActiveScope(db, scope)) {
    return { ...report, errorCode: 'SCOPE_NOT_FOUND' };
  }
  let cursor: string | null = null;
  const digestParts: string[] = [];
  while (true) {
    const rows = await readRows(db, scope, cursor, 50);
    for (const row of rows) {
      report.counts.scanned += 1;
      const envelopes = await readEnvelopes(db, row.id);
      const decrypted = await decryptStored(row, scope, envelopes);
      if (typeof decrypted === 'string') return { ...report, errorCode: decrypted };
      const snapshotSentinel = row.patient_snapshot_json === PATIENT_INTAKE_LEGACY_SENTINEL;
      const answersSentinel = row.answers_json === PATIENT_INTAKE_LEGACY_SENTINEL;
      if (snapshotSentinel !== answersSentinel) return { ...report, errorCode: 'MIXED_SENTINEL' };
      if (!snapshotSentinel && (decrypted.patient_snapshot_json !== row.patient_snapshot_json ||
          decrypted.answers_json !== row.answers_json)) return { ...report, errorCode: 'MISMATCH' };
      report.counts.covered += 1;
      digestParts.push(await digest(JSON.stringify([
        row.id, row.revision, row.schema_version,
        decrypted.patient_snapshot_json, decrypted.answers_json,
      ])));
    }
    if (rows.length < 50) break;
    cursor = rows.at(-1)!.id;
  }
  report.coverageTotal = report.counts.scanned;
  report.coverageDigest = await digest(digestParts.join('\n'));
  return report;
}

async function readState(db: D1Database, scope: PatientIntakeMigrationScope): Promise<MigrationState | null> {
  return db.prepare(`SELECT phase, coverage_total, coverage_digest, approved_by, approval_reference
    FROM pharmacy_patient_intake_migration_state WHERE tenant_id = ? AND line_account_id = ?`)
    .bind(scope.tenantId, scope.lineAccountId).first<MigrationState>();
}

function approvalMatches(state: MigrationState, approval: PatientIntakeMigrationApproval): boolean {
  return state.coverage_total === approval.coverageTotal &&
    state.coverage_digest === approval.coverageDigest && state.approved_by === approval.approvedBy &&
    state.approval_reference === approval.approvalReference;
}

export async function freezePatientIntakeWrites(
  db: D1Database,
  scope: PatientIntakeMigrationScope,
  approval: PatientIntakeMigrationApproval,
): Promise<PatientIntakeCoverageReport> {
  const coverage = await inspectPatientIntakeCoverage(db, scope);
  if (!validApproval(approval)) return { ...coverage, errorCode: 'APPROVAL_REQUIRED' };
  if (coverage.errorCode || coverage.coverageTotal !== approval.coverageTotal ||
      coverage.coverageDigest !== approval.coverageDigest) {
    return { ...coverage, errorCode: coverage.errorCode ?? 'COVERAGE_MISMATCH' };
  }
  const existing = await readState(db, scope);
  if (existing) {
    return approvalMatches(existing, approval) && existing.phase === 'frozen'
      ? coverage
      : { ...coverage, errorCode: 'INVALID_STATE' };
  }
  const now = new Date().toISOString();
  const write = await db.prepare(`INSERT INTO pharmacy_patient_intake_migration_state
    (tenant_id, line_account_id, phase, coverage_total, coverage_digest,
     approved_by, approval_reference, approved_at, updated_at)
    SELECT ?, ?, 'frozen', ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM tenant_line_accounts WHERE tenant_id = ? AND line_account_id = ?)`)
    .bind(
      scope.tenantId, scope.lineAccountId, approval.coverageTotal, approval.coverageDigest,
      approval.approvedBy, approval.approvalReference, now, now, scope.tenantId, scope.lineAccountId,
    ).run();
  return write.meta?.changes === 1 ? coverage : { ...coverage, errorCode: 'STORAGE_FAILED' };
}

async function migrateLegacyFields(
  db: D1Database,
  input: MigrationInput,
  mode: 'scrub' | 'restore',
): Promise<PatientIntakeMigrationReport> {
  const resultCounts = counts();
  const inputError = migrationInputError(input);
  if (inputError) return failed(inputError);
  if (!validApproval(input.approval)) return failed('APPROVAL_REQUIRED');
  const state = await readState(db, input);
  const allowed = mode === 'scrub' ? ['frozen', 'scrubbing', 'restored'] : ['scrubbed', 'restoring'];
  if (!state || !allowed.includes(state.phase) || !approvalMatches(state, input.approval)) {
    return failed('INVALID_STATE');
  }
  const coverage = await inspectPatientIntakeCoverage(db, input);
  if (coverage.errorCode) return failed(coverage.errorCode);
  if (coverage.coverageTotal !== state.coverage_total ||
      coverage.coverageDigest !== state.coverage_digest) return failed('COVERAGE_MISMATCH');
  const rows = await readRows(db, input, input.cursor, input.limit + 1);
  const batch = rows.slice(0, input.limit);
  const writes: D1PreparedStatement[] = [];
  for (const row of batch) {
    resultCounts.scanned += 1;
    const decrypted = await decryptStored(row, input, await readEnvelopes(db, row.id));
    if (typeof decrypted === 'string') return failed(decrypted, resultCounts, input.cursor);
    const snapshotSentinel = row.patient_snapshot_json === PATIENT_INTAKE_LEGACY_SENTINEL;
    const answersSentinel = row.answers_json === PATIENT_INTAKE_LEGACY_SENTINEL;
    if (snapshotSentinel !== answersSentinel) return failed('MIXED_SENTINEL', resultCounts, input.cursor);
    if (mode === 'scrub') {
      if (snapshotSentinel) { resultCounts.skipped += 1; continue; }
      if (decrypted.patient_snapshot_json !== row.patient_snapshot_json ||
          decrypted.answers_json !== row.answers_json) return failed('MISMATCH', resultCounts, input.cursor);
      writes.push(db.prepare(`UPDATE pharmacy_patient_intake_responses
        SET patient_snapshot_json = '{}', answers_json = '{}'
        WHERE id = ? AND line_account_id = ? AND patient_snapshot_json = ? AND answers_json = ?`)
        .bind(row.id, input.lineAccountId, row.patient_snapshot_json, row.answers_json));
    } else {
      if (!snapshotSentinel) {
        if (decrypted.patient_snapshot_json !== row.patient_snapshot_json ||
            decrypted.answers_json !== row.answers_json) return failed('MISMATCH', resultCounts, input.cursor);
        resultCounts.skipped += 1;
        continue;
      }
      writes.push(db.prepare(`UPDATE pharmacy_patient_intake_responses
        SET patient_snapshot_json = ?, answers_json = ?
        WHERE id = ? AND line_account_id = ? AND patient_snapshot_json = '{}' AND answers_json = '{}'`)
        .bind(decrypted.patient_snapshot_json, decrypted.answers_json, row.id, input.lineAccountId));
    }
    resultCounts.verified += 1;
  }
  const nextCursor = rows.length > input.limit ? batch.at(-1)?.id ?? input.cursor : null;
  if (input.dryRun !== false) return { counts: resultCounts, errorCode: null, nextCursor };
  try {
    const phaseWrite = await db.prepare(`UPDATE pharmacy_patient_intake_migration_state SET phase = ?, updated_at = ?
      WHERE tenant_id = ? AND line_account_id = ? AND phase = ? AND coverage_digest = ?`)
      .bind(
        mode === 'scrub' ? 'scrubbing' : 'restoring', new Date().toISOString(),
        input.tenantId, input.lineAccountId, state.phase, state.coverage_digest,
      ).run();
    if (phaseWrite.meta?.changes !== 1) return failed('INVALID_STATE', resultCounts, input.cursor);
    if (writes.length) {
      const results = await db.batch(writes);
      if (results.length !== writes.length || results.some((item) => item.meta?.changes !== 1)) {
        resultCounts.conflicts += 1;
        return failed('CAS_CONFLICT', resultCounts, input.cursor);
      }
    }
    if (mode === 'scrub') resultCounts.scrubbed = writes.length;
    else resultCounts.restored = writes.length;
    if (nextCursor === null) {
      if (mode === 'scrub') {
        const completed = await db.prepare(`UPDATE pharmacy_patient_intake_migration_state SET phase = 'scrubbed', updated_at = ?
          WHERE tenant_id = ? AND line_account_id = ? AND phase = 'scrubbing'`)
          .bind(new Date().toISOString(), input.tenantId, input.lineAccountId).run();
        if (completed.meta?.changes !== 1) return failed('INVALID_STATE', resultCounts, input.cursor);
      } else {
        const completed = await db.prepare(`UPDATE pharmacy_patient_intake_migration_state
          SET phase = 'restored', updated_at = ?
          WHERE tenant_id = ? AND line_account_id = ? AND phase = 'restoring'`)
          .bind(new Date().toISOString(), input.tenantId, input.lineAccountId).run();
        if (completed.meta?.changes !== 1) return failed('INVALID_STATE', resultCounts, input.cursor);
      }
    }
  } catch {
    return failed('STORAGE_FAILED', resultCounts, input.cursor);
  }
  return { counts: resultCounts, errorCode: null, nextCursor };
}

export function scrubPatientIntakeLegacyFields(
  db: D1Database,
  input: MigrationInput,
): Promise<PatientIntakeMigrationReport> {
  return migrateLegacyFields(db, input, 'scrub');
}

export function restorePatientIntakeLegacyFields(
  db: D1Database,
  input: MigrationInput,
): Promise<PatientIntakeMigrationReport> {
  return migrateLegacyFields(db, input, 'restore');
}
