-- Fixed-purpose, account/environment-scoped recovery approvals and execution fences.
-- This migration records PHI-free evidence only; it does not store secrets,
-- ciphertext, patient ids, or decrypted payloads.

CREATE TABLE pharmacy_recovery_backup_generations (
  generation_id          TEXT NOT NULL,
  tenant_id              TEXT NOT NULL,
  line_account_id        TEXT NOT NULL,
  environment            TEXT NOT NULL CHECK (
    length(environment) BETWEEN 1 AND 64
    AND environment NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  status                 TEXT NOT NULL CHECK (status IN ('verified', 'invalidated')),
  manifest_digest        TEXT NOT NULL CHECK (
    length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  expected_row_count     INTEGER NOT NULL CHECK (expected_row_count >= 0),
  expected_object_count  INTEGER NOT NULL CHECK (expected_object_count >= 0),
  verified_at            TEXT NOT NULL CHECK (length(verified_at) >= 20),
  created_at             TEXT NOT NULL CHECK (length(created_at) >= 20),
  PRIMARY KEY (generation_id, environment),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id)
);

CREATE INDEX idx_pharmacy_recovery_backup_generations_scope
  ON pharmacy_recovery_backup_generations
    (tenant_id, line_account_id, environment, status, verified_at);

CREATE TABLE pharmacy_recovery_operations (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  line_account_id           TEXT NOT NULL,
  environment               TEXT NOT NULL CHECK (
    length(environment) BETWEEN 1 AND 64
    AND environment NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  operation                 TEXT NOT NULL CHECK (
    operation IN (
      'fle_backfill', 'plaintext_scrub', 'plaintext_restore',
      'retention_delete', 'restore_rehearsal'
    )
  ),
  status                    TEXT NOT NULL CHECK (
    status IN ('created', 'preflighted', 'approved', 'running',
               'completed', 'stale', 'failed')
  ),
  requested_by_issuer       TEXT NOT NULL CHECK (requested_by_issuer = 'platform-admin'),
  requested_by_subject      TEXT NOT NULL CHECK (length(requested_by_subject) BETWEEN 1 AND 160),
  approver_issuer           TEXT CHECK (approver_issuer IS NULL OR approver_issuer = 'platform-admin'),
  approver_subject          TEXT CHECK (approver_subject IS NULL OR length(approver_subject) BETWEEN 1 AND 160),
  executor_issuer            TEXT CHECK (executor_issuer IS NULL OR executor_issuer = 'platform-admin'),
  executor_subject          TEXT CHECK (executor_subject IS NULL OR length(executor_subject) BETWEEN 1 AND 160),
  approval_expires_at       TEXT NOT NULL CHECK (length(approval_expires_at) >= 20),
  job_id                    TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 160),
  idempotency_key           TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  schema_digest             TEXT,
  field_inventory_digest    TEXT,
  key_versions_json         TEXT,
  backup_generation_id      TEXT,
  expected_row_count        INTEGER CHECK (expected_row_count IS NULL OR expected_row_count >= 0),
  expected_object_count     INTEGER CHECK (expected_object_count IS NULL OR expected_object_count >= 0),
  stop_policy               TEXT,
  rollback_policy           TEXT,
  evidence_digest           TEXT,
  row_digest                TEXT,
  coverage_total            INTEGER CHECK (coverage_total IS NULL OR coverage_total >= 0),
  coverage_verified         INTEGER CHECK (coverage_verified IS NULL OR coverage_verified IN (0, 1)),
  key_recovery_acknowledged INTEGER CHECK (
    key_recovery_acknowledged IS NULL OR key_recovery_acknowledged IN (0, 1)
  ),
  execution_id              TEXT UNIQUE,
  fence_id                  TEXT UNIQUE,
  fence_token               TEXT UNIQUE,
  cursor                    TEXT,
  processed_row_count       INTEGER NOT NULL DEFAULT 0 CHECK (processed_row_count >= 0),
  processed_object_count    INTEGER NOT NULL DEFAULT 0 CHECK (processed_object_count >= 0),
  last_batch_id             TEXT,
  error_code                TEXT,
  created_at                TEXT NOT NULL CHECK (length(created_at) >= 20),
  approved_at               TEXT,
  claimed_at                TEXT,
  completed_at              TEXT,
  updated_at                TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK (
    executor_subject IS NULL OR approver_subject IS NULL OR executor_subject <> approver_subject
  ),
  UNIQUE (id, tenant_id, line_account_id, environment),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id),
  FOREIGN KEY (backup_generation_id, environment)
    REFERENCES pharmacy_recovery_backup_generations(generation_id, environment)
);

CREATE UNIQUE INDEX idx_pharmacy_recovery_operations_idempotency
  ON pharmacy_recovery_operations
    (tenant_id, line_account_id, environment, operation, idempotency_key);

CREATE INDEX idx_pharmacy_recovery_operations_scope_status
  ON pharmacy_recovery_operations
    (tenant_id, line_account_id, environment, status, updated_at);

CREATE TABLE pharmacy_recovery_execution_fences (
  fence_id             TEXT PRIMARY KEY,
  operation_id         TEXT NOT NULL UNIQUE
                       REFERENCES pharmacy_recovery_operations(id) ON DELETE CASCADE,
  tenant_id            TEXT NOT NULL,
  line_account_id      TEXT NOT NULL,
  environment          TEXT NOT NULL CHECK (
    length(environment) BETWEEN 1 AND 64
    AND environment NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  execution_id         TEXT NOT NULL UNIQUE,
  fence_token          TEXT NOT NULL UNIQUE CHECK (length(fence_token) BETWEEN 32 AND 240),
  owner_issuer         TEXT NOT NULL CHECK (owner_issuer = 'platform-admin'),
  owner_subject        TEXT NOT NULL CHECK (length(owner_subject) BETWEEN 1 AND 160),
  status               TEXT NOT NULL CHECK (status IN ('active', 'released')),
  expires_at           TEXT NOT NULL CHECK (length(expires_at) >= 20),
  created_at           TEXT NOT NULL CHECK (length(created_at) >= 20),
  released_at          TEXT,
  FOREIGN KEY (operation_id, tenant_id, line_account_id, environment)
    REFERENCES pharmacy_recovery_operations(id, tenant_id, line_account_id, environment)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id)
);

CREATE UNIQUE INDEX idx_pharmacy_recovery_execution_fences_active_scope
  ON pharmacy_recovery_execution_fences (tenant_id, line_account_id, environment)
  WHERE status = 'active';

CREATE INDEX idx_pharmacy_recovery_execution_fences_scope_status
  ON pharmacy_recovery_execution_fences
    (tenant_id, line_account_id, environment, status, expires_at);
