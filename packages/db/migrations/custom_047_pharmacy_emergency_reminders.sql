-- Pharmacy v0.30 neutral appointment reminder. Generation is dormant without an account control row.

CREATE TABLE IF NOT EXISTS pharmacy_emergency_reminder_controls (
  line_account_id  TEXT PRIMARY KEY,
  state            TEXT NOT NULL CHECK (state IN ('inactive', 'active', 'frozen')),
  time_zone        TEXT NOT NULL DEFAULT 'Asia/Tokyo' CHECK (time_zone = 'Asia/Tokyo'),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  updated_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, updated_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE IF NOT EXISTS pharmacy_emergency_reminders (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  intake_id        TEXT NOT NULL,
  reminder_kind    TEXT NOT NULL CHECK (reminder_kind = 'appointment_neutral_v1'),
  anchor_at        TEXT NOT NULL,
  due_at           TEXT NOT NULL,
  deadline_at      TEXT NOT NULL,
  occurrence_hash  TEXT NOT NULL
    CHECK (length(occurrence_hash) = 64 AND occurrence_hash NOT GLOB '*[^0-9a-f]*'),
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'suppressed', 'failed')),
  attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token      TEXT,
  claimed_at       TEXT,
  reason_code      TEXT CHECK (reason_code IS NULL OR reason_code IN (
                     'QUIET_HOURS_PAST_DEADLINE', 'ACTIVATION_DISABLED',
                     'FEATURE_DISABLED', 'CONTACT_NOT_ALLOWED', 'INTAKE_INACTIVE',
                     'INTAKE_EXPIRED', 'ANCHOR_CHANGED', 'DEADLINE_PASSED',
                     'RECIPIENT_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE', 'SEND_FAILED'
                   )),
  sent_at          TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (line_account_id, intake_id, reminder_kind, anchor_at),
  UNIQUE (line_account_id, occurrence_hash),
  CHECK (deadline_at > due_at),
  CHECK ((status = 'processing') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  FOREIGN KEY (intake_id, line_account_id)
    REFERENCES pharmacy_emergency_intakes(id, line_account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_reminders_due
  ON pharmacy_emergency_reminders(status, due_at, deadline_at, line_account_id, id);

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_reminder_identity_immutable
BEFORE UPDATE ON pharmacy_emergency_reminders
WHEN NEW.line_account_id IS NOT OLD.line_account_id
  OR NEW.intake_id IS NOT OLD.intake_id
  OR NEW.reminder_kind IS NOT OLD.reminder_kind
  OR NEW.anchor_at IS NOT OLD.anchor_at
  OR NEW.due_at IS NOT OLD.due_at
  OR NEW.deadline_at IS NOT OLD.deadline_at
  OR NEW.occurrence_hash IS NOT OLD.occurrence_hash
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_REMINDER_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_reminder_terminal_immutable
BEFORE UPDATE ON pharmacy_emergency_reminders
WHEN OLD.status IN ('sent', 'suppressed')
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_REMINDER_TERMINAL_IMMUTABLE'); END;
