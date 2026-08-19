-- Tenant/account-scoped LINE credentials. Plaintext values remain outside this table.
CREATE TABLE IF NOT EXISTS pharmacy_line_credentials (
  tenant_id       TEXT NOT NULL CHECK (length(tenant_id) > 0),
  line_account_id TEXT NOT NULL CHECK (length(line_account_id) > 0),
  credential_kind TEXT NOT NULL CHECK (
    credential_kind IN ('channel_access_token', 'channel_secret', 'login_channel_secret')
  ),
  nonce           TEXT NOT NULL CHECK (length(nonce) > 0),
  ciphertext      TEXT NOT NULL CHECK (length(ciphertext) > 0),
  key_version     INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  lookup_digest   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, line_account_id, credential_kind),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts (tenant_id, line_account_id) ON DELETE CASCADE,
  CHECK (
    (credential_kind = 'channel_access_token' AND
     lookup_digest IS NOT NULL AND
     length(lookup_digest) = 64 AND
     lookup_digest NOT GLOB '*[^0-9a-f]*')
    OR
    (credential_kind <> 'channel_access_token' AND lookup_digest IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_line_credentials_access_token
  ON pharmacy_line_credentials (lookup_digest)
  WHERE credential_kind = 'channel_access_token' AND lookup_digest IS NOT NULL;
