-- Account-scoped write freeze and human approval evidence for intake PHI scrub/restore.

CREATE TABLE pharmacy_patient_intake_migration_state (
  tenant_id          TEXT NOT NULL,
  line_account_id    TEXT PRIMARY KEY,
  phase              TEXT NOT NULL
    CHECK (phase IN ('frozen', 'scrubbing', 'scrubbed', 'restoring', 'restored')),
  coverage_total     INTEGER NOT NULL CHECK (coverage_total >= 0),
  coverage_digest    TEXT NOT NULL CHECK (
    length(coverage_digest) = 64 AND coverage_digest NOT GLOB '*[^0-9a-f]*'
  ),
  approved_by        TEXT NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 120),
  approval_reference TEXT NOT NULL CHECK (length(approval_reference) BETWEEN 1 AND 240),
  approved_at        TEXT NOT NULL CHECK (length(approved_at) >= 20),
  updated_at         TEXT NOT NULL CHECK (length(updated_at) >= 20),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id)
);

CREATE INDEX idx_pharmacy_patient_intake_migration_state_scope
  ON pharmacy_patient_intake_migration_state (tenant_id, line_account_id, phase);
