import {
  decryptEndpointUrl,
  encryptEndpointUrl,
  normalizeEndpointUrl,
  sha256Hex,
} from './endpoint.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ALIAS_PATTERN = /^[A-Za-z0-9-]{3,64}$/;

interface EndpointRow {
  id: string;
  line_account_id: string;
  tenant_alias: string;
  endpoint_url_encrypted: string;
  endpoint_url_hash: string;
  allowed_host: string;
  enabled: number;
  valid_from: string;
  retired_at: string | null;
  last_verified_at: string | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface MynaEndpointAdminConfig {
  id: string;
  line_account_id: string;
  tenant_alias: string;
  endpoint_url_masked: string;
  allowed_host: string;
  enabled: boolean;
  valid_from: string;
  retired_at: string | null;
  last_verified_at: string | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface MynaEndpointRuntimeConfig extends MynaEndpointAdminConfig {
  endpoint_url: string;
}

export interface SaveMynaEndpointInput {
  lineAccountId: string;
  tenantAlias: string;
  endpointUrl: string;
  enabled: boolean;
  staffId: string;
  encryptionSecret: string;
  allowedHosts: string[];
}

function maskEndpointUrl(endpointUrl: string): string {
  const url = new URL(endpointUrl);
  return `${url.origin}/…`;
}

function decodeAdmin(row: EndpointRow, endpointUrl: string): MynaEndpointAdminConfig {
  return {
    id: row.id,
    line_account_id: row.line_account_id,
    tenant_alias: row.tenant_alias,
    endpoint_url_masked: maskEndpointUrl(endpointUrl),
    allowed_host: row.allowed_host,
    enabled: row.enabled === 1,
    valid_from: row.valid_from,
    retired_at: row.retired_at,
    last_verified_at: row.last_verified_at,
    revision: row.revision,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function decodeRuntime(
  row: EndpointRow,
  encryptionSecret: string,
): Promise<MynaEndpointRuntimeConfig> {
  const endpointUrl = await decryptEndpointUrl(row.endpoint_url_encrypted, encryptionSecret, { lineAccountId: row.line_account_id });
  const normalized = normalizeEndpointUrl(endpointUrl, [row.allowed_host]);
  if (await sha256Hex(normalized) !== row.endpoint_url_hash) {
    throw new Error('Myna endpoint integrity check failed');
  }
  return { ...decodeAdmin(row, normalized), endpoint_url: normalized };
}

const endpointSelect = `
  SELECT id, line_account_id, tenant_alias, endpoint_url_encrypted, endpoint_url_hash,
         allowed_host, enabled, valid_from, retired_at, last_verified_at, revision,
         created_by, updated_by, created_at, updated_at
    FROM pharmacy_myna_endpoint_configs`;

export async function getActiveMynaEndpoint(
  db: D1Database,
  lineAccountId: string,
  encryptionSecret: string,
): Promise<MynaEndpointRuntimeConfig | null> {
  const row = await db.prepare(
    `${endpointSelect}
      WHERE line_account_id = ? AND enabled = 1 AND retired_at IS NULL
      ORDER BY revision DESC, updated_at DESC
      LIMIT 1`,
  ).bind(lineAccountId).first<EndpointRow>();
  return row ? decodeRuntime(row, encryptionSecret) : null;
}

export async function getAdminMynaEndpoint(
  db: D1Database,
  lineAccountId: string,
  encryptionSecret: string,
): Promise<MynaEndpointAdminConfig | null> {
  const row = await db.prepare(
    `${endpointSelect}
      WHERE line_account_id = ?
      ORDER BY revision DESC, updated_at DESC
      LIMIT 1`,
  ).bind(lineAccountId).first<EndpointRow>();
  if (!row) return null;
  const endpointUrl = await decryptEndpointUrl(row.endpoint_url_encrypted, encryptionSecret, { lineAccountId: row.line_account_id });
  return decodeAdmin(row, normalizeEndpointUrl(endpointUrl, [row.allowed_host]));
}

export async function setMynaEndpointEnabled(
  db: D1Database,
  lineAccountId: string,
  enabled: boolean,
  expectedRevision: number,
  staffId: string,
  encryptionSecret: string,
): Promise<MynaEndpointAdminConfig> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('stale Myna endpoint revision');
  }
  const current = await db.prepare(
    `${endpointSelect}
      WHERE line_account_id = ?
      ORDER BY revision DESC, updated_at DESC
      LIMIT 1`,
  ).bind(lineAccountId).first<EndpointRow>();
  if (!current) throw new Error('Myna endpoint not found');
  if (current.revision !== expectedRevision) throw new Error('stale Myna endpoint revision');
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_myna_endpoint_configs
        SET enabled = ?, retired_at = ?, last_verified_at = NULL,
            updated_by = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND revision = ?
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_myna_endpoint_configs AS newer
           WHERE newer.line_account_id = ? AND newer.revision > ?
        )`,
  ).bind(
    enabled ? 1 : 0, enabled ? null : now, staffId, now,
    current.id, lineAccountId, expectedRevision, lineAccountId, expectedRevision,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('stale Myna endpoint revision');
  const endpointUrl = await decryptEndpointUrl(current.endpoint_url_encrypted, encryptionSecret, { lineAccountId: current.line_account_id });
  return decodeAdmin({
    ...current,
    enabled: enabled ? 1 : 0,
    retired_at: enabled ? null : now,
    last_verified_at: null,
    updated_by: staffId,
    updated_at: now,
  }, normalizeEndpointUrl(endpointUrl, [current.allowed_host]));
}

function validateSaveInput(input: SaveMynaEndpointInput): string {
  if (!ID_PATTERN.test(input.lineAccountId) || !ID_PATTERN.test(input.staffId) ||
      !ALIAS_PATTERN.test(input.tenantAlias) || !input.encryptionSecret) {
    throw new Error('invalid Myna endpoint config');
  }
  return normalizeEndpointUrl(input.endpointUrl, input.allowedHosts);
}

export async function saveMynaEndpoint(
  db: D1Database,
  input: SaveMynaEndpointInput,
): Promise<MynaEndpointAdminConfig> {
  const endpointUrl = validateSaveInput(input);
  const endpointHash = await sha256Hex(endpointUrl);
  const encrypted = await encryptEndpointUrl(endpointUrl, input.encryptionSecret, { lineAccountId: input.lineAccountId });
  const current = await db.prepare(
    `${endpointSelect}
      WHERE line_account_id = ?
      ORDER BY revision DESC, updated_at DESC
      LIMIT 1`,
  ).bind(input.lineAccountId).first<EndpointRow>();
  const now = new Date().toISOString();
  const enabled = input.enabled ? 1 : 0;
  const retiredAt = input.enabled ? null : now;
  const id = current && current.endpoint_url_hash === endpointHash &&
    current.tenant_alias === input.tenantAlias ? current.id : crypto.randomUUID();
  const revision = current ? current.revision + (id === current.id ? 0 : 1) : 1;
  const row: EndpointRow = {
    id,
    line_account_id: input.lineAccountId,
    tenant_alias: input.tenantAlias,
    endpoint_url_encrypted: encrypted,
    endpoint_url_hash: endpointHash,
    allowed_host: new URL(endpointUrl).hostname.toLowerCase(),
    enabled,
    valid_from: current && id === current.id ? current.valid_from : now,
    retired_at: retiredAt,
    last_verified_at: null,
    revision,
    created_by: current && id === current.id ? current.created_by : input.staffId,
    updated_by: input.staffId,
    created_at: current && id === current.id ? current.created_at : now,
    updated_at: now,
  };

  if (current && id === current.id) {
    await db.prepare(
      `UPDATE pharmacy_myna_endpoint_configs
          SET endpoint_url_encrypted = ?, endpoint_url_hash = ?, allowed_host = ?,
              enabled = ?, retired_at = ?, last_verified_at = NULL, updated_by = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ?`,
    ).bind(
      encrypted, endpointHash, row.allowed_host, enabled, retiredAt,
      input.staffId, now, current.id, input.lineAccountId,
    ).run();
  } else {
    const statements: D1PreparedStatement[] = [];
    if (current) {
      statements.push(db.prepare(
        `UPDATE pharmacy_myna_endpoint_configs
            SET enabled = 0, retired_at = COALESCE(retired_at, ?), updated_by = ?, updated_at = ?
          WHERE id = ? AND line_account_id = ?`,
      ).bind(now, input.staffId, now, current.id, input.lineAccountId));
    }
    statements.push(db.prepare(
      `INSERT INTO pharmacy_myna_endpoint_configs
       (id, line_account_id, tenant_alias, endpoint_url_encrypted, endpoint_url_hash,
        allowed_host, enabled, valid_from, retired_at, revision, created_by, updated_by,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id, row.line_account_id, row.tenant_alias, row.endpoint_url_encrypted,
      row.endpoint_url_hash, row.allowed_host, row.enabled, row.valid_from, row.retired_at,
      row.revision, row.created_by, row.updated_by, row.created_at, row.updated_at,
    ));
    await db.batch(statements);
  }
  return decodeAdmin(row, endpointUrl);
}

export async function markMynaEndpointVerified(
  db: D1Database,
  lineAccountId: string,
  expectedRevision: number,
): Promise<string> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('stale Myna endpoint revision');
  }
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_myna_endpoint_configs
        SET last_verified_at = ?, updated_at = ?
      WHERE line_account_id = ? AND revision = ? AND enabled = 1 AND retired_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_myna_endpoint_configs AS newer
           WHERE newer.line_account_id = ? AND newer.revision > ?
        )`,
  ).bind(now, now, lineAccountId, expectedRevision, lineAccountId, expectedRevision).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('stale Myna endpoint revision');
  return now;
}
