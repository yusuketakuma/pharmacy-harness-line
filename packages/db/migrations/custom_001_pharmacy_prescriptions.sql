-- Dedicated, account-scoped prescription pre-send storage.

CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_id_line_account
  ON friends (id, line_account_id);

CREATE TABLE pharmacy_prescription_submissions (
  id                               TEXT PRIMARY KEY,
  line_account_id                  TEXT NOT NULL REFERENCES line_accounts(id),
  friend_id                        TEXT NOT NULL,
  idempotency_key                  TEXT NOT NULL,
  status                           TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','received','needs_resubmission','accepted','ready','closed','cancelled')),
  active_revision                  INTEGER CHECK (active_revision >= 1),
  upload_revision                  INTEGER NOT NULL DEFAULT 1 CHECK (upload_revision >= 1),
  desired_pickup_at                TEXT,
  original_prescription_consent_at TEXT,
  readiness_notice_consent_at      TEXT,
  resubmission_reason_code         TEXT
    CHECK (resubmission_reason_code IS NULL OR resubmission_reason_code IN
      ('blurred','cropped','glare','unreadable','missing_page')),
  requested_at                     TEXT,
  closed_at                        TEXT,
  created_at                       TEXT NOT NULL,
  updated_at                       TEXT NOT NULL,
  UNIQUE (line_account_id, friend_id, idempotency_key),
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends(id, line_account_id)
);

CREATE INDEX idx_pharmacy_prescriptions_account_status_requested
  ON pharmacy_prescription_submissions (line_account_id, status, requested_at, id);
CREATE INDEX idx_pharmacy_prescriptions_friend_history
  ON pharmacy_prescription_submissions (line_account_id, friend_id, created_at DESC, id DESC);

CREATE TABLE pharmacy_prescription_files (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL REFERENCES pharmacy_prescription_submissions(id) ON DELETE CASCADE,
  revision       INTEGER NOT NULL CHECK (revision >= 1),
  position       INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
  r2_key         TEXT NOT NULL UNIQUE
    CHECK (r2_key LIKE 'custom/pharmacy/prescriptions/%'),
  content_type   TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png')),
  byte_size      INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  sha256         TEXT NOT NULL CHECK (length(sha256) = 64),
  state          TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','ready','deleted')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (submission_id, revision, position)
);

CREATE INDEX idx_pharmacy_prescription_files_revision
  ON pharmacy_prescription_files (submission_id, revision, position);

CREATE TABLE pharmacy_prescription_events (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL REFERENCES pharmacy_prescription_submissions(id) ON DELETE CASCADE,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('patient','staff','system')),
  actor_id       TEXT,
  event_type     TEXT NOT NULL CHECK (event_type IN
    ('status_changed','revision_reserved','revision_activated','file_deleted','notification_failed')),
  from_status    TEXT CHECK (from_status IS NULL OR from_status IN
    ('draft','received','needs_resubmission','accepted','ready','closed','cancelled')),
  to_status      TEXT CHECK (to_status IS NULL OR to_status IN
    ('draft','received','needs_resubmission','accepted','ready','closed','cancelled')),
  reason_code    TEXT CHECK (reason_code IS NULL OR reason_code IN
    ('blurred','cropped','glare','unreadable','missing_page','patient_cancelled','admin_cancelled')),
  revision       INTEGER CHECK (revision IS NULL OR revision >= 1),
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_pharmacy_prescription_events_submission
  ON pharmacy_prescription_events (submission_id, created_at, id);
