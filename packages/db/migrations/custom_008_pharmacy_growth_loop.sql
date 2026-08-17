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
  PRIMARY KEY (line_account_id, staff_id)
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

CREATE TABLE IF NOT EXISTS pharmacy_submission_sources (
  submission_id TEXT PRIMARY KEY REFERENCES pharmacy_prescription_submissions(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES pharmacy_medical_sources(id) ON DELETE SET NULL,
  classification TEXT NOT NULL CHECK (classification IN ('primary','other','unknown')),
  entered_by TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_submission_sources_account
  ON pharmacy_submission_sources(line_account_id, classification, entered_at);

CREATE TABLE IF NOT EXISTS pharmacy_prescription_validities (
  submission_id TEXT PRIMARY KEY REFERENCES pharmacy_prescription_submissions(id) ON DELETE CASCADE,
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
  CHECK (valid_until IS NULL OR issued_on IS NULL OR valid_until >= issued_on)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_prescription_validities_queue
  ON pharmacy_prescription_validities(line_account_id, verification_status, reminder_due_at);

CREATE TABLE IF NOT EXISTS pharmacy_notification_events (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id TEXT,
  message_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('transactional_care','followup_care','continuity','proactive_noncare','manual')),
  outcome TEXT NOT NULL CHECK (outcome IN ('attempted','sent','blocked','failed')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  occurred_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_notification_events_exposure
  ON pharmacy_notification_events(line_account_id, friend_id, occurred_at, category, outcome);
