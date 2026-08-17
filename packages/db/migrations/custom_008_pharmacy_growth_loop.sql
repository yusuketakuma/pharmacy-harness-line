-- Growth Loop Release 1. All tables are pharmacy-owned, additive, and
-- account-scoped. No LINE identifiers, prescription content, or PHI are stored.

CREATE TABLE IF NOT EXISTS pharmacy_account_capabilities (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'pharmacy' CHECK (mode = 'pharmacy'),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  proactive_monthly_limit INTEGER NOT NULL DEFAULT 1 CHECK (proactive_monthly_limit >= 0),
  unfollow_alert_state TEXT NOT NULL DEFAULT 'alert_only'
    CHECK (unfollow_alert_state IN ('alert_only','auto_pause')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pharmacy_staff_accounts (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (line_account_id, staff_id),
  FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pharmacy_growth_events (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  subject_key TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  occurred_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_growth_events_account_time
  ON pharmacy_growth_events(line_account_id, occurred_at, event_type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pharmacy_prescription_submissions_id_account
  ON pharmacy_prescription_submissions(id, line_account_id);

CREATE TABLE IF NOT EXISTS pharmacy_submission_attributes (
  submission_id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pharmacy_medical_sources (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  classification TEXT NOT NULL CHECK (classification IN ('primary','other')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (line_account_id, display_name)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_medical_sources_account
  ON pharmacy_medical_sources(line_account_id, is_active, classification);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pharmacy_medical_sources_id_account
  ON pharmacy_medical_sources(id, line_account_id);

CREATE TABLE IF NOT EXISTS pharmacy_submission_sources (
  submission_id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source_id TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('primary','other','unknown')),
  entered_by TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, line_account_id)
    REFERENCES pharmacy_medical_sources(id, line_account_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_submission_sources_account
  ON pharmacy_submission_sources(line_account_id, classification, entered_at);

CREATE TABLE IF NOT EXISTS pharmacy_prescription_validities (
  submission_id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  issued_on TEXT,
  valid_until TEXT,
  validity_basis TEXT NOT NULL CHECK (validity_basis IN ('default_4_days','prescriber_specified')),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','verified','expired_review_required','expired_confirmed')),
  verified_by TEXT,
  verified_at TEXT,
  reminder_due_at TEXT,
  reminder_claimed_at TEXT,
  reminder_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (valid_until IS NULL OR issued_on IS NULL OR valid_until >= issued_on),
  CHECK (verification_status = 'unverified' OR
    (issued_on IS NOT NULL AND valid_until IS NOT NULL AND
     verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_prescription_validities_queue
  ON pharmacy_prescription_validities(line_account_id, verification_status, reminder_due_at);

CREATE TABLE IF NOT EXISTS pharmacy_notification_events (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('transactional_care','followup_care','continuity','proactive_noncare','manual')),
  outcome TEXT NOT NULL CHECK (outcome IN ('attempted','sent','blocked','failed')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  occurred_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends(id, line_account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_notification_events_exposure
  ON pharmacy_notification_events(line_account_id, friend_id, occurred_at, category, outcome);

-- Native triggers keep state/config audit events in the same D1 transaction as
-- the mutation. Payloads contain identifiers and event names only, never PHI.
CREATE TRIGGER IF NOT EXISTS trg_pharmacy_capability_audit_insert
AFTER INSERT ON pharmacy_account_capabilities
BEGIN
  INSERT INTO pharmacy_growth_events
    (id, line_account_id, event_type, aggregate_id, schema_version,
     occurred_at, idempotency_key, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.line_account_id,
          'capability_config_updated', NEW.line_account_id, 1,
          NEW.updated_at, 'audit:' || lower(hex(randomblob(16))), '{}', NEW.updated_at); END;

CREATE TRIGGER IF NOT EXISTS trg_pharmacy_capability_audit_update
AFTER UPDATE ON pharmacy_account_capabilities
BEGIN
  INSERT INTO pharmacy_growth_events
    (id, line_account_id, event_type, aggregate_id, schema_version,
     occurred_at, idempotency_key, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.line_account_id,
          'capability_config_updated', NEW.line_account_id, 1,
          NEW.updated_at, 'audit:' || lower(hex(randomblob(16))), '{}', NEW.updated_at); END;

CREATE TRIGGER IF NOT EXISTS trg_pharmacy_medical_source_audit_insert
AFTER INSERT ON pharmacy_medical_sources
BEGIN
  INSERT INTO pharmacy_growth_events
    (id, line_account_id, event_type, aggregate_id, schema_version,
     occurred_at, idempotency_key, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.line_account_id,
          'medical_source_created', NEW.id, 1,
          NEW.updated_at, 'audit:' || lower(hex(randomblob(16))), '{}', NEW.updated_at); END;

CREATE TRIGGER IF NOT EXISTS trg_pharmacy_medical_source_audit_update
AFTER UPDATE ON pharmacy_medical_sources
BEGIN
  INSERT INTO pharmacy_growth_events
    (id, line_account_id, event_type, aggregate_id, schema_version,
     occurred_at, idempotency_key, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.line_account_id,
          'medical_source_updated', NEW.id, 1,
          NEW.updated_at, 'audit:' || lower(hex(randomblob(16))), '{}', NEW.updated_at); END;

CREATE TRIGGER IF NOT EXISTS trg_pharmacy_submission_source_audit_insert
AFTER INSERT ON pharmacy_submission_sources
BEGIN
  INSERT INTO pharmacy_growth_events
    (id, line_account_id, event_type, aggregate_id, schema_version,
     occurred_at, idempotency_key, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.line_account_id,
          'submission_source_classified', NEW.submission_id, 1,
          NEW.updated_at, 'audit:' || lower(hex(randomblob(16))), '{}', NEW.updated_at); END;

CREATE TRIGGER IF NOT EXISTS trg_pharmacy_submission_source_audit_update
AFTER UPDATE ON pharmacy_submission_sources
BEGIN
  INSERT INTO pharmacy_growth_events
    (id, line_account_id, event_type, aggregate_id, schema_version,
     occurred_at, idempotency_key, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.line_account_id,
          'submission_source_classified', NEW.submission_id, 1,
          NEW.updated_at, 'audit:' || lower(hex(randomblob(16))), '{}', NEW.updated_at); END;

CREATE TRIGGER IF NOT EXISTS trg_pharmacy_validity_audit_insert
AFTER INSERT ON pharmacy_prescription_validities
BEGIN
  INSERT INTO pharmacy_growth_events
    (id, line_account_id, event_type, aggregate_id, schema_version,
     occurred_at, idempotency_key, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.line_account_id,
          'prescription_validity_updated', NEW.submission_id, 1,
          NEW.updated_at, 'audit:' || lower(hex(randomblob(16))), '{}', NEW.updated_at); END;

CREATE TRIGGER IF NOT EXISTS trg_pharmacy_validity_audit_update
AFTER UPDATE ON pharmacy_prescription_validities
BEGIN
  INSERT INTO pharmacy_growth_events
    (id, line_account_id, event_type, aggregate_id, schema_version,
     occurred_at, idempotency_key, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.line_account_id,
          'prescription_validity_updated', NEW.submission_id, 1,
          NEW.updated_at, 'audit:' || lower(hex(randomblob(16))), '{}', NEW.updated_at); END;

CREATE TRIGGER IF NOT EXISTS trg_pharmacy_notification_audit_insert
AFTER INSERT ON pharmacy_notification_events
BEGIN
  INSERT INTO pharmacy_growth_events
    (id, line_account_id, event_type, aggregate_id, schema_version,
     occurred_at, idempotency_key, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.line_account_id,
          'notification_' || NEW.outcome, NEW.id, 1,
          NEW.occurred_at, 'audit:' || lower(hex(randomblob(16))), '{}', NEW.occurred_at); END;

CREATE TRIGGER IF NOT EXISTS trg_pharmacy_notification_audit_update
AFTER UPDATE OF outcome ON pharmacy_notification_events
BEGIN
  INSERT INTO pharmacy_growth_events
    (id, line_account_id, event_type, aggregate_id, schema_version,
     occurred_at, idempotency_key, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.line_account_id,
          'notification_' || NEW.outcome, NEW.id, 1,
          NEW.occurred_at, 'audit:' || lower(hex(randomblob(16))), '{}', NEW.occurred_at); END;
