import {
  computeLineAccessTokenLookupDigest,
  decryptLineCredential,
  encryptLineCredential,
  INVALID_LINE_CREDENTIAL_ERROR,
  type LineCredentialKind,
} from './line-credentials.js';

export const LINE_CREDENTIAL_STORE_ERROR = 'Unable to store LINE credential';
export const LINE_CREDENTIAL_CONFLICT_ERROR = 'LINE credential changed concurrently';

export interface WriteLineCredentialInput {
  tenantId: string;
  lineAccountId: string;
  kind: LineCredentialKind;
  credential: string;
  expectedRevision?: number;
}

export interface ReadLineCredentialInput {
  tenantId: string;
  lineAccountId: string;
  kind: LineCredentialKind;
}

export interface LineCredentialLookup {
  tenantId: string;
  lineAccountId: string;
  kind: 'channel_access_token';
  credential: string;
  revision: number;
}

type StoredLineCredential = {
  tenant_id: string;
  line_account_id: string;
  credential_kind: LineCredentialKind;
  nonce: string;
  ciphertext: string;
  key_version: number;
  revision: number;
  lookup_digest: string | null;
};

const ACTIVE_MAPPING_JOINS = `
  INNER JOIN tenants AS tenant
          ON tenant.id = mapping.tenant_id
         AND tenant.status = 'active'
  INNER JOIN line_accounts AS account
          ON account.id = mapping.line_account_id
         AND account.is_active = 1`;

const ACTIVE_MAPPING_SOURCE = `
  FROM tenant_line_accounts AS mapping
  ${ACTIVE_MAPPING_JOINS}`;

function validateExpectedRevision(value: unknown): void {
  if (value !== undefined &&
      (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(INVALID_LINE_CREDENTIAL_ERROR);
  }
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

async function prepareLineCredentialWrite(
  db: D1Database,
  rootSecret: string,
  input: WriteLineCredentialInput,
): Promise<D1PreparedStatement> {
  validateExpectedRevision(input.expectedRevision);
  const encrypted = await encryptLineCredential({
    rootSecret,
    tenantId: input.tenantId,
    lineAccountId: input.lineAccountId,
    kind: input.kind,
    credential: input.credential,
  });
  const now = new Date().toISOString();
  const expectedRevision = input.expectedRevision ?? null;

  return db.prepare(
      `INSERT INTO pharmacy_line_credentials
         (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
          key_version, revision, lookup_digest, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          ${ACTIVE_MAPPING_SOURCE}
           WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?
        )
          AND (
            ? IS NULL OR ? = 0 OR EXISTS (
              SELECT 1
                FROM pharmacy_line_credentials AS current
               WHERE current.tenant_id = ?
                 AND current.line_account_id = ?
                 AND current.credential_kind = ?
            )
          )
       ON CONFLICT (tenant_id, line_account_id, credential_kind) DO UPDATE SET
         nonce = excluded.nonce,
         ciphertext = excluded.ciphertext,
         key_version = excluded.key_version,
         revision = pharmacy_line_credentials.revision + 1,
         lookup_digest = excluded.lookup_digest,
         updated_at = excluded.updated_at
        WHERE (? IS NULL OR pharmacy_line_credentials.revision = ?)
       RETURNING revision`,
    ).bind(
      input.tenantId,
      input.lineAccountId,
      input.kind,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.keyVersion,
      encrypted.lookupDigest,
      now,
      now,
      input.tenantId,
      input.lineAccountId,
      expectedRevision,
      expectedRevision,
      input.tenantId,
      input.lineAccountId,
      input.kind,
      expectedRevision,
      expectedRevision,
    );
}

export async function writeLineCredential(
  db: D1Database,
  rootSecret: string,
  input: WriteLineCredentialInput,
): Promise<{ revision: number }> {
  const statement = await prepareLineCredentialWrite(db, rootSecret, input);
  let result: { revision: number } | null;
  try {
    result = await statement.first<{ revision: number }>();
  } catch {
    throw new Error(LINE_CREDENTIAL_STORE_ERROR);
  }

  if (!result || !isRevision(result.revision)) {
    throw new Error(LINE_CREDENTIAL_CONFLICT_ERROR);
  }
  return { revision: result.revision };
}

export async function deleteLineCredential(
  db: D1Database,
  input: ReadLineCredentialInput,
): Promise<boolean> {
  try {
    const deleted = await db.prepare(
      `DELETE FROM pharmacy_line_credentials
        WHERE tenant_id = ?
          AND line_account_id = ?
          AND credential_kind = ?
          AND EXISTS (
            SELECT 1
            ${ACTIVE_MAPPING_SOURCE}
             WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?
          )
       RETURNING tenant_id`,
    ).bind(
      input.tenantId,
      input.lineAccountId,
      input.kind,
      input.tenantId,
      input.lineAccountId,
    ).first<{ tenant_id: string }>();
    return Boolean(deleted);
  } catch {
    throw new Error(LINE_CREDENTIAL_STORE_ERROR);
  }
}

export async function readLineCredential(
  db: D1Database,
  rootSecret: string,
  input: ReadLineCredentialInput,
): Promise<string | null> {
  try {
    const row = await db.prepare(
      `SELECT credential.tenant_id, credential.line_account_id,
              credential.credential_kind, credential.nonce, credential.ciphertext,
              credential.key_version, credential.revision, credential.lookup_digest
         FROM pharmacy_line_credentials AS credential
         INNER JOIN tenant_line_accounts AS mapping
                 ON mapping.tenant_id = credential.tenant_id
                AND mapping.line_account_id = credential.line_account_id
         ${ACTIVE_MAPPING_JOINS}
        WHERE credential.tenant_id = mapping.tenant_id
          AND credential.line_account_id = mapping.line_account_id
          AND mapping.tenant_id = ?
          AND mapping.line_account_id = ?
          AND credential.credential_kind = ?
        LIMIT 1`,
    ).bind(input.tenantId, input.lineAccountId, input.kind).first<StoredLineCredential>();
    if (!row || !isRevision(row.revision)) return null;
    return await decryptLineCredential({
      rootSecret,
      tenantId: row.tenant_id,
      lineAccountId: row.line_account_id,
      kind: row.credential_kind,
      keyVersion: row.key_version,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      lookupDigest: row.lookup_digest,
    });
  } catch {
    return null;
  }
}

export async function findLineCredentialByAccessToken(
  db: D1Database,
  rootSecret: string,
  token: string,
): Promise<LineCredentialLookup | null> {
  try {
    const lookupDigest = await computeLineAccessTokenLookupDigest(rootSecret, token);
    const result = await db.prepare(
      `SELECT credential.tenant_id, credential.line_account_id,
              credential.credential_kind, credential.nonce, credential.ciphertext,
              credential.key_version, credential.revision, credential.lookup_digest
         FROM pharmacy_line_credentials AS credential
         INNER JOIN tenant_line_accounts AS mapping
                 ON mapping.tenant_id = credential.tenant_id
                AND mapping.line_account_id = credential.line_account_id
         ${ACTIVE_MAPPING_JOINS}
        WHERE credential.tenant_id = mapping.tenant_id
          AND credential.line_account_id = mapping.line_account_id
          AND credential.credential_kind = 'channel_access_token'
          AND credential.lookup_digest = ?
        LIMIT 2`,
    ).bind(lookupDigest).all<StoredLineCredential>();
    if (result.results.length !== 1) {
      return null;
    }
    const row = result.results[0];
    if (row.credential_kind !== 'channel_access_token' || !isRevision(row.revision)) return null;
    const credential = await decryptLineCredential({
      rootSecret,
      tenantId: row.tenant_id,
      lineAccountId: row.line_account_id,
      kind: row.credential_kind,
      keyVersion: row.key_version,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      lookupDigest: row.lookup_digest,
    });
    return {
      tenantId: row.tenant_id,
      lineAccountId: row.line_account_id,
      kind: 'channel_access_token',
      credential,
      revision: row.revision,
    };
  } catch {
    return null;
  }
}
