-- Patient-approved next-intake timing attached one-to-one to existing continuity.
-- This does not reserve medication or promise dispensing before a prescription arrives.

CREATE TABLE IF NOT EXISTS pharmacy_next_intake_expectations (
  id                 TEXT PRIMARY KEY,
  obligation_id      TEXT NOT NULL,
  line_account_id    TEXT NOT NULL,
  owner_friend_id    TEXT NOT NULL,
  patient_id         TEXT NOT NULL,
  status             TEXT NOT NULL
    CHECK (status IN
      ('offered','accepted','active','reminded','linked','fulfilled','paused','ended')),
  timing_source      TEXT NOT NULL
    CHECK (timing_source IN ('manual_supply_days','manual_window')),
  supply_days        INTEGER,
  expected_from      TEXT NOT NULL,
  expected_to        TEXT NOT NULL,
  reminder_at        TEXT NOT NULL,
  reminded_at        TEXT,
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (obligation_id),
  UNIQUE (id, line_account_id),
  CHECK (expected_to >= expected_from),
  CHECK (
    (timing_source = 'manual_supply_days' AND supply_days BETWEEN 1 AND 365) OR
    (timing_source = 'manual_window' AND supply_days IS NULL)
  ),
  FOREIGN KEY (obligation_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_continuity_obligations(id, line_account_id, owner_friend_id),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_next_intake_expectations_due
  ON pharmacy_next_intake_expectations
     (line_account_id, status, reminder_at, id);

CREATE INDEX IF NOT EXISTS idx_pharmacy_next_intake_expectations_patient
  ON pharmacy_next_intake_expectations
     (line_account_id, patient_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS pharmacy_next_intake_expectation_events (
  id               TEXT PRIMARY KEY,
  expectation_id   TEXT NOT NULL,
  line_account_id  TEXT NOT NULL,
  event_type       TEXT NOT NULL
    CHECK (event_type IN
      ('offered','accepted','active','reminded','linked','fulfilled','paused','ended')),
  from_status      TEXT
    CHECK (from_status IS NULL OR from_status IN
      ('offered','accepted','active','reminded','linked','fulfilled','paused','ended')),
  to_status        TEXT
    CHECK (to_status IS NULL OR to_status IN
      ('offered','accepted','active','reminded','linked','fulfilled','paused','ended')),
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('patient','staff','system')),
  actor_id         TEXT,
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at      TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (expectation_id, line_account_id)
    REFERENCES pharmacy_next_intake_expectations(id, line_account_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_next_intake_expectation_events_item
  ON pharmacy_next_intake_expectation_events
     (line_account_id, expectation_id, occurred_at DESC, id DESC);
