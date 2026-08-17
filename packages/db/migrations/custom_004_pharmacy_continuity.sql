-- Pharmacy-owned continuity follow-up records. This is an operational workflow,
-- not a statutory or clinical obligation.

CREATE TABLE pharmacy_continuity_obligations (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  owner_friend_id       TEXT NOT NULL,
  patient_id            TEXT NOT NULL,
  source_submission_id  TEXT NOT NULL,
  candidate_submission_id TEXT,
  status                TEXT NOT NULL CHECK (status IN
    ('active','linked','fulfilled','paused','ended')),
  expected_next_from    TEXT NOT NULL,
  expected_next_to      TEXT NOT NULL,
  next_contact_at       TEXT NOT NULL,
  consent_at            TEXT NOT NULL,
  last_reminded_at      TEXT,
  reminder_count        INTEGER NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, line_account_id, owner_friend_id),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (source_submission_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id, friend_id),
  FOREIGN KEY (candidate_submission_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id, friend_id)
);

CREATE UNIQUE INDEX idx_pharmacy_continuity_open_patient
  ON pharmacy_continuity_obligations (line_account_id, patient_id)
  WHERE status IN ('active','linked');

CREATE UNIQUE INDEX idx_pharmacy_continuity_account
  ON pharmacy_continuity_obligations (id, line_account_id);

CREATE INDEX idx_pharmacy_continuity_due
  ON pharmacy_continuity_obligations (line_account_id, status, next_contact_at, last_reminded_at);

CREATE INDEX idx_pharmacy_continuity_patient
  ON pharmacy_continuity_obligations (line_account_id, patient_id, created_at DESC, id);

CREATE TABLE pharmacy_continuity_events (
  id              TEXT PRIMARY KEY,
  obligation_id   TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN
    ('opened','linked','reminded','fulfilled','paused','ended')),
  submission_id   TEXT,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('staff','system','patient')),
  actor_id        TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (obligation_id, line_account_id)
    REFERENCES pharmacy_continuity_obligations(id, line_account_id)
);

CREATE INDEX idx_pharmacy_continuity_events_obligation
  ON pharmacy_continuity_events (line_account_id, obligation_id, created_at, id);
