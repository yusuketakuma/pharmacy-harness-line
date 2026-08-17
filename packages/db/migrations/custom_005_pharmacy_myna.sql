-- Controlled Myna at-home reception handoff and pharmacy verification.
-- No card, qualification, prescription or screenshot data is stored here.

ALTER TABLE pharmacy_fulfillment_quotes
  ADD COLUMN status TEXT CHECK (status IS NULL OR status IN
    ('CHECKING','AVAILABLE','PARTIALLY_AVAILABLE','UNAVAILABLE','PHARMACIST_REVIEW_REQUIRED'));

ALTER TABLE pharmacy_fulfillment_quotes
  ADD COLUMN fulfillment_method TEXT CHECK (fulfillment_method IS NULL OR fulfillment_method IN
    ('PICKUP','DELIVERY','HOME_VISIT','FACILITY_DELIVERY'));

ALTER TABLE pharmacy_fulfillment_quotes
  ADD COLUMN constraints_json TEXT CHECK (constraints_json IS NULL OR
    (json_valid(constraints_json) AND length(constraints_json) BETWEEN 2 AND 4096));

ALTER TABLE pharmacy_fulfillment_quotes
  ADD COLUMN reservation_expires_at TEXT;

ALTER TABLE pharmacy_fulfillment_quotes
  ADD COLUMN confirmed_by TEXT;

ALTER TABLE pharmacy_fulfillment_quotes
  ADD COLUMN confirmed_at TEXT;

ALTER TABLE pharmacy_prescription_submissions
  ADD COLUMN intake_method TEXT NOT NULL DEFAULT 'PAPER' CHECK
    (intake_method IN ('E_PRESCRIPTION','PAPER','MEDICAL_INSTITUTION_SENT'));

ALTER TABLE pharmacy_prescription_submissions
  ADD COLUMN source_handoff_id TEXT;

CREATE TABLE pharmacy_myna_endpoint_configs (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id),
  tenant_alias          TEXT NOT NULL UNIQUE CHECK (
    length(tenant_alias) BETWEEN 3 AND 64
    AND tenant_alias NOT GLOB '*[^A-Za-z0-9-]*'
  ),
  endpoint_url_encrypted TEXT NOT NULL,
  endpoint_url_hash     TEXT NOT NULL,
  allowed_host          TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  valid_from            TEXT NOT NULL,
  retired_at            TEXT,
  last_verified_at      TEXT,
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by            TEXT NOT NULL,
  updated_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, line_account_id)
);

CREATE UNIQUE INDEX idx_pharmacy_myna_endpoint_active_account
  ON pharmacy_myna_endpoint_configs (line_account_id)
  WHERE enabled = 1 AND retired_at IS NULL;

CREATE INDEX idx_pharmacy_myna_endpoint_account
  ON pharmacy_myna_endpoint_configs (line_account_id, revision DESC, updated_at DESC);

CREATE TABLE pharmacy_myna_handoffs (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  friend_id             TEXT NOT NULL,
  patient_id            TEXT,
  expectation_id        TEXT,
  method                TEXT NOT NULL CHECK
    (method IN ('E_PRESCRIPTION','PAPER','MEDICAL_INSTITUTION_SENT')),
  status                TEXT NOT NULL CHECK (status IN
    ('CREATED','LAUNCH_REQUESTED','PATIENT_REPORTED_COMPLETE',
     'PATIENT_REPORTED_NO_PRESCRIPTION','SUPPORT_NEEDED','PAPER_FALLBACK',
     'ABANDONED','EXPIRED','CLOSED')),
  source                TEXT NOT NULL CHECK (source IN ('RICH_MENU','MESSAGE','LIFF')),
  correlation_id        TEXT NOT NULL,
  launched_at           TEXT,
  patient_reported_at   TEXT,
  expires_at            TEXT NOT NULL,
  closed_at             TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, friend_id, correlation_id),
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends(id, line_account_id),
  FOREIGN KEY (patient_id, line_account_id, friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id)
);

CREATE INDEX idx_pharmacy_myna_handoffs_queue
  ON pharmacy_myna_handoffs (line_account_id, status, created_at DESC, id);

CREATE INDEX idx_pharmacy_myna_handoffs_friend
  ON pharmacy_myna_handoffs (line_account_id, friend_id, created_at DESC, id);

CREATE TABLE pharmacy_prescription_expectations (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  friend_id             TEXT NOT NULL,
  patient_id            TEXT,
  handoff_id            TEXT NOT NULL,
  method                TEXT NOT NULL CHECK
    (method IN ('E_PRESCRIPTION','PAPER','MEDICAL_INSTITUTION_SENT')),
  receipt_status        TEXT NOT NULL CHECK (receipt_status IN
    ('EXPECTED','RECEIPT_REPORTED','RECEIVED','FULFILLMENT_REVIEW','ACCEPTED',
     'DISPENSING','READY','DELIVERED','CANCELLED','EXPIRED')),
  shadow_submission_id  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  UNIQUE (handoff_id),
  FOREIGN KEY (handoff_id, line_account_id)
    REFERENCES pharmacy_myna_handoffs(id, line_account_id),
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends(id, line_account_id),
  FOREIGN KEY (patient_id, line_account_id, friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (shadow_submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id)
);

CREATE INDEX idx_pharmacy_prescription_expectations_queue
  ON pharmacy_prescription_expectations (line_account_id, receipt_status, updated_at DESC, id);

CREATE TABLE pharmacy_myna_verifications (
  id                TEXT PRIMARY KEY,
  handoff_id        TEXT NOT NULL,
  line_account_id   TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
    ('NOT_CHECKED','E_PRESCRIPTION_RECEIVED','CONSENT_ONLY_OR_NO_PRESCRIPTION',
     'NO_RECORD_FOUND','SUBMITTED_TO_OTHER_PHARMACY','PRESCRIPTION_EXPIRED',
     'PAPER_FALLBACK','PATIENT_MISMATCH','MANUAL_EXCEPTION')),
  verified_by       TEXT NOT NULL,
  verified_at       TEXT NOT NULL,
  reason_code       TEXT,
  note              TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  source_system     TEXT NOT NULL,
  source_reference  TEXT CHECK (source_reference IS NULL OR length(source_reference) BETWEEN 1 AND 128),
  created_at        TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  FOREIGN KEY (handoff_id, line_account_id)
    REFERENCES pharmacy_myna_handoffs(id, line_account_id)
);

CREATE INDEX idx_pharmacy_myna_verifications_handoff
  ON pharmacy_myna_verifications (line_account_id, handoff_id, verified_at DESC, id);

CREATE TABLE pharmacy_myna_events (
  id              TEXT PRIMARY KEY,
  handoff_id      TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN
    ('PRESCRIPTION_INTENT_CREATED','MYNA_EXTERNAL_LAUNCH_REQUESTED',
     'MYNA_PATIENT_REPORTED_COMPLETE','MYNA_PATIENT_REPORTED_NO_PRESCRIPTION',
     'MYNA_SUPPORT_REQUESTED','MYNA_VERIFICATION_RECORDED',
     'E_PRESCRIPTION_RECEIPT_CONFIRMED','PRESCRIPTION_RECEIPT_REJECTED',
     'FULFILLMENT_REVIEW_STARTED','FULFILLMENT_QUOTE_ISSUED')),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('PATIENT_CONTACT','STAFF','SYSTEM')),
  actor_id        TEXT,
  correlation_id  TEXT NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  metadata_json   TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND length(metadata_json) BETWEEN 2 AND 4096),
  occurred_at     TEXT NOT NULL,
  FOREIGN KEY (handoff_id, line_account_id)
    REFERENCES pharmacy_myna_handoffs(id, line_account_id)
);

CREATE INDEX idx_pharmacy_myna_events_handoff
  ON pharmacy_myna_events (line_account_id, handoff_id, occurred_at, id);
