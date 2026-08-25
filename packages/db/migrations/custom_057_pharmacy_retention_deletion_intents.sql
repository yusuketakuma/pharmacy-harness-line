-- V032-4. Durable retention fences and deletion intents.
--
-- Hold state is separate from the DSR workflow row so a retention decision can
-- be fenced independently of a request version.  `patient_key='*'` is the
-- account-owner fence used while an uploaded object has not yet been linked to
-- one unambiguous patient.

CREATE TABLE IF NOT EXISTS pharmacy_retention_hold_epochs (
  tenant_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  owner_friend_id TEXT NOT NULL,
  patient_key     TEXT NOT NULL CHECK (patient_key = '*' OR length(patient_key) > 0),
  epoch           INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  status          TEXT NOT NULL CHECK (status IN ('held', 'released', 'unknown')),
  release_at      TEXT,
  reason_code     TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, line_account_id, owner_friend_id, patient_key),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts (tenant_id, line_account_id),
  FOREIGN KEY (owner_friend_id, line_account_id)
    REFERENCES friends (id, line_account_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_retention_hold_epochs_scope
  ON pharmacy_retention_hold_epochs
     (tenant_id, line_account_id, owner_friend_id, patient_key, epoch);

CREATE TABLE IF NOT EXISTS pharmacy_retention_deletion_intents (
  id              TEXT PRIMARY KEY,
  operation_id    TEXT NOT NULL CHECK (length(trim(operation_id)) BETWEEN 1 AND 200),
  execution_id    TEXT NOT NULL CHECK (length(trim(execution_id)) BETWEEN 1 AND 200),
  fence_token     TEXT NOT NULL CHECK (length(trim(fence_token)) BETWEEN 1 AND 500),
  executor_subject TEXT NOT NULL CHECK (length(trim(executor_subject)) BETWEEN 1 AND 200),
  environment     TEXT NOT NULL CHECK (length(trim(environment)) BETWEEN 1 AND 80),
  tenant_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  owner_friend_id TEXT NOT NULL,
  patient_key     TEXT NOT NULL CHECK (patient_key = '*' OR length(patient_key) > 0),
  resource_type   TEXT NOT NULL CHECK (resource_type IN ('prescription_file', 'incoming_image')),
  resource_id     TEXT NOT NULL CHECK (length(trim(resource_id)) BETWEEN 1 AND 300),
  r2_key          TEXT NOT NULL CHECK (length(trim(r2_key)) BETWEEN 1 AND 1000),
  stored_sha256   TEXT NOT NULL CHECK (length(stored_sha256) = 64),
  age_reference_at TEXT NOT NULL,
  row_state       TEXT NOT NULL CHECK (row_state IN ('pending', 'ready', 'deleted')),
  row_revision    INTEGER NOT NULL CHECK (row_revision >= 1),
  hold_epoch      INTEGER NOT NULL CHECK (hold_epoch >= 0),
  status          TEXT NOT NULL CHECK (status IN (
    'CLAIMED', 'CANCELLED_HELD', 'CANCELLED_UNKNOWN', 'CANCELLED_STALE',
    'DELETE_COMMITTED', 'FINALIZED_DELETED', 'OUTCOME_UNKNOWN'
  )),
  last_error_code TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (operation_id, resource_type, resource_id, r2_key, stored_sha256),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts (tenant_id, line_account_id),
  FOREIGN KEY (owner_friend_id, line_account_id)
    REFERENCES friends (id, line_account_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_retention_deletion_intents_queue
  ON pharmacy_retention_deletion_intents (status, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_pharmacy_retention_deletion_intents_scope
  ON pharmacy_retention_deletion_intents
     (tenant_id, line_account_id, resource_type, resource_id, status);
