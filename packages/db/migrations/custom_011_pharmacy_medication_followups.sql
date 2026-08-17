-- Pharmacist-scheduled, PHI-free medication follow-up workflow.
-- Clinical content remains in the pharmacy's source systems and manual chat.

CREATE TABLE IF NOT EXISTS pharmacy_medication_followups (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  owner_friend_id       TEXT NOT NULL,
  patient_id            TEXT NOT NULL,
  source_submission_id  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN
      ('scheduled','due','delivered','no_issue','concern','pharmacist_requested',
       'assigned','responded','escalated','closed','cancelled')),
  due_at                TEXT NOT NULL,
  delivered_at          TEXT,
  responded_at          TEXT,
  assigned_to           TEXT,
  closed_at             TEXT,
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, source_submission_id),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (source_submission_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_prescription_patients(submission_id, line_account_id, owner_friend_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_medication_followups_due
  ON pharmacy_medication_followups (line_account_id, status, due_at, id);

CREATE INDEX IF NOT EXISTS idx_pharmacy_medication_followups_patient
  ON pharmacy_medication_followups (line_account_id, patient_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS pharmacy_medication_followup_events (
  id               TEXT PRIMARY KEY,
  followup_id      TEXT NOT NULL,
  line_account_id  TEXT NOT NULL,
  event_type       TEXT NOT NULL
    CHECK (event_type IN
      ('scheduled','due','delivered','no_issue','concern','pharmacist_requested',
       'assigned','responded','escalated','closed','cancelled')),
  from_status      TEXT
    CHECK (from_status IS NULL OR from_status IN
      ('scheduled','due','delivered','no_issue','concern','pharmacist_requested',
       'assigned','responded','escalated','closed','cancelled')),
  to_status        TEXT
    CHECK (to_status IS NULL OR to_status IN
      ('scheduled','due','delivered','no_issue','concern','pharmacist_requested',
       'assigned','responded','escalated','closed','cancelled')),
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('patient','staff','system')),
  actor_id         TEXT,
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at      TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (followup_id, line_account_id)
    REFERENCES pharmacy_medication_followups(id, line_account_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_medication_followup_events_followup
  ON pharmacy_medication_followup_events
     (line_account_id, followup_id, occurred_at DESC, id DESC);
