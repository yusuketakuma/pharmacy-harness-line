import {
  computeLineAccessTokenLookupDigest,
  decryptLineCredential,
  encryptLineCredential,
  type LineCredentialKind,
} from './line-credentials.js';

export const LEGACY_LINE_CREDENTIAL_SENTINEL = 'encrypted:v1';
export const LINE_CREDENTIAL_BACKFILL_ERROR = 'Unable to backfill LINE credentials';
export const LINE_CREDENTIAL_SCRUB_ERROR = 'Unable to scrub legacy LINE credentials';
export const LINE_CREDENTIAL_RESTORE_ERROR = 'Unable to restore legacy LINE credentials';

export interface LineCredentialMigrationInput {
  tenantId: string;
  lineAccountId: string;
}

export interface LineCredentialBackfillResult {
  written: number;
  verified: number;
}

export interface LineCredentialScrubResult {
  scrubbed: boolean;
  verified: number;
}

export interface LineCredentialRestoreResult {
  restored: boolean;
  verified: number;
}

const ROOT_VALIDATION_CREDENTIAL = `root-validation-${'x'.repeat(32)}`;

const LEGACY_FIELDS = [
  { kind: 'channel_access_token', column: 'channel_access_token' },
  { kind: 'channel_secret', column: 'channel_secret' },
  { kind: 'login_channel_secret', column: 'login_channel_secret' },
] as const satisfies ReadonlyArray<{
  kind: LineCredentialKind;
  column: keyof LegacyLineAccountRow;
}>;

type LegacyLineAccountRow = {
  tenant_id: string;
  line_account_id: string;
  channel_access_token: string | null;
  channel_secret: string | null;
  login_channel_secret: string | null;
};

type StoredLineCredentialRow = {
  credential_kind: LineCredentialKind;
  nonce: string;
  ciphertext: string;
  key_version: number;
  revision: number;
  lookup_digest: string | null;
};

type CredentialState = {
  kind: LineCredentialKind;
  legacy: string | null;
  encrypted: StoredLineCredentialRow | null;
};

function fail(message: string): never {
  throw new Error(message);
}

function validateMigrationInput(input: LineCredentialMigrationInput): void {
  for (const value of [input.tenantId, input.lineAccountId]) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128 ||
        value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) {
      fail(LINE_CREDENTIAL_BACKFILL_ERROR);
    }
  }
}

async function validateRootSecret(rootSecret: unknown): Promise<string> {
  if (typeof rootSecret !== 'string') fail(LINE_CREDENTIAL_BACKFILL_ERROR);
  try {
    await computeLineAccessTokenLookupDigest(rootSecret, ROOT_VALIDATION_CREDENTIAL);
  } catch {
    fail(LINE_CREDENTIAL_BACKFILL_ERROR);
  }
  return rootSecret;
}

async function readLegacyLineAccount(
  db: D1Database,
  input: LineCredentialMigrationInput,
): Promise<LegacyLineAccountRow> {
  try {
    const result = await db.prepare(`
      /* line-credential-backfill:legacy */
      SELECT mapping.tenant_id, mapping.line_account_id,
             account.channel_access_token,
             account.channel_secret,
             account.login_channel_secret
        FROM tenant_line_accounts AS mapping
        INNER JOIN tenants AS tenant
                ON tenant.id = mapping.tenant_id
               AND tenant.status = 'active'
        INNER JOIN line_accounts AS account
                ON account.id = mapping.line_account_id
       WHERE mapping.line_account_id = ?
       LIMIT 2
    `).bind(input.lineAccountId).all<LegacyLineAccountRow>();
    const rows = result.results ?? [];
    if (rows.length !== 1 || rows[0]?.tenant_id !== input.tenantId ||
        rows[0]?.line_account_id !== input.lineAccountId) {
      fail(LINE_CREDENTIAL_BACKFILL_ERROR);
    }
    const row = rows[0]!;
    for (const field of LEGACY_FIELDS) {
      const value = row[field.column];
      if (value !== null && typeof value !== 'string') {
        fail(LINE_CREDENTIAL_BACKFILL_ERROR);
      }
    }
    return row;
  } catch {
    fail(LINE_CREDENTIAL_BACKFILL_ERROR);
  }
}

async function readEncryptedCredentials(
  db: D1Database,
  input: LineCredentialMigrationInput,
): Promise<Map<LineCredentialKind, StoredLineCredentialRow>> {
  try {
    const result = await db.prepare(`
      /* line-credential-backfill:encrypted */
      SELECT credential_kind, nonce, ciphertext, key_version, revision, lookup_digest
        FROM pharmacy_line_credentials
       WHERE tenant_id = ? AND line_account_id = ?
    `).bind(input.tenantId, input.lineAccountId).all<StoredLineCredentialRow>();
    const rows = result.results ?? [];
    const byKind = new Map<LineCredentialKind, StoredLineCredentialRow>();
    for (const row of rows) {
      if (!LEGACY_FIELDS.some((field) => field.kind === row.credential_kind) ||
          byKind.has(row.credential_kind) ||
          !Number.isSafeInteger(row.revision) || row.revision < 1) {
        fail(LINE_CREDENTIAL_BACKFILL_ERROR);
      }
      byKind.set(row.credential_kind, row);
    }
    return byKind;
  } catch {
    fail(LINE_CREDENTIAL_BACKFILL_ERROR);
  }
}

async function inspectCredentials(
  db: D1Database,
  rootSecret: string,
  input: LineCredentialMigrationInput,
  allowMissingPlaintext: boolean,
): Promise<{ states: CredentialState[]; verified: number }> {
  const legacy = await readLegacyLineAccount(db, input);
  const encrypted = await readEncryptedCredentials(db, input);
  const states: CredentialState[] = [];
  let verified = 0;

  for (const field of LEGACY_FIELDS) {
    const legacyValue = legacy[field.column];
    const encryptedValue = encrypted.get(field.kind) ?? null;
    if (legacyValue === null) {
      if (encryptedValue) fail(LINE_CREDENTIAL_BACKFILL_ERROR);
      states.push({ kind: field.kind, legacy: null, encrypted: null });
      continue;
    }

    if (!encryptedValue) {
      if (!allowMissingPlaintext || legacyValue === LEGACY_LINE_CREDENTIAL_SENTINEL) {
        fail(LINE_CREDENTIAL_BACKFILL_ERROR);
      }
      states.push({ kind: field.kind, legacy: legacyValue, encrypted: null });
      continue;
    }

    let decrypted: string;
    try {
      decrypted = await decryptLineCredential({
        rootSecret,
        tenantId: input.tenantId,
        lineAccountId: input.lineAccountId,
        kind: field.kind,
        keyVersion: encryptedValue.key_version,
        nonce: encryptedValue.nonce,
        ciphertext: encryptedValue.ciphertext,
        lookupDigest: encryptedValue.lookup_digest,
      });
    } catch {
      fail(LINE_CREDENTIAL_BACKFILL_ERROR);
    }
    if (legacyValue !== LEGACY_LINE_CREDENTIAL_SENTINEL && decrypted !== legacyValue) {
      fail(LINE_CREDENTIAL_BACKFILL_ERROR);
    }
    verified += 1;
    states.push({
      kind: field.kind,
      legacy: legacyValue,
      encrypted: encryptedValue,
    });
  }

  return { states, verified };
}

async function validateMissingCredentials(
  rootSecret: string,
  input: LineCredentialMigrationInput,
  states: CredentialState[],
): Promise<void> {
  try {
    await Promise.all(states
      .filter((state): state is CredentialState & { legacy: string; encrypted: null } =>
        state.legacy !== null && state.encrypted === null)
      .map((state) => encryptLineCredential({
        rootSecret,
        tenantId: input.tenantId,
        lineAccountId: input.lineAccountId,
        kind: state.kind,
        credential: state.legacy,
      })));
  } catch {
    fail(LINE_CREDENTIAL_BACKFILL_ERROR);
  }
}

async function writeMigratedCredential(
  db: D1Database,
  rootSecret: string,
  input: LineCredentialMigrationInput,
  state: CredentialState & { legacy: string; encrypted: null },
): Promise<void> {
  // Migration-only insert: inactive mapped accounts still need their plaintext scrubbed.
  try {
    const encrypted = await encryptLineCredential({
      rootSecret,
      tenantId: input.tenantId,
      lineAccountId: input.lineAccountId,
      kind: state.kind,
      credential: state.legacy,
    });
    const now = new Date().toISOString();
    const result = await db.prepare(`
      INSERT INTO pharmacy_line_credentials
        (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
         key_version, revision, lookup_digest, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ?
       WHERE EXISTS (
         SELECT 1
           FROM tenant_line_accounts AS mapping
           INNER JOIN tenants AS tenant
                   ON tenant.id = mapping.tenant_id
                  AND tenant.status = 'active'
          WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?
       )
      ON CONFLICT (tenant_id, line_account_id, credential_kind) DO UPDATE SET
        nonce = excluded.nonce,
        ciphertext = excluded.ciphertext,
        key_version = excluded.key_version,
        revision = pharmacy_line_credentials.revision + 1,
        lookup_digest = excluded.lookup_digest,
        updated_at = excluded.updated_at
       WHERE pharmacy_line_credentials.revision = 0
      RETURNING revision
    `).bind(
      input.tenantId,
      input.lineAccountId,
      state.kind,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.keyVersion,
      encrypted.lookupDigest,
      now,
      now,
      input.tenantId,
      input.lineAccountId,
    ).first<{ revision: number }>();
    if (!result || !Number.isSafeInteger(result.revision) || result.revision < 1) {
      fail(LINE_CREDENTIAL_BACKFILL_ERROR);
    }
  } catch {
    fail(LINE_CREDENTIAL_BACKFILL_ERROR);
  }
}

export async function backfillLineCredentials(
  db: D1Database,
  rootSecret: string,
  input: LineCredentialMigrationInput,
): Promise<LineCredentialBackfillResult> {
  try {
    validateMigrationInput(input);
    const validatedRoot = await validateRootSecret(rootSecret);
    const inspected = await inspectCredentials(db, validatedRoot, input, true);
    await validateMissingCredentials(validatedRoot, input, inspected.states);

    let written = 0;
    for (const state of inspected.states) {
      if (state.legacy === null || state.encrypted !== null) continue;
      // Revision 0 is the store's insert-only CAS: a concurrent row is rejected.
      await writeMigratedCredential(db, validatedRoot, input, state as CredentialState & {
        legacy: string;
        encrypted: null;
      });
      written += 1;
    }
    return { written, verified: inspected.verified };
  } catch {
    fail(LINE_CREDENTIAL_BACKFILL_ERROR);
  }
}

function scrubGuard(column: string, value: string | null, values: unknown[]): string {
  if (value === null) return `account.${column} IS NULL`;
  values.push(value);
  return `account.${column} = ?`;
}

export async function scrubLegacyLineCredentials(
  db: D1Database,
  rootSecret: string,
  input: LineCredentialMigrationInput,
): Promise<LineCredentialScrubResult> {
  try {
    validateMigrationInput(input);
    const validatedRoot = await validateRootSecret(rootSecret);
    const inspected = await inspectCredentials(db, validatedRoot, input, false);
    const legacyByKind = new Map(inspected.states.map((state) => [state.kind, state.legacy]));
    const token = legacyByKind.get('channel_access_token') ?? null;
    const secret = legacyByKind.get('channel_secret') ?? null;
    const loginSecret = legacyByKind.get('login_channel_secret') ?? null;
    const needsScrub = [token, secret, loginSecret]
      .some((value) => value !== null && value !== LEGACY_LINE_CREDENTIAL_SENTINEL);
    if (!needsScrub) return { scrubbed: false, verified: inspected.verified };

    const guardValues: unknown[] = [];
    const guards = [
      scrubGuard('channel_access_token', token, guardValues),
      scrubGuard('channel_secret', secret, guardValues),
      scrubGuard('login_channel_secret', loginSecret, guardValues),
    ];
    const result = await db.batch([
      db.prepare(`
        UPDATE line_accounts AS account
           SET channel_access_token = ?,
               channel_secret = ?,
               login_channel_secret = ?
         WHERE account.id = ?
           AND (
             SELECT COUNT(*)
               FROM tenant_line_accounts AS mapping
               INNER JOIN tenants AS tenant
                       ON tenant.id = mapping.tenant_id
                      AND tenant.status = 'active'
              WHERE mapping.line_account_id = account.id
           ) = 1
           AND EXISTS (
             SELECT 1
               FROM tenant_line_accounts AS mapping
               INNER JOIN tenants AS tenant
                       ON tenant.id = mapping.tenant_id
                      AND tenant.status = 'active'
              WHERE mapping.line_account_id = account.id
                AND mapping.tenant_id = ?
           )
           AND ${guards.join('\n           AND ')}
      `).bind(
        token === null ? null : LEGACY_LINE_CREDENTIAL_SENTINEL,
        secret === null ? null : LEGACY_LINE_CREDENTIAL_SENTINEL,
        loginSecret === null ? null : LEGACY_LINE_CREDENTIAL_SENTINEL,
        input.lineAccountId,
        input.tenantId,
        ...guardValues,
      ),
    ]);
    if (result.length !== 1 || (result[0]?.meta.changes ?? 0) !== 1) {
      fail(LINE_CREDENTIAL_SCRUB_ERROR);
    }
    return { scrubbed: true, verified: inspected.verified };
  } catch {
    fail(LINE_CREDENTIAL_SCRUB_ERROR);
  }
}

export async function restoreLegacyLineCredentials(
  db: D1Database,
  rootSecret: string,
  input: LineCredentialMigrationInput,
): Promise<LineCredentialRestoreResult> {
  try {
    validateMigrationInput(input);
    const validatedRoot = await validateRootSecret(rootSecret);
    const inspected = await inspectCredentials(db, validatedRoot, input, false);
    const encryptedStates = inspected.states.filter((state) => state.legacy !== null);
    if (!encryptedStates.some((state) => state.legacy === LEGACY_LINE_CREDENTIAL_SENTINEL)) {
      return { restored: false, verified: inspected.verified };
    }
    if (encryptedStates.some((state) => state.legacy !== LEGACY_LINE_CREDENTIAL_SENTINEL)) {
      fail(LINE_CREDENTIAL_RESTORE_ERROR);
    }

    const plaintext = new Map<LineCredentialKind, string>();
    for (const state of encryptedStates) {
      if (!state.encrypted) fail(LINE_CREDENTIAL_RESTORE_ERROR);
      plaintext.set(state.kind, await decryptLineCredential({
        rootSecret: validatedRoot,
        tenantId: input.tenantId,
        lineAccountId: input.lineAccountId,
        kind: state.kind,
        keyVersion: state.encrypted.key_version,
        nonce: state.encrypted.nonce,
        ciphertext: state.encrypted.ciphertext,
        lookupDigest: state.encrypted.lookup_digest,
      }));
    }

    const current = new Map(inspected.states.map((state) => [state.kind, state.legacy]));
    const guardValues: unknown[] = [];
    const guards = LEGACY_FIELDS.map((field) =>
      scrubGuard(field.column, current.get(field.kind) ?? null, guardValues));
    const result = await db.batch([
      db.prepare(`
        UPDATE line_accounts AS account
           SET channel_access_token = ?,
               channel_secret = ?,
               login_channel_secret = ?
         WHERE account.id = ?
           AND (
             SELECT COUNT(*)
               FROM tenant_line_accounts AS mapping
               INNER JOIN tenants AS tenant
                       ON tenant.id = mapping.tenant_id
                      AND tenant.status = 'active'
              WHERE mapping.line_account_id = account.id
           ) = 1
           AND EXISTS (
             SELECT 1
               FROM tenant_line_accounts AS mapping
               INNER JOIN tenants AS tenant
                       ON tenant.id = mapping.tenant_id
                      AND tenant.status = 'active'
              WHERE mapping.line_account_id = account.id
                AND mapping.tenant_id = ?
           )
           AND ${guards.join('\n           AND ')}
      `).bind(
        plaintext.get('channel_access_token') ?? null,
        plaintext.get('channel_secret') ?? null,
        plaintext.get('login_channel_secret') ?? null,
        input.lineAccountId,
        input.tenantId,
        ...guardValues,
      ),
    ]);
    if (result.length !== 1 || (result[0]?.meta.changes ?? 0) !== 1) {
      fail(LINE_CREDENTIAL_RESTORE_ERROR);
    }
    return { restored: true, verified: inspected.verified };
  } catch {
    fail(LINE_CREDENTIAL_RESTORE_ERROR);
  }
}
