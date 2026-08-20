-- Tenant-scoped admin login credentials and idempotent platform provisioning.
-- Passwords are stored only as versioned PBKDF2 hashes by the Worker.

CREATE UNIQUE INDEX IF NOT EXISTS idx_line_accounts_login_channel_unique
  ON line_accounts (login_channel_id)
  WHERE login_channel_id IS NOT NULL AND login_channel_id != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_line_accounts_liff_unique
  ON line_accounts (liff_id)
  WHERE liff_id IS NOT NULL AND liff_id != '';

CREATE TABLE IF NOT EXISTS tenant_admin_credentials (
  tenant_id            TEXT NOT NULL,
  staff_id             TEXT NOT NULL,
  login_id             TEXT NOT NULL COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1
                       CHECK (must_change_password IN (0, 1)),
  credential_version   INTEGER NOT NULL DEFAULT 1
                       CHECK (credential_version >= 1),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (tenant_id, staff_id),
  UNIQUE (tenant_id, login_id),
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES tenant_staff_memberships (tenant_id, staff_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_admin_credentials_login
  ON tenant_admin_credentials (tenant_id, login_id);

CREATE TABLE IF NOT EXISTS tenant_admin_sessions (
  token_hash         TEXT PRIMARY KEY
                     CHECK (length(token_hash) = 64
                            AND token_hash NOT GLOB '*[^0-9a-f]*'),
  tenant_id          TEXT NOT NULL,
  staff_id           TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
  session_kind       TEXT NOT NULL CHECK (session_kind IN ('bootstrap', 'standard')),
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL,
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES tenant_staff_memberships (tenant_id, staff_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_admin_sessions_staff
  ON tenant_admin_sessions (tenant_id, staff_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS pharmacy_line_channel_identities (
  line_account_id TEXT PRIMARY KEY,
  bot_user_id     TEXT NOT NULL UNIQUE CHECK (length(bot_user_id) BETWEEN 2 AND 128),
  created_at      TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pharmacy_tenant_provisioning_requests (
  idempotency_key_hash TEXT PRIMARY KEY
                       CHECK (length(idempotency_key_hash) = 64
                              AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
  request_hash         TEXT NOT NULL,
  actor_key_hash       TEXT NOT NULL,
  tenant_id            TEXT NOT NULL,
  line_account_id      TEXT NOT NULL,
  staff_id             TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts (tenant_id, line_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES tenant_staff_memberships (tenant_id, staff_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_tenant_provisioning_tenant
  ON pharmacy_tenant_provisioning_requests (tenant_id, created_at);
