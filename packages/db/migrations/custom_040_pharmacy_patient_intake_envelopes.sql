-- Additive encrypted envelopes for the two PHI-bearing intake JSON fields.
-- Legacy plaintext columns remain during the verified dual-read migration.

CREATE UNIQUE INDEX idx_pharmacy_patient_intake_responses_envelope_scope
  ON pharmacy_patient_intake_responses
    (id, patient_id, line_account_id, owner_friend_id, schema_version, revision);

CREATE TABLE pharmacy_patient_intake_envelopes (
  response_id       TEXT NOT NULL,
  tenant_id         TEXT NOT NULL,
  line_account_id   TEXT NOT NULL,
  owner_friend_id   TEXT NOT NULL,
  patient_id        TEXT NOT NULL,
  field_name        TEXT NOT NULL
    CHECK (field_name IN ('patient_snapshot_json', 'answers_json')),
  schema_version    INTEGER NOT NULL CHECK (schema_version >= 1),
  source_revision   INTEGER NOT NULL CHECK (source_revision >= 1),
  envelope_version  INTEGER NOT NULL CHECK (envelope_version >= 1),
  key_version       INTEGER NOT NULL CHECK (key_version >= 1),
  nonce             TEXT NOT NULL CHECK (length(nonce) = 16),
  ciphertext        TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 22 AND 90000),
  encrypted_at      TEXT NOT NULL CHECK (length(encrypted_at) >= 20),
  PRIMARY KEY (response_id, field_name),
  UNIQUE (key_version, nonce),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id),
  FOREIGN KEY (
    response_id, patient_id, line_account_id, owner_friend_id, schema_version, source_revision
  ) REFERENCES pharmacy_patient_intake_responses (
    id, patient_id, line_account_id, owner_friend_id, schema_version, revision
  ) ON DELETE CASCADE
);

CREATE INDEX idx_pharmacy_patient_intake_envelopes_scope
  ON pharmacy_patient_intake_envelopes
    (tenant_id, line_account_id, owner_friend_id, patient_id, response_id, field_name);
