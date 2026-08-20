import { getLineAccountByIdForTenant, type LineAccount } from '@line-crm/db';
import {
  encryptLineCredential,
  type LineCredentialKind,
} from './line-credentials.js';

const ENCRYPTED_CREDENTIAL = 'encrypted:v1';
const CREATE_ERROR = 'Unable to create LINE account';
export const LINE_ACCOUNT_CONFLICT_ERROR = 'LINE account changed concurrently';

export interface CreateEncryptedLineAccountInput {
  tenantId: string;
  /** The authenticated creator receives explicit pharmacy account access. */
  assignedStaffId?: string;
  channelId: string;
  name: string;
  credentials: Array<{ kind: LineCredentialKind; credential: string }>;
  loginChannelId?: string | null;
  liffId?: string | null;
  ogSiteName?: string | null;
  ogDefaultImageUrl?: string | null;
  ogDefaultDescription?: string | null;
}

export interface UpdateEncryptedLineAccountInput {
  tenantId: string;
  lineAccountId: string;
  expectedUpdatedAt: string;
  credentials: Array<{ kind: LineCredentialKind; credential: string | null }>;
  metadata: {
    name?: string;
    isActive?: boolean;
    country?: string | null;
    role?: string | null;
    loginChannelId?: string | null;
    liffId?: string | null;
    ogSiteName?: string | null;
    ogDefaultImageUrl?: string | null;
    ogDefaultDescription?: string | null;
    tokenExpiresAt?: string | null;
  };
}

export async function createEncryptedLineAccount(
  db: D1Database,
  rootSecret: string,
  input: CreateEncryptedLineAccountInput,
): Promise<LineAccount> {
  const kinds = new Set(input.credentials.map(({ kind }) => kind));
  if (kinds.size !== input.credentials.length ||
      !kinds.has('channel_access_token') || !kinds.has('channel_secret')) {
    throw new Error(CREATE_ERROR);
  }

  try {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const order = await db.prepare(
      `SELECT COALESCE(MAX(account.display_order), -1) + 1 AS next
         FROM line_accounts AS account
         INNER JOIN tenant_line_accounts AS mapping
                 ON mapping.line_account_id = account.id
        WHERE mapping.tenant_id = ?`,
    ).bind(input.tenantId).first<{ next: number }>();
    const encrypted = await Promise.all(input.credentials.map(async ({ kind, credential }) => ({
      kind,
      ...await encryptLineCredential({
        rootSecret,
        tenantId: input.tenantId,
        lineAccountId: id,
        kind,
        credential,
      }),
    })));
    const loginSecret = kinds.has('login_channel_secret') ? ENCRYPTED_CREDENTIAL : null;

    const statements: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO line_accounts
          (id, channel_id, name, channel_access_token, channel_secret,
           login_channel_id, login_channel_secret, liff_id,
           is_active, display_order,
           og_site_name, og_default_image_url, og_default_description,
           created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?
           FROM tenants
          WHERE id = ? AND status = 'active'`,
      ).bind(
        id,
        input.channelId,
        input.name,
        ENCRYPTED_CREDENTIAL,
        ENCRYPTED_CREDENTIAL,
        input.loginChannelId ?? null,
        loginSecret,
        input.liffId ?? null,
        order?.next ?? 0,
        input.ogSiteName ?? null,
        input.ogDefaultImageUrl ?? null,
        input.ogDefaultDescription ?? null,
        now,
        now,
        input.tenantId,
      ),
      db.prepare(
        `INSERT INTO tenant_line_accounts
          (tenant_id, line_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(input.tenantId, id, now, now),
      ...encrypted.map((credential) => db.prepare(
        `INSERT INTO pharmacy_line_credentials
          (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
           key_version, revision, lookup_digest, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        input.tenantId,
        id,
        credential.kind,
        credential.nonce,
        credential.ciphertext,
        credential.keyVersion,
        credential.lookupDigest,
        now,
        now,
      )),
    ];
    if (input.assignedStaffId) {
      statements.push(db.prepare(
        `INSERT INTO pharmacy_staff_accounts
          (line_account_id, staff_id, is_active, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      ).bind(id, input.assignedStaffId, now, now));
    }
    await db.batch(statements);

    const account = await getLineAccountByIdForTenant(db, input.tenantId, id);
    if (!account) throw new Error(CREATE_ERROR);
    return account;
  } catch {
    throw new Error(CREATE_ERROR);
  }
}

export async function updateEncryptedLineAccount(
  db: D1Database,
  rootSecret: string | undefined,
  input: UpdateEncryptedLineAccountInput,
): Promise<LineAccount> {
  const kinds = new Set(input.credentials.map(({ kind }) => kind));
  if (kinds.size !== input.credentials.length || input.credentials.some(({ kind, credential }) =>
    credential === null && kind !== 'login_channel_secret')) {
    throw new Error(CREATE_ERROR);
  }

  try {
    const expectedTime = Date.parse(input.expectedUpdatedAt);
    const now = new Date(Math.max(
      Date.now(),
      Number.isFinite(expectedTime) ? expectedTime + 1 : Date.now(),
    )).toISOString();
    const writes = input.credentials.filter(
      (item): item is { kind: LineCredentialKind; credential: string } => item.credential !== null,
    );
    if (writes.length > 0 && !rootSecret) throw new Error(CREATE_ERROR);
    const encrypted = await Promise.all(writes.map(async ({ kind, credential }) => ({
      kind,
      ...await encryptLineCredential({
        rootSecret: rootSecret!,
        tenantId: input.tenantId,
        lineAccountId: input.lineAccountId,
        kind,
        credential,
      }),
    })));

    const statements: D1PreparedStatement[] = encrypted.map((credential) => db.prepare(
      `INSERT INTO pharmacy_line_credentials
        (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
         key_version, revision, lookup_digest, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
            FROM tenant_line_accounts AS mapping
            INNER JOIN tenants AS tenant
                    ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
            INNER JOIN line_accounts AS account
                    ON account.id = mapping.line_account_id
           WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?
             AND account.updated_at = ?
        )
       ON CONFLICT (tenant_id, line_account_id, credential_kind) DO UPDATE SET
         nonce = excluded.nonce,
         ciphertext = excluded.ciphertext,
         key_version = excluded.key_version,
         revision = pharmacy_line_credentials.revision + 1,
         lookup_digest = excluded.lookup_digest,
         updated_at = excluded.updated_at`,
    ).bind(
      input.tenantId,
      input.lineAccountId,
      credential.kind,
      credential.nonce,
      credential.ciphertext,
      credential.keyVersion,
      credential.lookupDigest,
      now,
      now,
      input.tenantId,
      input.lineAccountId,
      input.expectedUpdatedAt,
    ));
    if (input.credentials.some(({ credential }) => credential === null)) {
      statements.push(db.prepare(
        `DELETE FROM pharmacy_line_credentials
          WHERE tenant_id = ? AND line_account_id = ?
            AND credential_kind = 'login_channel_secret'
            AND EXISTS (
              SELECT 1
                FROM tenant_line_accounts AS mapping
                INNER JOIN tenants AS tenant
                        ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
                INNER JOIN line_accounts AS account
                        ON account.id = mapping.line_account_id
               WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?
                 AND account.updated_at = ?
            )`,
      ).bind(
        input.tenantId,
        input.lineAccountId,
        input.tenantId,
        input.lineAccountId,
        input.expectedUpdatedAt,
      ));
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (input.metadata.name !== undefined) add('name', input.metadata.name);
    if (input.metadata.isActive !== undefined) add('is_active', input.metadata.isActive ? 1 : 0);
    if (input.metadata.country !== undefined) add('country', input.metadata.country);
    if (input.metadata.role !== undefined) add('role', input.metadata.role);
    if (input.metadata.loginChannelId !== undefined) add('login_channel_id', input.metadata.loginChannelId);
    if (input.metadata.liffId !== undefined) add('liff_id', input.metadata.liffId);
    if (input.metadata.ogSiteName !== undefined) add('og_site_name', input.metadata.ogSiteName);
    if (input.metadata.ogDefaultImageUrl !== undefined) {
      add('og_default_image_url', input.metadata.ogDefaultImageUrl);
    }
    if (input.metadata.ogDefaultDescription !== undefined) {
      add('og_default_description', input.metadata.ogDefaultDescription);
    }
    if (input.metadata.tokenExpiresAt !== undefined) {
      add('token_expires_at', input.metadata.tokenExpiresAt);
    }
    for (const { kind, credential } of input.credentials) {
      add(kind, credential === null ? null : ENCRYPTED_CREDENTIAL);
    }

    if (sets.length > 0) {
      add('updated_at', now);
      statements.push(db.prepare(
        `UPDATE line_accounts
            SET ${sets.join(', ')}
          WHERE id = ?
            AND updated_at = ?
            AND EXISTS (
              SELECT 1
                FROM tenant_line_accounts AS mapping
                INNER JOIN tenants AS tenant
                        ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
               WHERE mapping.tenant_id = ? AND mapping.line_account_id = line_accounts.id
            )`,
      ).bind(...values, input.lineAccountId, input.expectedUpdatedAt, input.tenantId));
    }

    if (statements.length > 0) {
      const results = await db.batch(statements);
      if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
        throw new Error(LINE_ACCOUNT_CONFLICT_ERROR);
      }
    }
    const account = await getLineAccountByIdForTenant(db, input.tenantId, input.lineAccountId);
    if (!account) throw new Error(CREATE_ERROR);
    return account;
  } catch (error) {
    if (error instanceof Error && error.message === LINE_ACCOUNT_CONFLICT_ERROR) throw error;
    throw new Error(CREATE_ERROR);
  }
}
